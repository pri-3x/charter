import type { AuthorityTrace } from "@mandate/shared";
import type { PoolClient } from "../db.js";
import type { Action, ConsumeItem } from "../policy/evaluate.js";
import type { CharterContext } from "./store.js";

/**
 * Authority enforcement (Charter §5.2/§5.3) — the OUTER envelope around the policy engine.
 *
 * The policy says what the ops rules permit; the authority document says what Finance actually
 * granted. The grant always wins, and it can only ever TIGHTEN a verdict:
 *
 *   charter expired/revoked → DENY   (no valid charter ⇒ no authority at all)
 *   no live grant           → DENY
 *   outside validity window → DENY
 *   tool ∈ forbidden_ops    → DENY   (even when the policy would ALLOW it — this is the point:
 *                                     a policy mistake cannot exceed the granted authority)
 *   tool ∉ allowed_tools    → DENY
 *   spend + amount > budget → DENY   (fail closed: exceeding the grant is not an escalation, because
 *                                     an approver may not hand out authority nobody granted them)
 *
 * Every check — passed or failed — lands in the AuthorityTrace inside the VERDICT payload, so the
 * evidence shows not just the verdict but which grant it was measured against.
 */

export interface AuthorityDecision {
  /**
   * Set when the grant itself blocks the action. null when the grant permits it.
   *
   * `stage` decides whether the policy is even consulted:
   *   'standing' — the agent has no valid standing (no charter, no grant, expired, revoked). There is
   *                nothing to evaluate: the gate short-circuits with an empty rule_trace, exactly as
   *                it does for a suspended agent (D15). Fastest path, and the fail-closed one.
   *   'envelope' — the agent HAS standing but this action falls outside the grant. The policy is
   *                still evaluated so the evidence records both views ("policy matched R6, the grant
   *                overruled it") — which is the whole point of having a grant above a policy.
   */
  deny: { rule_id: string; reason: string; stage: "standing" | "envelope" } | null;
  trace: AuthorityTrace;
  /** Budget spend to record when this action is finally ALLOWed (or approved later). */
  consume: ConsumeItem | null;
}

const EMPTY_TRACE = (): AuthorityTrace => ({
  authority_id: null,
  ref: null,
  version: null,
  doc_hash: null,
  checks: [],
});

/** Read spend inside the grant's budget window (same 1-minute buckets as policy limits, D8). */
export async function fetchAuthoritySpend(
  client: PoolClient,
  tenant: string,
  authorityId: string,
  agentId: string,
  windowMinutes: number,
): Promise<number> {
  const { rows } = await client.query<{ s: string }>(
    `SELECT COALESCE(SUM(event_sum), 0)::bigint AS s FROM limit_counters
      WHERE tenant_id = $1 AND rule_id = $2 AND key = $3
        AND window_start > now() - make_interval(mins => $4)`,
    [tenant, `authority:${authorityId}`, `agent:${agentId}`, windowMinutes],
  );
  return Number(rows[0]!.s);
}

