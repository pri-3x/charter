import type { Verdict, RuleTrace, RuleTraceItem } from "@mandate/shared";
import type { PolicyDoc, Rule, Matcher } from "./schema.js";

/**
 * Policy evaluation (SPEC 3.3, DECISIONS D7/D8).
 *
 * Reconciliation of a spec inconsistency (documented in PROGRESS.md M2): the SPEC 3.3 pseudocode is
 * strict first-match-wins with a `break`, but under example.acme.yaml a small refund matches R1
 * (ALLOW) and would break before reaching R5 (the velocity sum limit) — making S13 impossible. So
 * limit rules are treated as CROSS-CUTTING guards: the first matching *verdict* rule sets the base
 * verdict (first-match-wins among verdict rules), and every matching *limit* rule is also evaluated.
 * The final verdict is the MOST RESTRICTIVE of all contributions (DENY > ESCALATE > ALLOW) — which is
 * also the fail-closed reading (it can only tighten, never loosen, the base verdict).
 */

export const TENANT_DEFAULT_APPROVERS = ["role:finance-lead"];
export const CAP_ESCALATION_TTL_MINUTES = 240;

const RANK: Record<Verdict, number> = { ALLOW: 0, ESCALATE: 1, DENY: 2 };

export interface Action {
  tool: string;
  params: Record<string, unknown>;
  principal: string;
}

export interface LimitMatch {
  rule: Rule;
  key: string; // 'agent:<id>' | 'principal:<id>'
  value: number; // amount for sum limits; 0 for count limits
}

/** Result of the pure matching pass (no counter state yet). */
export interface MatchResult {
  scopeOk: boolean;
  verdict?: Verdict; // set immediately only for scope/unknown-agent denials
  ruleId?: string;
  reason?: string;
  verdictRule?: {
    id: string;
    verdict: Verdict;
    reason?: string;
    approvers?: string[];
    ttl_minutes?: number;
  };
  limitMatches: LimitMatch[];
  traceRules: RuleTraceItem[];
}

/** Current window usage for a matched limit rule. */
export interface Usage {
  count: number;
  sum: number;
}

export interface ConsumeItem {
  rule_id: string;
  key: string;
  kind: "count" | "sum";
  value: number;
}

export interface EvalResult {
  verdict: Verdict;
  rule_id: string;
  reason?: string;
  rule_trace: RuleTrace;
  cap_applied: boolean;
  /** Counter increments to apply IN THE VERDICT TRANSACTION (only when final verdict is ALLOW). */
  consume: ConsumeItem[];
  /**
   * Counter increments to apply IF this ESCALATE is later APPROVED (D8: "ESCALATE-then-approved
   * count"). Stored in the VERDICT payload and replayed in the approval transaction.
   */
  deferred_consume: ConsumeItem[];
  /** Hold parameters when the final verdict is ESCALATE. */
  escalation?: { approvers: string[]; ttl_minutes: number };
}

function resolveField(action: Action, path: string): { present: boolean; value: unknown } {
  if (path === "tool") return { present: true, value: action.tool };
  if (path === "principal") return { present: true, value: action.principal };
  if (path.startsWith("params.")) {
    const segments = path.slice("params.".length).split(".");
    let cur: unknown = action.params;
    for (const seg of segments) {
      if (cur === null || typeof cur !== "object" || !(seg in (cur as object))) {
        return { present: false, value: undefined };
      }
      cur = (cur as Record<string, unknown>)[seg];
    }
    return { present: true, value: cur };
  }
  return { present: false, value: undefined };
}

/** Apply one matcher to a value. Returns whether it matched and a short human-readable reason. */
function applyMatcher(path: string, value: unknown, matcher: Matcher): { ok: boolean; why: string } {
  if (typeof matcher !== "object" || matcher === null) {
    const ok = value === matcher;
    return { ok, why: ok ? `${path}=${String(matcher)}` : `${path}!=${String(matcher)}` };
  }
  const m = matcher as {
    eq?: unknown;
    gt?: number;
    gte?: number;
    lt?: number;
    lte?: number;
    in?: unknown[];
  };
  const num = typeof value === "number" ? value : NaN;
  const checks: Array<[boolean, string]> = [];
  if (m.eq !== undefined) checks.push([value === m.eq, `${path}=${String(m.eq)}`]);
  if (m.gt !== undefined) checks.push([num > m.gt, `${path}>${m.gt}`]);
  if (m.gte !== undefined) checks.push([num >= m.gte, `${path}>=${m.gte}`]);
  if (m.lt !== undefined) checks.push([num < m.lt, `${path}<${m.lt}`]);
  if (m.lte !== undefined) checks.push([num <= m.lte, `${path}<=${m.lte}`]);
  if (m.in !== undefined) checks.push([m.in.includes(value), `${path} in [${m.in.join(",")}]`]);
  const failed = checks.find(([ok]) => !ok);
  if (failed) return { ok: false, why: `not ${failed[1]}` };
  return { ok: true, why: checks.map(([, w]) => w).join(" & ") };
}

