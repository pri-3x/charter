/**
 * `npx tsx scripts/provision-sandbox.ts` — create (or reset) a tenant anyone may be given.
 *
 * The console is an operator tool and its admin key is genuinely dangerous: full ledger read, agent
 * creation, authority grants, credential registration, across every tenant. Handing that to someone
 * who just wants to try Charter is not a shortcut, it is a mistake. This provisions a tenant that is
 * safe to hand out instead, and mints a key that is admin for THAT TENANT ONLY.
 *
 * What a tester can then do: register agents, ask for permission, watch a hold, approve it, read the
 * ledger, verify the chain. What they cannot do: see or touch the real tenant. That boundary is
 * enforced by the gate pinning the tenant on every admin request, and is covered adversarially by
 * tests/integration/m8.tenant-scope.test.ts.
 *
 *   POSTGRES_SUPERUSER_URL=...  required — this writes tenants, principals and policy
 *   CHARTER_BASE_URL=...        optional — printed in the instructions (default the local gate)
 *   SANDBOX_TENANT=...          optional — default 'sandbox'
 *   --reset                     wipe the sandbox's agents/keys first (the LEDGER is never deleted)
 */
import { randomBytes, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { loadEnv } from "@charter/shared";

loadEnv();

const TENANT = process.env.SANDBOX_TENANT ?? "sandbox";
const BASE = process.env.CHARTER_BASE_URL ?? `http://localhost:${process.env.PORT ?? 8090}`;
const RESET = process.argv.includes("--reset");
const sha = (s: string): string => "sha256:" + createHash("sha256").update(s).digest("hex");

const url = process.env.POSTGRES_SUPERUSER_URL;
if (!url) {
  console.error("POSTGRES_SUPERUSER_URL is required (the OWNER connection string, unpooled)");
  process.exit(2);
}

const c = new pg.Client({ connectionString: url });
await c.connect();

try {
  await c.query("BEGIN");

  await c.query(
    "INSERT INTO tenants (id, name) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name",
    [TENANT, "Charter Sandbox"],
  );
  // Without this row appendEntry throws on the very first verdict, which would make the sandbox look
  // broken the moment anyone used it.
  await c.query(
    "INSERT INTO ledger_seq (tenant_id, last_seq) VALUES ($1, 0) ON CONFLICT (tenant_id) DO NOTHING",
    [TENANT],
  );

  // An agent's owner must be a real principal in the same tenant, so a sandbox with no principals
  // fails at the first thing a tester tries. Two of them, because approving your own request is
  // refused (D9) and a tester who cannot approve anything never sees the best part.
  for (const [id, name, roles] of [
    ["user:you@sandbox.test", "You", ["support-lead"]],
    ["user:approver@sandbox.test", "Dana (approver)", ["finance-lead"]],
  ] as Array<[string, string, string[]]>) {
    await c.query(
      `INSERT INTO principals (id, tenant_id, display_name, roles) VALUES ($1,$2,$3,$4)
       ON CONFLICT (tenant_id, id) DO UPDATE SET display_name = EXCLUDED.display_name, roles = EXCLUDED.roles`,
      [id, TENANT, name, roles],
    );
  }

  if (RESET) {
    // The ledger is INSERT-only and stays. Only the things a tester creates are cleared.
    await c.query("UPDATE tenant_admin_keys SET status='REVOKED', revoked_at=now() WHERE tenant_id=$1", [TENANT]);
    await c.query("DELETE FROM authorities WHERE tenant_id=$1", [TENANT]);
    await c.query("DELETE FROM agents WHERE tenant_id=$1", [TENANT]);
  }

  // A policy, or every check fails closed with "no active policy" and the sandbox looks broken.
  const active = await c.query("SELECT 1 FROM policies WHERE tenant_id=$1 AND status='active'", [TENANT]);
  if (active.rowCount === 0) {
    const yaml = readFileSync(resolve(process.cwd(), "policies/example.acme.yaml"), "utf8")
      .replace(/^tenant:.*$/m, `tenant: ${TENANT}`);
    await c.query(
      `INSERT INTO policies (tenant_id, version, doc_yaml, doc_hash, status, activated_at)
       VALUES ($1, 1, $2, $3, 'active', now())`,
      [TENANT, yaml, sha(yaml)],
    );
  }

  const key = `chr_ta_${randomBytes(24).toString("base64url")}`;
  await c.query(
    "INSERT INTO tenant_admin_keys (fingerprint, tenant_id, label) VALUES ($1,$2,$3)",
    // The stored form is exactly what resolveAuth computes: sha256Token() keeps the `sha256:`
    // prefix. Stripping it stores a fingerprint that can never match, and the symptom is a key that
    // 401s while looking perfectly well-formed.
    [sha(key), TENANT, "sandbox console key"],
  );

  await c.query("COMMIT");

  console.log(`
  Sandbox ready — tenant '${TENANT}'

  Give the tester this, and nothing else:

    Console      ${BASE}/console/
    Base URL     (leave blank)
    Tenant       ${TENANT}
    Admin key    ${key}

  That key is admin for '${TENANT}' only. It cannot read or touch any other tenant — every admin
  request has its tenant pinned by the gate, and the attempt to escape is refused, not redirected.

  Re-run with --reset to clear the sandbox's agents and revoke its keys. The ledger is INSERT-only
  and is never deleted, which is the point of it.
`);
} catch (err) {
  await c.query("ROLLBACK").catch(() => {});
  throw err;
} finally {
  await c.end();
}
