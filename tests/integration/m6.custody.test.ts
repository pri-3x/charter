import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadEnv } from "@charter/shared";
import { buildApp, makePool } from "@charter/gate";
import type { Pool } from "@charter/gate";

/**
 * Pattern B — credential custody (SPEC §7, D1). The question this suite answers is the one A4 asks
 * and Pattern A cannot: what happens when the agent simply does not cooperate?
 *
 * Under Pattern A the answer is "the call succeeds and the ledger never hears about it", which A4
 * asserts on purpose. Here the agent holds no credential, so the same non-cooperation produces
 * nothing at all. These tests check that the credential really is unreachable, not merely unused.
 *
 * A throwaway HTTP server stands in for the upstream tool. It records every request it receives,
 * which is how "the tool was NOT called" is asserted as a fact rather than an absence of logging.
 */

loadEnv();

interface Seed {
  tenant: string;
  adminKey: string;
  agents: Record<string, string>;
}
const seed: Seed = JSON.parse(readFileSync(resolve(process.cwd(), ".seed/agent-key.json"), "utf8"));

const AGENT = "refunds-agent";
const TOOL = "refund";
const SECRET = "sk_live_pattern_b_" + randomBytes(6).toString("hex");
const CREDENTIAL_KEY = randomBytes(32);

let pool: Pool;
let app: FastifyInstance;
let upstream: Server;
let upstreamUrl: string;

/** Every request the fake tool saw, including the headers — so we can prove what was presented. */
const received: Array<{ auth: string | undefined; body: unknown; method: string }> = [];
let upstreamStatus = 200;

const adminAuth = { authorization: `Bearer ${seed.adminKey}` };
const agentAuth = { authorization: `Bearer ${seed.agents[AGENT]}` };
let n = 0;
const idem = (): Record<string, string> => ({ "idempotency-key": `cust-${Date.now()}-${n++}` });

