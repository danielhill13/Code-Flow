// Setup sections for what an org measures and how (decision D39): its repos, branches, bots and
// file paths, its sync, and its settings. They edit org.yml through the server, which checks each
// save as a whole; each section sends only the keys it shows, so the rest of the file is untouched.
import { useEffect, useState } from "preact/hooks";
import { AdoStatus, GitHubStatus, PreviewTable, useStatus } from "../welcome.tsx";
import type {
  AdoCheck,
  AdoSettings,
  GitHubCheck,
  GitHubSettings,
  RawSource,
  SourcesPreview,
  SyncedRepos,
} from "./api.ts";
import { Choice, Field, List, Problem, Text } from "./fields.tsx";
import { Form, message, type SectionProps, usePart, Waiting } from "./kit.tsx";
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
        <SourceList sources={sources} onChange={setSources} />
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
    </>
  );
}

// Branches -------------------------------------------------------------------------------------

export function Branches(props: SectionProps) {
  const org = useOrg(props);
  const [synced, setSynced] = useState<SyncedRepos | null>(null);
  useEffect(() => {
    props.api.repos().then(setSynced, () => setSynced({ repos: [], advice: [] }));
  }, [props.api, org.saved]);
  if (!org.value) return <Waiting problem={org.part.problem} />;
  const rows = Object.entries(org.value.branches);
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
            <div key={i} class="pair-row">
              <input
                type="text"
                aria-label="Repos"
                value={pattern}
                placeholder="your-org/legacy-*"
                onInput={(e) =>
                  setRows(rows.map((r, j) => (j === i ? [e.currentTarget.value, r[1]] : r)))
                }
              />
              <input
                type="text"
                aria-label="Branches"
                value={branches.join(", ")}
                placeholder="main, develop"
                onChange={(e) =>
                  setRows(
                    rows.map((r, j) =>
                      j === i
                        ? [
                            r[0],
                            e.currentTarget.value
                              .split(",")
                              .map((b) => b.trim())
                              .filter(Boolean),
                          ]
                        : r,
                    ),
                  )
                }
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
        <List
          label="Promotion branches"
          value={org.value.promotions}
          onChange={(promotions) => org.set({ promotions })}
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
        <List
          label="Also bots"
          value={bots.accounts ?? []}
          onChange={(accounts) => set({ accounts })}
          placeholder="deploy-svc, release-*"
          hint="Service accounts GitHub doesn't mark as bots."
        />
        <List
          label="Bots whose reviews count"
          value={bots.reviewers ?? []}
          onChange={(reviewers) => set({ reviewers })}
          placeholder="review-assistant[bot]"
        />
        <Choice
          label="Bots' own PRs"
          value={bots.include_prs}
          onChange={(include_prs) => set({ include_prs })}
          unset="Not counted"
          yes="Counted"
          no="Not counted"
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
            <div key={i} class="path-row wide-path">
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
              <input
                type="text"
                aria-label="Only in repos"
                value={(rule.repos ?? []).join(", ")}
                placeholder="every repo"
                onChange={(e) => {
                  const repos = split(e.currentTarget.value);
                  setPaths(
                    paths.map((r, j) =>
                      j === i
                        ? { match: r.match, bucket: r.bucket, ...(repos.length ? { repos } : {}) }
                        : r,
                    ),
                  );
                }}
              />
              <button
                type="button"
                class="link-button"
                onClick={() => setPaths(paths.filter((_, j) => j !== i))}
              >
                Remove
              </button>
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
    </>
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
          hint="A personal access token with Code (Read), or sign in with the Azure CLI (az login)."
        />
        <div class="wide-field">
          <AdoStatus
            check={adoCheck}
            busy={adoChecking}
            onCheck={async () => {
              setAdoChecking(true);
              const organization = value.sources.find((s): s is { ado: string } => "ado" in s)?.ado;
              setAdoCheck(await props.api.checkAdo({ ...value.azure_devops, organization }));
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
