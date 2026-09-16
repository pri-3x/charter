import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { ulid } from "ulid";
import { jcsHashToken } from "@charter/shared";
import type { Pool } from "./db.js";
import { dbReachable } from "./db.js";
import { resolveAuth } from "./auth.js";
import type { AgentRow } from "./auth.js";
import { appendEntry } from "./ledger.js";
import {
  checkBodySchema,
  resultBodySchema,
  policyCreateSchema,
  decisionBodySchema,
} from "./schemas.js";
import { PolicyStore } from "./policy/store.js";
import { matchRules, resolveVerdict } from "./policy/evaluate.js";
import type { EvalResult } from "./policy/evaluate.js";
import { fetchUsages, applyConsumption } from "./policy/limits.js";
import { createHold } from "./policy/holds.js";
import { createDraft, activateDraft, DraftNotFoundError } from "./policy/activate.js";
import { PolicyValidationError } from "./policy/schema.js";
import { PolicyCoverageError } from "./policy/coverage.js";
import { decideHold } from "./holds-resolve.js";
import { suspendAgent } from "./suspend.js";
import { leafFromEntryHash, merkleRootHex, merkleProof } from "./merkle.js";
import {
  loadCharter,
  listRegistry,
  listAuthorities,
  registerAgent,
  grantAuthority,
  revokeAuthority,
  reinstateAgent,
} from "./registry/store.js";
import { evaluateAuthority, fetchAuthoritySpend } from "./registry/authority.js";
import type { AuthorityDecision } from "./registry/authority.js";
import {
  registerAgentSchema,
  grantAuthoritySchema,
  revokeSchema,
  attestationQuerySchema,
  DEFAULT_TENANT,
} from "./schemas.js";
import {
  buildAttestationPack,
  renderAttestationHtml,
  TenantNotFoundError,
} from "./attestation/index.js";
import { registerStreamRoute } from "./stream.js";
import { pinTenant } from "./tenant-scope.js";
import { randomBytes } from "node:crypto";
import { sha256Token } from "@charter/shared";

export interface Deps {
  pool: Pool;
  adminKey: string;
  store: PolicyStore;
  /** Out-of-band checkpoint record (D5); read by the attestation pack. Defaults to env/./anchors.log. */
  anchorsLogPath?: string;
}

const UNIQUE_VIOLATION = "23505";

/** Fail-closed evaluation result used when a tenant has no active policy (never default-allow). */
const NO_POLICY_RESULT: EvalResult = {
  verdict: "DENY",
  rule_id: "no_active_policy",
  reason: "no active policy for tenant",
  rule_trace: { scope_ok: false, cap_applied: false, rules: [] },
  cap_applied: false,
  consume: [],
  deferred_consume: [],
};

/** Fail-closed result for a suspended agent (D15): every check denies before policy is consulted. */
const SUSPENDED_RESULT: EvalResult = {
  verdict: "DENY",
  rule_id: "agent_suspended",
  reason: "agent suspended",
  rule_trace: { scope_ok: false, cap_applied: false, rules: [] },
  cap_applied: false,
  consume: [],
  deferred_consume: [],
};

/** Fail-closed result for a key that authenticates but has no registry charter (D16). */
const UNCHARTERED_RESULT: EvalResult = {
  verdict: "DENY",
  rule_id: "charter.missing",
  reason: "agent is not present in the registry",
  rule_trace: { scope_ok: false, cap_applied: false, rules: [] },
  cap_applied: false,
  consume: [],
  deferred_consume: [],
};

/**
 * Fold the authority decision into the policy result. The grant can only ever TIGHTEN (D17): when it
 * denies, the action dies here; when it permits, its budget spend joins the consumption plan under
 * the same ALLOW-consumes / ESCALATE-defers discipline as policy limits (D8).
 */
function applyAuthority(result: EvalResult, decision: AuthorityDecision): EvalResult {
  if (decision.deny) {
    // Already DENY on policy grounds → keep the policy's rule_id (the authority finding is still in
    // the trace, so the evidence shows both reasons). Otherwise the grant sets the verdict.
    if (result.verdict === "DENY") {
      return { ...result, consume: [], deferred_consume: [] };
    }
    return {
      verdict: "DENY",
      rule_id: decision.deny.rule_id,
      reason: decision.deny.reason,
      rule_trace: result.rule_trace,
      cap_applied: result.cap_applied,
      consume: [],
      deferred_consume: [],
    };
  }
  if (!decision.consume) return result;
  return {
    ...result,
    consume: result.verdict === "ALLOW" ? [...result.consume, decision.consume] : result.consume,
    deferred_consume:
      result.verdict === "ESCALATE"
        ? [...result.deferred_consume, decision.consume]
        : result.deferred_consume,
  };
}


/**
 * Is this request allowed to see or touch local dev conveniences? Fail closed three ways: an explicit
 * env opt-in, never in production, and loopback only.
 */
