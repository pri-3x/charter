import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadEnv } from "@mandate/shared";
import { buildApp, makePool } from "@mandate/gate";
import type { Pool } from "@mandate/gate";

/**
 * Registry + Authority acceptance: S21–S24 (Charter §5.1/§5.2, DECISIONS D16–D18) plus the
 * registry lifecycle (charter an agent → grant → revoke → re-grant → suspend → reinstate), each
 * asserted against the LEDGER, not just the HTTP response: registration and every authority change
 * must be evidenced.
 *
 * State discipline: S23 revokes the demo agent's grant and re-grants it in the same test; the suite
 * restores the demo agent to a live grant in afterAll so re-runs start clean.
 */

loadEnv();

interface Seed {
  tenant: string;
  agentId: string;
  apiKey: string;
  adminKey: string;
  agents: Record<string, string>;
}
const seed: Seed = JSON.parse(readFileSync(resolve(process.cwd(), ".seed/agent-key.json"), "utf8"));

const DEMO_AGENT = "refunds-agent";
const EXPIRED_AGENT = "collections-agent";

let pool: Pool;
let app: FastifyInstance;
const adminAuth = { authorization: `Bearer ${seed.adminKey}` };

let n = 0;
const idem = (): Record<string, string> => ({ "idempotency-key": `reg-${Date.now()}-${n++}` });

function checkAs(
  agentKey: string,
  tool: string,
  params: Record<string, unknown>,
  principal: string,
) {
  return app.inject({
    method: "POST",
    url: "/v1/actions/check",
    headers: { authorization: `Bearer ${agentKey}`, ...idem() },
    payload: { tool, params, principal },
  });
}

async function entry(entryId: string): Promise<{ kind: string; payload: any } | null> {
  const { rows } = await pool.query<{ kind: string; payload: any }>(
    "SELECT kind, payload FROM ledger_entries WHERE tenant_id = $1 AND entry_id = $2",
    [seed.tenant, entryId],
  );
  return rows[0] ?? null;
}

async function activeAuthorityId(agentId: string): Promise<string | null> {
  const { rows } = await pool.query<{ id: string }>(
    "SELECT id FROM authorities WHERE tenant_id = $1 AND agent_id = $2 AND status = 'ACTIVE'",
    [seed.tenant, agentId],
  );
  return rows[0]?.id ?? null;
}

const DAY = 86_400_000;
const iso = (offsetDays: number): string => new Date(Date.now() + offsetDays * DAY).toISOString();

/** The demo agent's grant, as seeded (Charter §5.2 card). Used to restore state after revocation. */
function demoGrantBody() {
  return {
    grantor_principal: "user:monty@acme.co",
    valid_from: iso(-1),
    valid_until: iso(90),
    budget_minor: 10_000_000,
    budget_currency: "INR",
    budget_window_minutes: 1440,
    allowed_tools: ["refund", "send_email", "lookup_order", "update_record"],
    forbidden_ops: ["initiate_payout", "run_payroll", "production_db_query"],
  };
}

function grant(agentId: string, body: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: `/v1/agents/${agentId}/authorities`,
    headers: adminAuth,
    payload: body,
  });
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  pool = makePool(url);
  app = await buildApp({ pool, adminKey: seed.adminKey }, { logger: false });
});

afterAll(async () => {
  // Leave the demo agent holding a live grant regardless of how the suite ended.
  if ((await activeAuthorityId(DEMO_AGENT)) === null) {
    await grant(DEMO_AGENT, demoGrantBody());
  }
  await app.close();
  await pool.end();
});

