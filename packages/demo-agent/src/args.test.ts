import { describe, it, expect } from "vitest";
import { ArgError, parseArgs } from "./args.js";
import { ADVERSARIAL_IDS, SCENARIO_IDS } from "./scenarios.js";

describe("CLI argument parsing", () => {
  it("runs every scenario when none is named", () => {
    const args = parseArgs([]);
    expect(args.mode).toBe("scenarios");
    expect(args.scenarios).toEqual([...SCENARIO_IDS]);
    expect(args.live).toBe(false);
  });

  it("defaults to the fixture model — live is opt-in only", () => {
    expect(parseArgs([]).live).toBe(false);
    expect(parseArgs(["--live"]).live).toBe(true);
  });

  it("parses a comma list, case-insensitively, preserving order and de-duplicating", () => {
    expect(parseArgs(["--scenario", "a2,s1,A2"]).scenarios).toEqual(["A2", "S1"]);
  });

  it("expands --adversarial to A1..A4", () => {
    expect(parseArgs(["--adversarial"]).scenarios).toEqual([...ADVERSARIAL_IDS]);
  });

  it("rejects an unknown scenario instead of quietly skipping it", () => {
    expect(() => parseArgs(["--scenario", "S99"])).toThrow(ArgError);
    expect(() => parseArgs(["--scenario"])).toThrow(ArgError);
  });

  it("rejects an unknown option", () => {
    expect(() => parseArgs(["--turbo"])).toThrow(ArgError);
  });

  it("treats --approve and --reject as mutually exclusive", () => {
    expect(parseArgs(["--approve"]).decision).toBe("APPROVED");
    expect(parseArgs(["--reject"]).decision).toBe("REJECTED");
    expect(() => parseArgs(["--approve", "--reject"])).toThrow(ArgError);
  });

  it("switches to interactive mode and accepts an acting agent", () => {
    const args = parseArgs(["--interactive", "--agent", "support-agent"]);
    expect(args.mode).toBe("interactive");
    expect(args.agentId).toBe("support-agent");
  });

  it("validates --run-tag so it cannot break a principal string", () => {
    expect(parseArgs(["--run-tag", "abc12"]).runTag).toBe("abc12");
    expect(() => parseArgs(["--run-tag", "has space"])).toThrow(ArgError);
    expect(() => parseArgs(["--run-tag", "A"])).toThrow(ArgError);
  });

  it("--help short-circuits everything else", () => {
    expect(parseArgs(["--scenario", "S1", "--help"]).mode).toBe("help");
  });
});
