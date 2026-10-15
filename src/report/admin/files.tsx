// Setup › Paths › "What your PRs change" (decision D56): the folders and kinds of file counted as
// code, with how many files each changes per PR, and a rule added in a click. A tree of notes or
// data looks like code until a rule says otherwise; this is where it shows. Adding a rule puts it
// in the path rules above, to save with the rest.
import { useState } from "preact/hooks";
import type { FileUsage, UsageRow } from "../../core/file-usage.ts";
import { num } from "../../core/format.ts";
import type { AdminApi } from "./api.ts";
import { message } from "./kit.tsx";

type Rule = { match: string[]; bucket: string; repos?: string[] };

/** What a rule can call a file that isn't code. */
const NOT_CODE = ["docs", "assets", "generated", "vendored", "lockfile"] as const;

const ROOT = "(repo root)";

/** The rule that counts a folder, or a kind of file, as `bucket`. */
export function ruleFor(
  row: UsageRow,
  folder: boolean,
  bucket: string,
  repo: string | null,
): Rule | null {
  if (folder && row.name === ROOT) return null;
  const match = folder ? `${row.name}/**` : row.whole ? `**/${row.name}` : `**/*${row.name}`;
  return { match: [match], bucket, ...(repo ? { repos: [repo] } : {}) };
}

export function WhatPrsChange(props: {
  api: AdminApi;
  /** The repos to choose from. */
  repos: readonly string[];
  /** Puts a rule in the path rules, unsaved. */
  onAdd: (rule: Rule) => void;
}) {
  const [usage, setUsage] = useState<FileUsage | null | undefined>(undefined);
  const [repo, setRepo] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());

  const load = async (which: string) => {
    setBusy(true);
    setProblem(null);
    try {
      setUsage(await props.api.files(which || undefined));
    } catch (err) {
      setProblem(message(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="card vstack" aria-labelledby="what-prs-change">
      <div class="card-head">
        <h2 id="what-prs-change">What your PRs change</h2>
        <span class="note">
          The folders and kinds of file counted as code, from the PRs already synced. One that
          changes hundreds of files per PR is flagged: often notes, data or tool output.
        </span>
      </div>
      <div class="step-actions">
        <select
          aria-label="Repo"
          value={repo}
          onChange={(e) => {
            setRepo(e.currentTarget.value);
            if (usage !== undefined) load(e.currentTarget.value);
          }}
        >
          <option value="">All repos</option>
          {props.repos.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <button type="button" class="button" disabled={busy} onClick={() => load(repo)}>
          {busy
            ? "Reading your PRs…"
            : usage === undefined
              ? "Show what your PRs change"
              : "Refresh"}
        </button>
      </div>
      {problem && <p class="problem">{problem}</p>}
      {usage === null && <p class="muted">Nothing is synced yet.</p>}
      {usage && usage.prs === 0 && <p class="muted">No synced PR lists its files yet.</p>}
      {usage && usage.prs > 0 && (
        <>
          <p>
            {num(usage.changes)} file changes in {num(usage.prs)} PRs;{" "}
            <b>{num(usage.codeChanges)}</b> counted as code (
            {usage.byBucket
              .filter((b) => b.changes > 0 && b.bucket !== "product" && b.bucket !== "test")
              .map((b) => `${b.bucket} ${num(b.changes)}`)
              .join(", ") || "nothing else"}
            ).
          </p>
          <UsageTable
            title="Folders (a folder includes its subfolders)"
            rows={usage.folders}
            folder
            total={usage.codeChanges}
            repo={repo || null}
            added={added}
            onAdd={(rule, key) => {
              props.onAdd(rule);
              setAdded(new Set([...added, key]));
            }}
          />
          <UsageTable
            title="Kinds of file"
            rows={usage.extensions}
            folder={false}
            total={usage.codeChanges}
            repo={repo || null}
            added={added}
            onAdd={(rule, key) => {
              props.onAdd(rule);
              setAdded(new Set([...added, key]));
            }}
          />
        </>
      )}
    </section>
  );
}

function UsageTable(props: {
  title: string;
  rows: readonly UsageRow[];
  folder: boolean;
  total: number;
  repo: string | null;
  added: ReadonlySet<string>;
  onAdd: (rule: Rule, key: string) => void;
}) {
  const [bucket, setBucket] = useState<Record<string, string>>({});
  const cols = "minmax(160px,1.4fr) 90px 60px 70px 70px minmax(170px,1.2fr)";
  return (
    <div class="vstack">
      <h3 class="form-section">{props.title}</h3>
      <div class="table">
        <div class="table-inner" style={{ "--min": "720px" }}>
          <div class="row head" style={{ "--cols": cols }}>
            <span>{props.folder ? "Folder" : "Kind"}</span>
            <span>Changes</span>
            <span>PRs</span>
            <span>Per PR</span>
            <span>{props.folder ? "Mostly" : "Example"}</span>
            <span>Not code?</span>
          </div>
          {props.rows.map((row) => {
            const key = `${props.folder ? "folder" : "kind"}:${row.name}`;
            const chosen = bucket[key] ?? "docs";
            const rule = ruleFor(row, props.folder, chosen, props.repo);
            return (
              <div key={key} class="row dense" style={{ "--cols": cols }}>
                <span class="clip" title={row.examples.join("\n")}>
                  {props.folder && row.name !== ROOT ? `${row.name}/` : row.name}
                  {row.bulk && <span class="pill-likely"> bulk</span>}
                </span>
                <span class="num">{num(row.changes)}</span>
                <span class="num">{num(row.prs)}</span>
                <span class="num">{num(row.perPr)}</span>
                <span class="soft clip">
                  {props.folder ? row.extensions.join(" ") : (row.examples[0] ?? "")}
                </span>
                <span style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                  {props.added.has(key) ? (
                    <span class="muted">Added above: save the rules</span>
                  ) : (
                    <>
                      <select
                        aria-label={`Count ${row.name} as`}
                        value={chosen}
                        disabled={rule === null}
                        onChange={(e) => setBucket({ ...bucket, [key]: e.currentTarget.value })}
                      >
                        {NOT_CODE.map((b) => (
                          <option key={b} value={b}>
                            {b}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        class="link-button"
                        disabled={rule === null}
                        aria-label={`Add a rule for ${row.name}`}
                        onClick={() => rule && props.onAdd(rule, key)}
                      >
                        Add rule
                      </button>
                    </>
                  )}
                </span>
              </div>
            );
          })}
          {props.rows.length === 0 && <div class="empty">None.</div>}
        </div>
      </div>
    </div>
  );
}
