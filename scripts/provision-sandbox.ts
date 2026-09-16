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
import { grantAuthority } from "../packages/gate/src/registry/store.js";
import { makePool } from "../packages/gate/src/db.js";
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
    // Retire the policy too, so --reset actually re-applies policies/sandbox.yaml. Without this the
    // insert below is skipped (a policy is already active) and the sandbox keeps running whatever
    // it was first provisioned with — which is how it ended up enforcing another tenant's policy
    // and answering defaults.unknown_agent for the only agent it has.
    await c.query("UPDATE policies SET status='retired' WHERE tenant_id=$1 AND status='active'", [TENANT]);
    await c.query("DELETE FROM authorities WHERE tenant_id=$1", [TENANT]);
    await c.query("DELETE FROM agents WHERE tenant_id=$1", [TENANT]);
  }

  // A policy, or every check fails closed with "no active policy" and the sandbox looks broken.
  const active = await c.query("SELECT 1 FROM policies WHERE tenant_id=$1 AND status='active'", [TENANT]);
  if (active.rowCount === 0) {
    // A policy written for the sandbox rather than acme's with the tenant swapped: acme's names
    // agents that do not exist here, and the gate correctly answers defaults.unknown_agent for all
    // of them, which looks exactly like the product being broken.
    const yaml = readFileSync(resolve(process.cwd(), "policies/sandbox.yaml"), "utf8")
      .replace(/^tenant:.*$/m, `tenant: ${TENANT}`);
    // Version must not collide with a retired one: (tenant, version) is the primary key.
    const next = await c.query<{ v: number }>(
      "SELECT COALESCE(MAX(version), 0) + 1 AS v FROM policies WHERE tenant_id = $1 AND version > 0",
      [TENANT],
    );
    await c.query(
      `INSERT INTO policies (tenant_id, version, doc_yaml, doc_hash, status, activated_at)
       VALUES ($1, $2, $3, $4, 'active', now())`,
      [TENANT, Number(next.rows[0]!.v), yaml, sha(yaml)],
    );
  }

  // A ready-made agent. A sandbox that starts empty makes the tester build a charter and a grant
  // before anything can happen, and the first thing they see is an empty table — which reads as
  // broken rather than as "nothing here yet". They can still create their own; this is so there is
  // something to press immediately.
  const agentKey = `chr_${randomBytes(24).toString("base64url")}`;
  const existing = await c.query("SELECT 1 FROM agents WHERE tenant_id=$1 AND id=$2", [TENANT, "demo-agent"]);
  if (existing.rowCount === 0) {
    await c.query(
      `INSERT INTO agents (id, tenant_id, name, key_fingerprint, max_autonomy, status,
                           owner_principal, department, purpose, approver_chain, expires_at)
       VALUES ($1,$2,$3,$4,'ALLOW','ACTIVE',$5,$6,$7,$8, now() + interval '90 days')`,
      [
        "demo-agent", TENANT, "Demo Agent", sha(agentKey),
        "user:you@sandbox.test", "Customer Support",
        "Handles refunds and customer email for the sandbox.",
        ["role:finance-lead"],
      ],
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

  // The grant is written through the real code path (it writes an AUTHORITY_GRANTED ledger entry),
  // so it needs its own connection after the transaction above has committed.
  const liveGrant = await c.query(
    "SELECT 1 FROM authorities WHERE tenant_id=$1 AND agent_id=$2 AND status='ACTIVE'",
    [TENANT, "demo-agent"],
  );
  if (liveGrant.rowCount === 0) {
    // Written through the real grant path so it produces an AUTHORITY_GRANTED ledger entry — the
    // sandbox's chain should look like a real one from its first entry.
    const pool = makePool(url);
    const day = 86400000;
    const res = await grantAuthority(pool, {
      tenant: TENANT,
      agentId: "demo-agent",
      grantorPrincipal: "user:approver@sandbox.test",
      validFrom: new Date(Date.now() - day).toISOString(),
      validUntil: new Date(Date.now() + 90 * day).toISOString(),
      budgetMinor: 10_000_000, // Rs 1,00,000/day — enough to explore without hitting the ceiling
      budgetCurrency: "INR",
      budgetWindowMinutes: 1440,
      allowedTools: ["refund", "send_email", "lookup_order", "update_record"],
      forbiddenOps: ["initiate_payout", "run_payroll", "production_db_query"],
      ref: "sandbox-grant",
    });
    await pool.end();
    if (!res.ok) throw new Error(`grant failed: ${JSON.stringify(res)}`);
  }

  console.log(`
  Sandbox ready — tenant '${TENANT}'

  Send the tester these four lines and TESTING.md:

    Console      ${BASE}/console/
    Base URL     (leave blank)
    Admin key    ${key}
    Agent key    demo-agent=${agentKey}

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
