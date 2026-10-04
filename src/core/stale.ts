// Stale open PRs (decision D36): open, but with no activity by a person for longer than the
// org's `stale_after_days`. They stay visible and listable, apart from the PRs open now, so a
// years-old backlog doesn't bury what is actually waiting today.
import type { PrFact } from "./facts.ts";

export const DEFAULT_STALE_DAYS = 90;

const DAY_MS = 86_400_000;

/** Days since an open PR's last activity by a person, as of the data; null once it has ended. */
export function quietDays(pr: Pick<PrFact, "lastActivityAt">, asOf: Date): number | null {
  return pr.lastActivityAt === null
    ? null
    : (asOf.getTime() - Date.parse(pr.lastActivityAt)) / DAY_MS;
}

/** An open PR nobody has touched for longer than `days`. */
export function isStale(
  pr: Pick<PrFact, "state" | "lastActivityAt">,
  asOf: Date,
  days: number,
): boolean {
  if (pr.state !== "open") return false;
  const quiet = quietDays(pr, asOf);
  return quiet !== null && quiet > days;
}
