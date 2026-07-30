import { describe, it, expect } from "vitest";
import { evaluateAuthority, actionAmount } from "./authority.js";
import type { CharterContext, AuthorityRow } from "./store.js";
import type { Action } from "../policy/evaluate.js";

/**
 * Unit tests for the authority envelope (Charter §5.2, DECISIONS D16–D17). The evaluator is pure —
 * Postgres has already resolved every time comparison into the CharterContext booleans — so these
 * tests pin the fail-closed ordering without a database.
 */

const grant = (over: Partial<AuthorityRow> = {}): AuthorityRow => ({
  id: "01AUTH",
  ref: "auth_2026_0071",
  version: 1,
  grantor_principal: "user:monty@acme.co",
  valid_from: "2026-07-01T00:00:00.000Z",
  valid_until: "2026-10-30T00:00:00.000Z",
  budget_minor: 10_000_000,
  budget_currency: "INR",
  budget_window_minutes: 1440,
  allowed_tools: ["refund", "send_email"],
  forbidden_ops: ["initiate_payout", "run_payroll"],
  status: "ACTIVE",
  doc_hash: "sha256:deadbeef",
  granted_entry_id: "01ENTRY",
  revoked_by: null,
  revoked_at: null,
  created_at: "2026-07-01T00:00:00.000Z",
  ...over,
});

const charter = (over: Partial<CharterContext> = {}): CharterContext => ({
  agent: {
    id: "refunds-agent",
    name: "Refunds Agent",
    status: "ACTIVE",
    owner_principal: "user:sarah@acme.co",
    department: "Customer Support",
    approver_chain: ["role:finance-lead"],
    expires_at: "2026-10-30T00:00:00.000Z",
    max_autonomy: "ALLOW",
  },
  charter_expired: false,
  authority: grant(),
  authority_not_yet_valid: false,
  authority_expired: false,
  ...over,
});

const refund = (amount: number, currency?: string): Action => ({
  tool: "refund",
  params: { amount, ...(currency ? { currency } : {}) },
  principal: "user:cust@acme.co",
});

describe("evaluateAuthority", () => {
  it("permits an action inside the grant and plans the budget spend", () => {
    const d = evaluateAuthority({ charter: charter(), action: refund(20_000), spendBefore: 0 });
    expect(d.deny).toBeNull();
    expect(d.consume).toEqual({
      rule_id: "authority:01AUTH",
      key: "agent:refunds-agent",
      kind: "sum",
      value: 20_000,
    });
    expect(d.trace.ref).toBe("auth_2026_0071");
    expect(d.trace.checks.every((c) => c.ok)).toBe(true);
  });

  it("denies a revoked charter before anything else", () => {
    const d = evaluateAuthority({
      charter: charter({ agent: { ...charter().agent, status: "REVOKED" } }),
      action: refund(1),
      spendBefore: 0,
    });
    expect(d.deny?.rule_id).toBe("charter.revoked");
    expect(d.trace.authority_id).toBeNull(); // never even looked at the grant
  });

  it("denies an expired charter (S21)", () => {
    const d = evaluateAuthority({
      charter: charter({ charter_expired: true }),
      action: refund(1),
      spendBefore: 0,
    });
    expect(d.deny?.rule_id).toBe("charter.expired");
    expect(d.deny?.reason).toContain("2026-10-30");
  });

  it("denies when the agent holds no grant at all (S23)", () => {
    const d = evaluateAuthority({
      charter: charter({ authority: null }),
      action: refund(1),
      spendBefore: 0,
    });
    expect(d.deny?.rule_id).toBe("authority.missing");
  });

  it("denies outside the grant's validity window", () => {
    expect(
      evaluateAuthority({
        charter: charter({ authority_not_yet_valid: true }),
        action: refund(1),
        spendBefore: 0,
      }).deny?.rule_id,
    ).toBe("authority.not_yet_valid");
    expect(
      evaluateAuthority({
        charter: charter({ authority_expired: true }),
        action: refund(1),
        spendBefore: 0,
      }).deny?.rule_id,
    ).toBe("authority.expired");
  });

  it("denies a forbidden operation even though the policy would allow it (S22)", () => {
    const d = evaluateAuthority({
      charter: charter(),
      action: { tool: "initiate_payout", params: { amount: 50_000 }, principal: "user:x@acme.co" },
      spendBefore: 0,
    });
    expect(d.deny?.rule_id).toBe("authority.forbidden_operation");
    expect(d.consume).toBeNull();
  });

  it("denies a tool the grant never granted", () => {
    const d = evaluateAuthority({
      charter: charter(),
      action: { tool: "update_record", params: {}, principal: "user:x@acme.co" },
      spendBefore: 0,
    });
    expect(d.deny?.rule_id).toBe("authority.tool_not_granted");
  });

  it("denies when the action would cross the budget, at the exact boundary (S24)", () => {
    // Exactly on the ceiling is inside the grant…
    const ok = evaluateAuthority({
      charter: charter(),
      action: refund(1_000_000),
      spendBefore: 9_000_000,
    });
    expect(ok.deny).toBeNull();
    // …one paisa past it is not.
    const breach = evaluateAuthority({
      charter: charter(),
      action: refund(1_000_001),
      spendBefore: 9_000_000,
    });
    expect(breach.deny?.rule_id).toBe("authority.budget_exceeded");
    expect(breach.trace.spend_before).toBe(9_000_000);
    expect(breach.trace.budget_minor).toBe(10_000_000);
  });

  it("denies a currency the grant is not denominated in (fail closed)", () => {
    const d = evaluateAuthority({
      charter: charter(),
      action: refund(100, "USD"),
      spendBefore: 0,
    });
    expect(d.deny?.rule_id).toBe("authority.currency_mismatch");
  });

  it("skips the budget check for a grant with no ceiling and for amount-less tools", () => {
    const noCeiling = evaluateAuthority({
      charter: charter({ authority: grant({ budget_minor: null }) }),
      action: refund(999_999_999),
      spendBefore: 0,
    });
    expect(noCeiling.deny).toBeNull();
    expect(noCeiling.consume).toBeNull(); // nothing to meter against

    const email = evaluateAuthority({
      charter: charter(),
      action: { tool: "send_email", params: { to: "a@b.co" }, principal: "user:x@acme.co" },
      spendBefore: 0,
    });
    expect(email.deny).toBeNull();
    expect(email.consume).toBeNull();
  });

  it("records every check it ran in the trace, in order", () => {
    const d = evaluateAuthority({ charter: charter(), action: refund(1), spendBefore: 0 });
    expect(d.trace.checks.map((c) => c.check)).toEqual([
      "charter_expiry",
      "authority_present",
      "authority_window",
      "forbidden_ops",
      "allowed_tools",
      "budget",
    ]);
  });
});

describe("actionAmount", () => {
  it("reads a numeric amount and ignores anything else", () => {
    expect(actionAmount(refund(500))).toBe(500);
    expect(actionAmount({ tool: "t", params: { amount: "500" }, principal: "p" })).toBeNull();
    expect(actionAmount({ tool: "t", params: {}, principal: "p" })).toBeNull();
    expect(actionAmount({ tool: "t", params: { amount: Infinity }, principal: "p" })).toBeNull();
  });
});
