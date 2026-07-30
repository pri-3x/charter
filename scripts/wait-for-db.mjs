// Waits for Postgres to genuinely accept queries from the host. Used by db:up / db:reset.
//
// `pg_isready` alone is not enough: the official image reports ready during its init phase and then
// restarts to apply configuration, so a client connecting in that window gets ECONNRESET — which
// surfaced as a random `db:reset` failure right before an integration run. So do the check that
// actually proves the server is usable: connect from the host and run a query, twice.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Client } from "pg";

// This script runs under plain node, before tsx is involved, so it reads .env itself rather than
// importing the workspace's TypeScript env helper.
function envValue(key) {
  if (process.env[key]) return process.env[key];
  try {
    const line = readFileSync(new URL("../.env", import.meta.url), "utf8")
      .split("\n")
      .find((l) => l.startsWith(key + "="));
    return line ? line.slice(key.length + 1).trim() : undefined;
  } catch {
    return undefined;
  }
}

const URL_ =
  envValue("POSTGRES_SUPERUSER_URL") ?? "postgres://postgres:postgres@localhost:5433/mandate";
const RETRIES = 40;

async function queryable() {
  const client = new Client({ connectionString: URL_, connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
    await client.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

for (let i = 1; i <= RETRIES; i++) {
  let socketUp = false;
  try {
    execSync("docker compose exec -T postgres pg_isready -U postgres -d mandate", {
      stdio: "ignore",
    });
    socketUp = true;
  } catch {
    socketUp = false;
  }

  // Two consecutive successful host queries: the first can still land inside the init window.
  if (socketUp && (await queryable()) && (await queryable())) {
    console.log("postgres is ready");
    process.exit(0);
  }
  if (i === RETRIES) {
    console.error("postgres did not become ready in time");
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 700));
}
