import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import Fastify from "fastify";
import type { FastifyInstance, FastifyError, FastifyReply, FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import { registerRoutes } from "./routes.js";
import { registerDemoRoutes } from "./demo.js";
import { registerCredentialRoutes } from "./credentials/routes.js";
import { registerMcpRoutes } from "./mcp/routes.js";
import { PolicyStore } from "./policy/store.js";
import type { Pool } from "./db.js";

/** Logger redaction paths — never let raw action params reach the logs (CLAUDE.md / D12). */
const REDACT_PATHS = [
  "params", "*.params", "action.params", "req.headers.authorization",
  // Pattern B: the register/rotate body carries a live tool credential, and an error log of a
  // failed registration is exactly where one would otherwise end up in plaintext, forever.
  "secret", "*.secret", "body.secret", "req.body.secret",
];

export interface BuildDeps {
  pool: Pool;
  adminKey: string;
  /** Out-of-band checkpoint record (D5), read by the attestation pack. Defaults to env / ./anchors.log. */
  anchorsLogPath?: string;
  /**
   * Agent key the public demo endpoints act as. Supplying it is what turns those endpoints on; with
   * it absent they report 503 rather than falling back to anything. Never the admin key.
   */
  demoAgentKey?: string;
  /** Tenant the demo reads. Defaults to the single-tenant POC tenant. */
  demoTenant?: string;
  /**
   * AES-256 key (raw bytes) sealing Pattern B tool credentials. Absent ⇒ /v1/credentials and
   * /v1/proxy answer 503. Never defaulted or generated: a gate that invents a key at boot encrypts
   * happily and then cannot decrypt anything after a restart.
   */
  credentialKey?: Buffer;
  /** Dev/test only: permit http://localhost egress targets. */
  allowLoopbackEgress?: boolean;
}

/**
 * Build the gate Fastify app with injected dependencies (pool, admin key). Kept dependency-injected
 * so integration tests can point it at a test DB — or a deliberately unreachable one (S18). The
 * per-tenant active-policy cache lives on the returned app instance (one PolicyStore per app).
 */
export async function buildApp(
  deps: BuildDeps,
  opts: { logger?: boolean } = {},
): Promise<FastifyInstance> {
  const loggerEnabled = opts.logger !== false;
  const app = Fastify({
    logger: loggerEnabled
      ? { level: process.env.LOG_LEVEL ?? "info", redact: { paths: REDACT_PATHS, censor: "[redacted]" } }
      : false,
    bodyLimit: 1_000_000,
  });

  // Normalize errors: malformed JSON / oversized body / zod → 4xx; unexpected → 500 (fail closed).
  app.setErrorHandler((err: FastifyError, req: FastifyRequest, reply: FastifyReply) => {
    const statusCode = err.statusCode ?? 500;
    if (statusCode >= 500) {
      req.log.error({ err }, "request failed");
      return reply.code(500).send({ error: "internal error" });
    }
    return reply.code(statusCode).send({ error: err.message, details: err.validation });
  });

  // Serve the operator console (static, same-origin → no CORS) if present. Out of the POC's core
  // scope but an explicit extra; isolated to the /console/ prefix.
  const consoleRoot = fileURLToPath(new URL("../../console/public", import.meta.url));
  if (existsSync(consoleRoot)) {
    await app.register(fastifyStatic, {
      root: consoleRoot,
      prefix: "/console/",
      cacheControl: false,
    });
    // The console has no build step and no content-hashed filenames, so a cached charter.js silently
    // runs against newer HTML — the page half-works and the cause is invisible. Revalidate always.
    app.addHook("onSend", async (req, reply) => {
      if (req.url.startsWith("/console/") || req.url === "/") {
        reply.header("Cache-Control", "no-store, must-revalidate");
      }
    });
    // Landing page at the root; the operator console SPA lives under /console/.
    app.get("/", async (_req, reply) => reply.sendFile("landing.html"));
  }

  const store = new PolicyStore(deps.pool);
  registerRoutes(app, {
    pool: deps.pool,
    adminKey: deps.adminKey,
    store,
    ...(deps.anchorsLogPath ? { anchorsLogPath: deps.anchorsLogPath } : {}),
  });

  // Public, credential-free demo endpoints. Registered unconditionally so the routes exist and can
  // answer honestly; without a demo agent key they return 503 rather than 404, which distinguishes
  // "not configured here" from "no such endpoint".
  registerDemoRoutes(app, {
    pool: deps.pool,
    adminKey: deps.adminKey,
    ...(deps.demoAgentKey ? { demoAgentKey: deps.demoAgentKey } : {}),
    tenant: deps.demoTenant ?? "acme-fintech",
  });

  // Pattern B (credential custody). Registered unconditionally for the same reason as the demo
  // routes: without a key they answer 503, so "not configured here" is distinguishable from
  // "this build does not have it".
  registerCredentialRoutes(app, {
    pool: deps.pool,
    adminKey: deps.adminKey,
    ...(deps.credentialKey ? { credentialKey: deps.credentialKey } : {}),
    ...(deps.allowLoopbackEgress ? { allowLoopbackEgress: deps.allowLoopbackEgress } : {}),
    defaultTenant: deps.demoTenant ?? "acme-fintech",
  });

  // MCP. Registered unconditionally so a client gets a protocol-shaped answer either way; without
  // custody configured tools/list is simply empty, because a tool Charter holds no credential for
  // is one it cannot carry out.
  registerMcpRoutes(app, {
    pool: deps.pool,
    adminKey: deps.adminKey,
    custodyEnabled: Boolean(deps.credentialKey),
  });
  return app;
}
