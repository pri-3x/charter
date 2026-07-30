import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadEnv, jcsHashToken } from "@mandate/shared";
import { buildApp, makePool } from "@mandate/gate";
import type { Pool } from "@mandate/gate";

/**
 * M2 acceptance scenarios: S1–S4, S9–S14, S16, S17 (MILESTONES M2), plus S18/S19 (fail-closed +
 * malformed) carried over. Runs against the docker-compose Postgres with policy version 1
 * (example.acme.yaml) seeded active. Policy-activation scenarios (S17, S14) run LAST because they
 * change the active version for the tenant.
 */

loadEnv();

const seed: { tenant: string; agentId: string; apiKey: string; adminKey: string } = JSON.parse(
  readFileSync(resolve(process.cwd(), ".seed/agent-key.json"), "utf8"),
);
const EXAMPLE_YAML = readFileSync(resolve(process.cwd(), "policies/example.acme.yaml"), "utf8");

let pool: Pool;
let app: FastifyInstance;
const agentAuth = { authorization: `Bearer ${seed.apiKey}` };
const adminAuth = { authorization: `Bearer ${seed.adminKey}` };

let n = 0;
const idem = (): Record<string, string> => ({ "idempotency-key": `it-${Date.now()}-${n++}` });

async function check(
  tool: string,
  params: Record<string, unknown>,
  principal: string,
  extraHeaders: Record<string, string> = {},
) {
  return app.inject({
    method: "POST",
    url: "/v1/actions/check",
    headers: { ...agentAuth, ...idem(), ...extraHeaders },
    payload: { tool, params, principal },
  });
}

async function entryByEntryId(entryId: string): Promise<{ kind: string; payload: any } | null> {
  const { rows } = await pool.query<{ kind: string; payload: any }>(
    "SELECT kind, payload FROM ledger_entries WHERE tenant_id = $1 AND entry_id = $2",
    [seed.tenant, entryId],
  );
  return rows[0] ?? null;
}

async function maxSeq(): Promise<number> {
  const { rows } = await pool.query<{ m: string | null }>(
    "SELECT max(seq) AS m FROM ledger_entries WHERE tenant_id = $1",
    [seed.tenant],
  );
  return rows[0]?.m ? Number(rows[0].m) : 0;
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  pool = makePool(url);
  app = await buildApp({ pool, adminKey: seed.adminKey }, { logger: false });
  await app.ready();
  await app.inject({ method: "GET", url: "/healthz" });
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("S1 — small refund ALLOW + OUTCOME", () => {
  it("refund 20,000 → ALLOW R1, payload reconstructs (policy v1), OUTCOME, dup 409", async () => {
    const params = { order_id: "O-9912", amount: 20000, currency: "INR" };
    const res = await check("refund", params, "user:s1@acme.co");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.verdict).toBe("ALLOW");
    expect(body.rule_id).toBe("R1-refund-small");

    const dur = Number(/dur=([\d.]+)/.exec(res.headers["server-timing"] as string)?.[1]);
    expect(dur).toBeLessThan(150);

    const p = (await entryByEntryId(body.entry_id))!.payload;
    expect(p.policy.version).toBe(1);
    expect(p.policy.doc_hash).toMatch(/^sha256:/);
    expect(p.action.params_hash).toBe(jcsHashToken(params));
    expect(p.rule_trace.scope_ok).toBe(true);
    expect(p.rule_trace.rules.some((r: any) => r.rule_id === "R1-refund-small" && r.matched)).toBe(true);

    const rr = await app.inject({
      method: "POST",
      url: `/v1/actions/${body.entry_id}/result`,
      headers: agentAuth,
      payload: { status: "SUCCESS", result_hash: "sha256:beef" },
    });
    expect(rr.statusCode).toBe(200);
    expect((await entryByEntryId(rr.json().outcome_entry_id))!.kind).toBe("OUTCOME");

    const dup = await app.inject({
      method: "POST",
      url: `/v1/actions/${body.entry_id}/result`,
      headers: agentAuth,
      payload: { status: "SUCCESS", result_hash: "sha256:beef" },
    });
    expect(dup.statusCode).toBe(409);
  });
});

