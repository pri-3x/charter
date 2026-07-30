import type { FastifyInstance } from "fastify";
import type { Pool } from "./db.js";
import { resolveAuth } from "./auth.js";
import { streamQuerySchema } from "./schemas.js";

/**
 * GET /v1/stream — Server-Sent Events feed of new ledger entries (admin key).
 *
 * The operator console needs verdicts to appear as they land. A POC-scale poll beats a
 * LISTEN/NOTIFY plumbing job: the ledger is a monotonic per-tenant sequence (D4), so "what is new"
 * is one integer comparison and the cursor survives a reconnect without any server-side state.
 *
 * Read-only by construction — this route never writes, so it cannot affect a verdict or the chain.
 */

const POLL_INTERVAL_MS = 750;
const HEARTBEAT_MS = 15_000;
/** Cap per poll so a large backlog trickles out instead of flooding the socket in one write. */
const MAX_BATCH = 200;

export interface StreamDeps {
  pool: Pool;
  adminKey: string;
}

export function registerStreamRoute(app: FastifyInstance, deps: StreamDeps): void {
  const { pool, adminKey } = deps;

  app.get<{ Querystring: { tenant?: string; from_seq?: string } }>(
    "/v1/stream",
    async (req, reply) => {
      const auth = await resolveAuth(pool, req.headers.authorization, adminKey);
      if (auth.kind !== "admin") return reply.code(401).send({ error: "unauthorized" });

      const parsed = streamQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid request", details: parsed.error.issues });
      }
      const { tenant, from_seq } = parsed.data;

      // Resolve the cursor BEFORE hijacking the socket: a DB failure here is still a clean 5xx
      // rather than a half-open stream that silently never delivers anything (fail closed).
      let cursor: number;
      if (from_seq !== undefined) {
        cursor = from_seq - 1; // from_seq is inclusive, matching GET /v1/ledger
      } else {
        const { rows } = await pool.query<{ s: string | null }>(
          "SELECT MAX(seq) AS s FROM ledger_entries WHERE tenant_id = $1",
          [tenant],
        );
        cursor = Number(rows[0]?.s ?? 0);
      }

      // Take the socket over: Fastify must not try to serialize or terminate this response.
      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      let closed = false;
      let polling = false;

      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(pollTimer);
        clearInterval(heartbeatTimer);
        try {
          raw.end();
        } catch {
          // socket already gone — nothing left to release
        }
      };

      /** Write to the socket, treating any failure as "the client is gone" and tearing down. */
      const send = (chunk: string): boolean => {
        if (closed) return false;
        try {
          raw.write(chunk);
          return true;
        } catch {
          cleanup();
          return false;
        }
      };

      send(`: charter stream tenant=${tenant} from_seq=${cursor + 1}\n\n`);

      const poll = async (): Promise<void> => {
        if (closed || polling) return; // never let two polls race the cursor
        polling = true;
        try {
          const { rows } = await pool.query<{ seq: string; payload: unknown }>(
            `SELECT seq, payload FROM ledger_entries
              WHERE tenant_id = $1 AND seq > $2
              ORDER BY seq ASC
              LIMIT $3`,
            [tenant, cursor, MAX_BATCH],
          );
          for (const row of rows) {
            if (closed) return;
            const seq = Number(row.seq);
            // `id:` lets a reconnecting client resume with Last-Event-ID / from_seq.
            if (!send(`id: ${seq}\nevent: entry\ndata: ${JSON.stringify(row.payload)}\n\n`)) return;
            cursor = seq;
          }
        } catch (err) {
          req.log.error({ err, tenant }, "ledger stream poll failed");
          if (!closed) {
            send(`event: error\ndata: {"error":"stream poll failed"}\n\n`);
            cleanup();
          }
        } finally {
          polling = false;
        }
      };

      const pollTimer = setInterval(() => void poll(), POLL_INTERVAL_MS);
      const heartbeatTimer = setInterval(() => {
        send(": heartbeat\n\n");
      }, HEARTBEAT_MS);
      // Unref so an open stream can never hold the process (or a test run) alive on its own.
      pollTimer.unref();
      heartbeatTimer.unref();

      req.raw.on("close", cleanup);
      req.raw.on("error", cleanup);
      raw.on("error", cleanup);

      // Deliver anything already waiting immediately rather than after the first tick.
      void poll();
    },
  );
}
