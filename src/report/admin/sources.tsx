// What an org measures, as a list of sources: a GitHub organization or user, one GitHub repo, or
// an Azure DevOps organization's (or one project's) repos. One editor for the first steps and
// for Setup › Repos, so both say the same thing the same way (decisions D39, D40).
import type { RawSource } from "./api.ts";
import { Field, Text } from "./fields.tsx";
import { type Option, Picker } from "./picker.tsx";

type Kind = "owner" | "repo" | "ado";

const KINDS: readonly { kind: Kind; label: string; empty: RawSource }[] = [
  { kind: "owner", label: "GitHub: every repo of an organization or user", empty: { owner: "" } },
  { kind: "repo", label: "GitHub: one repo", empty: { repo: "" } },
  {
    kind: "ado",
    label: "Azure DevOps: an organization's or a project's repos",
    empty: { ado: "" },
  },
];

export const kindOf = (source: RawSource): Kind =>
  "ado" in source ? "ado" : "repo" in source ? "repo" : "owner";

export function SourceList(props: {
  sources: RawSource[];
  onChange: (sources: RawSource[]) => void;
  /** Repos codeflow has seen (synced, or listed by "Show what this measures"), by full name. */
  repos?: readonly string[];
}) {
  const { sources, onChange } = props;
  const update = (i: number, next: RawSource) =>
    onChange(sources.map((s, j) => (j === i ? next : s)));
  return (
    <div class="wide-field vstack">
      {sources.map((source, i) => (
        <div key={i} class="source-row">
          <Field label="Kind">
            <select
              value={kindOf(source)}
              onChange={(e) =>
                update(
                  i,
                  KINDS.find((k) => k.kind === e.currentTarget.value)?.empty ?? { owner: "" },
                )
              }
            >
              {KINDS.map((k) => (
                <option key={k.kind} value={k.kind}>
                  {k.label}
                </option>
              ))}
            </select>
          </Field>
          <SourceFields
            source={source}
            onChange={(next) => update(i, next)}
            repos={props.repos ?? []}
          />
          <button
            type="button"
            class="link-button"
            disabled={sources.length === 1}
            onClick={() => onChange(sources.filter((_, j) => j !== i))}
          >
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        class="link-button"
        onClick={() => onChange([...sources, { owner: "" }])}
      >
        + Add a source
      </button>
    </div>
  );
}

/** The repos a source covers, by the name its patterns match: the repo's own name. */
function namesIn(source: RawSource, repos: readonly string[]): Option[] {
  const prefix =
    "ado" in source
      ? `${source.ado}/${source.project ? `${source.project}/` : ""}`
      : "owner" in source
        ? `${source.owner}/`
        : null;
  if (!prefix || prefix.startsWith("/")) return [];
  const seen = new Map<string, string>();
  for (const repo of repos) {
    if (!repo.toLowerCase().startsWith(prefix.toLowerCase())) continue;
    const name = repo.split("/").at(-1) ?? repo;
    if (!seen.has(name)) seen.set(name, repo);
  }
  return [...seen]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, repo]) => ({ value: name, label: name, detail: repo }));
}

function SourceFields({
  source,
  onChange,
  repos,
}: {
  source: RawSource;
  onChange: (source: RawSource) => void;
  repos: readonly string[];
}) {
  if ("repo" in source) {
    return (
      <Text
        label="Repo"
        value={source.repo}
        onChange={(repo) => onChange({ repo: repo.trim() })}
        placeholder="your-org/api"
      />
    );
  }
  const names = namesIn(source, repos);
  const seen = names.length > 0 ? "" : ' "Show what this measures" lists the repos to choose from.';
  const patterns = (
    <>
      <Picker
        label="Only repos named"
        options={names}
        value={source.include ?? []}
        onChange={(include) =>
          onChange({ ...source, include: include.length ? include : undefined })
        }
        placeholder="Every repo; search to narrow…"
        free="Add the pattern"
        hint={`None: every repo. A pattern such as api-* takes in repos to come.${seen}`}
      />
      <Picker
        label="Leave out"
        options={names}
        value={source.exclude ?? []}
        onChange={(exclude) =>
          onChange({ ...source, exclude: exclude.length ? exclude : undefined })
        }
        placeholder="Search repos to leave out…"
        free="Add the pattern"
        hint="Such as *-sandbox."
      />
    </>
  );
  const forks = (
    <label class="radio">
      <input
        type="checkbox"
        checked={source.forks ?? false}
        onChange={(e) => onChange({ ...source, forks: e.currentTarget.checked || undefined })}
      />
      forks
    </label>
  );
  if ("ado" in source) {
    return (
      <>
        <Text
          label="Azure DevOps organization"
          value={source.ado}
          onChange={(ado) => onChange({ ...source, ...adoAddress(ado) })}
          placeholder="contoso"
          hint="As in dev.azure.com/contoso. Pasting the address fills both."
        />
        <Text
          label="Project"
          value={source.project ?? ""}
          onChange={(project) => onChange({ ...source, project: project.trim() || undefined })}
          placeholder="every project"
        />
        {patterns}
        <div class="field">
          <span class="field-label">Also measure</span>
          {forks}
        </div>
      </>
    );
  }
  return (
    <>
      <Text
        label="Organization or user"
        value={source.owner}
        onChange={(owner) => onChange({ ...source, owner: owner.trim() })}
        placeholder="your-org"
      />
      {patterns}
      <div class="field">
        <span class="field-label">Also measure</span>
        <label class="radio">
          <input
            type="checkbox"
            checked={source.archived ?? false}
            onChange={(e) =>
              onChange({ ...source, archived: e.currentTarget.checked || undefined })
            }
          />
          archived repos
        </label>
        {forks}
      </div>
    </>
  );
}

/**
 * What's typed or pasted as the Azure DevOps organization: a name, or an address
 * (https://dev.azure.com/contoso/Platform, contoso.visualstudio.com/Platform), which gives the
 * project too.
 */
export function adoAddress(text: string): { ado: string; project?: string } {
  const value = text.trim();
  const address =
    /^(?:https?:\/\/)?(?:[^@/]+@)?dev\.azure\.com\/([^/?#]+)(?:\/([^/?#]+))?/i.exec(value) ??
    /^(?:https?:\/\/)?([^./]+)\.visualstudio\.com(?:\/(?!DefaultCollection\b)([^/?#]+))?/i.exec(
      value,
    );
  if (!address) return { ado: value };
  const project = address[2] ? decodeURIComponent(address[2]) : undefined;
  return project && !project.startsWith("_")
    ? { ado: address[1] ?? "", project }
    : { ado: address[1] ?? "" };
}

/** Sources a form can't save yet: a kind with its name left blank. */
export function blank(source: RawSource): boolean {
  return "ado" in source ? !source.ado : "repo" in source ? !source.repo : !source.owner;
}