/** Evaluate a rule's `when` (all conditions AND). A missing referenced field ⇒ no match (SPEC 3.2). */
function matchWhen(rule: Rule, action: Action): { matched: boolean; why: string } {
  const parts: string[] = [];
  for (const [path, matcher] of Object.entries(rule.when)) {
    const resolved = resolveField(action, path);
    if (!resolved.present) return { matched: false, why: `${path} missing` };
    const res = applyMatcher(path, resolved.value, matcher as Matcher);
    if (!res.ok) return { matched: false, why: res.why };
    parts.push(res.why);
  }
  return { matched: true, why: parts.join(" & ") || "always" };
}

/**
 * Pass 1 — pure matching. Handles scope/unknown-agent denials, records which verdict rule wins and
 * which limit rules match. Counter state is NOT needed here (fetched by the caller for pass 2).
 */
export function matchRules(policy: PolicyDoc, agentId: string, action: Action): MatchResult {
  const agentCfg = policy.agents[agentId];
  if (!agentCfg) {
    return {
      scopeOk: false,
      verdict: policy.defaults.unknown_agent,
      ruleId: "defaults.unknown_agent",
      reason: "agent not defined in active policy",
      limitMatches: [],
      traceRules: [],
    };
  }
  if (!agentCfg.allowed_tools.includes(action.tool)) {
    // Out-of-scope tool is an unknown tool: DENY via defaults.unknown_tool, scope_ok=false, and no
    // rules evaluated. This unifies S10 (scope block, no rules) and S11 (via defaults.unknown_tool).
    return {
      scopeOk: false,
      verdict: policy.defaults.unknown_tool,
      ruleId: "defaults.unknown_tool",
      reason: `tool '${action.tool}' is not in the agent's allowed_tools (out of scope)`,
      limitMatches: [],
      traceRules: [],
    };
  }

  const traceRules: RuleTraceItem[] = [];
  const limitMatches: LimitMatch[] = [];
  let verdictRule: MatchResult["verdictRule"];

  for (const rule of policy.rules) {
    const { matched, why } = matchWhen(rule, action);
    traceRules.push({ rule_id: rule.id, matched, why });
    if (!matched) continue;

    if (rule.limit) {
      const keyStr =
        rule.limit.key === "agent" ? `agent:${agentId}` : `principal:${action.principal}`;
      let value = 0;
      if (rule.limit.sum_param) {
        const resolved = resolveField(action, rule.limit.sum_param);
        value = typeof resolved.value === "number" ? resolved.value : 0;
      }
      limitMatches.push({ rule, key: keyStr, value });
    } else if (!verdictRule) {
      // first-match-wins among verdict rules
      verdictRule = {
        id: rule.id,
        verdict: rule.verdict!,
        ...(rule.reason ? { reason: rule.reason } : {}),
        ...(rule.approvers ? { approvers: rule.approvers } : {}),
        ...(rule.ttl_minutes ? { ttl_minutes: rule.ttl_minutes } : {}),
      };
    }
  }

  return { scopeOk: true, verdictRule, limitMatches, traceRules };
}

interface Candidate {
  rule_id: string;
  verdict: Verdict;
  reason?: string;
  approvers?: string[];
  ttl_minutes?: number;
}

/**
 * Pass 2 — combine the base verdict rule with cross-cutting limit outcomes, apply the autonomy cap,
 * and produce the final verdict + consumption plan + escalation params. `usages` maps a matched
 * limit rule id → its current window usage.
 */