describe("Registry + Authority (S21–S24)", () => {
  it("S21: an agent whose charter has expired is denied everything", async () => {
    const res = await checkAs(seed.agents[EXPIRED_AGENT]!, "refund", { amount: 100, currency: "INR" }, "user:s21@acme.co");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.verdict).toBe("DENY");
    expect(body.rule_id).toBe("charter.expired");
    expect(body.reason).toMatch(/charter expired on/);

    // The denial is evidenced, and it names the charter that lapsed.
    const p = (await entry(body.entry_id))!.payload;
    expect(p.kind).toBe("VERDICT");
    expect(p.agent.id).toBe(EXPIRED_AGENT);
    expect(p.authority.checks.find((c: any) => c.check === "charter_expiry").ok).toBe(false);
    // Fail closed BEFORE the policy: no rules were consulted at all.
    expect(p.rule_trace.rules).toEqual([]);
  });

  it("S22: a forbidden operation is denied even though the policy allows it", async () => {
    // Policy rule R6-payout-small ALLOWs initiate_payout ≤ Rs 1,000 for this agent…
    const res = await checkAs(
      seed.agents[DEMO_AGENT]!,
      "initiate_payout",
      { amount: 50_000, currency: "INR" },
      "user:s22@acme.co",
    );
    const body = res.json();
    // …and the grant forbids payouts outright, so the grant wins.
    expect(body.verdict).toBe("DENY");
    expect(body.rule_id).toBe("authority.forbidden_operation");
    expect(body.reason).toContain("auth_2026_0071");

    const p = (await entry(body.entry_id))!.payload;
    // Evidence keeps BOTH facts: the policy matched R6, the authority overruled it.
    expect(p.rule_trace.rules.find((r: any) => r.rule_id === "R6-payout-small").matched).toBe(true);
    expect(p.authority.checks.find((c: any) => c.check === "forbidden_ops").ok).toBe(false);
    expect(p.authority.ref).toBe("auth_2026_0071");
  });

  it("S23: revoking the authority denies everything until a new grant is issued", async () => {
    const authorityId = await activeAuthorityId(DEMO_AGENT);
    expect(authorityId).not.toBeNull();

    const revoked = await app.inject({
      method: "POST",
      url: `/v1/authorities/${authorityId}/revoke`,
      headers: adminAuth,
      payload: { by_principal: "user:monty@acme.co", reason: "quarterly review" },
    });
    expect(revoked.statusCode).toBe(200);
    const revokeEntry = (await entry(revoked.json().entry_id))!;
    expect(revokeEntry.kind).toBe("AUTHORITY_REVOKED");
    expect(revokeEntry.payload.revoked_by).toBe("user:monty@acme.co");

    // A refund that was ALLOWed a moment ago is now denied — no grant, no authority.
    const after = await checkAs(seed.agents[DEMO_AGENT]!, "refund", { amount: 20_000, currency: "INR" }, "user:s23@acme.co");
    expect(after.json().verdict).toBe("DENY");
    expect(after.json().rule_id).toBe("authority.missing");

    // Revoking twice is a conflict, not a silent no-op.
    const again = await app.inject({
      method: "POST",
      url: `/v1/authorities/${authorityId}/revoke`,
      headers: adminAuth,
      payload: { by_principal: "user:monty@acme.co" },
    });
    expect(again.statusCode).toBe(409);

    // Re-granting is itself a ledger event, and it restores service.
    const regrant = await grant(DEMO_AGENT, demoGrantBody());
    expect(regrant.statusCode).toBe(201);
    expect(regrant.json().version).toBeGreaterThan(1);
    const grantEntry = (await entry(regrant.json().entry_id))!;
    expect(grantEntry.kind).toBe("AUTHORITY_GRANTED");
    expect(grantEntry.payload.doc.budget.minor).toBe(10_000_000);
    expect(grantEntry.payload.authority.doc_hash).toMatch(/^sha256:/);

    const restored = await checkAs(seed.agents[DEMO_AGENT]!, "refund", { amount: 20_000, currency: "INR" }, "user:s23@acme.co");
    expect(restored.json().verdict).toBe("ALLOW");
  });

  it("S24: an action past the grant's daily budget is denied, and DENY consumes nothing", async () => {
    const authorityId = (await activeAuthorityId(DEMO_AGENT))!;
    const spend = async (): Promise<number> => {
      const { rows } = await pool.query<{ s: string }>(
        `SELECT COALESCE(SUM(event_sum), 0)::bigint AS s FROM limit_counters
          WHERE tenant_id = $1 AND rule_id = $2 AND key = $3`,
        [seed.tenant, `authority:${authorityId}`, `agent:${DEMO_AGENT}`],
      );
      return Number(rows[0]!.s);
    };

    const before = await spend();
    // Budget is Rs 1,00,000/day (10,000,000 paise). Rs 2,00,000 cannot fit whatever else happened.
    const res = await checkAs(
      seed.agents[DEMO_AGENT]!,
      "refund",
      { amount: 20_000_000, currency: "INR" },
      "user:s24@acme.co",
    );
    const body = res.json();
    expect(body.verdict).toBe("DENY");
    expect(body.rule_id).toBe("authority.budget_exceeded");
    // A DENY must not eat budget (D8), and it must not create a hold either.
    expect(await spend()).toBe(before);
    expect(body.hold_id).toBeUndefined();

    const p = (await entry(body.entry_id))!.payload;
    expect(p.authority.budget_minor).toBe(10_000_000);
    expect(p.authority.checks.find((c: any) => c.check === "budget").ok).toBe(false);
  });

  it("an ALLOW inside the grant records spend against the authority", async () => {
    const authorityId = (await activeAuthorityId(DEMO_AGENT))!;
    const spend = async (): Promise<number> => {
      const { rows } = await pool.query<{ s: string }>(
        `SELECT COALESCE(SUM(event_sum), 0)::bigint AS s FROM limit_counters
          WHERE tenant_id = $1 AND rule_id = $2 AND key = $3`,
        [seed.tenant, `authority:${authorityId}`, `agent:${DEMO_AGENT}`],
      );
      return Number(rows[0]!.s);
    };
    const before = await spend();
    const res = await checkAs(seed.agents[DEMO_AGENT]!, "refund", { amount: 33_300, currency: "INR" }, "user:spend@acme.co");
    expect(res.json().verdict).toBe("ALLOW");
    expect(await spend()).toBe(before + 33_300);
  });
});

