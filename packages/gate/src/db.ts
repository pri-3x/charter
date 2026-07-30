import pg from "pg";

const { Pool } = pg;
export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

/**
 * Build a connection pool for the gate role. Short connection/statement timeouts so that a stalled
 * or unreachable DB fails the request fast (fail closed) rather than hanging the agent.
 */
export function makePool(connectionString: string): Pool {
  const pool = new Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 30_000,
    // statement_timeout guards against a wedged transaction holding the per-tenant seq lock.
    statement_timeout: 5000,
  });

  /*
   * Postgres can drop an IDLE pooled connection at any time — a restart, a failover, an admin
   * `pg_terminate_backend`, or a `docker compose down` in development. `pg` emits that as an 'error'
   * event on the pool, and an unhandled 'error' event terminates the Node process.
   *
   * Crashing is the wrong failure mode here. Fail closed means "the action does not proceed", not
   * "the gate disappears": a dead gate cannot deny anything, cannot serve /healthz 503, and cannot
   * write the evidence that the action was refused. So the error is swallowed deliberately — the
   * broken client is already removed from the pool by `pg`, the next request opens a fresh one, and
   * /healthz reports 503 for as long as the database is genuinely unreachable (TEST_PLAN S18).
   */
  pool.on("error", (err) => {
    // stderr, not the request logger: this fires outside any request context.
    console.error(
      `[gate] idle postgres client error (pool recovers, requests fail closed): ${err.message}`,
    );
  });

  return pool;
}

/** True if the pool can reach Postgres right now. Used by /healthz. */
export async function dbReachable(pool: Pool): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}
