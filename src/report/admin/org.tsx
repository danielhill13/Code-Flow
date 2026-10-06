// Setup sections for what an org measures and how (decision D39): its repos, branches, bots and
// file paths, its sync, and its settings. They edit org.yml through the server, which checks each
// save as a whole; each section sends only the keys it shows, so the rest of the file is untouched.
import { useEffect, useState } from "preact/hooks";
import { num } from "../../core/format.ts";
import { AdoStatus, GitHubStatus, PreviewTable, useStatus } from "../welcome.tsx";
import type {
  AdoCheck,
  AdoSettings,
  CopyRow,
  GitHubCheck,
  GitHubSettings,
  RawSource,
  SourcesPreview,
  SyncedRepos,
  Unmeasured,
} from "./api.ts";
import { Choice, Field, List, Problem, Text } from "./fields.tsx";
import { Form, message, type SectionProps, usePart, Waiting } from "./kit.tsx";
import { branchOptions, Picker, repoOptions, useAccounts } from "./picker.tsx";
import { SourceList } from "./sources.tsx";

/** org.yml as the server reads it for Setup: what the file says, defaults filled in. */
type OrgRaw = {
  sources: RawSource[];
  since: string;
  github: GitHubSettings;
  azure_devops: AdoSettings;
  branches: Record<string, string[]>;
  promotions: string[];
  bots: {
    accounts?: string[];
    reviewers?: string[];
    include_prs?: boolean;
    ignore_bodies?: string[];
  };
  paths: { match: string | string[]; bucket: string; repos?: string[] }[];
  sync_every: string;
  stale_after_days: number;
  churn_window_days: number;
  size_target_lines: number;
  local_copies: string[];
  ticket_pattern?: string;
  duplicates_by_work_item: boolean;
  people_views: boolean;
};

/** org.yml, opened for one section, with a draft of the keys that section changes. */
function useOrg(props: SectionProps) {
  const part = usePart(props.api, "settings", props.onSaved);
  const [draft, setDraft] = useState<Partial<OrgRaw>>({});
  const [saved, setSaved] = useState(false);
  const opened = part.opened?.value as OrgRaw | undefined;
  const value = opened ? ({ ...opened, ...draft } as OrgRaw) : null;
  return {
    part,
    value,
    dirty: Object.keys(draft).length > 0,
    saved,
    set: (patch: Partial<OrgRaw>) => {
      setSaved(false);
      setDraft((d) => ({ ...d, ...patch }));
    },
    reset: () => {
      setDraft({});
      setSaved(false);
    },
    save: async () => {
      if (await part.save(draft)) {
        setDraft({});
        setSaved(true);
      }
    },
  };
}

function Saved({ show }: { show: boolean }) {
  return show ? <p class="muted wide-field">Saved to org.yml.</p> : null;
}

// Repos ----------------------------------------------------------------------------------------