describe("Registry lifecycle", () => {
  const NEW_AGENT = `kyc-agent-${Date.now().toString(36)}`;

  it("chartering an agent writes AGENT_REGISTERED and mints a working key", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: adminAuth,
      payload: {
        id: NEW_AGENT,
        name: "KYC Follow-up Agent",
        owner_principal: "user:sarah@acme.co",
        department: "Compliance Ops",
        purpose: "Chases missing KYC documents.",
        approver_chain: ["role:finance-lead"],
        expires_at: iso(30),
      },
    });
    expect(res.statusCode).toBe(201);
    const { api_key, entry_id } = res.json();
    expect(api_key).toMatch(/^chr_/);

    const registered = (await entry(entry_id))!;
    expect(registered.kind).toBe("AGENT_REGISTERED");
    expect(registered.payload.owner_principal).toBe("user:sarah@acme.co");
    expect(registered.payload.department).toBe("Compliance Ops");
    // The raw key is never in the ledger — only its fingerprint.
    expect(JSON.stringify(registered.payload)).not.toContain(api_key);

    // The key authenticates, but with no grant yet the gate denies (fail closed by default).
    const first = await checkAs(api_key, "refund", { amount: 100, currency: "INR" }, "user:new@acme.co");
    expect(first.json().verdict).toBe("DENY");
    expect(first.json().rule_id).toBe("authority.missing");
  });

  it("rejects a charter with an owner who does not exist, and a duplicate id", async () => {
    const noOwner = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: adminAuth,
      payload: {
        id: `ghost-${Date.now().toString(36)}`,
        name: "Ghost",
        owner_principal: "user:nobody@acme.co",
        department: "Nowhere",
        expires_at: iso(30),
      },
    });
    expect(noOwner.statusCode).toBe(400);

    const dupe = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: adminAuth,
      payload: {
        id: NEW_AGENT,
        name: "KYC Follow-up Agent",
        owner_principal: "user:sarah@acme.co",
        department: "Compliance Ops",
        expires_at: iso(30),
      },
    });
    expect(dupe.statusCode).toBe(409);
  });

  it("rejects a charter with no expiry and a grant that ends before it starts", async () => {
    const noExpiry = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: adminAuth,
      payload: {
        id: `noexpiry-${Date.now().toString(36)}`,
        name: "Forever Agent",
        owner_principal: "user:sarah@acme.co",
        department: "Ops",
      },
    });
    expect(noExpiry.statusCode).toBe(400);

    const backwards = await grant(DEMO_AGENT, {
      ...demoGrantBody(),
      valid_from: iso(10),
      valid_until: iso(5),
    });
    expect(backwards.statusCode).toBe(400);

    // A tool cannot be both granted and forbidden — that ambiguity is refused, not resolved.
    const contradictory = await grant(DEMO_AGENT, {
      ...demoGrantBody(),
      allowed_tools: ["refund", "run_payroll"],
      forbidden_ops: ["run_payroll"],
    });
    expect(contradictory.statusCode).toBe(400);
  });

  it("lists the registry with derived charter status and live grant", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/agents", headers: adminAuth });
    expect(res.statusCode).toBe(200);
    const agents: any[] = res.json().agents;
    const byId = Object.fromEntries(agents.map((a) => [a.id, a]));

    expect(byId[seed.agentId].charter_status).toBe("ACTIVE");
    expect(byId[seed.agentId].owner_name).toBe("Sarah Menon");
    // EXPIRED is derived from the date, never stored as a status.
    expect(byId[EXPIRED_AGENT].status).toBe("ACTIVE");
    expect(byId[EXPIRED_AGENT].charter_status).toBe("EXPIRED");
    expect(byId[EXPIRED_AGENT].days_until_expiry).toBeLessThan(0);
    // Ref is per-grant (S23 above may have re-granted as a new version with its own ref).
    expect(byId[DEMO_AGENT].authority.ref).toMatch(/^auth_\d{4}_\d{4}$/);
    expect(byId[DEMO_AGENT].authority.budget_minor).toBe(10_000_000);
    expect(byId[DEMO_AGENT].spend_window_minor).toBeGreaterThan(0);
  });

  it("suspend then reinstate: both are ledger events and the gate follows both", async () => {
    const suspended = await app.inject({
      method: "POST",
      url: `/v1/agents/${NEW_AGENT}/suspend`,
      headers: adminAuth,
    });
    expect(suspended.statusCode).toBe(200);
    expect((await entry(suspended.json().entry_id))!.kind).toBe("AGENT_SUSPENDED");

    const reinstated = await app.inject({
      method: "POST",
      url: `/v1/agents/${NEW_AGENT}/reinstate`,
      headers: adminAuth,
      payload: { by_principal: "user:monty@acme.co" },
    });
    expect(reinstated.statusCode).toBe(200);
    const entryRow = (await entry(reinstated.json().entry_id))!;
    expect(entryRow.kind).toBe("AGENT_REINSTATED");
    expect(entryRow.payload.from_status).toBe("SUSPENDED");

    // Reinstating an already-active agent is a conflict.
    const again = await app.inject({
      method: "POST",
      url: `/v1/agents/${NEW_AGENT}/reinstate`,
      headers: adminAuth,
      payload: { by_principal: "user:monty@acme.co" },
    });
    expect(again.statusCode).toBe(409);
  });

  it("registry endpoints refuse an agent key (admin only)", async () => {
    const agentAuth = { authorization: `Bearer ${seed.apiKey}` };
    for (const url of ["/v1/agents", `/v1/agents/${DEMO_AGENT}`]) {
      const res = await app.inject({ method: "GET", url, headers: agentAuth });
      expect(res.statusCode).toBe(401);
    }
    const res = await app.inject({
      method: "POST",
      url: `/v1/agents/${DEMO_AGENT}/authorities`,
      headers: agentAuth,
      payload: demoGrantBody(),
    });
    expect(res.statusCode).toBe(401);
  });

  it("the whole chain is still intact after all registry writes", async () => {
    const { rows } = await pool.query<{ seq: string; prev_hash: string; entry_hash: string }>(
      "SELECT seq, prev_hash, entry_hash FROM ledger_entries WHERE tenant_id = $1 ORDER BY seq ASC",
      [seed.tenant],
    );
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.prev_hash).toBe(rows[i - 1]!.entry_hash);
    }
    expect(rows.length).toBeGreaterThan(10);
  });
});
