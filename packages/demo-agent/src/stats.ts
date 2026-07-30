/**
 * Latency statistics for the S20 soak. Kept here (rather than in scripts/) so it is covered by the
 * unit suite — a soak that reports the wrong p99 is worse than no soak.
 */

export interface LatencySummary {
  count: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
}

/**
 * Nearest-rank percentile on a copy of the samples (0 < p <= 100).
 * p50 of [1..100] is the 50th smallest value; p99 the 99th. No interpolation — with 1,000 samples
 * the reported p99 is a value that was actually observed, which is what a latency budget means.
 */
export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) throw new RangeError("percentile() needs at least one sample");
  if (!(p > 0 && p <= 100)) throw new RangeError(`percentile p out of range: ${p}`);
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx]!;
}

export function summarize(samples: readonly number[]): LatencySummary {
  if (samples.length === 0) throw new RangeError("summarize() needs at least one sample");
  let min = Infinity;
  let max = -Infinity;
  let total = 0;
  for (const s of samples) {
    if (s < min) min = s;
    if (s > max) max = s;
    total += s;
  }
  return {
    count: samples.length,
    min,
    max,
    mean: total / samples.length,
    p50: percentile(samples, 50),
    p90: percentile(samples, 90),
    p95: percentile(samples, 95),
    p99: percentile(samples, 99),
  };
}

export interface HistogramBucket {
  /** Inclusive lower bound in ms. */
  from: number;
  /** Exclusive upper bound in ms; Infinity for the overflow bucket. */
  to: number;
  count: number;
}

/** Fixed-edge histogram so runs are comparable to each other and to the budget. */
export const DEFAULT_EDGES: readonly number[] = [0, 5, 10, 20, 30, 50, 75, 100, 150, 250, 500, 1000];

export function histogram(
  samples: readonly number[],
  edges: readonly number[] = DEFAULT_EDGES,
): HistogramBucket[] {
  const buckets: HistogramBucket[] = [];
  for (let i = 0; i < edges.length; i++) {
    buckets.push({ from: edges[i]!, to: edges[i + 1] ?? Infinity, count: 0 });
  }
  for (const s of samples) {
    let placed = false;
    for (const b of buckets) {
      if (s >= b.from && s < b.to) {
        b.count++;
        placed = true;
        break;
      }
    }
    // Only possible for a negative sample, which would be a measurement bug.
    if (!placed) throw new RangeError(`sample ${s} fell outside every bucket`);
  }
  return buckets;
}

/** Render the histogram as fixed-width bars. */
export function renderHistogram(buckets: readonly HistogramBucket[], width = 48): string[] {
  const maxCount = buckets.reduce((m, b) => Math.max(m, b.count), 0);
  const lines: string[] = [];
  for (const b of buckets) {
    if (b.count === 0 && b.from > 0 && maxCount > 0 && b.from > 250) continue;
    const label = b.to === Infinity ? `>=${b.from}ms` : `${b.from}-${b.to}ms`;
    const bars = maxCount === 0 ? 0 : Math.round((b.count / maxCount) * width);
    lines.push(`  ${label.padStart(12)} | ${"#".repeat(bars).padEnd(width)} ${b.count}`);
  }
  return lines;
}