export function Repos(props: SectionProps) {
  const org = useOrg(props);
  const [preview, setPreview] = useState<SourcesPreview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  // Every repo a preview has listed, kept when the sources change so they stay choosable.
  const [seen, setSeen] = useState<string[]>([]);
  useEffect(() => {
    if (!preview) return;
    const listed = preview.sources.flatMap((source) => [
      ...source.repos.map((repo) => repo.fullName),
      ...source.skipped.map((skip) => skip.repo),
    ]);
    setSeen((before) => [...new Set([...before, ...listed])]);
  }, [preview]);
  if (!org.value) return <Waiting problem={org.part.problem} />;
  const { sources, since, github, azure_devops } = org.value;
  const setSources = (next: RawSource[]) => {
    setPreview(null);
    org.set({ sources: next });
  };
  const ask = async () => {
    setAsking(true);
    setProblem(null);
    try {
      setPreview(await props.api.previewSources({ sources, since, github, azure_devops }));
    } catch (err) {
      setProblem(message(err));
    } finally {
      setAsking(false);
    }
  };
  return (
    <>
      <div class="card-head" style={{ padding: "0 2px" }}>
        <h2>Repos</h2>
        <span class="note">
          What this org measures, on GitHub, Azure DevOps or both: one company, one report. Changes
          apply from the next sync.
        </span>
      </div>
      <Form
        title="Sources"
        problem={org.part.problem}
        busy={org.part.busy}
        onSave={org.save}
        onCancel={() => {
          org.reset();
          setPreview(null);
        }}
      >
        <SourceList
          sources={sources}
          onChange={setSources}
          repos={[...(props.meta?.repos ?? []), ...seen]}
        />
        <Field label="Measure from" hint="PRs active on or after this day.">
          <input
            type="date"
            value={since}
            onChange={(e) => {
              setPreview(null);
              org.set({ since: e.currentTarget.value });
            }}
          />
        </Field>
        <div class="wide-field step-actions">
          <button type="button" class="button" disabled={asking} onClick={ask}>
            {asking ? "Asking…" : "Show what this measures"}
          </button>
        </div>
        {problem && <p class="problem wide-field">{problem}</p>}
        {preview && (
          <div class="wide-field">
            <PreviewTable preview={preview} />
          </div>
        )}
        <Saved show={org.saved} />
      </Form>
      <NoLongerMeasured {...props} saved={org.saved} />
      <LocalCopies {...props} />
    </>
  );
}

/**
 * Which repos codeflow keeps a git copy of (decision D46): what it gives, what it costs, and each
 * copy's size and freshness. Saved to org.yml's `local_copies`; copies are made at the next sync.
 */
