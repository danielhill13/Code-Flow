// What the report looks at, in the header: a crumb per narrowed facet (teams, each kind of group,
// repos, people), each with a menu to switch it, and a picker for any mix of them (D26, D30).
import { useEffect, useState } from "preact/hooks";
import {
  type Choices,
  type Dimension,
  EVERYTHING,
  isEverything,
  kindOf,
  listed,
  type Selection,
  selectionName,
} from "../core/selection.ts";
import { selectionHref } from "./links.ts";
import type { ReportState } from "./state.ts";
import { capital } from "./ui.tsx";

/**
 * One thing a reader can narrow by: teams, the groups of one kind, repos or people. Groups of
 * different kinds are separate facets, since they combine rather than replace each other.
 */
type Facet = {
  id: string;
  dimension: Dimension;
  kind: string | null;
  one: string;
  plural: string;
  all: string;
  options: { value: string; label: string }[];
};

function facetsOf(choices: Choices): Facet[] {
  const plain = (values: string[]) => values.map((value) => ({ value, label: value }));
  return [
    {
      id: "team",
      dimension: "team",
      kind: null,
      one: "Team",
      plural: "Teams",
      all: "All teams",
      options: plain(choices.teams.map((t) => t.name)),
    },
    ...choices.kinds.map(
      (kind): Facet => ({
        id: `group:${kind}`,
        dimension: "group",
        kind,
        one: capital(kind),
        plural: `${capital(kind)}s`,
        all: `All ${kind}s`,
        options: plain(choices.groups.filter((g) => g.kind === kind).map((g) => g.name)),
      }),
    ),
    {
      id: "repo",
      dimension: "repo",
      kind: null,
      one: "Repo",
      plural: "Repos",
      all: "All repos",
      options: plain(choices.repos),
    },
    {
      id: "person",
      dimension: "person",
      kind: null,
      one: "Person",
      plural: "People",
      all: "Everyone",
      options: choices.people.map((p) => ({ value: p.key, label: p.name ?? p.key })),
    },
  ];
}

/** The values a selection holds for one facet. */
function valuesFor(choices: Choices, selection: Selection, facet: Facet): string[] {
  const values = selection[facet.dimension];
  return facet.kind === null ? values : values.filter((v) => kindOf(choices, v) === facet.kind);
}

/** The selection with one facet's values replaced. */
function withValues(
  choices: Choices,
  selection: Selection,
  facet: Facet,
  values: string[],
): Selection {
  const others = selection[facet.dimension].filter(
    (v) => facet.kind !== null && kindOf(choices, v) !== facet.kind,
  );
  return { ...selection, [facet.dimension]: [...others, ...values] };
}

export function SelectionBar({ choices, state }: { choices: Choices; state: ReportState }) {
  const [menu, setMenu] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const { selection } = state;
  const key = JSON.stringify(selection);
  useEffect(() => {
    setMenu(null);
    setPicking(false);
  }, [key]);
  const facets = facetsOf(choices);
  const narrowed = facets.filter((f) => valuesFor(choices, selection, f).length > 0);
  // With one repo and nothing else to choose, there is nothing to pick.
  const pickable = facets.some((f) => f.options.length > (f.dimension === "repo" ? 1 : 0));
  const top = selectionName(choices, EVERYTHING);
  const labelOf = (facet: Facet, value: string) =>
    facet.options.find((o) => o.value === value)?.label ?? value;

  return (
    <nav class="crumbs" aria-label="Selection">
      {isEverything(selection) ? (
        <span class="crumb current">{top}</span>
      ) : (
        <a class="crumb" href={selectionHref(state, EVERYTHING)}>
          {top}
        </a>
      )}
      {narrowed.map((facet) => {
        const values = valuesFor(choices, selection, facet);
        return (
          <span
            key={facet.id}
            style={{ display: "flex", alignItems: "center", gap: "2px", position: "relative" }}
          >
            <span class="crumb-sep">/</span>
            <button
              type="button"
              class="crumb current"
              aria-expanded={menu === facet.id}
              title={`${facet.one}: ${values.map((v) => labelOf(facet, v)).join(", ")}`}
              onClick={() => setMenu(menu === facet.id ? null : facet.id)}
            >
              {listed(values.map((v) => labelOf(facet, v)))}
              <span class="caret">▾</span>
            </button>
            {menu === facet.id && (
              <>
                {/* biome-ignore lint/a11y/noStaticElementInteractions: a click outside the menu closes it */}
                {/* biome-ignore lint/a11y/useKeyWithClickEvents: as above */}
                <div class="menu-shade" onClick={() => setMenu(null)} />
                <div class="menu" style={{ left: "16px" }}>
                  <div class="menu-title">{facet.one}</div>
                  <a href={selectionHref(state, withValues(choices, selection, facet, []))}>
                    <span>{facet.all}</span>
                  </a>
                  {facet.options.map((option) => (
                    <a
                      key={option.value}
                      class={values.includes(option.value) ? "current" : undefined}
                      href={selectionHref(
                        state,
                        withValues(choices, selection, facet, [option.value]),
                      )}
                    >
                      <span>{option.label}</span>
                    </a>
                  ))}
                </div>
              </>
            )}
          </span>
        );
      })}
      {pickable && (
        <span style={{ position: "relative" }}>
          <button
            type="button"
            class="crumb placeholder"
            aria-expanded={picking}
            onClick={() => setPicking(!picking)}
          >
            {isEverything(selection) ? "Select…" : "Change…"}
          </button>
          {picking && (
            <Picker
              choices={choices}
              facets={facets.filter((f) => f.options.length > (f.dimension === "repo" ? 1 : 0))}
              selection={selection}
              onApply={(next) => {
                location.hash = selectionHref(state, next);
              }}
              onClose={() => setPicking(false)}
            />
          )}
        </span>
      )}
    </nav>
  );
}