describe("S2 — lte boundary inclusive", () => {
  it("499,900 and exactly 500,000 → ALLOW R1", async () => {
    const a = await check("refund", { amount: 499900, currency: "INR" }, "user:s2a@acme.co");
    expect(a.json().verdict).toBe("ALLOW");
    expect(a.json().rule_id).toBe("R1-refund-small");
    const b = await check("refund", { amount: 500000, currency: "INR" }, "user:s2b@acme.co");
    expect(b.json().verdict).toBe("ALLOW");
    expect(b.json().rule_id).toBe("R1-refund-small");
  });
});

describe("S3 — large refund ESCALATE + hold", () => {
  it("500,100 → ESCALATE R2; hold PENDING ttl≈now+240m, approvers resolved", async () => {
    const res = await check("refund", { amount: 500100, currency: "INR" }, "user:s3@acme.co");
    const body = res.json();
    expect(body.verdict).toBe("ESCALATE");
    expect(body.rule_id).toBe("R2-refund-large");
    expect(body.ttl_minutes).toBe(240);
    expect(typeof body.hold_id).toBe("string");

    const { rows } = await pool.query<{
      status: string;
      approvers_snapshot: string[];
      initiating_principal: string;
      ttl_seconds: string;
    }>(
      `SELECT status, approvers_snapshot, initiating_principal,
              EXTRACT(EPOCH FROM (ttl_at - now())) AS ttl_seconds
         FROM holds WHERE id = $1`,
      [body.hold_id],
    );
    const hold = rows[0]!;
    expect(hold.status).toBe("PENDING");
    expect(hold.initiating_principal).toBe("user:s3@acme.co");
    expect(hold.approvers_snapshot.sort()).toEqual(["user:monty@acme.co", "user:steven@acme.co"]);
    // ttl_at ≈ now + 240m (14400s); allow a minute of slack
    expect(Number(hold.ttl_seconds)).toBeGreaterThan(14400 - 60);
    expect(Number(hold.ttl_seconds)).toBeLessThan(14400 + 60);

    // VERDICT payload carries the hold with approver specs
    const p = (await entryByEntryId(body.entry_id))!.payload;
    expect(p.hold.approvers).toEqual(["role:finance-lead"]);
    expect(p.hold.id).toBe(body.hold_id);
  });
});

describe("S4 — very large refund ESCALATE R2", () => {
  it("5,000,000 → ESCALATE R2", async () => {
    const res = await check("refund", { amount: 5000000, currency: "INR" }, "user:s4@acme.co");
    expect(res.json().verdict).toBe("ESCALATE");
    expect(res.json().rule_id).toBe("R2-refund-large");
  });
});

describe("S9 — delete_record DENY R3", () => {
  it("in-scope delete_record denied by R3 with exact reason", async () => {
    const res = await check("delete_record", { record_id: "R-1" }, "user:s9@acme.co");
    const body = res.json();
    expect(body.verdict).toBe("DENY");
    expect(body.rule_id).toBe("R3-no-deletes");
    expect(body.reason).toBe("Agents may never delete records.");
  });
});

describe("S10 — out-of-scope tool", () => {
  it("wire_transfer → DENY, scope block, no rules evaluated", async () => {
    const res = await check("wire_transfer", { amount: 100 }, "user:s10@acme.co");
    const body = res.json();
    expect(body.verdict).toBe("DENY");
    const p = (await entryByEntryId(body.entry_id))!.payload;
    expect(p.rule_trace.scope_ok).toBe(false);
    expect(p.rule_trace.rules).toHaveLength(0);
  });
});

