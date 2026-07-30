import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadEnv } from "@mandate/shared";
import { buildApp, makePool, expireHolds } from "@mandate/gate";
import type { Pool } from "@mandate/gate";
import { MandateClient, HoldRejectedError, HoldExpiredError } from "@mandate/sdk";

/**
 * M3 acceptance scenarios: S5–S8 (approvals via SDK guard()) and S15 (kill switch). Drives the real
 * SDK against a listening gate. The decision endpoint stands in for the approvals service (the
 * Telegram bot is manual-only). S15 runs LAST and the agent is restored to ACTIVE in afterAll.
 */

loadEnv();

const seed: { tenant: string; agentId: string; apiKey: string; adminKey: string } = JSON.parse(
  readFileSync(resolve(process.cwd(), ".seed/agent-key.json"), "utf8"),
);

let pool: Pool;
let app: FastifyInstance;
let client: MandateClient;
const adminAuth = { authorization: `Bearer ${seed.adminKey}` };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitForPendingHold(
  principal: string,
): Promise<{ id: string; verdict_entry_id: string }> {
  for (let i = 0; i < 60; i++) {
    const { rows } = await pool.query<{ id: string; verdict_entry_id: string }>(
      `SELECT id, verdict_entry_id FROM holds
        WHERE initiating_principal = $1 AND status = 'PENDING'
        ORDER BY created_at DESC LIMIT 1`,
      [principal],
    );
    if (rows[0]) return rows[0];
    await sleep(50);
  }
  throw new Error(`no PENDING hold appeared for ${principal}`);
}

function decide(holdId: string, decision: string, decidedBy: string) {
  return app.inject({
    method: "POST",
    url: `/v1/holds/${holdId}/decision`,
    headers: adminAuth,
    payload: { decision, decided_by_principal: decidedBy, channel: "test" },
  });
}

async function outcomeExists(verdictEntryId: string): Promise<boolean> {
  const { rows } = await pool.query(
    "SELECT 1 FROM ledger_entries WHERE tenant_id=$1 AND kind='OUTCOME' AND payload->>'verdict_entry_id'=$2",
    [seed.tenant, verdictEntryId],
  );
  return rows.length > 0;
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  pool = makePool(url);
  app = await buildApp({ pool, adminKey: seed.adminKey }, { logger: false });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  client = new MandateClient({
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey: seed.apiKey,
    agentId: seed.agentId,
    pollIntervalMs: 100,
  });
});

afterAll(async () => {
  // Restore the agent (S15 suspends it); un-suspend is manual SQL per D15.
  await pool.query("UPDATE agents SET status='ACTIVE' WHERE tenant_id=$1 AND id=$2", [
    seed.tenant,
    seed.agentId,
  ]);
  await app.close();
  await pool.end();
});

describe("S5 — escalation APPROVED → guard executes + OUTCOME", () => {
  it("guard resolves on approval and reports the outcome", async () => {
    const fn = vi.fn(async (p: { amount: number }) => ({ ok: true, refunded: p.amount }));
    const refund = client.guard("refund", fn, {
      principal: "user:s5@acme.co",
      reasoning: "duplicate charge confirmed",
    });
    const promise = refund({ order_id: "O-1", amount: 500100, currency: "INR" });

    const hold = await waitForPendingHold("user:s5@acme.co");
    const dec = await decide(hold.id, "APPROVED", "user:monty@acme.co");
    expect(dec.statusCode).toBe(200);
    expect(dec.json().decided_by).toBe("user:monty@acme.co");

    const result = await promise;
    expect(fn).toHaveBeenCalledOnce();
    expect(result).toEqual({ ok: true, refunded: 500100 });
    expect(await outcomeExists(hold.verdict_entry_id)).toBe(true);
  });
});

describe("S6 — escalation REJECTED → HoldRejectedError, no OUTCOME", () => {
  it("guard throws and never runs the fn", async () => {
    const fn = vi.fn();
    const refund = client.guard("refund", fn, { principal: "user:s6@acme.co" });
    const promise = refund({ order_id: "O-2", amount: 500100, currency: "INR" });

    const hold = await waitForPendingHold("user:s6@acme.co");
    await decide(hold.id, "REJECTED", "user:monty@acme.co");

    await expect(promise).rejects.toBeInstanceOf(HoldRejectedError);
    expect(fn).not.toHaveBeenCalled();
    expect(await outcomeExists(hold.verdict_entry_id)).toBe(false);
  });
});

describe("S7 — escalation EXPIRED → HoldExpiredError", () => {
  it("sweeper expires the hold; guard throws and never runs the fn", async () => {
    const fn = vi.fn();
    const refund = client.guard("refund", fn, { principal: "user:s7@acme.co" });
    const promise = refund({ order_id: "O-3", amount: 500100, currency: "INR" });

    const hold = await waitForPendingHold("user:s7@acme.co");
    // Simulate TTL elapsed, then run the fail-closed sweeper directly (30s timer in production).
    await pool.query("UPDATE holds SET ttl_at = now() - make_interval(mins => 1) WHERE id=$1", [
      hold.id,
    ]);
    const expired = await expireHolds(pool);
    expect(expired).toBeGreaterThanOrEqual(1);

    await expect(promise).rejects.toBeInstanceOf(HoldExpiredError);
    expect(fn).not.toHaveBeenCalled();

    const { rows } = await pool.query<{ payload: any }>(
      "SELECT payload FROM ledger_entries WHERE tenant_id=$1 AND kind='APPROVAL' AND payload->>'hold_id'=$2",
      [seed.tenant, hold.id],
    );
    expect(rows[0]!.payload.decision).toBe("EXPIRED");
    expect(rows[0]!.payload.decided_by).toBeNull();
  });
});

describe("S8 — self-approval refused (403), then a real approver works", () => {
  it("initiator cannot decide own hold; hold stays PENDING; another approver resolves", async () => {
    const check = await client.check({
      tool: "refund",
      params: { order_id: "O-4", amount: 600000, currency: "INR" },
      principal: "user:monty@acme.co",
    });
    expect(check.verdict).toBe("ESCALATE");
    const holdId = check.hold_id!;

    const selfAttempt = await decide(holdId, "APPROVED", "user:monty@acme.co");
    expect(selfAttempt.statusCode).toBe(403);
    expect((await client.getHold(holdId)).status).toBe("PENDING");

    const ok = await decide(holdId, "APPROVED", "user:steven@acme.co");
    expect(ok.statusCode).toBe(200);
    expect((await client.getHold(holdId)).status).toBe("APPROVED");
  });
});

// ---- S15 runs LAST: it suspends the shared agent (restored in afterAll) --------------------
describe("S15 — kill switch", () => {
  it("suspend → AGENT_SUSPENDED entry; subsequent checks DENY 'agent suspended'", async () => {
    const susp = await app.inject({
      method: "POST",
      url: `/v1/agents/${seed.agentId}/suspend`,
      headers: adminAuth,
    });
    expect(susp.statusCode).toBe(200);
    expect(susp.json().status).toBe("SUSPENDED");

    const { rows } = await pool.query(
      "SELECT 1 FROM ledger_entries WHERE tenant_id=$1 AND kind='AGENT_SUSPENDED'",
      [seed.tenant],
    );
    expect(rows.length).toBeGreaterThan(0);

    const c = await client.check({
      tool: "refund",
      params: { amount: 100, currency: "INR" },
      principal: "user:s15@acme.co",
    });
    expect(c.verdict).toBe("DENY");
    expect(c.reason).toBe("agent suspended");
  });
});
