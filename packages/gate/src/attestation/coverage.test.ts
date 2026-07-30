import { describe, it, expect } from "vitest";
import { countInRange, intersect, latencyStats, mergeRanges, uncoveredRanges } from "./coverage.js";

/**
 * The coverage arithmetic is what makes the attestation pack honest about what is NOT sealed, so it
 * gets its own tests: an off-by-one here would silently claim a checkpoint covers entries it does not.
 */

describe("intersect", () => {
  it("returns the overlap, or null when the ranges are disjoint", () => {
    expect(intersect({ seq_from: 1, seq_to: 10 }, { seq_from: 5, seq_to: 20 })).toEqual({
      seq_from: 5,
      seq_to: 10,
    });
    expect(intersect({ seq_from: 1, seq_to: 4 }, { seq_from: 5, seq_to: 9 })).toBeNull();
    // Adjacent-but-not-overlapping is NOT an overlap; a single shared seq is.
    expect(intersect({ seq_from: 1, seq_to: 5 }, { seq_from: 5, seq_to: 9 })).toEqual({
      seq_from: 5,
      seq_to: 5,
    });
  });
});

describe("mergeRanges", () => {
  it("merges overlapping and adjacent ranges and leaves gaps alone", () => {
    expect(
      mergeRanges([
        { seq_from: 10, seq_to: 14 },
        { seq_from: 1, seq_to: 5 },
        { seq_from: 6, seq_to: 8 }, // adjacent to 1-5 → merges
        { seq_from: 20, seq_to: 20 },
      ]),
    ).toEqual([
      { seq_from: 1, seq_to: 8 },
      { seq_from: 10, seq_to: 14 },
      { seq_from: 20, seq_to: 20 },
    ]);
  });

  it("does not mutate its input", () => {
    const input = [{ seq_from: 1, seq_to: 2 }];
    mergeRanges(input);
    expect(input).toEqual([{ seq_from: 1, seq_to: 2 }]);
  });
});

describe("uncoveredRanges", () => {
  it("reports the trailing tail after the last checkpoint", () => {
    expect(uncoveredRanges({ seq_from: 1, seq_to: 85 }, [{ seq_from: 1, seq_to: 74 }])).toEqual([
      { seq_from: 75, seq_to: 85 },
    ]);
  });

  it("reports a leading gap when the first checkpoint starts mid-period", () => {
    expect(uncoveredRanges({ seq_from: 50, seq_to: 100 }, [{ seq_from: 60, seq_to: 100 }])).toEqual([
      { seq_from: 50, seq_to: 59 },
    ]);
  });

  it("reports an interior hole between two checkpoints", () => {
    expect(
      uncoveredRanges({ seq_from: 1, seq_to: 30 }, [
        { seq_from: 1, seq_to: 10 },
        { seq_from: 21, seq_to: 30 },
      ]),
    ).toEqual([{ seq_from: 11, seq_to: 20 }]);
  });

  it("returns nothing when the period is fully sealed, including by an over-wide checkpoint", () => {
    expect(uncoveredRanges({ seq_from: 5, seq_to: 9 }, [{ seq_from: 1, seq_to: 100 }])).toEqual([]);
  });

  it("returns the whole period when no checkpoint exists", () => {
    expect(uncoveredRanges({ seq_from: 3, seq_to: 7 }, [])).toEqual([{ seq_from: 3, seq_to: 7 }]);
  });
});

describe("countInRange", () => {
  it("counts only the seqs inside the inclusive bounds", () => {
    const seqs = [1, 2, 5, 9, 10];
    expect(countInRange(seqs, { seq_from: 2, seq_to: 9 })).toBe(3);
    expect(countInRange(seqs, { seq_from: 11, seq_to: 20 })).toBe(0);
    expect(countInRange(seqs, { seq_from: 1, seq_to: 10 })).toBe(5);
  });
});

describe("latencyStats", () => {
  it("is null for an empty sample and exact for odd/even counts", () => {
    expect(latencyStats([])).toBeNull();
    expect(latencyStats([5])).toEqual({ min: 5, median: 5, max: 5 });
    expect(latencyStats([3, 1, 2])).toEqual({ min: 1, median: 2, max: 3 });
    expect(latencyStats([4, 1, 3, 2])).toEqual({ min: 1, median: 2.5, max: 4 });
  });
});