describe("S11 — unknown tool", () => {
  it("totally_unknown → DENY via defaults.unknown_tool", async () => {
    const res = await check("totally_unknown", {}, "user:s11@acme.co");
    const body = res.json();
    expect(body.verdict).toBe("DENY");
    expect(body.rule_id).toBe("defaults.unknown_tool");
  });
});

describe("S12 — email rate limit (R4 count, per agent)", () => {
  it("20 emails ALLOW, 21st DENY R4; counter = 20", async () => {
    for (let i = 0; i < 20; i++) {
      const r = await check("send_email", { to: `c${i}@x.com` }, "user:s12@acme.co");
      expect(r.json().verdict).toBe("ALLOW");
      expect(r.json().rule_id).toBe("R4-email-rate");
    }
    const twentyFirst = await check("send_email", { to: "c21@x.com" }, "user:s12@acme.co");
    expect(twentyFirst.json().verdict).toBe("DENY");
    expect(twentyFirst.json().rule_id).toBe("R4-email-rate");

    const { rows } = await pool.query<{ c: string }>(
      `SELECT COALESCE(SUM(event_count),0)::bigint AS c FROM limit_counters
        WHERE tenant_id=$1 AND rule_id='R4-email-rate' AND key='agent:support-agent'`,
      [seed.tenant],
    );
    expect(Number(rows[0]!.c)).toBe(20); // DENY did not consume
  });
});

describe("S13 — anti-structuring sum limit (R5, per principal)", () => {
  it("11×490,000: 1–10 ALLOW, 11th ESCALATE R5; breach does not consume", async () => {
    const principal = "user:s13@acme.co";
    for (let i = 0; i < 10; i++) {
      const r = await check("refund", { amount: 490000, currency: "INR" }, principal);
      expect(r.json().verdict).toBe("ALLOW");
      expect(r.json().rule_id).toBe("R1-refund-small");
    }
    const eleventh = await check("refund", { amount: 490000, currency: "INR" }, principal);
    expect(eleventh.json().verdict).toBe("ESCALATE");
    expect(eleventh.json().rule_id).toBe("R5-refund-velocity");

    const { rows } = await pool.query<{ s: string }>(
      `SELECT COALESCE(SUM(event_sum),0)::bigint AS s FROM limit_counters
        WHERE tenant_id=$1 AND rule_id='R5-refund-velocity' AND key=$2`,
      [seed.tenant, `principal:${principal}`],
    );
    expect(Number(rows[0]!.s)).toBe(4_900_000); // 11th (ESCALATE breach) did not consume
  });
});

describe("S16 — idempotency", () => {
  it("same key → identical body, replay header, exactly ONE entry", async () => {
    const headers = { ...agentAuth, ...idem() };
    const payload = { tool: "refund", params: { amount: 15000, currency: "INR" }, principal: "user:s16@acme.co" };
    const first = await app.inject({ method: "POST", url: "/v1/actions/check", headers, payload });
    const second = await app.inject({ method: "POST", url: "/v1/actions/check", headers, payload });
    expect(first.headers["idempotency-replayed"]).toBeUndefined();
    expect(second.headers["idempotency-replayed"]).toBe("true");
    expect(second.json()).toEqual(first.json());
    const { rows } = await pool.query<{ c: string }>(
      "SELECT count(*) AS c FROM ledger_entries WHERE tenant_id=$1 AND entry_id=$2",
      [seed.tenant, first.json().entry_id],
    );
    expect(Number(rows[0]!.c)).toBe(1);
  });
});

describe("S19 — malformed body", () => {
  it("amount string + missing principal → 400 zod details, no entry", async () => {
    const before = await maxSeq();
    const res = await app.inject({
      method: "POST",
      url: "/v1/actions/check",
      headers: { ...agentAuth, ...idem() },
      payload: { tool: "refund", params: { amount: "lots" } },
    });
    expect(res.statusCode).toBe(400);
    expect(Array.isArray(res.json().details)).toBe(true);
    expect(await maxSeq()).toBe(before);
  });
});