beforeAll(async () => {
  upstream = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      received.push({
        auth: req.headers.authorization,
        body: raw ? JSON.parse(raw) : null,
        method: req.method ?? "",
      });
      res.writeHead(upstreamStatus, { "content-type": "application/json" });
      res.end(JSON.stringify({ refund_id: "rf_123", echo: raw ? JSON.parse(raw) : null }));
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const addr = upstream.address();
  upstreamUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/refund`;

  pool = makePool(process.env.DATABASE_URL!);
  app = await buildApp(
    {
      pool,
      adminKey: seed.adminKey,
      credentialKey: CREDENTIAL_KEY,
      allowLoopbackEgress: true, // the fake tool is on localhost
      demoTenant: seed.tenant,
    },
    { logger: false },
  );
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await new Promise<void>((r) => upstream.close(() => r()));
});

const register = (over: Record<string, unknown> = {}) =>
  app.inject({
    method: "POST",
    url: "/v1/credentials",
    headers: adminAuth,
    payload: {
      tool: TOOL,
      endpoint_url: upstreamUrl,
      method: "POST",
      auth_scheme: "bearer",
      secret: SECRET,
      by_principal: "user:monty@acme.co",
      ...over,
    },
  });

const proxy = (params: Record<string, unknown>) =>
  app.inject({
    method: "POST",
    url: `/v1/proxy/${TOOL}`,
    headers: { ...agentAuth, ...idem() },
    payload: { params, principal: "user:sarah@acme.co" },
  });

describe("credential registration", () => {
  it("stores the secret and never echoes it back", async () => {
    const res = await register();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.key_fingerprint).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it("does not expose the secret through the admin list", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/credentials", headers: adminAuth });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(SECRET);
    const row = res.json().credentials.find((c: { tool: string }) => c.tool === TOOL);
    expect(row).toMatchObject({ tool: TOOL, auth_scheme: "bearer", status: "ACTIVE" });
  });

  it("keeps the plaintext out of the database entirely", async () => {
    // The strongest available statement: grep every column of the row for the secret.
    const { rows } = await pool.query(
      "SELECT to_jsonb(t)::text AS dump FROM tool_credentials t WHERE tenant_id = $1 AND tool = $2",
      [seed.tenant, TOOL],
    );
    expect(rows[0].dump).not.toContain(SECRET);
  });

  it("evidences registration in the ledger without the secret", async () => {
    const { rows } = await pool.query(
      `SELECT payload FROM ledger_entries
        WHERE tenant_id = $1 AND kind = 'CREDENTIAL_REGISTERED'
        ORDER BY seq DESC LIMIT 1`,
      [seed.tenant],
    );
    expect(rows[0].payload.tool).toBe(TOOL);
    expect(rows[0].payload.by_principal).toBe("user:monty@acme.co");
    expect(JSON.stringify(rows[0].payload)).not.toContain(SECRET);
  });

  it("refuses an endpoint a credential must never be sent to", async () => {
    const res = await register({ endpoint_url: "https://169.254.169.254/latest/meta-data" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/private or link-local/);
  });

  it("requires admin", async () => {
    const res = await app.inject({
      method: "POST", url: "/v1/credentials", headers: agentAuth,
      payload: { tool: TOOL, endpoint_url: upstreamUrl, auth_scheme: "bearer", secret: "x", by_principal: "p" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("the proxy carries the credential the agent never sees", () => {
  it("ALLOW: the gate calls the tool, presenting the secret itself", async () => {
    received.length = 0;
    const res = await proxy({ amount: 20000, currency: "INR" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.verdict).toBe("ALLOW");
    expect(body.tool_status).toBe(200);
    expect(body.tool_response.refund_id).toBe("rf_123");

    // The upstream saw the credential...
    expect(received).toHaveLength(1);
    expect(received[0]!.auth).toBe(`Bearer ${SECRET}`);
    // ...and the agent's response did not.
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it("sends exactly the params that were authorized", async () => {
    received.length = 0;
    await proxy({ amount: 31337, currency: "INR" });
    expect(received[0]!.body).toEqual({ amount: 31337, currency: "INR" });
  });

  it("records an OUTCOME the gate observed, not one the agent asserted", async () => {
    received.length = 0;
    const res = await proxy({ amount: 12345, currency: "INR" });
    const { entry_id, outcome_entry_id } = res.json();
    const { rows } = await pool.query(
      "SELECT payload FROM ledger_entries WHERE tenant_id = $1 AND entry_id = $2",
      [seed.tenant, outcome_entry_id],
    );
    expect(rows[0].payload).toMatchObject({
      verdict_entry_id: entry_id,
      status: "SUCCESS", // the OUTCOME's own verdict, not the upstream HTTP code
      via: "proxy",
    });
    // The upstream's status lives under `egress` precisely so it cannot shadow the line above.
    expect(rows[0].payload.egress.upstream_status).toBe(200);
    expect(rows[0].payload.result_hash).toMatch(/^sha256:/);
  });

  it("DENY: the tool is never called at all", async () => {
    received.length = 0;
    // delete_record is denied by R3 for every agent.
    const res = await app.inject({
      method: "POST",
      url: "/v1/proxy/delete_record",
      headers: { ...agentAuth, ...idem() },
      payload: { params: { record_id: "CUST-1", record_type: "customer" }, principal: "user:sarah@acme.co" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().verdict).not.toBe("ALLOW");
    expect(received).toHaveLength(0);
  });

  it("ESCALATE: held, and the tool is not called until a human approves", async () => {
    received.length = 0;
    const res = await proxy({ amount: 8_000_000, currency: "INR" }); // way over R2's ceiling
    expect(res.statusCode).toBe(200);
    expect(res.json().verdict).toBe("ESCALATE");
    expect(res.json().hold_id).toBeTruthy();
    expect(received).toHaveLength(0); // nothing left the gate
  });

  it("refuses to resume a hold that is still pending", async () => {
    const held = await proxy({ amount: 9_000_000, currency: "INR" });
    const holdId = held.json().hold_id;
    const res = await app.inject({
      method: "POST", url: "/v1/proxy/resume", headers: agentAuth, payload: { hold_id: holdId },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/PENDING/);
    expect(received.filter((r) => (r.body as { amount?: number })?.amount === 9_000_000)).toHaveLength(0);
  });

  it("a caller cannot smuggle new params past an approval", async () => {
    // The heart of the resume design: approval is for the params in the ledger, not for whatever
    // the agent sends next. The endpoint accepts a hold id and nothing else.
    const held = await proxy({ amount: 7_500_000, currency: "INR" });
    const holdId = held.json().hold_id;
    await pool.query("UPDATE holds SET status = 'APPROVED', decided_by = $2 WHERE id = $1", [
      holdId, "user:monty@acme.co",
    ]);

    received.length = 0;
    const res = await app.inject({
      method: "POST",
      url: "/v1/proxy/resume",
      headers: agentAuth,
      payload: { hold_id: holdId, params: { amount: 1 } }, // strict schema: extra key is rejected
    });
    expect(res.statusCode).toBe(400);

    const ok = await app.inject({
      method: "POST", url: "/v1/proxy/resume", headers: agentAuth, payload: { hold_id: holdId },
    });
    expect(ok.statusCode).toBe(200);
    // Executed with the AUTHORIZED amount, read back from the ledger.
    expect(received).toHaveLength(1);
    expect((received[0]!.body as { amount: number }).amount).toBe(7_500_000);
  });

  it("executes an approval only once", async () => {
    const held = await proxy({ amount: 6_500_000, currency: "INR" });
    const holdId = held.json().hold_id;
    await pool.query("UPDATE holds SET status = 'APPROVED' WHERE id = $1", [holdId]);
    const first = await app.inject({
      method: "POST", url: "/v1/proxy/resume", headers: agentAuth, payload: { hold_id: holdId },
    });
    expect(first.statusCode).toBe(200);
    received.length = 0;
    const second = await app.inject({
      method: "POST", url: "/v1/proxy/resume", headers: agentAuth, payload: { hold_id: holdId },
    });
    expect(second.statusCode).toBe(409);
    expect(received).toHaveLength(0);
  });
});

describe("revocation bites immediately", () => {
  it("a revoked credential cannot be used, and the tool is not called", async () => {
    const rev = await app.inject({
      method: "POST", url: `/v1/credentials/${TOOL}/revoke`, headers: adminAuth,
      payload: { by_principal: "user:monty@acme.co" },
    });
    expect(rev.statusCode).toBe(200);

    received.length = 0;
    const res = await proxy({ amount: 100, currency: "INR" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/no active credential/);
    expect(received).toHaveLength(0);

    // Restore for any later run against this database.
    await register();
  });
});

describe("A4 revisited — the bypass Pattern A cannot close", () => {
  it("an agent with no credential cannot reach the tool on its own", async () => {
    // Pattern A's bypass is "call the wrapped function directly". Under Pattern B the agent was
    // never given the function or the key — the only thing it holds is its Charter API key, which
    // the upstream tool does not accept.
    received.length = 0;
    const res = await fetch(upstreamUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${seed.agents[AGENT]}` },
      body: JSON.stringify({ amount: 999999, currency: "INR" }),
    });
    await res.text();
    // The stub accepts anything, so assert the security-relevant fact: what the agent could present
    // is NOT the credential. A real upstream rejects it; the credential never left Charter.
    expect(received).toHaveLength(1);
    expect(received[0]!.auth).not.toBe(`Bearer ${SECRET}`);
    expect(received[0]!.auth).toBe(`Bearer ${seed.agents[AGENT]}`);
  });
});