function LocalCopies(props: SectionProps) {
  const org = useOrg(props);
  const [status, setStatus] = useState<{ git: string | null; copies: CopyRow[] } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    props.api.copies().then(setStatus, () => setStatus({ git: null, copies: [] }));
  }, [props.api, org.saved]);
  if (!org.value) return null;
  const chosen = org.value.local_copies ?? [];
  const unwanted = status?.copies.filter((c) => !c.wanted && c.bytes !== null) ?? [];
  const mb = (bytes: number) => `${num(Math.max(1, Math.round(bytes / 1_048_576)))} MB`;
  return (
    <Form
      title="Local copies (optional)"
      problem={org.part.problem}
      busy={org.part.busy}
      onSave={org.save}
      onCancel={org.reset}
    >
      <div class="wide-field vstack">
        <p style={{ margin: 0 }}>
          codeflow reads everything through GitHub's and Azure DevOps's APIs. For the repos you
          choose here, it can also keep a copy of the repo's git history on this machine, and read
          more from it:
        </p>
        <ul class="plain-list">
          <li>
            <b>Exact PR sizes on Azure DevOps</b>, with fewer requests (its API counts lines ten
            files at a time).
          </li>
          <li>
            <b>Changed after review on Azure DevOps</b>: its API doesn't give lines per commit.
          </li>
          <li>
            <b>Lines rewritten soon</b>, on either host: of the lines a PR added, how many were
            changed again within the churn window, line by line rather than file by file.
          </li>
        </ul>
        <p class="muted" style={{ margin: 0 }}>
          What it costs: the repo's source code is stored on this machine (in the org's data folder,
          never shared or uploaded), and as much disk as a clone of the repo. The first sync
          downloads its history; later syncs fetch only what's new. GitHub repos already get exact
          sizes and rework from GitHub's API, so for them a copy adds only line-level churn.
        </p>
        {status && status.git === null && (
          <p class="problem">
            git isn't installed on this machine, or isn't on the PATH: local copies need it
            (git-scm.com).
          </p>
        )}
      </div>
      <Picker
        label="Keep a copy of"
        options={repoOptions(props.meta?.repos ?? [])}
        value={chosen}
        onChange={(local_copies) => org.set({ local_copies })}
        free="Add the pattern"
        placeholder="No repos: search to choose some…"
        hint="Repos, or patterns such as your-org/Project/*. Copies are made at the next sync."
      />
      {status && status.copies.length > 0 && (
        <div class="wide-field table">
          <div class="table-inner" style={{ "--min": "520px" }}>
            <div class="row head" style={{ "--cols": "minmax(200px,2fr) 1fr 1fr" }}>
              <span>Repo</span>
              <span>Copy</span>
              <span>Last fetched</span>
            </div>
            {status.copies.map((row) => (
              <div
                key={row.repo}
                class="row dense"
                style={{ "--cols": "minmax(200px,2fr) 1fr 1fr" }}
              >
                <span>{row.repo}</span>
                <span class="soft">
                  {row.bytes === null
                    ? "made at the next sync"
                    : row.wanted
                      ? mb(row.bytes)
                      : `${mb(row.bytes)}, no longer kept`}
                </span>
                <span class="soft">
                  {row.fetchedAt ? new Date(row.fetchedAt).toLocaleString() : "—"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
      {unwanted.length > 0 && (
        <div class="wide-field step-actions">
          <button
            type="button"
            class="button"
            onClick={async () => {
              setProblem(null);
              try {
                const { removed } = await props.api.cleanCopies();
                setNote(`Deleted the copies of ${removed.join(", ")}.`);
                setStatus(await props.api.copies());
              } catch (err) {
                setProblem(message(err));
              }
            }}
          >
            Delete copies no longer kept ({mb(unwanted.reduce((n, c) => n + (c.bytes ?? 0), 0))})
          </button>
        </div>
      )}
      {note && <p class="muted wide-field">{note}</p>}
      <Problem text={problem} />
      <Saved show={org.saved} />
    </Form>
  );
}

/**
 * Repos stored under an earlier, wider source that no source selects now (decision D43): listed,
 * and their data removed after a second click. Until then they stay in the report.
 */
function NoLongerMeasured(props: SectionProps & { saved: boolean }) {
  const [repos, setRepos] = useState<Unmeasured[] | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    props.api.unmeasured().then(
      (r) => setRepos(r.repos),
      () => setRepos([]),
    );
  }, [props.api, props.saved]);
  if (done) return <p class="muted">{done}</p>;
  if (!repos || repos.length === 0) return null;
  const prs = repos.reduce((n, r) => n + r.prs, 0);
  const remove = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const { removed } = await props.api.prune();
      setDone(
        `Removed the data of ${removed.length === 1 ? "1 repo" : `${num(removed.length)} repos`}.`,
      );
      props.onSaved();
    } catch (err) {
      setProblem(message(err));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };
  return (
    <section class="card vstack" aria-labelledby="no-longer-measured">
      <div class="card-head">
        <h2 id="no-longer-measured">Stored, but no longer measured</h2>
        <span class="note">
          These were synced under an earlier source. They stay in the report until their data is
          removed.
        </span>
      </div>
      <ul class="skipped">
        {repos.map((repo) => (
          <li key={repo.id}>
            {repo.fullName} <span class="muted">· {num(repo.prs)} PRs</span>
          </li>
        ))}
      </ul>
      <Problem text={problem} />
      <div class="step-actions">
        {confirming ? (
          <>
            <button type="button" class="button primary" disabled={busy} onClick={remove}>
              {busy
                ? "Removing…"
                : `Remove ${num(prs)} PRs from ${repos.length === 1 ? "1 repo" : `${num(repos.length)} repos`}`}
            </button>
            <button type="button" class="button" onClick={() => setConfirming(false)}>
              Keep them
            </button>
            <span class="muted">
              Only this machine's copy; syncing them again brings them back.
            </span>
          </>
        ) : (
          <button type="button" class="button" onClick={() => setConfirming(true)}>
            Remove their data…
          </button>
        )}
      </div>
    </section>
  );
}

// Branches -------------------------------------------------------------------------------------

export function Branches(props: SectionProps) {
  const org = useOrg(props);
  const [synced, setSynced] = useState<SyncedRepos | null>(null);
  useEffect(() => {
    props.api.repos().then(setSynced, () => setSynced({ repos: [], advice: [], branches: [] }));
  }, [props.api, org.saved]);
  if (!org.value) return <Waiting problem={org.part.problem} />;
  const rows = Object.entries(org.value.branches);
  const repos = repoOptions(synced?.repos.map((r) => r.fullName) ?? []);
  const branches_ = branchOptions(synced?.branches ?? [], [
    ...new Set(synced?.repos.map((r) => r.defaultBranch) ?? []),
  ]);
  const setRows = (next: [string, string[]][]) => org.set({ branches: Object.fromEntries(next) });
  const cols = "minmax(180px,2fr) 130px minmax(160px,1.5fr) 220px";
  return (
    <>
      <div class="card-head" style={{ padding: "0 2px" }}>
        <h2>Branches</h2>
        <span class="note">
          A PR counts where it lands on a measured branch: each repo's default branch unless you say
          otherwise. PRs from long-lived branches (promotions) aren't counted again.
        </span>
      </div>
      {synced && synced.repos.length > 0 && (
        <section class="card flush">
          <div class="table">
            <div class="table-inner" style={{ "--min": "640px" }}>
              <div class="row head" style={{ "--cols": cols }}>
                <span>Repo</span>
                <span>Default branch</span>
                <span>Measured</span>
                <span />
              </div>
              {synced.repos.map((repo) => {
                const advice = synced.advice.find((a) => a.repo === repo.fullName);
                return (
                  <div key={repo.fullName} class="row dense" style={{ "--cols": cols }}>
                    <span>{repo.fullName}</span>
                    <span class="soft">{repo.defaultBranch}</span>
                    <span class="soft">{repo.measured.join(", ")}</span>
                    <span>
                      {advice && (
                        <button
                          type="button"
                          class="link-button"
                          title={`${advice.into} of ${advice.merged} PRs merged in the last 90 days went into ${advice.branch}`}
                          onClick={() =>
                            setRows([
                              ...rows.filter(([pattern]) => pattern !== repo.fullName),
                              [repo.fullName, [...new Set([...repo.measured, advice.branch])]],
                            ])
                          }
                        >
                          Work lands on {advice.branch}: measure it
                        </button>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      )}
      <Form
        title="Measured branches and promotions"
        problem={org.part.problem}
        busy={org.part.busy}
        onSave={org.save}
        onCancel={org.reset}
      >
        <div class="wide-field vstack">
          <span class="field-label">Measure other branches</span>
          {rows.length === 0 && (
            <span class="field-hint">None: every repo is measured on its default branch.</span>
          )}
          {rows.map(([pattern, branches], i) => (
            <div key={i} class="choice-card">
              <Picker
                label="Repos"
                options={repos}
                value={pattern ? [pattern] : []}
                onChange={(picked) =>
                  setRows(rows.map((r, j) => (j === i ? [picked.at(-1) ?? "", r[1]] : r)))
                }
                free="Add the pattern"
                hint="One repo, or a pattern such as your-org/legacy-*."
              />
              <Picker
                label="Branches"
                options={branches_}
                value={branches}
                onChange={(picked) => setRows(rows.map((r, j) => (j === i ? [r[0], picked] : r)))}
                free="Add the branch"
                hint="Every branch to measure in it, its default branch too if it still counts."
              />
              <button
                type="button"
                class="link-button"
                onClick={() => setRows(rows.filter((_, j) => j !== i))}
              >
                Remove
              </button>
            </div>
          ))}
          <button type="button" class="link-button" onClick={() => setRows([...rows, ["", []]])}>
            + Measure another branch
          </button>
        </div>
        <Picker
          label="Promotion branches"
          options={branches_}
          value={org.value.promotions}
          onChange={(promotions) => org.set({ promotions })}
          free="Add the branch"
          hint="A PR from one of these same-repo branches moves work already counted, so it isn't counted again."
        />
        <Saved show={org.saved} />
      </Form>
    </>
  );
}

// Bots -----------------------------------------------------------------------------------------

export function Bots(props: SectionProps) {
  const org = useOrg(props);
  const accounts = useAccounts(props.api);
  if (!org.value) return <Waiting problem={org.part.problem} />;
  const bots = org.value.bots;
  const set = (patch: Partial<OrgRaw["bots"]>) => org.set({ bots: { ...bots, ...patch } });
  return (
    <>
      <div class="card-head" style={{ padding: "0 2px" }}>
        <h2>Bots</h2>
        <span class="note">
          Accounts GitHub marks as bots are already handled: their PRs aren't counted and their
          reviews aren't review. Name more here.
        </span>
      </div>
      <Form
        title="Bots"
        problem={org.part.problem}
        busy={org.part.busy}
        onSave={org.save}
        onCancel={org.reset}
      >
        <Picker
          label="Also bots"
          options={accounts.accounts}
          value={bots.accounts ?? []}
          onChange={(picked) => set({ accounts: picked })}
          placeholder="Search accounts…"
          free="Add the account or pattern"
          hint="Service accounts the host doesn't mark as bots. A pattern such as release-* takes in more."
        />
        <Picker
          label="Bots whose reviews count"
          options={accounts.bots}
          value={bots.reviewers ?? []}
          onChange={(reviewers) => set({ reviewers })}
          placeholder="Search bots…"
          free="Add the account"
          hint="Review bots whose approvals are real review."
        />
        <Choice
          label="Bots' own PRs"
          value={bots.include_prs}
          onChange={(include_prs) => set({ include_prs })}
          unset="Counted (the default)"
          yes="Counted"
          no="Not counted"
          hint="PRs that bots open, such as dependency bumps. Not counted: the report measures only people's PRs."
        />
        <List
          label="Ignore comments matching"
          lines
          value={bots.ignore_bodies ?? []}
          onChange={(ignore_bodies) => set({ ignore_bodies })}
          placeholder="^Thanks for opening this pull request"
          hint="Regular expressions, one per line: boilerplate that isn't review."
        />
        <Saved show={org.saved} />
      </Form>
    </>
  );
}

// Paths ----------------------------------------------------------------------------------------

const BUCKETS = ["product", "test", "docs", "generated", "vendored", "lockfile"];

export function Paths(props: SectionProps) {
  const org = useOrg(props);
  const [repos, setRepos] = useState<string[]>([]);
  useEffect(() => {
    props.api.repos().then(
      (synced) => setRepos(synced.repos.map((r) => r.fullName)),
      () => setRepos([]),
    );
  }, [props.api]);
  if (!org.value) return <Waiting problem={org.part.problem} />;
  const paths = org.value.paths;
  const setPaths = (next: OrgRaw["paths"]) => org.set({ paths: next });
  const list = (value: string | string[]) => (Array.isArray(value) ? value : [value]);
  const split = (text: string) =>
    text
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  return (
    <>
      <div class="card-head" style={{ padding: "0 2px" }}>
        <h2>Paths</h2>
        <span class="note">
          PR size counts product code only. Common tests, docs, generated and vendored files and
          lockfiles are recognized already; add your own here. The first match wins.
        </span>
      </div>
      <Form
        title="Path rules"
        problem={org.part.problem}
        busy={org.part.busy}
        onSave={org.save}
        onCancel={org.reset}
      >
        <div class="wide-field vstack">
          {paths.length === 0 && <span class="field-hint">No rules of your own yet.</span>}
          {paths.map((rule, i) => (
            <div key={i} class="choice-card">
              <div class="path-row wide-path">
                <input
                  type="text"
                  aria-label="Files"
                  value={list(rule.match).join(", ")}
                  placeholder="e2e/**, *.snap"
                  onChange={(e) =>
                    setPaths(
                      paths.map((r, j) =>
                        j === i ? { ...r, match: split(e.currentTarget.value) } : r,
                      ),
                    )
                  }
                />
                <select
                  aria-label="Bucket"
                  value={rule.bucket}
                  onChange={(e) =>
                    setPaths(
                      paths.map((r, j) => (j === i ? { ...r, bucket: e.currentTarget.value } : r)),
                    )
                  }
                >
                  {BUCKETS.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  class="link-button"
                  onClick={() => setPaths(paths.filter((_, j) => j !== i))}
                >
                  Remove
                </button>
              </div>
              <Picker
                label="Only in repos"
                options={repoOptions(repos)}
                value={rule.repos ?? []}
                placeholder="Every repo; search to narrow…"
                free="Add the pattern"
                onChange={(picked) =>
                  setPaths(
                    paths.map((r, j) =>
                      j === i
                        ? {
                            match: r.match,
                            bucket: r.bucket,
                            ...(picked.length ? { repos: picked } : {}),
                          }
                        : r,
                    ),
                  )
                }
              />
            </div>
          ))}
          <button
            type="button"
            class="link-button"
            onClick={() => setPaths([...paths, { match: [], bucket: "test" }])}
          >
            + Add a rule
          </button>
        </div>
        <Saved show={org.saved} />
      </Form>
    </>
  );
}

// Sync -----------------------------------------------------------------------------------------

export function Sync(props: SectionProps) {
  const status = useStatus(props.api, 2000);
  const [problem, setProblem] = useState<string | null>(null);
  const running = status?.running || status?.queued;
  return (
    <>
      <div class="card-head" style={{ padding: "0 2px" }}>
        <h2>Sync</h2>
        <span class="note">
          Fetches PRs changed since the last sync. codeflow syncs on the org's schedule while it
          runs; sync now to get changes at once.
        </span>
      </div>
      <section class="card vstack" aria-live="polite">
        {status === null ? (
          <p class="muted">Loading…</p>
        ) : (
          <>
            <p>
              {status.lastSync
                ? `Last synced ${new Date(status.lastSync).toLocaleString()}.`
                : "Not synced yet."}{" "}
              {status.every === "off"
                ? "No schedule: sync by hand."
                : status.nextSync
                  ? `Next, on the ${status.every} schedule: ${new Date(status.nextSync).toLocaleString()}.`
                  : `Schedule: every ${status.every}, while codeflow serve runs without --no-schedule.`}
            </p>
            {running && (
              <p>
                <span class="spinner" aria-hidden="true" />{" "}
                {status.queued && !status.running
                  ? "Waiting for another org's sync…"
                  : (status.progress ?? "Syncing…")}
              </p>
            )}
            {status.lastError && !running && (
              <p class="problem">The last sync stopped: {status.lastError}</p>
            )}
            {status.log.length > 0 && <pre class="sync-log">{status.log.join("\n")}</pre>}
            <div class="step-actions">
              <button
                type="button"
                class="button primary"
                disabled={running}
                onClick={async () => {
                  setProblem(null);
                  try {
                    await props.api.syncNow();
                  } catch (err) {
                    setProblem(message(err));
                  }
                }}
              >
                {running ? "Syncing…" : "Sync now"}
              </button>
            </div>
          </>
        )}
        <Problem text={problem} />
      </section>
      <FetchAgain {...props} running={running === true} />
    </>
  );
}

/**
 * Clears chosen repos' stored PRs and syncs them whole again: for data read wrongly before a fix
 * (Azure DevOps sizes, say), or fields codeflow asks for now and didn't then (commit lines).
 */
function FetchAgain(props: SectionProps & { running: boolean }) {
  const [repos, setRepos] = useState<string[]>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [done, setDone] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    props.api.repos().then(
      (synced) => setRepos(synced.repos.map((r) => r.fullName)),
      () => setRepos([]),
    );
  }, [props.api]);
  if (repos.length === 0) return null;
  return (
    <section class="card vstack" aria-labelledby="fetch-again">
      <div class="card-head">
        <h2 id="fetch-again">Fetch repos again</h2>
        <span class="note">
          Clears what is stored for them and fetches every PR again: after an update that reads
          more, or reads something better. A first sync's time again, for these repos.
        </span>
      </div>
      <Picker
        label="Repos"
        options={repoOptions(repos)}
        value={chosen}
        onChange={(next) => {
          setChosen(next);
          setDone(null);
        }}
        free="Add the pattern"
        hint="Every repo of an Azure DevOps project: your-org/Project/*."
      />
      <Problem text={problem} />
      {done && <p class="muted">{done}</p>}
      <div class="step-actions">
        <button
          type="button"
          class="button"
          disabled={chosen.length === 0 || busy || props.running}
          onClick={async () => {
            setBusy(true);
            setProblem(null);
            try {
              const { cleared } = await props.api.refetch(chosen);
              setDone(
                cleared.length === 0
                  ? "No synced repo matches."
                  : `Cleared ${cleared.map((r) => r.fullName).join(", ")}: syncing them again now.`,
              );
              setChosen([]);
              props.onSaved();
            } catch (err) {
              setProblem(message(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          {props.running ? "Wait for the sync to finish" : "Clear and fetch again"}
        </button>
      </div>
    </section>
  );
}

// Settings -------------------------------------------------------------------------------------

const SCHEDULES = ["6h", "12h", "24h", "7d", "off"];

export function Settings(props: SectionProps) {
  const org = useOrg(props);
  const [check, setCheck] = useState<GitHubCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [adoCheck, setAdoCheck] = useState<AdoCheck | null>(null);
  const [adoChecking, setAdoChecking] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (!org.value) return <Waiting problem={org.part.problem} />;
  const value = org.value;
  const runCheck = async () => {
    setChecking(true);
    setCheck(await props.api.checkGitHub(value.github));
    setChecking(false);
  };
  return (
    <>
      <div class="card-head" style={{ padding: "0 2px" }}>
        <h2>Settings</h2>
        <span class="note">How this org's data is kept current, and how its report reads it.</span>
      </div>
      <Form
        title="Report settings"
        problem={org.part.problem}
        busy={org.part.busy}
        onSave={org.save}
        onCancel={org.reset}
      >
        <Text
          label="Sync every"
          value={value.sync_every}
          onChange={(sync_every) => org.set({ sync_every: sync_every.trim() })}
          list="schedules"
          hint="While codeflow serve runs: a number and m, h or d, or off. 24h is daily."
        />
        <datalist id="schedules">
          {SCHEDULES.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
        <Field
          label="Stale after (days)"
          hint="An open PR with no activity by a person for longer is stale: listed apart from the PRs open now."
        >
          <input
            type="number"
            min={1}
            max={3650}
            value={value.stale_after_days}
            onInput={(e) => org.set({ stale_after_days: Number(e.currentTarget.value) })}
          />
        </Field>
        <Field
          label="Size target (lines)"
          hint="PRs at or under this many lines of product code are within the target. Small PRs are reviewed sooner and more closely."
        >
          <input
            type="number"
            min={1}
            max={100000}
            value={value.size_target_lines}
            onInput={(e) => org.set({ size_target_lines: Number(e.currentTarget.value) })}
          />
        </Field>
        <Text
          label="Ticket IDs, to count a fix once"
          value={value.ticket_pattern ?? ""}
          onChange={(ticket_pattern) => org.set({ ticket_pattern: ticket_pattern.trim() })}
          placeholder="\b(?:ADO-)?(\d{5})\b"
          hint={
            "How your ticket IDs look, as a regular expression; the part in brackets is the ID, so ADO-12340 and 12340 are one ticket. A PR names them in its branch, title or description. When a ticket's fix lands on one branch (prod) and later on another (develop), only the first counts. Several PRs for one ticket into the same branch all count. Empty: off."
          }
        />
        <Choice
          label="Azure DevOps: count a fix once by its work items"
          value={value.duplicates_by_work_item}
          onChange={(on) => org.set({ duplicates_by_work_item: on ?? false })}
          unset="Off (the default)"
          yes="On"
          no="Off"
          hint="On: PRs linked to the same work item are one fix, as a ticket ID in the title is. Each PR read asks for its links: one more request per PR, once (Setup › Sync › Fetch repos again reads PRs synced before)."
        />
        <Field
          label="Changed again within (days)"
          hint="A merged PR whose product files another PR changes within this many days counts as changed again soon (churn)."
        >
          <input
            type="number"
            min={1}
            max={365}
            value={value.churn_window_days}
            onInput={(e) => org.set({ churn_window_days: Number(e.currentTarget.value) })}
          />
        </Field>
        <Field
          label="People views"
          hint="On: the report can show one person's numbers and name reviewers. Off: teams, groups and repos only."
        >
          <select
            value={value.people_views ? "on" : "off"}
            onChange={(e) => org.set({ people_views: e.currentTarget.value === "on" })}
          >
            <option value="on">On</option>
            <option value="off">Off</option>
          </select>
        </Field>
        <h3 class="form-section">Connection to GitHub</h3>
        <Text
          label="API address"
          value={value.github.api_url ?? ""}
          onChange={(api_url) =>
            org.set({ github: { ...value.github, api_url: api_url || undefined } })
          }
          placeholder="https://api.github.com"
          hint="Only for GitHub Enterprise Server: https://<your host>/api/v3"
        />
        <Text
          label="Token variable"
          value={value.github.token_env ?? ""}
          onChange={(token_env) =>
            org.set({ github: { ...value.github, token_env: token_env || undefined } })
          }
          placeholder="GITHUB_TOKEN"
          hint="Where codeflow finds the token. codeflow never stores tokens in its files."
        />
        <div class="wide-field">
          {check || checking ? (
            <GitHubStatus check={check} busy={checking} onCheck={runCheck} />
          ) : (
            <button type="button" class="button" onClick={runCheck}>
              Check the connection
            </button>
          )}
        </div>
        <h3 class="form-section">Connection to Azure DevOps</h3>
        <Text
          label="Server address"
          value={value.azure_devops?.url ?? ""}
          onChange={(url) =>
            org.set({ azure_devops: { ...value.azure_devops, url: url || undefined } })
          }
          placeholder="https://dev.azure.com"
          hint="Only for Azure DevOps Server: its address, such as https://tfs.acme.com/tfs"
        />
        <Text
          label="Azure DevOps token variable"
          value={value.azure_devops?.token_env ?? ""}
          onChange={(token_env) =>
            org.set({ azure_devops: { ...value.azure_devops, token_env: token_env || undefined } })
          }
          placeholder="AZURE_DEVOPS_TOKEN"
          hint="A personal access token with Code (Read) and Project and Team (Read), or sign in with the Azure CLI (az login)."
        />
        <div class="wide-field">
          <AdoStatus
            check={adoCheck}
            busy={adoChecking}
            onCheck={async () => {
              setAdoChecking(true);
              const source = value.sources.find(
                (s): s is { ado: string; project?: string } => "ado" in s,
              );
              setAdoCheck(
                await props.api.checkAdo({
                  ...value.azure_devops,
                  organization: source?.ado,
                  project: source?.project,
                }),
              );
              setAdoChecking(false);
            }}
          />
        </div>
        <Saved show={org.saved} />
      </Form>
      <section class="card vstack">
        <h2 style={{ fontSize: "14px" }}>Other orgs</h2>
        <p class="muted">
          <a href="/welcome/">Add another org</a>. Or take {props.api.org} off the list: its files
          and data stay where they are, so adding it back to codeflow.yml restores it.
        </p>
        <div class="step-actions">
          {removing ? (
            <>
              <button
                type="button"
                class="button"
                onClick={async () => {
                  try {
                    await props.api.remove();
                    location.assign("/");
                  } catch (err) {
                    setProblem(message(err));
                    setRemoving(false);
                  }
                }}
              >
                Yes, take {props.api.org} off the list
              </button>
              <button type="button" class="link-button" onClick={() => setRemoving(false)}>
                Keep it
              </button>
            </>
          ) : (
            <button type="button" class="button" onClick={() => setRemoving(true)}>
              Take {props.api.org} off the list
            </button>
          )}
        </div>
        <Problem text={problem} />
      </section>
    </>
  );
}
