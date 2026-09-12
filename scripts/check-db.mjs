/**
 * `node scripts/check-db.mjs` — is a database ready to run Charter against?
 *
 * Written for the managed-Postgres setup, where the usual failure is not an error but a *silent
 * success*: migrations applied as the owner, the app then connecting as that same owner, and the
 * append-only guarantee quietly gone because the role it depends on was never the one in use. So
 * this does not just check that things exist — it checks that the gate role is actually POWERLESS
 * where it is supposed to be.
 *
 *   POSTGRES_SUPERUSER_URL=...  (owner)       structural checks: migrations, tables, seed
 *   DATABASE_URL=...            (charter_gate) privilege checks: what the gate may and may not do
 *
 * Either may be omitted; whatever is present gets checked. Nothing here writes to the ledger, and
 * no connection string or password is ever printed.
 */
import pg from "pg";

const ok = (m) => console.log(`  \x1b[32m✔\x1b[0m ${m}`);
const bad = (m) => console.log(`  \x1b[31m✘\x1b[0m ${m}`);
const warn = (m) => console.log(`  \x1b[33m!\x1b[0m ${m}`);
let failures = 0;
const fail = (m) => { failures++; bad(m); };

/** Never let a DSN (and its password) reach the terminal. */
const where = (u) => {
  try { const p = new URL(u); return `${p.hostname}${p.pathname}`; } catch { return "(unparseable URL)"; }
};

async function connect(url, label) {
  const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 15000 });
  try {
    await c.connect();
    const who = await c.query("SELECT current_user, current_database()");
    ok(`${label}: connected to ${where(url)} as ${who.rows[0].current_user}`);
    return c;
  } catch (e) {
    fail(`${label}: could not connect to ${where(url)} — ${e.message}`);
    return null;
  }
}

const OWNER = process.env.POSTGRES_SUPERUSER_URL;
const GATE = process.env.DATABASE_URL;
if (!OWNER && !GATE) {
  console.error("set POSTGRES_SUPERUSER_URL and/or DATABASE_URL");
  process.exit(2);
}

console.log("\n\x1b[1mcharter db check\x1b[0m\n");

// ---- structure, as the owner ----------------------------------------------------------------
if (OWNER) {
  const c = await connect(OWNER, "owner");
  if (c) {
    const mig = await c.query("SELECT name FROM _migrations ORDER BY name").catch(() => null);
    if (!mig) fail("_migrations table is absent — migrations have not run");
    else {
      ok(`migrations applied: ${mig.rows.map((r) => r.name).join(", ")}`);
      for (const need of ["0001", "0002", "0003"]) {
        if (!mig.rows.some((r) => r.name.startsWith(need))) fail(`migration ${need}* has not been applied`);
      }
    }

    const tables = await c.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' ORDER BY table_name`,
    );
    const names = tables.rows.map((r) => r.table_name);
    for (const t of ["tenants", "agents", "policies", "ledger_entries", "ledger_seq",
                     "checkpoints", "holds", "authorities", "tool_credentials"]) {
      names.includes(t) ? ok(`table ${t}`) : fail(`table ${t} is missing`);
    }

    // Seed: a tenant, an ACTIVE policy, at least one agent, and a ledger_seq row (without which
    // appendEntry throws on the very first verdict).
    const t = await c.query("SELECT id FROM tenants");
    t.rowCount ? ok(`tenant(s): ${t.rows.map((r) => r.id).join(", ")}`) : fail("no tenant rows — seed has not run");

    const pol = await c.query("SELECT tenant_id, version FROM policies WHERE status = 'active'");
    pol.rowCount
      ? ok(`active policy: v${pol.rows[0].version} for ${pol.rows[0].tenant_id}`)
      : fail("no ACTIVE policy — the gate fails closed on every call without one");

    const ag = await c.query("SELECT id, status FROM agents");
    ag.rowCount ? ok(`agents: ${ag.rows.map((r) => `${r.id}(${r.status})`).join(", ")}`)
                : fail("no agents — seed has not run");

    const seq = await c.query("SELECT tenant_id, last_seq FROM ledger_seq");
    seq.rowCount ? ok(`ledger_seq present (head ${seq.rows[0].last_seq})`)
                 : fail("no ledger_seq row — appendEntry throws without one");

    const roles = await c.query(
      "SELECT rolname FROM pg_roles WHERE rolname IN ('charter_gate','charter_verifier')",
    );
    const rn = roles.rows.map((r) => r.rolname);
    for (const r of ["charter_gate", "charter_verifier"]) {
      rn.includes(r) ? ok(`role ${r} exists`) : fail(`role ${r} does not exist`);
    }
    await c.end();
  }
}

// ---- privileges, as the gate ------------------------------------------------------------------
if (GATE) {
  console.log("");
  const c = await connect(GATE, "gate");
  if (c) {
    const who = (await c.query("SELECT current_user")).rows[0].current_user;
    if (who !== "charter_gate") {
      fail(`DATABASE_URL connects as '${who}', not charter_gate — the ledger's append-only ` +
           `guarantee comes from that role's missing privileges, so this throws it away`);
    } else ok("DATABASE_URL uses the charter_gate role");

    // It must be able to read and to append.
    await c.query("SELECT count(*) FROM ledger_entries")
      .then(() => ok("can SELECT ledger_entries"))
      .catch((e) => fail(`cannot SELECT ledger_entries — ${e.message}`));

    // And it must NOT be able to rewrite history. Rolled back either way.
    for (const [sql, verb] of [
      ["DELETE FROM ledger_entries", "DELETE"],
      ["UPDATE ledger_entries SET seq = seq", "UPDATE"],
    ]) {
      await c.query("BEGIN");
      try {
        await c.query(sql);
        fail(`gate role CAN ${verb} ledger_entries — the ledger is not append-only`);
      } catch {
        ok(`gate role cannot ${verb} ledger_entries`);
      }
      await c.query("ROLLBACK").catch(() => {});
    }
    await c.end();
  }
}

console.log("");
if (failures) { console.log(`\x1b[31m${failures} problem(s) — not ready\x1b[0m\n`); process.exit(1); }
console.log("\x1b[32mready\x1b[0m\n");