export function resolveVerdict(
  policy: PolicyDoc,
  agentId: string,
  match: MatchResult,
  usages: Map<string, Usage>,
  /**
   * Approvers to use when a rule names none (cap-induced escalations). Defaults to the tenant
   * fallback; the gate passes the agent's registry approver_chain when the charter defines one.
   */
  defaultApprovers: string[] = TENANT_DEFAULT_APPROVERS,
): EvalResult {
  // Scope / unknown-agent denial short-circuits (no rules, no consumption).
  if (!match.scopeOk) {
    return {
      verdict: match.verdict ?? "DENY",
      rule_id: match.ruleId ?? "scope",
      ...(match.reason ? { reason: match.reason } : {}),
      rule_trace: { scope_ok: false, cap_applied: false, rules: match.traceRules },
      cap_applied: false,
      consume: [],
      deferred_consume: [],
    };
  }

  const candidates: Candidate[] = [];
  const consumeCandidates: Array<{ verdictIfAllow: true; item: ConsumeItem }> = [];

  if (match.verdictRule) {
    candidates.push({
      rule_id: match.verdictRule.id,
      verdict: match.verdictRule.verdict,
      ...(match.verdictRule.reason ? { reason: match.verdictRule.reason } : {}),
      ...(match.verdictRule.approvers ? { approvers: match.verdictRule.approvers } : {}),
      ...(match.verdictRule.ttl_minutes ? { ttl_minutes: match.verdictRule.ttl_minutes } : {}),
    });
  }

  for (const lm of match.limitMatches) {
    const usage = usages.get(lm.rule.id) ?? { count: 0, sum: 0 };
    const limit = lm.rule.limit!;
    let breach = false;
    let kind: "count" | "sum" = "count";
    if (limit.max_count !== undefined) {
      kind = "count";
      breach = usage.count + 1 > limit.max_count;
    } else if (limit.max_sum !== undefined) {
      kind = "sum";
      breach = usage.sum + lm.value > limit.max_sum;
    }

    if (breach) {
      candidates.push({
        rule_id: lm.rule.id,
        verdict: lm.rule.verdict_on_breach!,
        ...(lm.rule.reason ? { reason: lm.rule.reason } : {}),
        ...(lm.rule.approvers ? { approvers: lm.rule.approvers } : {}),
        ...(lm.rule.ttl_minutes ? { ttl_minutes: lm.rule.ttl_minutes } : {}),
      });
    } else {
      candidates.push({ rule_id: lm.rule.id, verdict: lm.rule.verdict ?? "ALLOW" });
      consumeCandidates.push({
        verdictIfAllow: true,
        item: { rule_id: lm.rule.id, key: lm.key, kind, value: lm.value },
      });
    }
  }

  if (candidates.length === 0) {
    candidates.push({
      rule_id: "defaults.unknown_tool",
      verdict: policy.defaults.unknown_tool,
      reason: "no policy rule permits this action",
    });
  }

  // Most restrictive wins; tie broken by document/candidate order (verdict rule listed first).
  let winner = candidates[0]!;
  for (const c of candidates) if (RANK[c.verdict] > RANK[winner.verdict]) winner = c;

  let verdict = winner.verdict;
  let capApplied = false;
  let escalation: { approvers: string[]; ttl_minutes: number } | undefined;
  let reason = winner.reason;
  let ruleId = winner.rule_id;

  // Autonomy cap (D7): caps only tighten. ALLOW → ESCALATE when the agent is capped to ESCALATE.
  const agentCfg = policy.agents[agentId]!;
  if (agentCfg.max_autonomy === "ESCALATE" && verdict === "ALLOW") {
    verdict = "ESCALATE";
    capApplied = true;
    escalation = { approvers: defaultApprovers, ttl_minutes: CAP_ESCALATION_TTL_MINUTES };
  } else if (verdict === "ESCALATE") {
    escalation = {
      approvers: winner.approvers ?? defaultApprovers,
      ttl_minutes: winner.ttl_minutes ?? CAP_ESCALATION_TTL_MINUTES,
    };
  }

  // Consume only when the FINAL verdict is ALLOW (D8: ALLOW consumes; ESCALATE-then-approved and
  // DENY do not consume at verdict time). For ESCALATE we carry the plan forward as deferred_consume
  // so it can be applied at approval.
  const items = consumeCandidates.map((c) => c.item);
  const consume = verdict === "ALLOW" ? items : [];
  const deferred_consume = verdict === "ESCALATE" ? items : [];

  const result: EvalResult = {
    verdict,
    rule_id: ruleId,
    rule_trace: { scope_ok: true, cap_applied: capApplied, rules: match.traceRules },
    cap_applied: capApplied,
    consume,
    deferred_consume,
  };
  if (reason) result.reason = reason;
  if (escalation) result.escalation = escalation;
  return result;
}
