import { buildApp } from "./app.js";
import { makePool } from "./db.js";
import type { Pool } from "./db.js";
import { expireHolds } from "./holds-resolve.js";
import { signerFromPem, createPendingCheckpoint } from "./checkpoint.js";
import type { FastifyInstance } from "fastify";

/**
 * Serverless adapter for the gate.
 *
 * The long-running server (server.ts) owns two setInterval workers — the D9 hold-expiry sweeper and
 * the Merkle checkpoint worker. Neither can exist here: a function only runs while a request is in
 * flight. They become scheduled HTTP calls instead, which is why sweepHolds() and sealCheckpoint()
 * are exported for a cron route to call rather than started on a timer.
 *
 * That is a real behavioural difference and worth naming rather than hiding: on this host a hold's
 * TTL is enforced to schedule granularity, not to the 30 seconds the long-running server manages.
 *
 * There is also no writable filesystem, so the out-of-band anchors log (D5) does not exist here. The
 * attestation pack reports it as absent, which is honest — the signed checkpoints in the database
 * are still there; only the second, off-database copy of them is missing.
 */

const TENANT = process.env.CHARTER_TENANT ?? "acme-fintech";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

/**
 * One app and one pool per warm instance. Building either per request would exhaust the database's
 * connection limit under any real concurrency, which is the classic way a serverless Postgres app
 * falls over.
 */
let pool: Pool | undefined;
let cached: Promise<FastifyInstance> | undefined;

function getPool(): Pool {
  if (!pool) pool = makePool(requireEnv("DATABASE_URL"));
  return pool;
}

export function getApp(): Promise<FastifyInstance> {
  if (!cached) {
    cached = (async () => {
      const app = await buildApp({
        pool: getPool(),
        adminKey: requireEnv("CHARTER_ADMIN_KEY"),
        ...(process.env.CHARTER_DEMO_AGENT_KEY
          ? { demoAgentKey: process.env.CHARTER_DEMO_AGENT_KEY }
          : {}),
        demoTenant: TENANT,
      });
      await app.ready();
      return app;
    })();
  }
  return cached;
}

/** Hand the raw Node request to Fastify's own server. */
export async function handler(req: unknown, res: unknown): Promise<void> {
  const app = await getApp();
  app.server.emit("request", req, res);
}

/** Cron: resolve holds past their TTL (D9). Returns how many were expired. */
export async function sweepHolds(): Promise<number> {
  return expireHolds(getPool());
}

/** Cron: seal un-checkpointed entries into one signed Merkle checkpoint (SPEC 4.3, D5). */
export async function sealCheckpoint(): Promise<{
  sealed: boolean;
  reason?: string;
  seq_from?: number;
  seq_to?: number;
}> {
  const pem = process.env.CHARTER_SIGNING_KEY_PEM;
  // Fail loudly rather than silently never sealing: a deployment without the key has no tamper
  // evidence over ranges, and that should be visible in the cron response.
  if (!pem) return { sealed: false, reason: "CHARTER_SIGNING_KEY_PEM is not set" };
  const cp = await createPendingCheckpoint(getPool(), signerFromPem(pem), TENANT);
  return cp ? { sealed: true, seq_from: cp.seq_from, seq_to: cp.seq_to } : { sealed: false, reason: "nothing pending" };
}