/** A column per facet, with a search across all of them. */
function Picker(props: {
  choices: Choices;
  facets: Facet[];
  selection: Selection;
  onApply: (selection: Selection) => void;
  onClose: () => void;
}) {
  const { choices } = props;
  const [draft, setDraft] = useState<Selection>(props.selection);
  const [search, setSearch] = useState("");
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [props.onClose]);
  const toggle = (facet: Facet, value: string) => {
    const values = valuesFor(choices, draft, facet);
    setDraft(
      withValues(
        choices,
        draft,
        facet,
        values.includes(value) ? values.filter((v) => v !== value) : [...values, value],
      ),
    );
  };
  const needle = search.trim().toLowerCase();
  return (
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a click outside the picker closes it */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes it too */}
      <div class="menu-shade" onClick={props.onClose} />
      <div class="menu picker" role="dialog" aria-label="Select what to look at">
        <input
          type="search"
          placeholder="Find a team, group, repo or person"
          aria-label="Find"
          value={search}
          onInput={(e) => setSearch(e.currentTarget.value)}
        />
        <div class="picker-columns">
          {props.facets.map((facet) => {
            const chosen = valuesFor(choices, draft, facet);
            const matches = facet.options.filter(
              (o) =>
                needle === "" ||
                o.label.toLowerCase().includes(needle) ||
                o.value.toLowerCase().includes(needle),
            );
            const visible = matches.slice(0, 60);
            return (
              <fieldset key={facet.id} class="picker-column">
                <legend class="menu-title">
                  {facet.plural}
                  {chosen.length > 0 ? ` · ${chosen.length}` : ""}
                </legend>
                {visible.map((option) => (
                  <label key={option.value}>
                    <input
                      type="checkbox"
                      checked={chosen.includes(option.value)}
                      onChange={() => toggle(facet, option.value)}
                    />
                    <span>{option.label}</span>
                  </label>
                ))}
                {matches.length > visible.length && (
                  <span class="muted" style={{ fontSize: "12px", padding: "4px 10px" }}>
                    {matches.length - visible.length} more: type to narrow
                  </span>
                )}
                {matches.length === 0 && (
                  <span class="muted" style={{ fontSize: "12px", padding: "4px 10px" }}>
                    none match
                  </span>
                )}
              </fieldset>
            );
          })}
        </div>
        <p class="muted" style={{ fontSize: "12px", margin: "4px 10px" }}>
          Any of the ticked values within a column; every column that has one.
        </p>
        <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end", padding: "6px" }}>
          <button type="button" class="button" onClick={() => setDraft(EVERYTHING)}>
            Clear
          </button>
          <button type="button" class="button primary" onClick={() => props.onApply(draft)}>
            Show
          </button>
        </div>
      </div>
    </>
  );
}
