import type { Verdict } from "@charter/shared";
import type { PolicyDoc, Rule, Matcher } from "./schema.js";

/**
 * Policy coverage analysis.
 *
 * The problem this exists to catch. SPEC 3.3 gives a matching *limit* rule a verdict of
 * `breach ? verdict_on_breach : (rule.verdict ?? ALLOW)`. A limit rule is a cross-cutting guard —
 * R5-refund-velocity is scoped to `tool: refund`, not to an amount — so it matches every refund. If
 * an operator tightens R1's ceiling from `lte: 500000` to `lte: 400000` while R2 still starts at
 * `gt: 500000`, then a 450000 refund matches NO verdict rule, falls through to R5, does not breach
 * the daily sum, and is ALLOWED with `rule_id: R5-refund-velocity`. A velocity guard has silently
 * become the thing that authorises the payment.
 *
 * That is fail-open, and it is invisible: the policy parses, the schema is satisfied, every rule is
 * individually correct. Only the *union* is wrong. So the union is what gets checked here, at draft
 * and activation time, before the policy can decide anything.
 *
 * What is checked, precisely. For each (agent, tool) the agent may call:
 *
 *   - Rules are split as the evaluator splits them: a rule with a `limit` is a GUARD (matchRules
 *     never lets it supply the base verdict), anything else is a VERDICT RULE.
 *   - If no verdict rule applies to the tool, nothing is checked. The tool is governed entirely by
 *     guards, which is a deliberate uniform choice (send_email + R4-email-rate in the example
 *     policy), not a partition with a hole in it.
 *   - Otherwise the verdict rules must cover the whole numeric range of whichever param they
 *     partition on. Uncovered bands are reported with the verdict the gate would ACTUALLY return
 *     for them, worked out the same way resolveVerdict would: the first matching guard's non-breach
 *     verdict, else `defaults.unknown_tool`, then the agent's autonomy cap.
 *
 * A gap whose verdict is ALLOW is fail-open and refuses activation. A gap that lands on DENY or
 * ESCALATE is reported but does not block: it is the fail-closed direction, and it is often
 * deliberate (nothing in the example policy covers payouts above R6's ceiling, and DENY is the
 * intended answer).
 *
 * Soundness. This only ever reports a gap it can prove. Anything it cannot analyse exactly — a rule
 * conditioned on more than the tool and one numeric param, two verdict rules partitioning different
 * params, a non-integer or `in`-list bound — is not guessed at: the pair is listed in `skipped` with
 * the reason, so an unanalysable policy is visibly unanalysed rather than silently passed.
 */

/** An inclusive integer band. ±Infinity for the unbounded ends. Amounts are integer minor units. */
interface Band {
  lo: number;
  hi: number;
}

export interface CoverageGap {
  agent: string;
  tool: string;
  /** The param path the verdict rules partition on, e.g. "params.amount". */
  param: string;
  from: number | null;
  to: number | null;
  /** Human-readable band, e.g. "400001..500000" or ">100000". */
  band: string;
  /** What the gate would actually return for an action in this band. */
  verdict: Verdict;
  /** The rule that would decide it — a guard id, or "defaults.unknown_tool". */
  decided_by: string;
}

export interface CoverageSkip {
  agent: string;
  tool: string;
  reason: string;
}

export interface CoverageReport {
  gaps: CoverageGap[];
  /** The subset that would be ALLOWED — these refuse activation. */
  failOpen: CoverageGap[];
  skipped: CoverageSkip[];
}

// ---------------------------------------------------------------------------------- matchers ----

/** Does this rule's `when.tool` admit `tool`? A rule with no `tool` key applies to every tool. */
function appliesToTool(rule: Rule, tool: string): boolean {
  const m = rule.when["tool"];
  if (m === undefined) return true;
  if (typeof m !== "object" || m === null) return m === tool;
  const o = m as { eq?: unknown; in?: unknown[] };
  if (o.eq !== undefined) return o.eq === tool;
  if (o.in !== undefined) return o.in.includes(tool);
  // A numeric operator on `tool` can never match a string tool name (applyMatcher compares against
  // NaN), so the rule is unreachable for this tool.
  return false;
}

