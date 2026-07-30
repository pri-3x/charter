import { ulid } from "ulid";
import type { Pool } from "./db.js";
import { appendEntry } from "./ledger.js";

export type SuspendResult =
  | { ok: true; entryId: string }
  | { ok: false; code: 404; reason: string };

/**
 * Kill switch (D15): set agents.status='SUSPENDED' and write an AGENT_SUSPENDED ledger entry in one
 * transaction. The gate checks status on every request, so this takes effect immediately. Un-suspend
 * is out of POC scope (manual SQL).
 */
export async function suspendAgent(
  pool: Pool,
  tenant: string,
  agentId: string,
): Promise<SuspendResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const upd = await client.query(
      "UPDATE agents SET status = 'SUSPENDED' WHERE tenant_id = $1 AND id = $2",
      [tenant, agentId],
    );
    if (upd.rowCount === 0) {
      await client.query("ROLLBACK");
      return { ok: false, code: 404, reason: "agent not found" };
    }
    const entryId = ulid();
    await appendEntry(client, {
      tenant,
      kind: "AGENT_SUSPENDED",
      entryId,
      body: { agent_id: agentId },
    });
    await client.query("COMMIT");
    return { ok: true, entryId };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
