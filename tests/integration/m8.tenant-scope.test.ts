import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadEnv } from "@charter/shared";
import { buildApp, makePool } from "@charter/gate";
import type { Pool } from "@charter/gate";

/**
 * A tenant-scoped admin key must not be able to reach another tenant.
 *
 * This is the suite that decides whether handing a stranger a sandbox key is safe, so it is written
 * adversarially: every test tries to ESCAPE the scope, and passes only when the attempt is refused.
 * Being able to read one's own tenant proves very little on its own.
 */

loadEnv();
const seed: { tenant: string; adminKey: string } = JSON.parse(
  readFileSync(resolve(process.cwd(), ".seed/agent-key.json"), "utf8"),
);

const REAL = seed.tenant;          // acme-fintech — must stay unreachable
const SANDBOX = "scope-test-tenant";

let pool: Pool;
let app: FastifyInstance;
let scopedKey: string;
const operator = { authorization: `Bearer ${seed.adminKey}` };
let scoped: Record<string, string>;

beforeAll(async () => {
  pool = makePool(process.env.DATABASE_URL!);
  app = await buildApp({ pool, adminKey: seed.adminKey }, { logger: false });
  await app.ready();

  await pool.query(
    `INSERT INTO tenants (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
    [SANDBOX, "Scope Test"],
  );
  await pool.query(
    `INSERT INTO ledger_seq (tenant_id, last_seq) VALUES ($1, 0) ON CONFLICT (tenant_id) DO NOTHING`,
    [SANDBOX],
  );
  // An agent's owner must be a real principal in the SAME tenant (schema.sql: "accountability is a
  // named human"). A sandbox without principals looks broken the moment a tester tries the first
  // thing they will try, so provisioning one is part of provisioning the tenant.
  await pool.query(
    `INSERT INTO principals (id, tenant_id, display_name, roles)
     VALUES ($1, $2, $3, $4) ON CONFLICT (tenant_id, id) DO NOTHING`,
    ["user:t@x.co", SANDBOX, "Tester", ["finance-lead"]],
  );

  const mint = await app.inject({
    method: "POST", url: "/v1/tenant-keys", headers: operator,
    payload: { tenant: SANDBOX, label: "scope test" },
  });
  scopedKey = mint.json().key;
  scoped = { authorization: `Bearer ${scopedKey}` };
});

afterAll(async () => {
  await pool.query("UPDATE tenant_admin_keys SET status='REVOKED' WHERE tenant_id = $1", [SANDBOX]);
  await app.close();
  await pool.end();
});

describe("minting", () => {
  it("issues a key that is shown once and stored only as a fingerprint", async () => {
    expect(scopedKey).toMatch(/^chr_ta_/);
    const { rows } = await pool.query("SELECT fingerprint FROM tenant_admin_keys WHERE tenant_id = $1", [SANDBOX]);
    expect(rows[0].fingerprint).not.toContain(scopedKey);
  });

  it("refuses to mint for a tenant that does not exist", async () => {
    const r = await app.inject({
      method: "POST", url: "/v1/tenant-keys", headers: operator,
      payload: { tenant: "no-such-tenant", label: "x" },
    });
    expect(r.statusCode).toBe(404);
  });

  it("will not let a scoped key mint more scoped keys", async () => {
    // Otherwise a sandbox admin is a privilege-escalation ladder.
    const r = await app.inject({
      method: "POST", url: "/v1/tenant-keys", headers: scoped,
      payload: { tenant: SANDBOX, label: "escalate" },
    });
    expect(r.statusCode).toBe(403);
  });

  it("will not let a scoped key revoke keys", async () => {
    const r = await app.inject({
      method: "POST", url: "/v1/tenant-keys/revoke", headers: scoped, payload: { key: scopedKey },
    });
    expect(r.statusCode).toBe(403);
  });
});

describe("the scope cannot be escaped", () => {
  it("reading the real tenant's ledger is refused, not silently redirected", async () => {
    const r = await app.inject({ method: "GET", url: `/v1/ledger?tenant=${REAL}&limit=5`, headers: scoped });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toMatch(/scoped to tenant/);
    expect(r.body).not.toContain("refunds-agent");
  });

  it("listing the real tenant's agents is refused", async () => {
    const r = await app.inject({ method: "GET", url: `/v1/agents?tenant=${REAL}`, headers: scoped });
    expect(r.statusCode).toBe(403);
  });

  it("omitting ?tenant= yields the SANDBOX, never the default tenant", async () => {
    // The pinning half: a route that falls back to DEFAULT_TENANT must still not serve it.
    const r = await app.inject({ method: "GET", url: "/v1/agents", headers: scoped });
    expect(r.statusCode).toBe(200);
    expect(r.json().agents).toEqual([]); // the sandbox has none; acme has several
  });

  it("the real tenant's attestation pack is refused", async () => {
    const r = await app.inject({ method: "GET", url: `/v1/attestation?tenant=${REAL}`, headers: scoped });
    expect(r.statusCode).toBe(403);
  });

  it("registering a credential for the real tenant is refused", async () => {
    const r = await app.inject({
      method: "POST", url: "/v1/credentials", headers: scoped,
      payload: { tenant: REAL, tool: "refund", endpoint_url: "https://x.test/r",
                 auth_scheme: "bearer", secret: "s", by_principal: "user:t" },
    });
    expect([403, 503]).toContain(r.statusCode); // 503 only if custody is unconfigured here
    if (r.statusCode === 403) expect(r.json().error).toMatch(/scoped to tenant/);
  });

  it("a policy naming the real tenant cannot be uploaded", async () => {
    const yaml = readFileSync(resolve(process.cwd(), "policies/example.acme.yaml"), "utf8");
    const r = await app.inject({ method: "POST", url: "/v1/policies", headers: scoped, payload: { yaml } });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toMatch(/names 'acme-fintech'/);
  });

  it("a policy naming the real tenant cannot be ACTIVATED via a draft made by the operator", async () => {
    const yaml = readFileSync(resolve(process.cwd(), "policies/example.acme.yaml"), "utf8");
    const draft = await app.inject({ method: "POST", url: "/v1/policies", headers: operator, payload: { yaml } });
    const id = draft.json().draft_id;
    const r = await app.inject({ method: "POST", url: `/v1/policies/${id}/activate`, headers: scoped });
    expect(r.statusCode).toBe(403);
  });

  it("creating an agent lands in the sandbox even when the real tenant is named", async () => {
    const r = await app.inject({
      method: "POST", url: `/v1/agents?tenant=${REAL}`, headers: scoped,
      payload: { id: "escapee", name: "Escapee", owner_principal: "user:t@x.co",
                 department: "QA", max_autonomy: "ALLOW",
                 expires_at: new Date(Date.now() + 30 * 86400000).toISOString() },
    });
    expect(r.statusCode).toBe(403);
    const { rows } = await pool.query("SELECT 1 FROM agents WHERE id = 'escapee' AND tenant_id = $1", [REAL]);
    expect(rows).toHaveLength(0);
  });
});

describe("within its own tenant it is a real admin", () => {
  it("can read its own (empty) ledger", async () => {
    const r = await app.inject({ method: "GET", url: `/v1/ledger?tenant=${SANDBOX}&limit=5`, headers: scoped });
    expect(r.statusCode).toBe(200);
  });

  it("can create an agent in its own tenant", async () => {
    const r = await app.inject({
      method: "POST", url: `/v1/agents?tenant=${SANDBOX}`, headers: scoped,
      payload: { id: "sandbox-agent", name: "Sandbox Agent", owner_principal: "user:t@x.co",
                 department: "QA", max_autonomy: "ALLOW",
                 expires_at: new Date(Date.now() + 30 * 86400000).toISOString() },
    });
    expect([200, 201, 409]).toContain(r.statusCode);
  });
});

describe("revocation", () => {
  it("a revoked key stops working immediately", async () => {
    const mint = await app.inject({
      method: "POST", url: "/v1/tenant-keys", headers: operator,
      payload: { tenant: SANDBOX, label: "to be revoked" },
    });
    const k = mint.json().key;
    const h = { authorization: `Bearer ${k}` };
    expect((await app.inject({ method: "GET", url: "/v1/agents", headers: h })).statusCode).toBe(200);

    await app.inject({ method: "POST", url: "/v1/tenant-keys/revoke", headers: operator, payload: { key: k } });
    expect((await app.inject({ method: "GET", url: "/v1/agents", headers: h })).statusCode).toBe(401);
  });
});
