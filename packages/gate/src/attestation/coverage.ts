/**
 * Pure interval + statistics helpers for the attestation pack. Kept separate from the DB reads so
 * the arithmetic an auditor relies on ("which sequence numbers are sealed?") is unit-testable.
 */

export interface SeqRange {
  seq_from: number;
  seq_to: number;
}

/** Intersection of two inclusive integer ranges, or null when they do not overlap. */
export function intersect(a: SeqRange, b: SeqRange): SeqRange | null {
  const from = Math.max(a.seq_from, b.seq_from);
  const to = Math.min(a.seq_to, b.seq_to);
  return from <= to ? { seq_from: from, seq_to: to } : null;
}

/** Merge overlapping/adjacent inclusive ranges into a minimal sorted set. */
export function mergeRanges(ranges: SeqRange[]): SeqRange[] {
  const sorted = [...ranges].sort((x, y) => x.seq_from - y.seq_from);
  const out: SeqRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.seq_from <= last.seq_to + 1) {
      last.seq_to = Math.max(last.seq_to, r.seq_to);
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

/**
 * The parts of `period` that no range in `covered` reaches. This is the honest half of checkpoint
 * coverage: a pack that only listed the sealed ranges would let a reader assume the rest was sealed
 * too.
 */
export function uncoveredRanges(period: SeqRange, covered: SeqRange[]): SeqRange[] {
  const clamped = covered
    .map((c) => intersect(period, c))
    .filter((c): c is SeqRange => c !== null);
  const merged = mergeRanges(clamped);
  const gaps: SeqRange[] = [];
  let cursor = period.seq_from;
  for (const c of merged) {
    if (c.seq_from > cursor) gaps.push({ seq_from: cursor, seq_to: c.seq_from - 1 });
    cursor = Math.max(cursor, c.seq_to + 1);
  }
  if (cursor <= period.seq_to) gaps.push({ seq_from: cursor, seq_to: period.seq_to });
  return gaps;
}

/** How many of `seqs` (sorted ascending) fall inside an inclusive range. */
export function countInRange(seqs: number[], range: SeqRange): number {
  let n = 0;
  for (const s of seqs) {
    if (s >= range.seq_from && s <= range.seq_to) n++;
  }
  return n;
}

/** min / median / max over a sample, or null when the sample is empty. */
export function latencyStats(
  samples: number[],
): { min: number; median: number; max: number } | null {
  if (samples.length === 0) return null;
  const s = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const median = s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
  return { min: s[0]!, median: round3(median), max: s[s.length - 1]! };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
