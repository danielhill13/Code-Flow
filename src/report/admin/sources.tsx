// What an org measures, as a list of sources: a GitHub organization or user, one GitHub repo, or
// an Azure DevOps organization's (or one project's) repos. One editor for the first steps and
// for Setup › Repos, so both say the same thing the same way (decisions D39, D40).
import type { RawSource } from "./api.ts";
import { Field, List, Text } from "./fields.tsx";

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
          <SourceFields source={source} onChange={(next) => update(i, next)} />
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

function SourceFields({
  source,
  onChange,
}: {
  source: RawSource;
  onChange: (source: RawSource) => void;
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
  const patterns = (
    <>
      <List
        label="Only repos named"
        value={source.include ?? []}
        onChange={(include) =>
          onChange({ ...source, include: include.length ? include : undefined })
        }
        placeholder="api-*, web"
        hint="Patterns; * matches anything. Empty: every repo."
      />
      <List
        label="Leave out"
        value={source.exclude ?? []}
        onChange={(exclude) =>
          onChange({ ...source, exclude: exclude.length ? exclude : undefined })
        }
        placeholder="*-sandbox"
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
          onChange={(ado) => onChange({ ...source, ado: ado.trim() })}
          placeholder="contoso"
          hint="As in dev.azure.com/contoso."
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

/** Sources a form can't save yet: a kind with its name left blank. */
export function blank(source: RawSource): boolean {
  return "ado" in source ? !source.ado : "repo" in source ? !source.repo : !source.owner;
}
