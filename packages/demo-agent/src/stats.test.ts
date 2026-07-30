import { describe, it, expect } from "vitest";
import { DEFAULT_EDGES, histogram, percentile, renderHistogram, summarize } from "./stats.js";

describe("stats — the soak's latency maths", () => {
  const oneToHundred = Array.from({ length: 100 }, (_v, i) => i + 1);

  it("uses nearest-rank percentiles, so a reported p99 is a value that was observed", () => {
    expect(percentile(oneToHundred, 50)).toBe(50);
    expect(percentile(oneToHundred, 90)).toBe(90);
    expect(percentile(oneToHundred, 99)).toBe(99);
    expect(percentile(oneToHundred, 100)).toBe(100);
    expect(percentile([7], 50)).toBe(7);
  });

  it("does not mutate the caller's samples", () => {
    const samples = [5, 1, 3];
    percentile(samples, 50);
    expect(samples).toEqual([5, 1, 3]);
  });

  it("rejects an empty sample set and an out-of-range percentile", () => {
    expect(() => percentile([], 50)).toThrow(RangeError);
    expect(() => percentile([1], 0)).toThrow(RangeError);
    expect(() => percentile([1], 101)).toThrow(RangeError);
    expect(() => summarize([])).toThrow(RangeError);
  });

  it("summarizes min/max/mean alongside the percentiles", () => {
    const s = summarize([10, 20, 30, 40]);
    expect(s.count).toBe(4);
    expect(s.min).toBe(10);
    expect(s.max).toBe(40);
    expect(s.mean).toBe(25);
    expect(s.p50).toBe(20);
  });

  it("buckets every sample exactly once", () => {
    const samples = [0, 4, 5, 9, 10, 19, 49, 150, 9_999];
    const buckets = histogram(samples, DEFAULT_EDGES);
    expect(buckets.reduce((n, b) => n + b.count, 0)).toBe(samples.length);
    expect(buckets[0]).toMatchObject({ from: 0, to: 5, count: 2 }); // 0 and 4
    expect(buckets[buckets.length - 1]).toMatchObject({ from: 1000, to: Infinity, count: 1 });
  });

  it("treats a negative sample as a measurement bug rather than bucketing it silently", () => {
    expect(() => histogram([-1])).toThrow(RangeError);
  });

  it("renders bars without crashing on an all-zero histogram", () => {
    const lines = renderHistogram(histogram([0]));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).toContain("0-5ms");
  });
});
