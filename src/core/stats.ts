/**
 * Observations a percentile needs before it is shown: at least five above it, or the "P95" of
 * a small sample is just its maximum under another name. P50 needs 10, P75 20, P90 50.
 */
export function minObservations(p: number): number {
  // 5 / (1 - 0.9) is 50.000000000000014 in floating point; don't let that round up to 51.
  return Math.ceil(5 / (1 - p) - 1e-9);
}

/** The p-th percentile of ascending values, interpolating between ranks (R's default, type 7). */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) throw new RangeError("percentile of no values");
  const rank = (sorted.length - 1) * p;
  const low = sorted[Math.floor(rank)] ?? 0;
  const high = sorted[Math.ceil(rank)] ?? 0;
  return low + (high - low) * (rank - Math.floor(rank));
}

export type Stat = {
  /** Null when hidden or when there was nothing to measure. */
  value: number | null;
  /** Observations: values that were not null. */
  n: number;
  /** Why the value is hidden, when it is. */
  hidden?: string;
};

/**
 * A percentile of the values that are not null. The threshold counts observations, not PRs: a
 * month can hold many PRs of which few have a value at all.
 */
export function percentileStat(values: readonly (number | null)[], p: number): Stat {
  const present = values.filter((value): value is number => value !== null).sort((a, b) => a - b);
  const needed = minObservations(p);
  if (present.length < needed) {
    return {
      value: null,
      n: present.length,
      hidden: `needs ${needed} PRs with a value, has ${present.length}`,
    };
  }
  return { value: percentile(present, p), n: present.length };
}