/**
 * Turn a numeric matcher into the inclusive integer band it admits, or null if it cannot be
 * analysed exactly (non-integer bound, `in` list, `eq` on a non-number).
 */
function bandOf(m: Matcher): Band | null {
  if (typeof m === "number") return Number.isInteger(m) ? { lo: m, hi: m } : null;
  if (typeof m !== "object" || m === null) return null;
  const o = m as { eq?: unknown; gt?: number; gte?: number; lt?: number; lte?: number; in?: unknown[] };
  if (o.in !== undefined) return null;
  let lo = -Infinity;
  let hi = Infinity;
  if (o.eq !== undefined) {
    if (typeof o.eq !== "number" || !Number.isInteger(o.eq)) return null;
    lo = Math.max(lo, o.eq);
    hi = Math.min(hi, o.eq);
  }
  // gt/lt are exclusive; on integers they shift by one. A non-integer bound would make that shift
  // wrong, so bail rather than approximate.
  for (const [v, apply] of [
    [o.gt, (n: number) => (lo = Math.max(lo, n + 1))],
    [o.gte, (n: number) => (lo = Math.max(lo, n))],
    [o.lt, (n: number) => (hi = Math.min(hi, n - 1))],
    [o.lte, (n: number) => (hi = Math.min(hi, n))],
  ] as const) {
    if (v === undefined) continue;
    if (!Number.isInteger(v)) return null;
    apply(v);
  }
  if (lo === -Infinity && hi === Infinity) return null; // no numeric operator at all
  return { lo, hi };
}

/** The `when` keys that are not `tool` — what the rule constrains beyond picking a tool. */
function extraKeys(rule: Rule): string[] {
  return Object.keys(rule.when).filter((k) => k !== "tool");
}

// --------------------------------------------------------------------------- band arithmetic ----

/** Union of inclusive integer bands, merged (so [1,5] and [6,9] become [1,9]). */
function union(bands: Band[]): Band[] {
  const sorted = [...bands].filter((b) => b.lo <= b.hi).sort((a, b) => a.lo - b.lo);
  const out: Band[] = [];
  for (const b of sorted) {
    const last = out[out.length - 1];
    // `last.hi + 1 >= b.lo` merges touching integer bands; +1 on Infinity stays Infinity.
    if (last && last.hi + 1 >= b.lo) last.hi = Math.max(last.hi, b.hi);
    else out.push({ ...b });
  }
  return out;
}

/** The bands of (-Infinity, Infinity) left uncovered by `covered`. */
function complement(covered: Band[]): Band[] {
  const out: Band[] = [];
  let cursor = -Infinity;
  for (const b of union(covered)) {
    if (b.lo > cursor) out.push({ lo: cursor, hi: b.lo - 1 });
    cursor = Math.max(cursor, b.hi + 1);
  }
  if (cursor <= Infinity && cursor !== Infinity) out.push({ lo: cursor, hi: Infinity });
  return out;
}

function overlaps(a: Band, b: Band): boolean {
  return a.lo <= b.hi && b.lo <= a.hi;
}

function describe(b: Band): string {
  if (b.lo === -Infinity && b.hi === Infinity) return "any value";
  if (b.lo === -Infinity) return `<=${b.hi}`;
  if (b.hi === Infinity) return `>=${b.lo}`;
  return b.lo === b.hi ? `${b.lo}` : `${b.lo}..${b.hi}`;
}

// -------------------------------------------------------------------------------- the analysis ----

/**
 * Which guard would decide an action in `gap`, and with what verdict? Mirrors resolveVerdict: guards
 * contribute `verdict ?? ALLOW` when they do not breach, and the most restrictive candidate wins —
 * so the worst case for a *coverage* question is the least restrictive guard, since a fresh counter
 * has not breached anything.
 */
