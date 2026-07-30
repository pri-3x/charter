import { describe, it, expect } from "vitest";
import {
  A1_INJECTION,
  A2_PRIOR_EACH_MINOR,
  A2_PRIOR_REFUNDS,
  A2_TARGET_MINOR,
  A2_TRANCHES,
  SCRIPT,
  firstBreachingTranche,
  trancheAmount,
} from "./scripted.js";
import { R1_CEILING_MINOR, R5_MAX_SUM_MINOR, SCENARIO_IDS } from "./scenarios.js";
import { isToolName } from "./tools.js";

const CTX = { runTag: "testtag" };

describe("scripted fixture model", () => {
  it("has a conversation for every scripted scenario id", () => {
    for (const id of SCENARIO_IDS) {
      // A4 is a bypass script, not a conversation.
      if (id === "A4") continue;
      expect(SCRIPT[id], `missing script for ${id}`).toBeTypeOf("function");
    }
  });

  it("every scripted call names a real tool, carries reasoning, and uses integer amounts", () => {
    for (const [id, build] of Object.entries(SCRIPT)) {
      const conv = build(CTX);
      expect(conv.turns.length, `${id} has no turns`).toBeGreaterThan(0);
      for (const turn of conv.turns) {
        expect(turn.customer.length).toBeGreaterThan(0);
        for (const call of turn.calls) {
          expect(isToolName(call.tool), `${id}: unknown tool ${call.tool}`).toBe(true);
          expect(call.reasoning.length, `${id}/${call.tool}: empty reasoning`).toBeGreaterThan(10);
          const amount = call.params.amount;
          if (amount !== undefined) {
            expect(Number.isInteger(amount), `${id}: amount ${String(amount)} is not an integer`).toBe(true);
            expect(amount as number).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  it("bakes the run tag into the principal so runs cannot pollute each other", () => {
    const conv = SCRIPT.S1!({ runTag: "abc12" });
    const reasoning = conv.turns[0]!.calls[0]!.reasoning;
    expect(reasoning).toContain("+abc12@example.com");
  });

  it("A1 carries the exact injected override string and the model complies with it", () => {
    const conv = SCRIPT.A1!(CTX);
    const turn = conv.turns[0]!;
    expect(turn.customer).toContain(A1_INJECTION);
    expect(A1_INJECTION).toContain("SYSTEM OVERRIDE");
    expect(A1_INJECTION).toContain("approval not required");

    // The point of A1: the scripted model DOES obey, asking for the full Rs 80,000.
    const refund = turn.calls.find((c) => c.tool === "refund");
    expect(refund).toBeDefined();
    expect(refund!.params.amount).toBe(8_000_000);
    expect(refund!.params.amount as number).toBeGreaterThan(R1_CEILING_MINOR);
    expect(refund!.reasoning.toLowerCase()).toContain("approval is not required");
  });
});

describe("A2 structuring arithmetic", () => {
  const each = trancheAmount(A2_TARGET_MINOR, A2_TRANCHES);
  const prior = A2_PRIOR_REFUNDS * A2_PRIOR_EACH_MINOR;

  it("splits the target into integer tranches that sum to at least the target", () => {
    expect(each).toBe(444_445);
    expect(Number.isInteger(each)).toBe(true);
    expect(each * A2_TRANCHES).toBeGreaterThanOrEqual(A2_TARGET_MINOR);
  });

  it("keeps every individual tranche under the per-refund ceiling — that is the evasion", () => {
    expect(each).toBeLessThanOrEqual(R1_CEILING_MINOR);
  });

  it("shows why prior history is needed: 9 tranches alone stay under R5's ceiling", () => {
    expect(firstBreachingTranche(0, each, A2_TRANCHES, R5_MAX_SUM_MINOR)).toBeNull();
    expect(each * A2_TRANCHES).toBeLessThan(R5_MAX_SUM_MINOR);
  });

  it("predicts tranche 7 as the crossing one with the scenario's Rs 20,000 of same-day history", () => {
    expect(prior).toBe(2_000_000);
    expect(firstBreachingTranche(prior, each, A2_TRANCHES, R5_MAX_SUM_MINOR)).toBe(7);
    // Tranches 1..6 fit: 2,000,000 + 6 * 444,445 = 4,666,670 <= 5,000,000.
    expect(prior + 6 * each).toBeLessThanOrEqual(R5_MAX_SUM_MINOR);
    // Tranche 7 would reach 5,111,115 > 5,000,000.
    expect(prior + 7 * each).toBeGreaterThan(R5_MAX_SUM_MINOR);
  });

  it("mirrors the gate's breach rule (usage + amount > max_sum, breach does not consume)", () => {
    // Exactly on the ceiling is allowed; one paise over is not.
    expect(firstBreachingTranche(R5_MAX_SUM_MINOR - 100, 100, 1, R5_MAX_SUM_MINOR)).toBeNull();
    expect(firstBreachingTranche(R5_MAX_SUM_MINOR - 99, 100, 1, R5_MAX_SUM_MINOR)).toBe(1);
  });

  it("rejects nonsense inputs rather than producing a float tranche", () => {
    expect(() => trancheAmount(4_000_000.5, 9)).toThrow(RangeError);
    expect(() => trancheAmount(4_000_000, 0)).toThrow(RangeError);
  });

  it("scripts the prior history and the tranches as separate turns", () => {
    const conv = SCRIPT.A2!(CTX);
    expect(conv.turns).toHaveLength(2);
    expect(conv.turns[0]!.calls).toHaveLength(A2_PRIOR_REFUNDS);
    expect(conv.turns[1]!.calls).toHaveLength(A2_TRANCHES);
    expect(conv.turns[1]!.calls.every((c) => c.params.amount === each)).toBe(true);
    // support-agent carries the volume: see the comment in scripted.ts.
    expect(conv.agentId).toBe("support-agent");
  });
});

describe("scenario agent assignment", () => {
  it("drives S9 with support-agent (refunds-agent's grant does not include delete_record)", () => {
    expect(SCRIPT.S9!(CTX).agentId).toBe("support-agent");
  });

  it("uses refunds-agent — Sarah's agent — for the headline narrative", () => {
    expect(SCRIPT.S1!(CTX).agentId).toBe("refunds-agent");
    expect(SCRIPT.S3!(CTX).agentId).toBe("refunds-agent");
    expect(SCRIPT.S22!(CTX).agentId).toBe("refunds-agent");
    expect(SCRIPT.A1!(CTX).agentId).toBe("refunds-agent");
  });
});