describe("S18 — DB down fail-closed", () => {
  it("healthz 503 + check 5xx when Postgres unreachable", async () => {
    const deadPool = makePool("postgres://mandate_gate:gatepass@127.0.0.1:59999/mandate");
    const deadApp = await buildApp({ pool: deadPool, adminKey: seed.adminKey }, { logger: false });
    await deadApp.ready();
    try {
      const h = await deadApp.inject({ method: "GET", url: "/healthz" });
      expect(h.statusCode).toBe(503);
      expect(h.json().ok).toBe(false);
      const c = await deadApp.inject({
        method: "POST",
        url: "/v1/actions/check",
        headers: { ...agentAuth, ...idem() },
        payload: { tool: "refund", params: { amount: 100, currency: "INR" }, principal: "user:s18@acme.co" },
      });
      expect(c.statusCode).toBeGreaterThanOrEqual(500);
      expect(c.statusCode).not.toBe(200);
    } finally {
      await deadApp.close();
      await deadPool.end();
    }
  });
});

// ---- Policy-activation scenarios run LAST (they change the active version) -------------------

describe("S17 — policy versioning", () => {
  it("activate v2: entries before ref v1, after ref v2; POLICY_ACTIVATED with doc_hash between", async () => {
    const beforeRes = await check("refund", { amount: 10000, currency: "INR" }, "user:s17a@acme.co");
    const beforePayload = (await entryByEntryId(beforeRes.json().entry_id))!.payload;
    expect(beforePayload.policy.version).toBe(1);

    const draft = await app.inject({
      method: "POST",
      url: "/v1/policies",
      headers: adminAuth,
      payload: { yaml: EXAMPLE_YAML },
    });
    expect(draft.statusCode).toBe(200);
    const activate = await app.inject({
      method: "POST",
      url: `/v1/policies/${draft.json().draft_id}/activate`,
      headers: adminAuth,
    });
    expect(activate.statusCode).toBe(200);
    expect(activate.json().version).toBe(2);
    expect(activate.json().doc_hash).toMatch(/^sha256:/);

    const activatedEntry = (await entryByEntryId(activate.json().activated_entry_id))!;
    expect(activatedEntry.kind).toBe("POLICY_ACTIVATED");
    expect(activatedEntry.payload.policy_version).toBe(2);
    expect(activatedEntry.payload.doc_hash).toMatch(/^sha256:/);

    const afterRes = await check("refund", { amount: 10000, currency: "INR" }, "user:s17b@acme.co");
    const afterPayload = (await entryByEntryId(afterRes.json().entry_id))!.payload;
    expect(afterPayload.policy.version).toBe(2);
  });
});

describe("S14 — autonomy cap via policy activation", () => {
  it("activate policy with max_autonomy ESCALATE → small refund ESCALATEs with cap_applied", async () => {
    const cappedYaml = EXAMPLE_YAML.replace("max_autonomy: ALLOW", "max_autonomy: ESCALATE");
    const draft = await app.inject({
      method: "POST",
      url: "/v1/policies",
      headers: adminAuth,
      payload: { yaml: cappedYaml },
    });
    expect(draft.statusCode).toBe(200);
    const activate = await app.inject({
      method: "POST",
      url: `/v1/policies/${draft.json().draft_id}/activate`,
      headers: adminAuth,
    });
    expect(activate.statusCode).toBe(200);

    const res = await check("refund", { amount: 20000, currency: "INR" }, "user:s14@acme.co");
    const body = res.json();
    expect(body.verdict).toBe("ESCALATE");
    expect(typeof body.hold_id).toBe("string");

    const p = (await entryByEntryId(body.entry_id))!.payload;
    expect(p.rule_trace.cap_applied).toBe(true);
  });
});