function decidedBy(
  guards: Rule[],
  tool: string,
  param: string,
  gap: Band,
): { verdict: Verdict; ruleId: string } | null {
  const RANK: Record<Verdict, number> = { ALLOW: 0, ESCALATE: 1, DENY: 2 };
  let best: { verdict: Verdict; ruleId: string } | null = null;
  for (const g of guards) {
    if (!appliesToTool(g, tool)) continue;
    const extras = extraKeys(g);
    if (extras.length === 0) {
      // Unconditional guard for this tool: matches the whole band.
    } else if (extras.length === 1 && extras[0] === param) {
      const b = bandOf(g.when[param]!);
      if (!b || !overlaps(b, gap)) continue;
    } else {
      continue; // conditioned on something else — cannot claim it matches
    }
    const verdict: Verdict = g.verdict ?? "ALLOW";
    if (!best || RANK[verdict] < RANK[best.verdict]) best = { verdict, ruleId: g.id };
  }
  return best;
}

export function analyseCoverage(doc: PolicyDoc): CoverageReport {
  const gaps: CoverageGap[] = [];
  const skipped: CoverageSkip[] = [];

  const verdictRules = doc.rules.filter((r) => !r.limit);
  const guards = doc.rules.filter((r) => r.limit);

  for (const [agent, cfg] of Object.entries(doc.agents)) {
    for (const tool of cfg.allowed_tools) {
      const applicable = verdictRules.filter((r) => appliesToTool(r, tool));
      if (applicable.length === 0) {
        skipped.push({
          agent,
          tool,
          reason:
            "no verdict rules apply to this tool — it is governed entirely by limit guards, so there is no partition to check",
        });
        continue;
      }

      // Work out the single param these rules partition on, and bail honestly if they do not.
      const covered: Band[] = [];
      let param: string | null = null;
      let unanalysable: string | null = null;

      for (const r of applicable) {
        const extras = extraKeys(r);
        if (extras.length === 0) {
          covered.push({ lo: -Infinity, hi: Infinity }); // matches every action for this tool
          continue;
        }
        if (extras.length > 1) {
          unanalysable = `rule ${r.id} constrains ${extras.length} fields (${extras.join(", ")}); only tool + one numeric param can be checked exactly`;
          break;
        }
        const path = extras[0]!;
        if (param !== null && param !== path) {
          unanalysable = `rules partition on two different params (${param} and ${path}); a two-dimensional partition cannot be checked exactly`;
          break;
        }
        const b = bandOf(r.when[path]!);
        if (!b) {
          unanalysable = `rule ${r.id} constrains ${path} with a matcher that is not an exact integer range`;
          break;
        }
        param = path;
        covered.push(b);
      }

      if (unanalysable) {
        skipped.push({ agent, tool, reason: unanalysable });
        continue;
      }
      // Every applicable rule was unconditional for this tool ⇒ total coverage, nothing to report.
      if (param === null) continue;

      for (const gap of complement(covered)) {
        const guard = decidedBy(guards, tool, param, gap);
        let verdict: Verdict = guard ? guard.verdict : doc.defaults.unknown_tool;
        const decided = guard ? guard.ruleId : "defaults.unknown_tool";
        // The autonomy cap only tightens, and it applies after the rules (D7).
        if (cfg.max_autonomy === "ESCALATE" && verdict === "ALLOW") verdict = "ESCALATE";
        gaps.push({
          agent,
          tool,
          param,
          from: gap.lo === -Infinity ? null : gap.lo,
          to: gap.hi === Infinity ? null : gap.hi,
          band: describe(gap),
          verdict,
          decided_by: decided,
        });
      }
    }
  }

  return { gaps, failOpen: gaps.filter((g) => g.verdict === "ALLOW"), skipped };
}

/** Thrown when a policy would let an uncovered action through as ALLOW. */
export class PolicyCoverageError extends Error {
  constructor(public gaps: CoverageGap[]) {
    super(
      `policy leaves ${gaps.length} action band${gaps.length === 1 ? "" : "s"} uncovered by any verdict rule, and ${gaps.length === 1 ? "it would be" : "they would be"} ALLOWED: ` +
        gaps
          .map(
            (g) =>
              `${g.agent}/${g.tool} ${g.param} ${g.band} would be decided by ${g.decided_by}`,
          )
          .join("; "),
    );
    this.name = "PolicyCoverageError";
  }
}