/** The action's money value in minor units, or null when the tool moves no money. */
export function actionAmount(action: Action): number | null {
  const raw = (action.params as { amount?: unknown }).amount;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

export interface EvaluateAuthorityInput {
  charter: CharterContext;
  action: Action;
  /** Spend already recorded in the grant's window (0 when there is no grant/budget). */
  spendBefore: number;
}

/**
 * Pure authority evaluation. Time comparisons are already resolved by Postgres into the
 * CharterContext booleans, which keeps this function deterministic and unit-testable.
 */
export function evaluateAuthority(input: EvaluateAuthorityInput): AuthorityDecision {
  const { charter, action, spendBefore } = input;
  const trace = EMPTY_TRACE();

  // ---- the charter itself ------------------------------------------------------------------
  if (charter.agent.status === "REVOKED") {
    trace.checks.push({ check: "charter_status", ok: false, why: "charter revoked" });
    return {
      deny: {
        rule_id: "charter.revoked",
        reason: "agent charter has been revoked",
        stage: "standing",
      },
      trace,
      consume: null,
    };
  }
  if (charter.charter_expired) {
    trace.checks.push({
      check: "charter_expiry",
      ok: false,
      why: `charter expired ${charter.agent.expires_at ?? ""}`.trim(),
    });
    return {
      deny: {
        rule_id: "charter.expired",
        reason: `agent charter expired on ${charter.agent.expires_at ?? "an unknown date"}`,
        stage: "standing",
      },
      trace,
      consume: null,
    };
  }
  trace.checks.push({
    check: "charter_expiry",
    ok: true,
    why: charter.agent.expires_at ? `valid until ${charter.agent.expires_at}` : "no expiry set",
  });

  // ---- a live grant must exist ---------------------------------------------------------------
  const auth = charter.authority;
  if (!auth) {
    trace.checks.push({ check: "authority_present", ok: false, why: "no active authority document" });
    return {
      deny: {
        rule_id: "authority.missing",
        reason: "agent holds no active authority document",
        stage: "standing",
      },
      trace,
      consume: null,
    };
  }
  trace.authority_id = auth.id;
  trace.ref = auth.ref;
  trace.version = auth.version;
  trace.doc_hash = auth.doc_hash;
  trace.checks.push({ check: "authority_present", ok: true, why: `${auth.ref} v${auth.version}` });

  if (charter.authority_not_yet_valid) {
    trace.checks.push({
      check: "authority_window",
      ok: false,
      why: `not valid before ${auth.valid_from}`,
    });
    return {
      deny: {
        rule_id: "authority.not_yet_valid",
        reason: `authority ${auth.ref} is not valid before ${auth.valid_from}`,
        stage: "standing",
      },
      trace,
      consume: null,
    };
  }
  if (charter.authority_expired) {
    trace.checks.push({ check: "authority_window", ok: false, why: `expired ${auth.valid_until}` });
    return {
      deny: {
        rule_id: "authority.expired",
        reason: `authority ${auth.ref} expired on ${auth.valid_until}`,
        stage: "standing",
      },
      trace,
      consume: null,
    };
  }
  trace.checks.push({
    check: "authority_window",
    ok: true,
    why: `${auth.valid_from} → ${auth.valid_until}`,
  });

  // ---- forbidden operations beat everything, including an ALLOW from policy -------------------
  if (auth.forbidden_ops.includes(action.tool)) {
    trace.checks.push({
      check: "forbidden_ops",
      ok: false,
      why: `'${action.tool}' is forbidden by the grant`,
    });
    return {
      deny: {
        rule_id: "authority.forbidden_operation",
        reason: `'${action.tool}' is a forbidden operation under authority ${auth.ref}`,
        stage: "envelope",
      },
      trace,
      consume: null,
    };
  }
  trace.checks.push({ check: "forbidden_ops", ok: true, why: `'${action.tool}' not forbidden` });

  // ---- the grant's tool envelope --------------------------------------------------------------
  if (auth.allowed_tools.length > 0 && !auth.allowed_tools.includes(action.tool)) {
    trace.checks.push({
      check: "allowed_tools",
      ok: false,
      why: `'${action.tool}' not granted`,
    });
    return {
      deny: {
        rule_id: "authority.tool_not_granted",
        reason: `authority ${auth.ref} does not grant '${action.tool}'`,
        stage: "envelope",
      },
      trace,
      consume: null,
    };
  }
  trace.checks.push({ check: "allowed_tools", ok: true, why: `'${action.tool}' granted` });

  // ---- budget ---------------------------------------------------------------------------------
  const amount = actionAmount(action);
  trace.spend_before = spendBefore;
  trace.budget_minor = auth.budget_minor;

  if (auth.budget_minor === null || amount === null || amount === 0) {
    trace.checks.push({
      check: "budget",
      ok: true,
      why:
        auth.budget_minor === null
          ? "grant sets no spend ceiling"
          : `no money amount on '${action.tool}'`,
    });
    return { deny: null, trace, consume: null };
  }

  // A currency the grant was not denominated in cannot be measured against it → fail closed.
  const currency = (action.params as { currency?: unknown }).currency;
  if (typeof currency === "string" && currency !== auth.budget_currency) {
    trace.checks.push({
      check: "budget_currency",
      ok: false,
      why: `${currency} ≠ granted ${auth.budget_currency}`,
    });
    return {
      deny: {
        rule_id: "authority.currency_mismatch",
        reason: `authority ${auth.ref} is denominated in ${auth.budget_currency}, action is in ${currency}`,
        stage: "envelope",
      },
      trace,
      consume: null,
    };
  }

  const after = spendBefore + amount;
  if (after > auth.budget_minor) {
    trace.checks.push({
      check: "budget",
      ok: false,
      why: `${after} > ${auth.budget_minor} ${auth.budget_currency} in ${auth.budget_window_minutes}m`,
    });
    return {
      deny: {
        rule_id: "authority.budget_exceeded",
        reason: `action would exceed the authority budget (${after} > ${auth.budget_minor} minor units of ${auth.budget_currency} per ${auth.budget_window_minutes} minutes)`,
        stage: "envelope",
      },
      trace,
      consume: null,
    };
  }

  trace.checks.push({
    check: "budget",
    ok: true,
    why: `${after} ≤ ${auth.budget_minor} ${auth.budget_currency} in ${auth.budget_window_minutes}m`,
  });
  return {
    deny: null,
    trace,
    // Recorded only when the verdict ends up ALLOW (or an ESCALATE is later approved) — same
    // consumption discipline as policy limits (D8).
    consume: {
      rule_id: `authority:${auth.id}`,
      key: `agent:${charter.agent.id}`,
      kind: "sum",
      value: amount,
    },
  };
}
