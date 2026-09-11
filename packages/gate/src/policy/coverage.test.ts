import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parsePolicyYaml } from "./schema.js";
import { analyseCoverage } from "./coverage.js";
import { matchRules, resolveVerdict } from "./evaluate.js";

const EXAMPLE = readFileSync(new URL("../../../../policies/example.acme.yaml", import.meta.url), "utf8");

/** A minimal policy: one agent, one tool, plus whatever rules the test supplies. */
function policy(rules: string, opts: { maxAutonomy?: string; unknownTool?: string } = {}) {
  return parsePolicyYaml(`
tenant: t
defaults: { unknown_tool: ${opts.unknownTool ?? "DENY"}, unknown_agent: DENY }
agents:
  a: { allowed_tools: [refund], max_autonomy: ${opts.maxAutonomy ?? "ALLOW"} }
rules:
${rules}`);
}

describe("analyseCoverage", () => {
  it("passes the shipped example policy with no fail-open gaps", () => {
    const r = analyseCoverage(parsePolicyYaml(EXAMPLE));
    expect(r.failOpen).toEqual([]);
  });

  it("reports the example's uncovered payout band as fail-closed, not blocking", () => {
    const r = analyseCoverage(parsePolicyYaml(EXAMPLE));
    const payout = r.gaps.find((g) => g.tool === "initiate_payout");
    expect(payout).toMatchObject({ from: 100001, to: null, verdict: "DENY", decided_by: "defaults.unknown_tool" });
  });

  it("does not check a tool governed only by limit guards", () => {
    // send_email has no verdict rule at all; that is a uniform choice, not a partition with a hole.
    const r = analyseCoverage(parsePolicyYaml(EXAMPLE));
    expect(r.gaps.some((g) => g.tool === "send_email")).toBe(false);
    expect(r.skipped.some((s) => s.tool === "send_email")).toBe(true);
  });

  it("catches the band a tightened ceiling leaves for a velocity guard to allow", () => {
    const r = analyseCoverage(parsePolicyYaml(EXAMPLE.replace("lte: 500000 }", "lte: 400000 }")));
    const g = r.failOpen.find((x) => x.agent === "support-agent" && x.tool === "refund");
    expect(g).toMatchObject({
      param: "params.amount",
      from: 400001,
      to: 500000,
      verdict: "ALLOW",
      decided_by: "R5-refund-velocity",
    });
  });

  it("agrees with the evaluator about what the uncovered band actually returns", () => {
    // The report is only worth blocking on if it predicts the real verdict. Check it against the
    // evaluator rather than against itself.
    const doc = parsePolicyYaml(EXAMPLE.replace("lte: 500000 }", "lte: 400000 }"));
    const gap = analyseCoverage(doc).failOpen.find((g) => g.agent === "support-agent")!;
    const action = { tool: "refund", params: { amount: gap.from! }, principal: "user:x" };
    const got = resolveVerdict(doc, "support-agent", matchRules(doc, "support-agent", action), new Map());
    expect(got.verdict).toBe(gap.verdict);
    expect(got.rule_id).toBe(gap.decided_by);
  });

  it("treats a gap with no guard behind it as fail-closed", () => {
    const r = analyseCoverage(policy(`  - { id: R1, when: { tool: refund, params.amount: { lte: 100 } }, verdict: ALLOW }`));
    expect(r.failOpen).toEqual([]);
    expect(r.gaps[0]).toMatchObject({ from: 101, to: null, verdict: "DENY" });
  });

  it("counts an autonomy cap, which turns a fail-open band into a human hold", () => {
    const rules = `  - { id: R1, when: { tool: refund, params.amount: { lte: 100 } }, verdict: ALLOW }
  - { id: G, when: { tool: refund }, limit: { window_minutes: 60, max_count: 5, key: agent }, verdict_on_breach: DENY }`;
    expect(analyseCoverage(policy(rules)).failOpen).toHaveLength(1);
    expect(analyseCoverage(policy(rules, { maxAutonomy: "ESCALATE" })).failOpen).toEqual([]);
  });

  it("treats an ALLOW default as fail-open for a band nothing covers", () => {
    const r = analyseCoverage(
      policy(`  - { id: R1, when: { tool: refund, params.amount: { lte: 100 } }, verdict: ALLOW }`, {
        unknownTool: "ALLOW",
      }),
    );
    expect(r.failOpen).toHaveLength(1);
    expect(r.failOpen[0]!.decided_by).toBe("defaults.unknown_tool");
  });

  it("accepts adjacent integer bands as total, with no phantom gap between them", () => {
    const r = analyseCoverage(policy(`  - { id: R1, when: { tool: refund, params.amount: { lte: 500 } }, verdict: ALLOW }
  - { id: R2, when: { tool: refund, params.amount: { gt: 500 } }, verdict: ESCALATE, approvers: [x] }`));
    expect(r.gaps).toEqual([]);
  });

  it("flags the negative side when a rule floors the band at zero", () => {
    // A negative refund is a credit. `gte: 0` on one side and nothing below it is a real hole.
    const r = analyseCoverage(policy(`  - { id: R1, when: { tool: refund, params.amount: { gte: 0, lte: 500 } }, verdict: ALLOW }
  - { id: R2, when: { tool: refund, params.amount: { gt: 500 } }, verdict: ESCALATE, approvers: [x] }
  - { id: G, when: { tool: refund }, limit: { window_minutes: 60, max_count: 5, key: agent }, verdict_on_breach: DENY }`));
    expect(r.failOpen).toHaveLength(1);
    expect(r.failOpen[0]).toMatchObject({ from: null, to: -1, verdict: "ALLOW" });
  });

  it("skips rather than guesses when a rule is conditioned on more than one field", () => {
    const r = analyseCoverage(policy(`  - { id: R1, when: { tool: refund, params.amount: { lte: 100 }, principal: bob }, verdict: ALLOW }`));
    expect(r.gaps).toEqual([]);
    expect(r.skipped[0]!.reason).toContain("constrains 2 fields");
  });

  it("skips rather than guesses when rules partition two different params", () => {
    const r = analyseCoverage(policy(`  - { id: R1, when: { tool: refund, params.amount: { lte: 100 } }, verdict: ALLOW }
  - { id: R2, when: { tool: refund, params.qty: { gt: 3 } }, verdict: DENY }`));
    expect(r.gaps).toEqual([]);
    expect(r.skipped[0]!.reason).toContain("two different params");
  });

  it("skips rather than guesses on a non-integer bound", () => {
    const r = analyseCoverage(policy(`  - { id: R1, when: { tool: refund, params.amount: { lte: 100.5 } }, verdict: ALLOW }`));
    expect(r.gaps).toEqual([]);
    expect(r.skipped[0]!.reason).toContain("not an exact integer range");
  });

  it("reports nothing when a verdict rule covers the tool unconditionally", () => {
    const r = analyseCoverage(policy(`  - { id: R1, when: { tool: refund, params.amount: { lte: 100 } }, verdict: ALLOW }
  - { id: R2, when: { tool: refund }, verdict: DENY }`));
    expect(r.gaps).toEqual([]);
  });
});
