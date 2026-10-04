// The first steps, at /welcome/ under `codeflow serve` (decisions D39, D40): connect to GitHub,
// Azure DevOps or both, say what to measure and see what that means, then create the org and
// watch its first sync. Everything
// lands in the same files `codeflow init` writes; nothing here needs a terminal.
import { useEffect, useRef, useState } from "preact/hooks";
import { duration, num } from "../core/format.ts";
import {
  type AdminApi,
  type AdoCheck,
  type AdoSettings,
  type GitHubCheck,
  type GitHubSettings,
  type RawSource,
  ServerAdmin,
  type SourcesPreview,
  type SyncStatus,
  type WorkspaceInfo,
  workspaceApi,
} from "./admin/api.ts";
import { Field, Problem, Text } from "./admin/fields.tsx";
import { blank, kindOf, SourceList } from "./admin/sources.tsx";

export function Welcome() {
  const [info, setInfo] = useState<WorkspaceInfo | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const load = () => workspaceApi.info().then(setInfo, (err: unknown) => setProblem(message(err)));
  useEffect(() => {
    load();
  }, []);
  return (
    <>
      <header class="header">
        <div class="wrap bar-row">
          <span class="logo">codeflow</span>
          {info && info.orgs.length > 0 && (
            <nav class="welcome-orgs" aria-label="Orgs">
              {info.orgs.map((org) => (
                <a key={org.name} href={`/orgs/${encodeURIComponent(org.name)}/`}>
                  {org.name}
                </a>
              ))}
            </nav>
          )}
        </div>
      </header>
      <main class="wrap welcome" data-view="" data-ready={info ? "true" : "false"}>
        <div class="heading">
          <h1>{info && info.orgs.length > 0 ? "Add an org" : "Set up codeflow"}</h1>
          <p>
            Three steps: connect to your code, choose what to measure, then let the first sync run.
            Everything is saved to config files you can also edit by hand.
          </p>
        </div>
        <Problem text={problem} />
        {info?.single ? <Convert onDone={load} /> : info && <Steps info={info} />}
      </main>
    </>
  );
}

