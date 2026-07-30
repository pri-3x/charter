import { ulid } from "ulid";
import type { Pool } from "./db.js";
import { appendEntry } from "./ledger.js";
import { applyConsumption } from "./policy/limits.js";
import type { ConsumeItem } from "./policy/evaluate.js";

/**
 * Hold resolution (SPEC §6, DECISIONS D8/D9). Two entry points share the APPROVAL-entry writer:
 *   - decideHold: a human/approvals-service decision (APPROVED | REJECTED)
 *   - expireHolds: the fail-closed sweeper that resolves past-TTL holds as EXPIRED
 * Both write an APPROVAL ledger entry and update the hold in one transaction.
 */

export type Decision = "APPROVED" | "REJECTED";

export type DecideResult =
  | { ok: true; holdId: string; status: Decision; decidedBy: string }
  | { ok: false; code: 403 | 404 | 409; reason: string };

interface HoldRow {
  tenant_id: string;
  status: string;
  initiating_principal: string;
  approvers_snapshot: string[];
  verdict_entry_id: string;
}

export async function decideHold(
  pool: Pool,
  holdId: string,
  input: { decision: Decision; decidedBy: string; channel: string },
): Promise<DecideResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const res = await client.query<HoldRow>(
      `SELECT tenant_id, status, initiating_principal, approvers_snapshot, verdict_entry_id
         FROM holds WHERE id = $1 FOR UPDATE`,
      [holdId],
    );
    if (res.rowCount === 0) {
      await client.query("ROLLBACK");
      return { ok: false, code: 404, reason: "hold not found" };
    }
    const hold = res.rows[0]!;
    if (hold.status !== "PENDING") {
      await client.query("ROLLBACK");
      return { ok: false, code: 409, reason: `hold already ${hold.status.toLowerCase()}` };
    }
    // Self-approval is refused and NOT written to the chain (D9 / API.md S8 semantics).
    if (input.decidedBy === hold.initiating_principal) {
      await client.query("ROLLBACK");
      return { ok: false, code: 403, reason: "self-approval is not allowed" };
    }
    if (!hold.approvers_snapshot.includes(input.decidedBy)) {
      await client.query("ROLLBACK");
      return { ok: false, code: 403, reason: "not an authorized approver for this hold" };
    }

    const entryId = ulid();
    await appendEntry(client, {
      tenant: hold.tenant_id,
      kind: "APPROVAL",
      entryId,
      body: {
        decision: input.decision,
        hold_id: holdId,
        verdict_entry_id: hold.verdict_entry_id,
        decided_by: input.decidedBy,
        channel: input.channel,
      },
    });
    await client.query(
      "UPDATE holds SET status = $1, decided_by = $2, decided_at = now() WHERE id = $3",
      [input.decision, input.decidedBy, holdId],
    );

    // D8: an approved escalation now consumes the limit budget it deferred at verdict time.
    if (input.decision === "APPROVED") {
      const v = await client.query<{ dc: ConsumeItem[] | null }>(
        "SELECT payload->'deferred_consume' AS dc FROM ledger_entries WHERE tenant_id = $1 AND entry_id = $2",
        [hold.tenant_id, hold.verdict_entry_id],
      );
      const dc = v.rows[0]?.dc ?? [];
      if (Array.isArray(dc) && dc.length) await applyConsumption(client, hold.tenant_id, dc);
    }

    await client.query("COMMIT");
    return { ok: true, holdId, status: input.decision, decidedBy: input.decidedBy };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Fail-closed expiry sweeper (D9): resolve every PENDING hold past its TTL as EXPIRED, writing an
 * APPROVAL entry with decision EXPIRED and decided_by null. Returns the number expired.
 */
export async function expireHolds(pool: Pool): Promise<number> {
  const due = await pool.query<{ id: string; tenant_id: string; verdict_entry_id: string }>(
    "SELECT id, tenant_id, verdict_entry_id FROM holds WHERE status = 'PENDING' AND ttl_at <= now()",
  );
  let expired = 0;
  for (const hold of due.rows) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const chk = await client.query<{ status: string }>(
        "SELECT status FROM holds WHERE id = $1 FOR UPDATE",
        [hold.id],
      );
      if (chk.rows[0]?.status !== "PENDING") {
        await client.query("ROLLBACK");
        continue;
      }
      const entryId = ulid();
      await appendEntry(client, {
        tenant: hold.tenant_id,
        kind: "APPROVAL",
        entryId,
        body: {
          decision: "EXPIRED",
          hold_id: hold.id,
          verdict_entry_id: hold.verdict_entry_id,
          decided_by: null,
          channel: "system",
        },
      });
      await client.query(
        "UPDATE holds SET status = 'EXPIRED', decided_at = now() WHERE id = $1",
        [hold.id],
      );
      await client.query("COMMIT");
      expired++;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
  return expired;
}