function devConsoleAllowed(req: { ip?: string }): boolean {
  if (process.env.CHARTER_DEV_CONSOLE !== "true") return false;
  if (process.env.NODE_ENV === "production") return false;
  const ip = req.ip ?? "";
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

export function registerRoutes(app: FastifyInstance, deps: Deps): void {
  const { pool, adminKey, store } = deps;

  // Live ledger feed (SSE) — its own module because it owns a socket, not a request/response.
  registerStreamRoute(app, { pool, adminKey });

  // ---- GET /healthz -------------------------------------------------------------------------
  app.get("/healthz", async (_req, reply) => {
    const ok = await dbReachable(pool);
    let activePolicyVersion: number | null = null;
    if (ok) {
      try {
        const active = await store.getActive("acme-fintech");
        activePolicyVersion = active?.version ?? null;
      } catch {
        activePolicyVersion = null;
      }
    }
    reply.code(ok ? 200 : 503).send({ ok, db: ok, active_policy_version: activePolicyVersion });
  });

  // ---- POST /v1/actions/check --------------------------------------------------------------
  app.post("/v1/actions/check", async (req, reply) => {
    const auth = await resolveAuth(pool, req.headers.authorization, adminKey);
    if (auth.kind !== "agent") return reply.code(401).send({ error: "unauthorized" });
    const agent: AgentRow = auth.agent;

    const idemKey = req.headers["idempotency-key"];
    if (typeof idemKey !== "string" || idemKey.trim() === "") {
      return reply.code(400).send({ error: "Idempotency-Key header is required" });
    }

    const parsed = checkBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid request", details: parsed.error.issues });
    }
    const { tool, params, principal, context } = parsed.data;
    const tenant = agent.tenant_id;

    // Idempotency replay (D10): same tenant+key → original response, no new ledger entry.
    const cached = await pool.query<{ response: unknown }>(
      "SELECT response FROM idempotency_keys WHERE tenant_id = $1 AND key = $2",
      [tenant, idemKey],
    );
    if (cached.rowCount && cached.rowCount > 0) {
      reply.header("Idempotency-Replayed", "true");
      return reply.code(200).send(cached.rows[0]!.response);
    }

    const t0 = performance.now();
    // Kill switch (D15): a suspended agent is denied before the policy is even consulted.
    const suspended = agent.status === "SUSPENDED";
    const active = suspended ? null : await store.getActive(tenant);
    const action = { tool, params, principal };
    const paramsHash = jcsHashToken(params);
    const entryId = ulid();

    // Pure matching pass (counter reads happen inside the transaction below).
    const match = active ? matchRules(active.doc, agent.id, action) : null;
    const policyMeta = active
      ? { version: active.version, doc_hash: active.docHash }
      : { version: null, doc_hash: null };

    const response: Record<string, unknown> = { verdict: "", entry_id: entryId, rule_id: "" };

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      let result: EvalResult;
      let authorityTrace: AuthorityDecision["trace"] | undefined;
      if (suspended) {
        result = SUSPENDED_RESULT;
      } else {
        // Registry + authority are read INSIDE the transaction so a revoke/expiry racing this check
        // cannot be missed, and the spend read sits in the same snapshot as its increment.
        const charter = await loadCharter(client, tenant, agent.id);
        if (!charter) {
          result = UNCHARTERED_RESULT;
        } else {
          const auth = charter.authority;
          const spendBefore =
            auth && auth.budget_minor !== null
              ? await fetchAuthoritySpend(
                  client,
                  tenant,
                  auth.id,
                  agent.id,
                  auth.budget_window_minutes,
                )
              : 0;
          const decision = evaluateAuthority({ charter, action, spendBefore });
          authorityTrace = decision.trace;

          if (decision.deny?.stage === "standing") {
            // No charter, no grant, expired or revoked → nothing to evaluate. Short-circuit with an
            // empty rule_trace, exactly like a suspended agent (D15).
            result = {
              verdict: "DENY",
              rule_id: decision.deny.rule_id,
              reason: decision.deny.reason,
              rule_trace: { scope_ok: false, cap_applied: false, rules: [] },
              cap_applied: false,
              consume: [],
              deferred_consume: [],
            };
          } else if (active && match) {
            const usages = await fetchUsages(client, tenant, match.limitMatches);
            const chain = charter.agent.approver_chain;
            result = resolveVerdict(
              active.doc,
              agent.id,
              match,
              usages,
              chain.length > 0 ? chain : undefined,
            );
          } else {
            result = NO_POLICY_RESULT;
          }
          if (decision.deny?.stage !== "standing") {
            result = applyAuthority(result, decision);
          }
        }
      }

      const escalate = result.verdict === "ESCALATE" && result.escalation !== undefined;
      const holdId = escalate ? ulid() : null;

      const body = {
        agent: { id: agent.id, key_fingerprint: agent.key_fingerprint },
        principal,
        action: { tool, params, params_hash: paramsHash },
        ...(context ? { context } : {}),
        policy: policyMeta,
        ...(authorityTrace ? { authority: authorityTrace } : {}),
        rule_trace: result.rule_trace,
        verdict: result.verdict,
        rule_id: result.rule_id,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(escalate
          ? {
              hold: {
                id: holdId,
                approvers: result.escalation!.approvers,
                ttl_minutes: result.escalation!.ttl_minutes,
              },
              deferred_consume: result.deferred_consume,
            }
          : {}),
      };

      await appendEntry(client, { tenant, kind: "VERDICT", entryId, body, paramsHash });

      if (escalate && holdId) {
        await createHold(client, {
          holdId,
          tenant,
          verdictEntryId: entryId,
          initiatingPrincipal: principal,
          approverSpecs: result.escalation!.approvers,
          ttlMinutes: result.escalation!.ttl_minutes,
        });
      }

      await applyConsumption(client, tenant, result.consume);

      response.verdict = result.verdict;
      response.rule_id = result.rule_id;
      if (result.reason) response.reason = result.reason;
      if (escalate && holdId) {
        response.hold_id = holdId;
        response.ttl_minutes = result.escalation!.ttl_minutes;
      }

      await client.query(
        "INSERT INTO idempotency_keys (tenant_id, key, response) VALUES ($1, $2, $3)",
        [tenant, idemKey, response],
      );
      await client.query("COMMIT");

      const ms = performance.now() - t0;
      req.log.info(
        {
          tenant,
          agent: agent.id,
          tool,
          principal,
          verdict: result.verdict,
          rule_id: result.rule_id,
          entry_id: entryId,
          params_hash: paramsHash,
          policy_version: policyMeta.version,
          eval_commit_ms: Number(ms.toFixed(2)),
        },
        "check evaluated",
      );
      reply.header("Server-Timing", `gate;dur=${ms.toFixed(2)}`);
      return reply.code(200).send(response);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
        const again = await pool.query<{ response: unknown }>(
          "SELECT response FROM idempotency_keys WHERE tenant_id = $1 AND key = $2",
          [tenant, idemKey],
        );
        if (again.rowCount && again.rowCount > 0) {
          reply.header("Idempotency-Replayed", "true");
          return reply.code(200).send(again.rows[0]!.response);
        }
      }
      throw err; // fail closed: any other DB error surfaces as 5xx, tool does NOT proceed
    } finally {
      client.release();
    }
  });

  // ---- POST /v1/actions/:entry_id/result ---------------------------------------------------
  app.post<{ Params: { entry_id: string } }>(
    "/v1/actions/:entry_id/result",
    async (req, reply) => {
      const auth = await resolveAuth(pool, req.headers.authorization, adminKey);
      if (auth.kind !== "agent") return reply.code(401).send({ error: "unauthorized" });
      const agent = auth.agent;

      const parsed = resultBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid request", details: parsed.error.issues });
      }
      const { status, result_hash } = parsed.data;
      const verdictEntryId = req.params.entry_id;
      const tenant = agent.tenant_id;

      const found = await pool.query<{ payload: { agent?: { id?: string } } }>(
        "SELECT payload FROM ledger_entries WHERE tenant_id = $1 AND entry_id = $2 AND kind = 'VERDICT'",
        [tenant, verdictEntryId],
      );
      if (found.rowCount === 0 || found.rows[0]!.payload.agent?.id !== agent.id) {
        return reply.code(404).send({ error: "verdict entry not found" });
      }

      const existing = await pool.query(
        "SELECT 1 FROM ledger_entries WHERE tenant_id = $1 AND kind = 'OUTCOME' AND payload->>'verdict_entry_id' = $2",
        [tenant, verdictEntryId],
      );
      if (existing.rowCount && existing.rowCount > 0) {
        return reply.code(409).send({ error: "result already reported" });
      }

      const outcomeId = ulid();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await appendEntry(client, {
          tenant,
          kind: "OUTCOME",
          entryId: outcomeId,
          body: { verdict_entry_id: verdictEntryId, status, result_hash },
        });
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }

      return reply.code(200).send({ outcome_entry_id: outcomeId });
    },
  );

  // ---- GET /v1/holds/:hold_id (agent that created it, or admin) ----------------------------
  app.get<{ Params: { hold_id: string } }>("/v1/holds/:hold_id", async (req, reply) => {
    const auth = await resolveAuth(pool, req.headers.authorization, adminKey);
    if (auth.kind === "none") return reply.code(401).send({ error: "unauthorized" });

    const { rows } = await pool.query<{
      id: string;
      tenant_id: string;
      status: string;
      decided_by: string | null;
      decided_at: string | null;
      verdict_entry_id: string;
    }>(
      "SELECT id, tenant_id, status, decided_by, decided_at, verdict_entry_id FROM holds WHERE id = $1",
      [req.params.hold_id],
    );
    const hold = rows[0];
    if (!hold) return reply.code(404).send({ error: "hold not found" });
    // An agent key may only read holds in its own tenant.
    if (auth.kind === "agent" && auth.agent.tenant_id !== hold.tenant_id) {
      return reply.code(404).send({ error: "hold not found" });
    }
    return reply.code(200).send({
      hold_id: hold.id,
      status: hold.status,
      decided_by: hold.decided_by,
      decided_at: hold.decided_at,
      verdict_entry_id: hold.verdict_entry_id,
    });
  });

  // ---- POST /v1/holds/:hold_id/decision (admin; approvals service) -------------------------
  app.post<{ Params: { hold_id: string } }>(
    "/v1/holds/:hold_id/decision",
    async (req, reply) => {
      const auth = await resolveAuth(pool, req.headers.authorization, adminKey);
      if (auth.kind !== "admin") return reply.code(401).send({ error: "unauthorized" });
      const scopeDenial = pinTenant(req, auth);
      if (scopeDenial) return reply.code(scopeDenial.code).send({ error: scopeDenial.error });

      const parsed = decisionBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid request", details: parsed.error.issues });
      }
      const { decision, decided_by_principal, channel } = parsed.data;
      const result = await decideHold(pool, req.params.hold_id, {
        decision,
        decidedBy: decided_by_principal,
        channel,
      });
      if (!result.ok) return reply.code(result.code).send({ error: result.reason });

      // Return the resolved hold view (same shape as GET /v1/holds/:id).
      const { rows } = await pool.query(
        "SELECT id, status, decided_by, decided_at, verdict_entry_id FROM holds WHERE id = $1",
        [req.params.hold_id],
      );
      const h = rows[0]!;
      return reply.code(200).send({
        hold_id: h.id,
        status: h.status,
        decided_by: h.decided_by,
        decided_at: h.decided_at,
        verdict_entry_id: h.verdict_entry_id,
      });
    },
  );

  // ---- POST /v1/agents/:agent_id/suspend (admin) -------------------------------------------
  app.post<{ Params: { agent_id: string } }>(
    "/v1/agents/:agent_id/suspend",
    async (req, reply) => {
      const auth = await resolveAuth(pool, req.headers.authorization, adminKey);
      if (auth.kind !== "admin") return reply.code(401).send({ error: "unauthorized" });
      const scopeDenial = pinTenant(req, auth);
      if (scopeDenial) return reply.code(scopeDenial.code).send({ error: scopeDenial.error });
      // Single-tenant POC: agents live under the seeded tenant.
      const result = await suspendAgent(pool, "acme-fintech", req.params.agent_id);
      if (!result.ok) return reply.code(result.code).send({ error: result.reason });
      return reply.code(200).send({ status: "SUSPENDED", entry_id: result.entryId });
    },
  );

  // ---- GET /v1/dev/credentials — local-only console bootstrap -------------------------------
  //
  // The console needs an admin key to read the ledger and an agent key to sign an action, and an
  // agent key is shown exactly once at registration. Making a human copy three secrets out of a JSON
  // file before the product does anything is a setup ceremony that teaches nothing, so on a local dev
  // box the console asks for them.
  //
  // Fail closed, three ways: refused unless CHARTER_DEV_CONSOLE is explicitly on, refused when
  // NODE_ENV=production, and refused for any request that did not come from loopback.
  app.get("/v1/dev/credentials", async (req, reply) => {
    if (!devConsoleAllowed(req)) return reply.code(404).send({ error: "not found" });
    try {
      const raw = readFileSync(resolve(process.cwd(), ".seed/agent-key.json"), "utf8");
      const seed = JSON.parse(raw) as {
        tenant: string;
        adminKey: string;
        agents?: Record<string, string>;
      };
      return reply.code(200).send({
        tenant: seed.tenant,
        admin_key: seed.adminKey,
        agents: seed.agents ?? {},
        note: "local development credentials — this endpoint is disabled unless CHARTER_DEV_CONSOLE=true and the request is from loopback",
      });
    } catch {
      return reply
        .code(404)
        .send({ error: "no seeded credentials found — run `npm run db:reset` first" });
    }
  });

  // ---- GET /v1/agents (admin) — the registry listing, i.e. the charter cards ----------------
  app.get<{ Querystring: { tenant?: string } }>("/v1/agents", async (req, reply) => {
    const auth = await resolveAuth(pool, req.headers.authorization, adminKey);
    if (auth.kind !== "admin") return reply.code(401).send({ error: "unauthorized" });
    const scopeDenial = pinTenant(req, auth);
    if (scopeDenial) return reply.code(scopeDenial.code).send({ error: scopeDenial.error });
    const tenant = req.query.tenant ?? DEFAULT_TENANT;
    return reply.code(200).send({ agents: await listRegistry(pool, tenant) });
  });

  // ---- GET /v1/agents/:agent_id (admin) — one charter + its full grant history --------------
  app.get<{ Params: { agent_id: string }; Querystring: { tenant?: string } }>(
    "/v1/agents/:agent_id",
    async (req, reply) => {
      const auth = await resolveAuth(pool, req.headers.authorization, adminKey);
      if (auth.kind !== "admin") return reply.code(401).send({ error: "unauthorized" });
      const scopeDenial = pinTenant(req, auth);
      if (scopeDenial) return reply.code(scopeDenial.code).send({ error: scopeDenial.error });
      const tenant = req.query.tenant ?? DEFAULT_TENANT;
      const cards = await listRegistry(pool, tenant);
      const card = cards.find((c) => c.id === req.params.agent_id);
      if (!card) return reply.code(404).send({ error: "agent not found" });
      const authorities = await listAuthorities(pool, tenant, req.params.agent_id);
      return reply.code(200).send({ agent: card, authorities });
    },
  );

  // ---- POST /v1/agents (admin) — charter a new agent ---------------------------------------
  app.post<{ Querystring: { tenant?: string } }>("/v1/agents", async (req, reply) => {
    const auth = await resolveAuth(pool, req.headers.authorization, adminKey);
    if (auth.kind !== "admin") return reply.code(401).send({ error: "unauthorized" });
    const scopeDenial = pinTenant(req, auth);
    if (scopeDenial) return reply.code(scopeDenial.code).send({ error: scopeDenial.error });

    const parsed = registerAgentSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid request", details: parsed.error.issues });
    }
    const b = parsed.data;
    const result = await registerAgent(pool, {
      tenant: req.query.tenant ?? DEFAULT_TENANT,
      agentId: b.id,
      name: b.name,
      ownerPrincipal: b.owner_principal,
      department: b.department,
      ...(b.purpose ? { purpose: b.purpose } : {}),
      approverChain: b.approver_chain,
      expiresAt: b.expires_at,
      maxAutonomy: b.max_autonomy,
    });
    if (!result.ok) return reply.code(result.code).send({ error: result.reason });

    // On a local dev box, also record the key where the CLI tooling looks for it. Without this, an
    // agent created in the console is only usable from that one browser tab — so `npm run demo:agent
    // --agent <id>` cannot act as it, and "I made an agent, now what?" has no answer.
    if (devConsoleAllowed(req)) {
      try {
        const path = resolve(process.cwd(), ".seed/agent-key.json");
        const seed = JSON.parse(readFileSync(path, "utf8")) as {
          agents?: Record<string, string>;
        };
        seed.agents = { ...(seed.agents ?? {}), [b.id]: result.apiKey };
        writeFileSync(path, JSON.stringify(seed, null, 2));
      } catch {
        // Never fail a registration because a dev convenience file could not be written.
      }
    }

    // The API key is shown exactly once — only its fingerprint is ever stored.
    return reply.code(201).send({
      agent_id: b.id,
      api_key: result.apiKey,
      entry_id: result.entryId,
      note: "store this key now; it is not recoverable",
    });
  });

  // ---- POST /v1/agents/:agent_id/authorities (admin) — issue a grant ------------------------
  app.post<{ Params: { agent_id: string }; Querystring: { tenant?: string } }>(
    "/v1/agents/:agent_id/authorities",
    async (req, reply) => {
      const auth = await resolveAuth(pool, req.headers.authorization, adminKey);
      if (auth.kind !== "admin") return reply.code(401).send({ error: "unauthorized" });
      const scopeDenial = pinTenant(req, auth);
      if (scopeDenial) return reply.code(scopeDenial.code).send({ error: scopeDenial.error });

      const parsed = grantAuthoritySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid request", details: parsed.error.issues });
      }
      const b = parsed.data;
      const result = await grantAuthority(pool, {
        tenant: req.query.tenant ?? DEFAULT_TENANT,
        agentId: req.params.agent_id,
        grantorPrincipal: b.grantor_principal,
        validFrom: b.valid_from,
        validUntil: b.valid_until,
        budgetMinor: b.budget_minor,
        budgetCurrency: b.budget_currency,
        budgetWindowMinutes: b.budget_window_minutes,
        allowedTools: b.allowed_tools,
        forbiddenOps: b.forbidden_ops,
        ...(b.ref ? { ref: b.ref } : {}),
      });
      if (!result.ok) return reply.code(result.code).send({ error: result.reason });
      return reply.code(201).send({
        authority_id: result.authorityId,
        ref: result.ref,
        version: result.version,
        doc_hash: result.docHash,
        entry_id: result.entryId,
      });
    },
  );

  // ---- POST /v1/authorities/:authority_id/revoke (admin) -----------------------------------
  app.post<{ Params: { authority_id: string }; Querystring: { tenant?: string } }>(
    "/v1/authorities/:authority_id/revoke",
    async (req, reply) => {
      const auth = await resolveAuth(pool, req.headers.authorization, adminKey);
      if (auth.kind !== "admin") return reply.code(401).send({ error: "unauthorized" });
      const scopeDenial = pinTenant(req, auth);
      if (scopeDenial) return reply.code(scopeDenial.code).send({ error: scopeDenial.error });

      const parsed = revokeSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid request", details: parsed.error.issues });
      }
      const result = await revokeAuthority(
        pool,
        req.query.tenant ?? DEFAULT_TENANT,
        req.params.authority_id,
        parsed.data.by_principal,
        parsed.data.reason,
      );
      if (!result.ok) return reply.code(result.code).send({ error: result.reason });
      return reply
        .code(200)
        .send({ status: "REVOKED", agent_id: result.agentId, entry_id: result.entryId });
    },
  );

  // ---- POST /v1/agents/:agent_id/reinstate (admin) — release the kill switch ----------------
  app.post<{ Params: { agent_id: string }; Querystring: { tenant?: string } }>(
    "/v1/agents/:agent_id/reinstate",
    async (req, reply) => {
      const auth = await resolveAuth(pool, req.headers.authorization, adminKey);
      if (auth.kind !== "admin") return reply.code(401).send({ error: "unauthorized" });
      const scopeDenial = pinTenant(req, auth);
      if (scopeDenial) return reply.code(scopeDenial.code).send({ error: scopeDenial.error });

      const parsed = revokeSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid request", details: parsed.error.issues });
      }
      const result = await reinstateAgent(
        pool,
        req.query.tenant ?? DEFAULT_TENANT,
        req.params.agent_id,
        parsed.data.by_principal,
      );
      if (!result.ok) return reply.code(result.code).send({ error: result.reason });
      return reply.code(200).send({ status: "ACTIVE", entry_id: result.entryId });
    },
  );

  // ---- GET /v1/policies (admin) — version history + the active document --------------------
  // The console needs the active YAML to edit it. Without this, "charter an agent" in the UI produces
  // an agent that cannot act, because nothing can add it to the policy's scope.
  app.get<{ Querystring: { tenant?: string } }>("/v1/policies", async (req, reply) => {
    const auth = await resolveAuth(pool, req.headers.authorization, adminKey);
    if (auth.kind !== "admin") return reply.code(401).send({ error: "unauthorized" });
    const scopeDenial = pinTenant(req, auth);
    if (scopeDenial) return reply.code(scopeDenial.code).send({ error: scopeDenial.error });
    const tenant = req.query.tenant ?? DEFAULT_TENANT;

    const { rows } = await pool.query<{
      version: number;
      doc_hash: string;
      status: string;
      activated_at: string | null;
    }>(
      `SELECT version, doc_hash, status,
              to_char(activated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS activated_at
         FROM policies WHERE tenant_id = $1 AND version > 0
        ORDER BY version DESC`,
      [tenant],
    );
    const activeRow = await pool.query<{ version: number; doc_yaml: string; doc_hash: string }>(
      "SELECT version, doc_yaml, doc_hash FROM policies WHERE tenant_id = $1 AND status = 'active'",
      [tenant],
    );
    const active = activeRow.rows[0];
    return reply.code(200).send({
      versions: rows.map((r) => ({ ...r, version: Number(r.version) })),
      active: active
        ? { version: Number(active.version), doc_hash: active.doc_hash, yaml: active.doc_yaml }
        : null,
    });
  });

  // ---- POST /v1/policies (admin) -----------------------------------------------------------
  app.post("/v1/policies", async (req, reply) => {
    const auth = await resolveAuth(pool, req.headers.authorization, adminKey);
    if (auth.kind !== "admin") return reply.code(401).send({ error: "unauthorized" });
    const scopeDenial = pinTenant(req, auth);
    if (scopeDenial) return reply.code(scopeDenial.code).send({ error: scopeDenial.error });

    const parsed = policyCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid request", details: parsed.error.issues });
    }
    try {
      const { draftId, parsed: doc, coverage } = await createDraft(pool, parsed.data.yaml);
      // A policy names its own tenant inside the document, where pinTenant cannot reach. A scoped
      // key that uploads a doc for someone else's tenant must be refused — the draft is already
      // stored at this point, but it is inert until activation and activation is checked too.
      if (auth.tenant && doc.tenant !== auth.tenant) {
        return reply.code(403).send({
          error: `this key is scoped to tenant '${auth.tenant}'; the policy document names '${doc.tenant}'`,
        });
      }
      return reply.code(200).send({
        draft_id: draftId,
        parsed: doc,
        // Fail-closed gaps and unanalysable pairs. Not errors — reported so an operator sees what
        // the policy does NOT say, which is the part no rule listing can show them.
        coverage: { gaps: coverage.gaps, skipped: coverage.skipped },
      });
    } catch (err) {
      if (err instanceof PolicyCoverageError) {
        return reply
          .code(400)
          .send({ error: err.message, coverage_gaps: err.gaps });
      }
      if (err instanceof PolicyValidationError) {
        return reply.code(400).send({ error: "policy validation failed", details: err.issues });
      }
      if (err instanceof Error && err.message.includes("not valid YAML")) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });

  // ---- POST /v1/policies/:draft_id/activate (admin) ----------------------------------------
  app.post<{ Params: { draft_id: string } }>(
    "/v1/policies/:draft_id/activate",
    async (req, reply) => {
      const auth = await resolveAuth(pool, req.headers.authorization, adminKey);
      if (auth.kind !== "admin") return reply.code(401).send({ error: "unauthorized" });
      const scopeDenial = pinTenant(req, auth);
      if (scopeDenial) return reply.code(scopeDenial.code).send({ error: scopeDenial.error });
      try {
        // Same reasoning as the draft route: the tenant lives on the stored row, not on the request.
        if (auth.tenant) {
          const owner = await pool.query<{ tenant_id: string }>(
            "SELECT tenant_id FROM policies WHERE draft_id = $1",
            [req.params.draft_id],
          );
          const t = owner.rows[0]?.tenant_id;
          if (t && t !== auth.tenant) {
            return reply.code(403).send({
              error: `this key is scoped to tenant '${auth.tenant}' and cannot activate a policy for '${t}'`,
            });
          }
        }
        const result = await activateDraft(pool, store, req.params.draft_id);
        return reply.code(200).send({
          version: result.version,
          doc_hash: result.docHash,
          activated_entry_id: result.activatedEntryId,
        });
      } catch (err) {
        if (err instanceof DraftNotFoundError) {
          return reply.code(404).send({ error: err.message });
        }
        if (err instanceof PolicyCoverageError) {
          return reply.code(400).send({ error: err.message, coverage_gaps: err.gaps });
        }
        throw err;
      }
    },
  );

  // ---- POST /v1/tenant-keys (GLOBAL admin only) ---------------------------------------------
  // Mint an admin key bounded to one tenant. Deliberately closed to scoped keys themselves: a
  // sandbox admin that could mint more sandbox admins is a privilege-escalation ladder, and there is
  // no reason a tester needs one.
  app.post<{ Body: { tenant?: string; label?: string } }>("/v1/tenant-keys", async (req, reply) => {
    const auth = await resolveAuth(pool, req.headers.authorization, adminKey);
    if (auth.kind !== "admin") return reply.code(401).send({ error: "unauthorized" });
    if (auth.tenant) {
      return reply.code(403).send({ error: "only the global operator key may mint tenant keys" });
    }
    const tenant = req.body?.tenant;
    const label = req.body?.label;
    if (!tenant || !label) return reply.code(400).send({ error: "tenant and label are required" });

    const exists = await pool.query("SELECT 1 FROM tenants WHERE id = $1", [tenant]);
    if (exists.rowCount === 0) return reply.code(404).send({ error: `no such tenant '${tenant}'` });

    // Shown once, stored as a fingerprint — the same contract as an agent key.
    const raw = `chr_ta_${randomBytes(24).toString("base64url")}`;
    await pool.query(
      "INSERT INTO tenant_admin_keys (fingerprint, tenant_id, label) VALUES ($1, $2, $3)",
      [sha256Token(raw), tenant, label],
    );
    return reply.code(200).send({ tenant, label, key: raw });
  });

  // ---- POST /v1/tenant-keys/revoke (GLOBAL admin only) ---------------------------------------
  app.post<{ Body: { key?: string } }>("/v1/tenant-keys/revoke", async (req, reply) => {
    const auth = await resolveAuth(pool, req.headers.authorization, adminKey);
    if (auth.kind !== "admin") return reply.code(401).send({ error: "unauthorized" });
    if (auth.tenant) return reply.code(403).send({ error: "only the global operator key may revoke" });
    const raw = req.body?.key;
    if (!raw) return reply.code(400).send({ error: "key is required" });
    const r = await pool.query(
      "UPDATE tenant_admin_keys SET status = 'REVOKED', revoked_at = now() WHERE fingerprint = $1 AND status = 'ACTIVE'",
      [sha256Token(raw)],
    );
    if (r.rowCount === 0) return reply.code(404).send({ error: "no active key matches" });
    return reply.code(200).send({ status: "REVOKED" });
  });

  // ---- GET /v1/ledger (admin) --------------------------------------------------------------
  app.get<{
    Querystring: {
      tenant?: string;
      kind?: string;
      tool?: string;
      verdict?: string;
      from_seq?: string;
      limit?: string;
    };
  }>("/v1/ledger", async (req, reply) => {
    const auth = await resolveAuth(pool, req.headers.authorization, adminKey);
    if (auth.kind !== "admin") return reply.code(401).send({ error: "unauthorized" });
    const scopeDenial = pinTenant(req, auth);
    if (scopeDenial) return reply.code(scopeDenial.code).send({ error: scopeDenial.error });

    const q = req.query;
    if (!q.tenant) return reply.code(400).send({ error: "tenant query param is required" });

    const limit = Math.min(Math.max(Number(q.limit ?? 100), 1), 500);
    const fromSeq = q.from_seq ? Number(q.from_seq) : 0;

    const clauses: string[] = ["tenant_id = $1", "seq >= $2"];
    const args: unknown[] = [q.tenant, fromSeq];
    if (q.kind) {
      args.push(q.kind);
      clauses.push(`kind = $${args.length}`);
    }
    if (q.tool) {
      args.push(q.tool);
      clauses.push(`payload->'action'->>'tool' = $${args.length}`);
    }
    if (q.verdict) {
      args.push(q.verdict);
      clauses.push(`payload->>'verdict' = $${args.length}`);
    }
    args.push(limit + 1);
    const limitParam = `$${args.length}`;

    const { rows } = await pool.query<{ seq: string; payload: unknown }>(
      `SELECT seq, payload FROM ledger_entries
        WHERE ${clauses.join(" AND ")}
        ORDER BY seq ASC
        LIMIT ${limitParam}`,
      args,
    );

    let nextFromSeq: number | null = null;
    const page = rows;
    if (page.length > limit) {
      const extra = page.pop()!;
      nextFromSeq = Number(extra.seq);
    }

    return reply.code(200).send({
      entries: page.map((r) => r.payload),
      next_from_seq: nextFromSeq,
    });
  });

  // ---- GET /v1/ledger/checkpoints (admin) --------------------------------------------------
  app.get<{ Querystring: { tenant?: string } }>("/v1/ledger/checkpoints", async (req, reply) => {
    const auth = await resolveAuth(pool, req.headers.authorization, adminKey);
    if (auth.kind !== "admin") return reply.code(401).send({ error: "unauthorized" });
    const scopeDenial = pinTenant(req, auth);
    if (scopeDenial) return reply.code(scopeDenial.code).send({ error: scopeDenial.error });
    const tenant = req.query.tenant ?? DEFAULT_TENANT;
    const { rows } = await pool.query(
      `SELECT id, seq_from, seq_to, merkle_root, signature,
              to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
         FROM checkpoints WHERE tenant_id = $1 ORDER BY seq_from ASC`,
      [tenant],
    );
    return reply.code(200).send({ checkpoints: rows });
  });

  // ---- GET /v1/ledger/proof/:entry_id (admin) ----------------------------------------------
  app.get<{ Params: { entry_id: string } }>("/v1/ledger/proof/:entry_id", async (req, reply) => {
    const auth = await resolveAuth(pool, req.headers.authorization, adminKey);
    if (auth.kind !== "admin") return reply.code(401).send({ error: "unauthorized" });
    const scopeDenial = pinTenant(req, auth);
    if (scopeDenial) return reply.code(scopeDenial.code).send({ error: scopeDenial.error });

    const entry = await pool.query<{ tenant_id: string; seq: string; entry_hash: string }>(
      "SELECT tenant_id, seq, entry_hash FROM ledger_entries WHERE entry_id = $1",
      [req.params.entry_id],
    );
    if (entry.rowCount === 0) return reply.code(404).send({ error: "entry not found" });
    const { tenant_id, entry_hash } = entry.rows[0]!;
    const seq = Number(entry.rows[0]!.seq);

    const cp = await pool.query<{
      id: string;
      seq_from: string;
      seq_to: string;
      merkle_root: string;
      signature: string;
    }>(
      "SELECT id, seq_from, seq_to, merkle_root, signature FROM checkpoints WHERE tenant_id = $1 AND seq_from <= $2 AND seq_to >= $2",
      [tenant_id, seq],
    );
    if (cp.rowCount === 0) return reply.code(404).send({ error: "entry not yet checkpointed" });
    const checkpoint = cp.rows[0]!;
    const seqFrom = Number(checkpoint.seq_from);

    const range = await pool.query<{ entry_hash: string }>(
      "SELECT entry_hash FROM ledger_entries WHERE tenant_id = $1 AND seq >= $2 AND seq <= $3 ORDER BY seq ASC",
      [tenant_id, seqFrom, Number(checkpoint.seq_to)],
    );
    const leaves = range.rows.map((r) => leafFromEntryHash(r.entry_hash));
    const path = merkleProof(leaves, seq - seqFrom);

    return reply.code(200).send({
      entry_hash,
      checkpoint_id: checkpoint.id,
      merkle_path: path,
      merkle_root: merkleRootHex(leaves),
      signature: checkpoint.signature,
    });
  });

  // ---- GET /v1/attestation (admin) — the regulator-facing evidence pack (Charter §5.5) -------
  app.get<{
    Querystring: {
      tenant?: string;
      from?: string;
      to?: string;
      agent_id?: string;
      format?: string;
    };
  }>("/v1/attestation", async (req, reply) => {
    const auth = await resolveAuth(pool, req.headers.authorization, adminKey);
    if (auth.kind !== "admin") return reply.code(401).send({ error: "unauthorized" });
    const scopeDenial = pinTenant(req, auth);
    if (scopeDenial) return reply.code(scopeDenial.code).send({ error: scopeDenial.error });

    const parsed = attestationQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid request", details: parsed.error.issues });
    }
    const q = parsed.data;

    let pack;
    try {
      pack = await buildAttestationPack(pool, {
        tenant: q.tenant,
        ...(q.from ? { from: q.from } : {}),
        ...(q.to ? { to: q.to } : {}),
        ...(q.agent_id ? { agentId: q.agent_id } : {}),
        ...(deps.anchorsLogPath ? { anchorsLogPath: deps.anchorsLogPath } : {}),
      });
    } catch (err) {
      // An unknown tenant is a 404, not an empty pack: a pack that looks clean because it queried
      // nothing is the most dangerous artifact this endpoint could produce.
      if (err instanceof TenantNotFoundError) {
        return reply.code(404).send({ error: err.message });
      }
      throw err;
    }

    if (q.format === "html") {
      return reply
        .code(200)
        .header("Content-Type", "text/html; charset=utf-8")
        .send(renderAttestationHtml(pack));
    }
    return reply.code(200).send(pack);
  });
}