/** A single-file config from before workspaces: it becomes a workspace before orgs can be added. */
function Convert({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <section class="card setup-step">
      <h2>Your config measures one org</h2>
      <p class="muted">
        codeflow.yml is a single-org config from before workspaces. Give its org a name to turn it
        into a workspace: its settings move to orgs/&lt;name&gt;/, its data comes along, and you can
        add more orgs. The old file is kept as codeflow.yml.single.bak.
      </p>
      <form
        class="inline-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setProblem(null);
          try {
            await workspaceApi.convert(name.trim());
            onDone();
          } catch (err) {
            setProblem(message(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Text label="Org name" value={name} onChange={setName} placeholder="acme" />
        <button type="submit" class="button primary" disabled={busy || !name.trim()}>
          {busy ? "Converting…" : "Convert"}
        </button>
      </form>
      <Problem text={problem} />
    </section>
  );
}

function Steps({ info }: { info: WorkspaceInfo }) {
  const [github, setGitHub] = useState<GitHubSettings>({});
  const [ado, setAdo] = useState<AdoSettings>({});
  const [check, setCheck] = useState<GitHubCheck | null>(null);
  const [adoCheck, setAdoCheck] = useState<AdoCheck | null>(null);
  const [sources, setSources] = useState<RawSource[]>([{ owner: "" }]);
  const [name, setName] = useState("");
  const [since, setSince] = useState(info.since);
  const [preview, setPreview] = useState<SourcesPreview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [previewProblem, setPreviewProblem] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [adoChecking, setAdoChecking] = useState(false);
  const [busy, setBusy] = useState<"preview" | "create" | null>(null);
  const [created, setCreated] = useState<string | null>(null);

  const filled = sources.filter((source) => !blank(source));
  const onGitHub = filled.some((source) => kindOf(source) !== "ado");
  const onAdo = filled.some((source) => kindOf(source) === "ado");
  const first = filled[0];
  const suggested = (
    !first
      ? ""
      : "ado" in first
        ? first.ado
        : "repo" in first
          ? (first.repo.split("/")[0] ?? "")
          : first.owner
  )
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const orgName = name.trim() || suggested;
  const taken = info.orgs.some((org) => org.name === orgName);

  const runCheck = async () => {
    setChecking(true);
    setCheck(await workspaceApi.checkGitHub(github));
    setChecking(false);
  };
  // The Azure DevOps check follows the source being typed: it names the organization (and the
  // project) to check, so "connected" means codeflow can read what step 2 asks for. Only the
  // latest check's answer is shown.
  const adoSource = filled.find((s): s is { ado: string; project?: string } => "ado" in s);
  const adoTarget = [
    adoSource?.ado ?? "",
    adoSource?.project ?? "",
    ado.url ?? "",
    ado.token_env ?? "",
  ];
  const latest = useRef(0);
  const runAdoCheck = async () => {
    const mine = ++latest.current;
    setAdoChecking(true);
    const result = await workspaceApi.checkAdo({
      ...ado,
      organization: adoSource?.ado,
      project: adoSource?.project,
    });
    if (mine !== latest.current) return;
    setAdoCheck(result);
    setAdoChecking(false);
  };
  useEffect(() => {
    runCheck();
  }, []);
  useEffect(() => {
    const timer = setTimeout(runAdoCheck, adoCheck === null ? 0 : 700);
    return () => clearTimeout(timer);
  }, adoTarget);

  const runPreview = async () => {
    setBusy("preview");
    setPreviewProblem(null);
    try {
      setPreview(
        await workspaceApi.previewSources({ sources: filled, since, github, azure_devops: ado }),
      );
    } catch (err) {
      setPreview(null);
      setPreviewProblem(message(err));
    } finally {
      setBusy(null);
    }
  };

  const create = async () => {
    setBusy("create");
    setProblem(null);
    try {
      const made = await workspaceApi.createOrg({
        name: orgName,
        owners: filled.flatMap((s) => ("owner" in s ? [s.owner] : [])),
        repos: filled.flatMap((s) => ("repo" in s ? [s.repo] : [])),
        ado: filled.flatMap((s) =>
          "ado" in s ? [{ organization: s.ado, project: s.project, include: s.include }] : [],
        ),
        since,
        github,
        azure_devops: ado,
      });
      await new ServerAdmin(made.name).syncNow();
      setCreated(made.name);
    } catch (err) {
      setProblem(message(err));
    } finally {
      setBusy(null);
    }
  };

  const found = preview?.sources.reduce((n, s) => n + s.repos.length, 0) ?? 0;
  const unread = preview?.sources.filter((s) => s.error).map((s) => s.name) ?? [];
  const githubReady = !onGitHub || check?.ok === true;
  const adoReady = !onAdo || adoCheck?.ok === true;
  const ready = githubReady && adoReady;
  const checks = checking || adoChecking;
  return (
    <div class="steps">
      <section class="card setup-step" aria-labelledby="step-connect">
        <h2 id="step-connect">
          <span class="step-n">1</span> Connect to your code
        </h2>
        <p class="muted">
          GitHub, Azure DevOps, or both: one org can measure repos on each, as one company. Connect
          the ones you use.
        </p>
        <h3 class="form-section">GitHub</h3>
        <GitHubStatus check={check} busy={checking} onCheck={runCheck} />
        <details class="advanced">
          <summary>GitHub Enterprise, or a token in another variable</summary>
          <div class="form">
            <Text
              label="API address"
              value={github.api_url ?? ""}
              onChange={(api_url) => setGitHub({ ...github, api_url })}
              placeholder="https://api.github.com"
              hint="For GitHub Enterprise Server: https://<your host>/api/v3"
            />
            <Text
              label="Token variable"
              value={github.token_env ?? ""}
              onChange={(token_env) => setGitHub({ ...github, token_env })}
              placeholder="GITHUB_TOKEN"
              hint="The environment variable codeflow reads the token from. codeflow never stores tokens."
            />
          </div>
        </details>
        <h3 class="form-section">Azure DevOps</h3>
        <AdoStatus check={adoCheck} busy={adoChecking} onCheck={runAdoCheck} />
        <details class="advanced">
          <summary>Azure DevOps Server, or a token in another variable</summary>
          <div class="form">
            <Text
              label="Server address"
              value={ado.url ?? ""}
              onChange={(url) => setAdo({ ...ado, url })}
              placeholder="https://dev.azure.com"
              hint="For Azure DevOps Server: its address, such as https://tfs.acme.com/tfs"
            />
            <Text
              label="Azure DevOps token variable"
              value={ado.token_env ?? ""}
              onChange={(token_env) => setAdo({ ...ado, token_env })}
              placeholder="AZURE_DEVOPS_TOKEN"
              hint="The environment variable holding a personal access token. codeflow never stores tokens."
            />
          </div>
        </details>
      </section>

      <section class="card setup-step" aria-labelledby="step-what">
        <h2 id="step-what">
          <span class="step-n">2</span> Choose what to measure
        </h2>
        <div class="form">
          <SourceList
            sources={sources}
            onChange={(next) => {
              setSources(next);
              setPreview(null);
            }}
          />
          <Field
            label="Measure from"
            hint="PRs active on or after this day. A year back is a good start."
          >
            <input
              type="date"
              value={since}
              onChange={(e) => {
                setSince(e.currentTarget.value);
                setPreview(null);
              }}
            />
          </Field>
          <Text
            label="Name in codeflow"
            value={name}
            onChange={setName}
            placeholder={suggested || "acme"}
            hint="Lowercase letters, digits, - and _. It names the org's folder and its address."
          />
        </div>
        <div class="step-actions">
          <button
            type="button"
            class="button"
            disabled={filled.length === 0 || busy !== null || checks || !ready}
            onClick={runPreview}
          >
            {busy === "preview" ? "Asking…" : "Show what this measures"}
          </button>
          {filled.length === 0 && <span class="muted">Name something to measure first.</span>}
          {filled.length > 0 && checks && <span class="muted">Checking the connection…</span>}
        </div>
        {filled.length > 0 && !checks && !ready && (
          <p class="problem">
            {!githubReady
              ? "codeflow can't read GitHub yet: step 1 says why."
              : "codeflow can't read Azure DevOps yet: step 1 says why."}{" "}
            {onGitHub && onAdo
              ? `To start with ${githubReady ? "GitHub" : "Azure DevOps"} alone, remove the ${githubReady ? "Azure DevOps" : "GitHub"} source; add it later in Setup › Repos.`
              : ""}
          </p>
        )}
        <Problem text={previewProblem} />
        {preview && <PreviewTable preview={preview} />}
      </section>

      <section class="card setup-step" aria-labelledby="step-sync">
        <h2 id="step-sync">
          <span class="step-n">3</span> Create the org and sync
        </h2>
        {created ? (
          <FirstSync org={created} />
        ) : (
          <>
            <p class="muted">
              {preview && found > 0
                ? `Creates orgs/${orgName}/ and fetches the PRs of ${found === 1 ? "1 repo" : `${num(found)} repos`}${preview.firstSync ? `, about ${num(preview.firstSync.prs + preview.firstSync.olderOpen)} of them on GitHub` : ""}. You can set up teams while it runs.`
                : "Show what it measures first, so there are no surprises."}
            </p>
            {taken && <p class="problem">There is already an org called {orgName}.</p>}
            {unread.length > 0 && (
              <p class="problem">
                {unread.join(", ")} couldn't be read (above). Fix it, or remove it to start without
                it and add it later in Setup › Repos.
              </p>
            )}
            {preview && found === 0 && unread.length === 0 && (
              <p class="problem">These sources hold no repos codeflow can measure.</p>
            )}
            <button
              type="button"
              class="button primary"
              disabled={
                !preview || found === 0 || unread.length > 0 || busy !== null || taken || !orgName
              }
              onClick={create}
            >
              {busy === "create" ? "Creating…" : `Create ${orgName || "the org"} and start syncing`}
            </button>
          </>
        )}
        <Problem text={problem} />
      </section>
    </div>
  );
}

/** Whether codeflow reads Azure DevOps, and as whom, or how to give it a token. */
export function AdoStatus(props: { check: AdoCheck | null; busy: boolean; onCheck: () => void }) {
  const { check } = props;
  return (
    <div class="github-status" aria-live="polite">
      {check === null ? (
        <p class="muted">Not checked yet.</p>
      ) : check.ok ? (
        <p>
          <span class="ok-mark">✓</span>{" "}
          {check.organization
            ? `Connected to ${check.organization} as ${check.who}`
            : "A token is ready"}
          , from <code>{check.source}</code> ({check.kind}).{" "}
          <span class="muted">
            {check.organization
              ? "codeflow paces its requests to stay inside Azure DevOps's limits."
              : "It's tried on your organization once you name one in step 2."}
          </span>
        </p>
      ) : (
        <div class="vstack">
          <p class="problem">{check.error}</p>
          <p class="muted">
            Make a personal access token in Azure DevOps (User settings › Personal access tokens)
            for your organization, with <b>Code (Read)</b> and <b>Project and Team (Read)</b>. Set
            it in <code>AZURE_DEVOPS_TOKEN</code> in the terminal you start codeflow from, then stop
            codeflow (Ctrl-C) and start it again: a running codeflow can't see a variable set after
            it started. In PowerShell: <code>$env:AZURE_DEVOPS_TOKEN = "…"</code>; in bash or zsh:{" "}
            <code>export AZURE_DEVOPS_TOKEN=…</code>. Or sign in with the Azure CLI (
            <code>az login</code>) and check again. codeflow never stores tokens in its files.
          </p>
        </div>
      )}
      <button type="button" class="button" disabled={props.busy} onClick={props.onCheck}>
        {props.busy ? "Checking…" : "Check again"}
      </button>
    </div>
  );
}

export function GitHubStatus(props: {
  check: GitHubCheck | null;
  busy: boolean;
  onCheck: () => void;
}) {
  const { check } = props;
  return (
    <div class="github-status" aria-live="polite">
      {check === null ? (
        <p class="muted">Checking…</p>
      ) : check.ok ? (
        <p>
          <span class="ok-mark">✓</span> Connected as <b>{check.login}</b>, with the token from{" "}
          <code>{check.source}</code> ({check.kind}).{" "}
          <span class="muted">
            {num(check.remaining)} of {num(check.limit)} points left this hour.
            {check.writeScopes.length > 0 &&
              " It can also write; codeflow only reads, so a read-only token is enough."}
          </span>
        </p>
      ) : (
        <div class="vstack">
          <p class="problem">{check.error}</p>
          <p class="muted">
            Give codeflow a token one of two ways, then check again. With the GitHub CLI, run{" "}
            <code>gh auth login</code> in a terminal. Or make a token (read-only is enough) at
            github.com › Settings › Developer settings, and start codeflow with it in{" "}
            <code>GITHUB_TOKEN</code>. codeflow never stores tokens in its files.
          </p>
        </div>
      )}
      <button type="button" class="button" disabled={props.busy} onClick={props.onCheck}>
        {props.busy ? "Checking…" : "Check again"}
      </button>
    </div>
  );
}

export function PreviewTable({ preview }: { preview: SourcesPreview }) {
  const first = preview.firstSync;
  return (
    <div class="preview-repos">
      {first && (
        <p>
          <b>First sync:</b> about {num(first.prs)} PRs
          {first.olderOpen > 0 ? `, plus ${num(first.olderOpen)} older open ones,` : ""}{" "}
          {first.seconds < 60 ? "in under a minute" : `in about ${duration(first.seconds / 3600)}`}
          {first.shareOfHour > 1
            ? ", waiting for GitHub's hourly limit to reset along the way"
            : ""}
          .
        </p>
      )}
      {preview.sources.map((source) => (
        <div key={source.name} class="vstack">
          {source.error ? (
            <p class="problem">
              {source.name}: {source.error}
            </p>
          ) : (
            <>
              <p class="muted">
                {source.name}
                {source.ownerType ? ` (${source.ownerType.toLowerCase()})` : ""}:{" "}
                {source.repos.length === 1 ? "1 repo" : `${num(source.repos.length)} repos`}
                {source.skipped.length > 0 ? `, ${num(source.skipped.length)} left out` : ""}
              </p>
              <div class="table">
                <div class="table-inner" style={{ "--min": "560px" }}>
                  <div class="row head" style={{ "--cols": REPO_COLS }}>
                    <span>Repo</span>
                    <span>Branch</span>
                    <span>Open</span>
                    <span>Merged</span>
                    <span>Last PR</span>
                  </div>
                  {source.repos.slice(0, 50).map((repo) => (
                    <div key={repo.fullName} class="row dense" style={{ "--cols": REPO_COLS }}>
                      <span>{repo.fullName}</span>
                      <span class="soft">{repo.defaultBranch ?? "—"}</span>
                      <span class="num">{repo.prs ? num(repo.prs.open) : "—"}</span>
                      <span class="num">{repo.prs ? num(repo.prs.merged) : "—"}</span>
                      <span class="soft">
                        {repo.lastPrActivity?.slice(0, 10) ?? (repo.prs ? "none" : "—")}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
              {source.repos.length > 50 && (
                <p class="muted">and {num(source.repos.length - 50)} more</p>
              )}
              {source.skipped.length > 0 && (
                <details>
                  <summary class="muted">Left out</summary>
                  <ul class="skipped">
                    {source.skipped.map((s) => (
                      <li key={s.repo}>
                        {s.repo} <span class="muted">· {s.reason}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
        </div>
      ))}
    </div>
  );
}

const REPO_COLS = "minmax(180px,2fr) 110px 70px 80px 110px";

/** The first sync, as it runs: its progress, its log, and the way into the report. */
export function FirstSync({ org, onDone }: { org: string; onDone?: () => void }) {
  const [api] = useState(() => new ServerAdmin(org));
  const status = useStatus(api, 1500);
  const done = status !== null && !status.running && !status.queued && status.lastSync !== null;
  useEffect(() => {
    if (done) onDone?.();
  }, [done]);
  const failed = status !== null && !status.running && !status.queued && status.lastError !== null;
  return (
    <div class="vstack" aria-live="polite">
      {done ? (
        <p>
          <span class="ok-mark">✓</span> {org} is synced.
        </p>
      ) : failed ? (
        <p class="problem">The sync stopped: {status?.lastError}</p>
      ) : (
        <p>
          <span class="spinner" aria-hidden="true" /> Syncing {org}…{" "}
          <span class="muted">{status?.progress ?? "starting"}</span>
        </p>
      )}
      {status && status.log.length > 0 && (
        <pre class="sync-log">{status.log.slice(-8).join("\n")}</pre>
      )}
      <div class="step-actions">
        <a class={`button${done ? " primary" : ""}`} href={`/orgs/${encodeURIComponent(org)}/`}>
          Open the report
        </a>
        <a class="button" href={`/orgs/${encodeURIComponent(org)}/#tab=setup`}>
          Set up teams and rules
        </a>
      </div>
    </div>
  );
}

/** An org's sync status, asked for every `everyMs` while the component shows. */
export function useStatus(
  api: Pick<AdminApi, "org" | "status">,
  everyMs: number,
): SyncStatus | null {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  useEffect(() => {
    let live = true;
    const ask = () =>
      api.status().then(
        (next) => live && setStatus(next),
        () => {},
      );
    ask();
    const timer = setInterval(ask, everyMs);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [api, everyMs]);
  return status;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
