import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ulid } from "ulid";
import { jcsHashToken } from "@charter/shared";
import type { Pool } from "../db.js";
import { resolveAuth } from "../auth.js";
import { appendEntry } from "../ledger.js";
import {
  registerCredential, revokeCredential, listCredentials, loadCredential,
  CredentialNotFoundError,
} from "./store.js";
import { callTool, assertSafeEndpoint, EgressConfigError } from "./egress.js";
import { CredentialKeyError } from "./crypto.js";

/**
 * Pattern B routes (SPEC §7, D1): credential custody and the authorizing proxy.
 *
 * Under Pattern A the agent holds the tool function and therefore the secret, so the gate is
 * advisory — TEST_PLAN A4 exists to show that an agent which never calls Charter is not governed by
 * it. Here the secret lives behind the gate. The agent sends a tool NAME and params; Charter
 * evaluates the action through the *same* /v1/actions/check route (re-entered in process, so there
 * is one implementation of authority, policy, limits, holds and the ledger), and only then makes the
 * outbound call itself.
 *
 * The bypass does not become "logged". It becomes impossible: the agent has no credential to bypass
 * Charter with.
 *
 *   POST /v1/credentials            (admin) register or rotate a tool's secret
 *   GET  /v1/credentials            (admin) list descriptors — fingerprints only, never secrets
 *   POST /v1/credentials/:tool/revoke (admin)
 *   POST /v1/proxy/:tool            (agent) check, then execute if ALLOW
 *   POST /v1/proxy/resume           (agent) execute a hold that a human has since APPROVED
 */

const registerSchema = z.object({
  tenant: z.string().min(1).optional(),
  tool: z.string().min(1),
  endpoint_url: z.string().min(1),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("POST"),
  auth_scheme: z.enum(["bearer", "header", "basic"]),
  auth_header: z.string().min(1).optional(),
  secret: z.string().min(1),
  by_principal: z.string().min(1),
}).strict().superRefine((v, ctx) => {
  if (v.auth_scheme === "header" && !v.auth_header) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["auth_header"],
      message: "auth_scheme 'header' requires auth_header" });
  }
});

/**
 * What a caller may say. Deliberately NOT here: url, method, headers, or anything else that could
 * steer where the credential goes. The caller names a tool; the admin decided long ago what that
 * tool means.
 */
const proxySchema = z.object({
  params: z.record(z.unknown()).default({}),
  principal: z.string().min(1),
  context: z.object({
    reasoning: z.string().optional(),
    conversation_ref: z.string().optional(),
  }).optional(),
}).strict();

const resumeSchema = z.object({ hold_id: z.string().min(1) }).strict();

export interface CredentialDeps {
  pool: Pool;
  adminKey: string;
  /** AES key for sealing secrets. Absent ⇒ the routes report 503, never a guess. */
  credentialKey?: Buffer | undefined;
  /** Dev/test only: permit http://localhost egress targets. */
  allowLoopbackEgress?: boolean | undefined;
  defaultTenant: string;
}

