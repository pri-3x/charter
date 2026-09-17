/**
 * `npx tsx scripts/tester-link.ts "Monty"` — mint ONE console link for ONE person.
 *
 * Deliberately separate from provision-sandbox.ts, which has a --reset that revokes every key
 * issued for the sandbox. That is the right behaviour for starting over and the wrong behaviour for
 * adding a tester, and running it by mistake silently breaks every link already handed out — which
 * is exactly how a key that "worked yesterday" starts answering 401.
 *
 * Each person gets their own key, labelled with their name, so one can be revoked without touching
 * anyone else's:
 *
 *   npx tsx scripts/tester-link.ts --revoke "Monty"
 *   npx tsx scripts/tester-link.ts --list
 *
 * Needs POSTGRES_SUPERUSER_URL (the owner connection string) and .seed/sandbox.json, which
 * provision-sandbox.ts writes.
 */
import { randomBytes, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { loadEnv } from "@charter/shared";

loadEnv();
const sha = (v: string): string => "sha256:" + createHash("sha256").update(v).digest("hex");

const url = process.env.POSTGRES_SUPERUSER_URL;
if (!url) {
  console.error("POSTGRES_SUPERUSER_URL is required (the OWNER connection string, unpooled)");
  process.exit(2);
}

let sandbox: { tenant: string; baseUrl: string; agentId: string; agentKey: string };
try {
  sandbox = JSON.parse(readFileSync(resolve(process.cwd(), ".seed/sandbox.json"), "utf8"));
} catch {
  console.error("No .seed/sandbox.json — run scripts/provision-sandbox.ts first.");
  process.exit(2);
}

const args = process.argv.slice(2);
const revoke = args.includes("--revoke");
const list = args.includes("--list");
const who = args.filter((a) => !a.startsWith("--")).join(" ").trim();

const c = new pg.Client({ connectionString: url });
await c.connect();
try {
  if (list) {
    const r = await c.query<{ label: string; status: string; created_at: Date }>(
      "SELECT label, status, created_at FROM tenant_admin_keys WHERE tenant_id=$1 ORDER BY created_at",
      [sandbox.tenant],
    );
    console.log(`\n  keys for '${sandbox.tenant}':\n`);
    for (const row of r.rows) {
      console.log(`    ${row.status.padEnd(8)} ${row.label.padEnd(28)} ${row.created_at.toISOString().slice(0, 16)}`);
    }
    console.log("");
  } else if (revoke) {
    if (!who) throw new Error('name the person: --revoke "Monty"');
    const r = await c.query(
      "UPDATE tenant_admin_keys SET status='REVOKED', revoked_at=now() WHERE tenant_id=$1 AND label=$2 AND status='ACTIVE'",
      [sandbox.tenant, who],
    );
    console.log(r.rowCount ? `\n  revoked ${r.rowCount} key(s) for "${who}". Other links keep working.\n`
                           : `\n  no active key labelled "${who}".\n`);
  } else {
    if (!who) throw new Error('name the person: npx tsx scripts/tester-link.ts "Monty"');
    const key = `chr_ta_${randomBytes(24).toString("base64url")}`;
    await c.query("INSERT INTO tenant_admin_keys (fingerprint, tenant_id, label) VALUES ($1,$2,$3)",
      [sha(key), sandbox.tenant, who]);
    const link = `${sandbox.baseUrl}/console/#key=${key}&agent=${encodeURIComponent(`${sandbox.agentId}=${sandbox.agentKey}`)}`;
    console.log(`\n  Link for ${who} — send this and TESTING.md, nothing else:\n\n    ${link}\n`);
    console.log(`  Revoke just this one later with:\n    npx tsx scripts/tester-link.ts --revoke "${who}"\n`);
  }
} finally {
  await c.end();
}
