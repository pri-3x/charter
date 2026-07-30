import { describe, it, expect } from "vitest";
import { parsePolicyYaml } from "./schema.js";
import { matchRules, resolveVerdict } from "./evaluate.js";
import type { Usage } from "./evaluate.js";

const POLICY_YAML = `
version: 0
tenant: acme-fintech
defaults:
  unknown_tool: DENY
  unknown_agent: DENY
agents:
  support-agent:
    allowed_tools: [refund, send_email, lookup_order, update_record, delete_record]
    max_autonomy: ALLOW
rules:
  - id: R1-refund-small
    when: { tool: refund, params.amount: { lte: 500000 } }
    verdict: ALLOW
  - id: R2-refund-large
    when: { tool: refund, params.amount: { gt: 500000 } }
    verdict: ESCALATE
    approvers: [role:finance-lead]
    ttl_minutes: 240
  - id: R3-no-deletes
    when: { tool: delete_record }
    verdict: DENY
    reason: "Agents may never delete records."
  - id: R4-email-rate
    when: { tool: send_email }
    limit: { window_minutes: 60, max_count: 20, key: agent }
    verdict_on_breach: DENY
  - id: R5-refund-velocity
    when: { tool: refund }
    limit: { window_minutes: 1440, sum_param: params.amount, max_sum: 5000000, key: principal }
    verdict_on_breach: ESCALATE
    approvers: [role:finance-lead]
    ttl_minutes: 240
`;

const policy = parsePolicyYaml(POLICY_YAML);

function evalAction(
  tool: string,
  params: Record<string, unknown>,
  principal = "user:rahul@acme.co",
  usages: Record<string, Usage> = {},
  agentId = "support-agent",
) {
  const action = { tool, params, principal };
  const match = matchRules(policy, agentId, action);
  const usageMap = new Map(Object.entries(usages));
  return resolveVerdict(policy, agentId, match, usageMap);
}

describe("evaluator — verdict rules", () => {
  it("small refund → ALLOW R1", () => {
    const r = evalAction("refund", { amount: 20000 });
    expect(r.verdict).toBe("ALLOW");
    expect(r.rule_id).toBe("R1-refund-small");
  });

  it("boundary 500000 → ALLOW R1 (lte inclusive)", () => {
    expect(evalAction("refund", { amount: 500000 }).verdict).toBe("ALLOW");
  });

  it("500100 → ESCALATE R2 with approvers + ttl", () => {
    const r = evalAction("refund", { amount: 500100 });
    expect(r.verdict).toBe("ESCALATE");
    expect(r.rule_id).toBe("R2-refund-large");
    expect(r.escalation).toEqual({ approvers: ["role:finance-lead"], ttl_minutes: 240 });
  });

  it("delete_record (in allowed_tools) → DENY R3 exact reason", () => {
    const r = evalAction("delete_record", {});
    expect(r.verdict).toBe("DENY");
    expect(r.rule_id).toBe("R3-no-deletes");
    expect(r.reason).toBe("Agents may never delete records.");
    expect(r.rule_trace.scope_ok).toBe(true);
  });

  it("tool outside allowed_tools → DENY defaults.unknown_tool, scope block, no rules (S10/S11)", () => {
    const r = evalAction("wire_transfer", { amount: 1 });
    expect(r.verdict).toBe("DENY");
    expect(r.rule_id).toBe("defaults.unknown_tool");
    expect(r.rule_trace.scope_ok).toBe(false);
    expect(r.rule_trace.rules).toHaveLength(0);
  });
});

describe("evaluator — missing params", () => {
  it("refund without amount → R1/R2 don't match; falls to R5 (no breach) ALLOW", () => {
    const r = evalAction("refund", {});
    // R1 needs amount (missing → no match), R2 needs amount (missing), R5 matches (tool only)
    expect(r.verdict).toBe("ALLOW");
    expect(r.rule_id).toBe("R5-refund-velocity");
    const r1 = r.rule_trace.rules.find((x) => x.rule_id === "R1-refund-small");
    expect(r1?.matched).toBe(false);
    expect(r1?.why).toContain("missing");
  });
});

describe("evaluator — stateful limits (cross-cutting)", () => {
  it("small refund consumes the R5 sum counter when ALLOW", () => {
    const r = evalAction("refund", { amount: 490000 });
    expect(r.verdict).toBe("ALLOW");
    expect(r.rule_id).toBe("R1-refund-small");
    expect(r.consume).toEqual([
      { rule_id: "R5-refund-velocity", key: "principal:user:rahul@acme.co", kind: "sum", value: 490000 },
    ]);
  });

  it("S13: sum would exceed 5,000,000 → ESCALATE R5, no consumption", () => {
    const r = evalAction("refund", { amount: 490000 }, "user:rahul@acme.co", {
      "R5-refund-velocity": { count: 10, sum: 4_900_000 },
    });
    expect(r.verdict).toBe("ESCALATE");
    expect(r.rule_id).toBe("R5-refund-velocity");
    expect(r.consume).toEqual([]); // breach does not consume
  });

  it("S12: 21st email (count already 20) → DENY R4, no consumption", () => {
    const r = evalAction("send_email", { to: "x@y.com" }, "user:rahul@acme.co", {
      "R4-email-rate": { count: 20, sum: 0 },
    });
    expect(r.verdict).toBe("DENY");
    expect(r.rule_id).toBe("R4-email-rate");
    expect(r.consume).toEqual([]);
  });

  it("email under the limit → ALLOW R4, consumes count", () => {
    const r = evalAction("send_email", { to: "x@y.com" }, "user:rahul@acme.co", {
      "R4-email-rate": { count: 5, sum: 0 },
    });
    expect(r.verdict).toBe("ALLOW");
    expect(r.rule_id).toBe("R4-email-rate");
    expect(r.consume).toEqual([
      { rule_id: "R4-email-rate", key: "agent:support-agent", kind: "count", value: 0 },
    ]);
  });
});

describe("evaluator — autonomy cap (S14)", () => {
  const cappedPolicy = parsePolicyYaml(POLICY_YAML.replace("max_autonomy: ALLOW", "max_autonomy: ESCALATE"));
  it("ALLOW is capped up to ESCALATE with cap_applied", () => {
    const action = { tool: "refund", params: { amount: 20000 }, principal: "user:rahul@acme.co" };
    const match = matchRules(cappedPolicy, "support-agent", action);
    const r = resolveVerdict(cappedPolicy, "support-agent", match, new Map());
    expect(r.verdict).toBe("ESCALATE");
    expect(r.cap_applied).toBe(true);
    expect(r.rule_trace.cap_applied).toBe(true);
    expect(r.escalation?.ttl_minutes).toBe(240);
    expect(r.consume).toEqual([]); // consumption deferred on cap escalation
  });
});