export function registerCredentialRoutes(app: FastifyInstance, deps: CredentialDeps): void {
  const { pool, adminKey, credentialKey, defaultTenant } = deps;
  const allowLoopback = deps.allowLoopbackEgress ?? false;

  /** Custody is unavailable rather than half-working when no key is configured. */
  const needKey = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => {
    if (credentialKey) return null;
    return reply.code(503).send({
      error: "credential custody is not configured on this deployment (CHARTER_CREDENTIAL_KEY unset)",
    });
  };

  // ---- POST /v1/credentials (admin) — register or rotate --------------------------------------
  app.post("/v1/credentials", async (req, reply) => {
    const auth = await resolveAuth(pool, req.headers.authorization, adminKey);
    if (auth.kind !== "admin") return reply.code(401).send({ error: "unauthorized" });
    const blocked = needKey(reply);
    if (blocked) return blocked;

    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid request", details: parsed.error.issues });
    }
    const b = parsed.data;
    // Validate the destination in front of the human installing it, not at 3am on the first payment.
    try {
      assertSafeEndpoint(b.endpoint_url, allowLoopback);
    } catch (err) {
      if (err instanceof EgressConfigError) return reply.code(400).send({ error: err.message });
      throw err;
    }

    const out = await registerCredential(pool, credentialKey!, {
      tenant: b.tenant ?? defaultTenant,
      tool: b.tool,
      endpointUrl: b.endpoint_url,
      method: b.method,
      authScheme: b.auth_scheme,
      authHeader: b.auth_header,
      secret: b.secret,
      byPrincipal: b.by_principal,
    });
    // The response echoes the fingerprint, never the secret — including on the request that set it.
    return reply.code(200).send({
      tool: b.tool,
      key_fingerprint: out.fingerprint,
      rotated: out.rotated,
      entry_id: out.entryId,
    });
  });

  // ---- GET /v1/credentials (admin) ------------------------------------------------------------
  app.get<{ Querystring: { tenant?: string } }>("/v1/credentials", async (req, reply) => {
    const auth = await resolveAuth(pool, req.headers.authorization, adminKey);
    if (auth.kind !== "admin") return reply.code(401).send({ error: "unauthorized" });
    const creds = await listCredentials(pool, req.query.tenant ?? defaultTenant);
    return reply.code(200).send({
      credentials: creds.map((c) => ({
        tool: c.tool,
        endpoint_url: c.endpointUrl,
        method: c.method,
        auth_scheme: c.authScheme,
        ...(c.authHeader ? { auth_header: c.authHeader } : {}),
        key_fingerprint: c.fingerprint,
        status: c.status,
      })),
    });
  });

  // ---- POST /v1/credentials/:tool/revoke (admin) ----------------------------------------------
  app.post<{ Params: { tool: string }; Body: { by_principal?: string } }>(
    "/v1/credentials/:tool/revoke",
    async (req, reply) => {
      const auth = await resolveAuth(pool, req.headers.authorization, adminKey);
      if (auth.kind !== "admin") return reply.code(401).send({ error: "unauthorized" });
      const by = req.body?.by_principal;
      if (!by) return reply.code(400).send({ error: "by_principal is required" });
      const out = await revokeCredential(pool, {
        tenant: defaultTenant,
        tool: req.params.tool,
        byPrincipal: by,
      });
      if (!out) return reply.code(404).send({ error: "no active credential for that tool" });
      return reply.code(200).send({ tool: req.params.tool, status: "REVOKED", entry_id: out.entryId });
    },
  );

  /**
   * Execute an authorized action and record the OUTCOME.
   *
   * `params` here must be the params the gate actually evaluated — supplied by the caller on the
   * ALLOW path (where the verdict was computed from them moments ago) and read back from the
   * immutable ledger entry on the resume path. Never re-read from the caller after an approval.
   */
  async function executeAndRecord(
    tenant: string,
    tool: string,
    verdictEntryId: string,
    params: Record<string, unknown>,
    log: { info: (o: object, m: string) => void },
  ) {
    let cred;
    try {
      cred = await loadCredential(pool, credentialKey!, tenant, tool);
    } catch (err) {
      if (err instanceof CredentialNotFoundError) return { http: 409 as const, body: { error: err.message } };
      throw err;
    }

    let result;
    try {
      result = await callTool(cred, params, { allowLoopback });
    } catch (err) {
      // The call could not be made. Record it as a FAILURE outcome so the ledger does not simply
      // stop after an ALLOW with no account of what happened.
      const msg = err instanceof Error ? err.message : String(err);
      await writeOutcome(tenant, verdictEntryId, "FAILURE", { error: msg.slice(0, 500) });
      if (err instanceof EgressConfigError) return { http: 502 as const, body: { error: msg } };
      return { http: 502 as const, body: { error: "the tool call could not be completed" } };
    }

    const outcomeId = await writeOutcome(
      tenant,
      verdictEntryId,
      result.ok ? "SUCCESS" : "FAILURE",
      { upstream_status: result.status, body: result.body, duration_ms: result.duration_ms },
    );

    log.info(
      {
        tenant, tool, verdict_entry_id: verdictEntryId, outcome_entry_id: outcomeId,
        upstream_status: result.status, key_fingerprint: cred.fingerprint,
        egress_ms: result.duration_ms,
      },
      "proxy executed",
    );

    return {
      http: 200 as const,
      body: {
        verdict: "ALLOW",
        entry_id: verdictEntryId,
        outcome_entry_id: outcomeId,
        tool_status: result.status,
        tool_response: result.body,
      },
    };
  }

  /** OUTCOME entries are written here rather than by the agent — under Pattern B the gate is the
   *  only party that knows what actually happened, so the agent cannot mis-report it. */
  async function writeOutcome(
    tenant: string,
    verdictEntryId: string,
    status: "SUCCESS" | "FAILURE",
    detail: Record<string, unknown>,
  ): Promise<string> {
    const outcomeId = ulid();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await appendEntry(client, {
        tenant,
        kind: "OUTCOME",
        entryId: outcomeId,
        body: {
          verdict_entry_id: verdictEntryId,
          status,
          result_hash: jcsHashToken(detail),
          via: "proxy", // distinguishes a gate-observed outcome from an agent-reported one
          // Nested, never spread: `detail` carries the upstream's own `status` (an HTTP code), and
          // spreading it at this level silently overwrote the SUCCESS/FAILURE that every other
          // OUTCOME consumer reads. Same field name, entirely different meaning.
          egress: detail,
        },
      });
      await client.query("COMMIT");
      return outcomeId;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  // ---- POST /v1/proxy/:tool (agent) -----------------------------------------------------------
  app.post<{ Params: { tool: string } }>("/v1/proxy/:tool", async (req, reply) => {
    const auth = await resolveAuth(pool, req.headers.authorization, adminKey);
    if (auth.kind !== "agent") return reply.code(401).send({ error: "unauthorized" });
    const blocked = needKey(reply);
    if (blocked) return blocked;

    const idem = req.headers["idempotency-key"];
    if (typeof idem !== "string" || idem.trim() === "") {
      return reply.code(400).send({ error: "Idempotency-Key header is required" });
    }
    const parsed = proxySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid request", details: parsed.error.issues });
    }
    const { params, principal, context } = parsed.data;
    const tool = req.params.tool;
    const tenant = auth.agent.tenant_id;

    // Re-enter the real check route in process rather than reimplementing it: same auth, same
    // registry and authority stage, same policy engine, same limits, same holds, same ledger
    // transaction. A proxy verdict is not a second opinion — it IS the verdict.
    const res = await app.inject({
      method: "POST",
      url: "/v1/actions/check",
      headers: {
        "content-type": "application/json",
        authorization: req.headers.authorization!,
        "idempotency-key": idem,
      },
      payload: { tool, params, principal, ...(context ? { context } : {}) },
    });
    if (res.statusCode !== 200) {
      return reply.code(res.statusCode).send(res.json());
    }
    const verdict = res.json() as {
      verdict: "ALLOW" | "DENY" | "ESCALATE";
      entry_id: string; rule_id: string; reason?: string;
      hold_id?: string; ttl_minutes?: number;
    };

    // DENY and ESCALATE do not touch the credential at all. Under Pattern A this is where the agent
    // could have simply called the tool anyway; here there is nothing for it to call with.
    if (verdict.verdict !== "ALLOW") return reply.code(200).send(verdict);

    const out = await executeAndRecord(tenant, tool, verdict.entry_id, params, req.log);
    return reply.code(out.http).send({ ...out.body, rule_id: verdict.rule_id });
  });

  // ---- POST /v1/proxy/resume (agent) ----------------------------------------------------------
  app.post("/v1/proxy/resume", async (req, reply) => {
    const auth = await resolveAuth(pool, req.headers.authorization, adminKey);
    if (auth.kind !== "agent") return reply.code(401).send({ error: "unauthorized" });
    const blocked = needKey(reply);
    if (blocked) return blocked;

    const parsed = resumeSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid request", details: parsed.error.issues });
    }
    const tenant = auth.agent.tenant_id;

    const hold = await pool.query<{ status: string; verdict_entry_id: string }>(
      "SELECT status, verdict_entry_id FROM holds WHERE id = $1 AND tenant_id = $2",
      [parsed.data.hold_id, tenant],
    );
    if (hold.rowCount === 0) return reply.code(404).send({ error: "hold not found" });
    const h = hold.rows[0]!;
    if (h.status !== "APPROVED") {
      // Fail closed on PENDING as well as REJECTED/EXPIRED: "not yet approved" must never execute.
      return reply.code(409).send({ error: `hold is ${h.status}, not APPROVED` });
    }

    const entry = await pool.query<{
      payload: { agent?: { id?: string }; action?: { tool?: string; params?: Record<string, unknown> } };
    }>(
      "SELECT payload FROM ledger_entries WHERE tenant_id = $1 AND entry_id = $2 AND kind = 'VERDICT'",
      [tenant, h.verdict_entry_id],
    );
    if (entry.rowCount === 0) return reply.code(404).send({ error: "verdict entry not found" });
    const payload = entry.rows[0]!.payload;
    if (payload.agent?.id !== auth.agent.id) {
      return reply.code(403).send({ error: "that hold belongs to a different agent" });
    }

    // Executing exactly once is what makes an approval an approval.
    const already = await pool.query(
      "SELECT 1 FROM ledger_entries WHERE tenant_id = $1 AND kind = 'OUTCOME' AND payload->>'verdict_entry_id' = $2",
      [tenant, h.verdict_entry_id],
    );
    if ((already.rowCount ?? 0) > 0) {
      return reply.code(409).send({ error: "this approval has already been executed" });
    }

    // THE point of this endpoint: the params come from the immutable ledger entry, not from the
    // caller. Otherwise an agent could get ₹500 approved by a human and then execute ₹500,000.
    const tool = payload.action?.tool;
    const params = payload.action?.params;
    if (!tool || !params) return reply.code(500).send({ error: "verdict entry is missing its action" });

    const out = await executeAndRecord(tenant, tool, h.verdict_entry_id, params, req.log);
    return reply.code(out.http).send(out.body);
  });
}

export { CredentialKeyError };
