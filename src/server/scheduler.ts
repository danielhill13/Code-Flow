// Keeps every org's data fresh while `codeflow serve` runs (decision D37): each org syncs on its
// own `sync_every` (daily unless set), one org at a time, as `codeflow sync` would. A sync that
// fails is tried again after a pause, never in a tight loop; one already running from the
// command line holds the org's lock, so the scheduler waits its turn.
import { existsSync } from "node:fs";
import { everyMs } from "../config/schema.ts";
import type { Org } from "../config/workspace.ts";
import { Store } from "../store/store.ts";
import type { Registry } from "./registry.ts";

/** Syncs one org; resolves with an exit code like the CLI's (0 when everything synced). */
export type SyncOrg = (org: Org, signal: AbortSignal) => Promise<number>;

export type SyncStatus = {
  /** The org's schedule as configured: "24h", "6h", "off". */
  every: string;
  /** When the newest sync that finished cleanly started: what the data is current to. */
  lastSync: string | null;
  /** When the scheduler will sync next; null when the schedule is off. */
  nextSync: string | null;
  running: boolean;
  /** What went wrong with the last scheduled sync, until one succeeds. */
  lastError: string | null;
};

/** How long to wait after a failed sync before trying again (or the schedule, if shorter). */
export const RETRY_MS = 30 * 60_000;
/** How often the scheduler looks for an org that is due. */
export const TICK_MS = 60_000;

export class Scheduler {
  readonly #registry: Registry;
  readonly #sync: SyncOrg;
  readonly #now: () => number;
  readonly #log: (line: string) => void;
  readonly #failedAt = new Map<string, { at: number; error: string }>();
  #running: string | null = null;
  #timer: NodeJS.Timeout | null = null;
  #abort = new AbortController();
  #ticking: Promise<void> | null = null;

  constructor(
    registry: Registry,
    options: { sync: SyncOrg; now?: () => number; log?: (line: string) => void },
  ) {
    this.#registry = registry;
    this.#sync = options.sync;
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? ((line) => console.log(line));
  }

  /** Checks now, then every minute, for orgs that are due. */
  start(tickMs = TICK_MS): void {
    void this.tick();
    this.#timer = setInterval(() => void this.tick(), tickMs);
    this.#timer.unref();
  }

  /** Stops checking, and stops a sync in flight after its current page. */
  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#abort.abort();
    await this.#ticking;
  }

  /** Syncs every org that is due, one after another. Never runs two ticks at once. */
  tick(): Promise<void> {
    if (this.#ticking) return this.#ticking;
    this.#ticking = this.#runDue().finally(() => {
      this.#ticking = null;
    });
    return this.#ticking;
  }

  async status(name: string): Promise<SyncStatus> {
    const { org } = await this.#registry.org(name);
    const lastSync = lastSyncOf(org);
    const next = this.#nextAt(org, lastSync);
    return {
      every: org.config.sync_every,
      lastSync,
      nextSync: Number.isFinite(next) ? new Date(next).toISOString() : null,
      running: this.#running === org.name,
      lastError: this.#failedAt.get(org.name)?.error ?? null,
    };
  }

  /** When an org is next due: its last clean sync plus its interval, later after a failure. */
  #nextAt(org: Org, lastSync: string | null): number {
    const every = everyMs(org.config.sync_every);
    if (!Number.isFinite(every)) return Number.POSITIVE_INFINITY;
    const due = lastSync === null ? 0 : Date.parse(lastSync) + every;
    const failed = this.#failedAt.get(org.name);
    return failed ? Math.max(due, failed.at + Math.min(RETRY_MS, every)) : due;
  }

  async #runDue(): Promise<void> {
    for (const name of await this.#registry.names()) {
      if (this.#abort.signal.aborted) return;
      // Each org as its files say now: a schedule edited meanwhile applies at once.
      const { org } = await this.#registry.org(name);
      if (this.#now() < this.#nextAt(org, lastSyncOf(org))) continue;
      this.#running = org.name;
      this.#log(`Scheduled sync of ${org.name} (every ${org.config.sync_every})`);
      try {
        const code = await this.#sync(org, this.#abort.signal);
        if (code === 0) this.#failedAt.delete(org.name);
        else this.#failedAt.set(org.name, { at: this.#now(), error: `sync exited with ${code}` });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        this.#failedAt.set(org.name, { at: this.#now(), error });
        this.#log(`Scheduled sync of ${org.name} failed: ${error}`);
      } finally {
        this.#running = null;
      }
    }
  }
}

/** When the org's newest clean sync started; null if it has never synced cleanly. */
function lastSyncOf(org: Org): string | null {
  if (!existsSync(org.dbPath)) return null;
  const store = Store.open(org.dbPath);
  try {
    return store.dataThrough();
  } finally {
    store.close();
  }
}
