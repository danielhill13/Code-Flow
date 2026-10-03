// What the report looks at, in the header: a crumb per narrowed dimension, each with a menu to
// switch it, and a picker for any mix of teams, products, repos and people (decision D26).
import { useEffect, useState } from "preact/hooks";
import {
  type Choices,
  DIMENSIONS,
  type Dimension,
  EVERYTHING,
  isEverything,
  listed,
  type Selection,
  selectionName,
} from "../core/selection.ts";
import { selectionHref } from "./links.ts";
import type { ReportState } from "./state.ts";

const LABELS: Record<Dimension, { one: string; all: string; plural: string }> = {
  team: { one: "Team", all: "All teams", plural: "Teams" },
  product: { one: "Product", all: "All products", plural: "Products" },
  repo: { one: "Repo", all: "All repos", plural: "Repos" },
  person: { one: "Person", all: "Everyone", plural: "People" },
};

export const dimensionLabel = (dimension: Dimension) => LABELS[dimension];

/** The values a reader can pick along each dimension. */
function optionsOf(choices: Choices): Record<Dimension, string[]> {
  return {
    team: choices.teams.map((t) => t.name),
    product: choices.products.map((p) => p.name),
    repo: choices.repos,
    person: choices.people,
  };
}

export function SelectionBar({ choices, state }: { choices: Choices; state: ReportState }) {
  const [menu, setMenu] = useState<Dimension | null>(null);
  const [picking, setPicking] = useState(false);
  const { selection } = state;
  const key = JSON.stringify(selection);
  useEffect(() => {
    setMenu(null);
    setPicking(false);
  }, [key]);
  const options = optionsOf(choices);
  const narrowed = DIMENSIONS.filter((d) => selection[d].length > 0);
  // With one repo and nothing else to choose, there is nothing to pick.
  const pickable = DIMENSIONS.some((d) => options[d].length > (d === "repo" ? 1 : 0));
  const top = selectionName(choices, EVERYTHING);

  return (
    <nav class="crumbs" aria-label="Selection">
      {isEverything(selection) ? (
        <span class="crumb current">{top}</span>
      ) : (
        <a class="crumb" href={selectionHref(state, EVERYTHING)}>
          {top}
        </a>
      )}
      {narrowed.map((dimension) => (
        <span
          key={dimension}
          style={{ display: "flex", alignItems: "center", gap: "2px", position: "relative" }}
        >
          <span class="crumb-sep">/</span>
          <button
            type="button"
            class="crumb current"
            aria-expanded={menu === dimension}
            title={selection[dimension].join(", ")}
            onClick={() => setMenu(menu === dimension ? null : dimension)}
          >
            {listed(selection[dimension])}
            <span class="caret">▾</span>
          </button>
          {menu === dimension && (
            <>
              {/* biome-ignore lint/a11y/noStaticElementInteractions: a click outside the menu closes it */}
              {/* biome-ignore lint/a11y/useKeyWithClickEvents: as above */}
              <div class="menu-shade" onClick={() => setMenu(null)} />
              <div class="menu" style={{ left: "16px" }}>
                <div class="menu-title">{LABELS[dimension].one}</div>
                <a href={selectionHref(state, { ...selection, [dimension]: [] })}>
                  <span>{LABELS[dimension].all}</span>
                </a>
                {options[dimension].map((value) => (
                  <a
                    key={value}
                    class={selection[dimension].includes(value) ? "current" : undefined}
                    href={selectionHref(state, { ...selection, [dimension]: [value] })}
                  >
                    <span>{value}</span>
                  </a>
                ))}
              </div>
            </>
          )}
        </span>
      ))}
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
              options={options}
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

/** Teams, products, repos and people, with a search across all of them. */
function Picker(props: {
  options: Record<Dimension, string[]>;
  selection: Selection;
  onApply: (selection: Selection) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Selection>(props.selection);
  const [search, setSearch] = useState("");
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [props.onClose]);
  const toggle = (dimension: Dimension, value: string) =>
    setDraft({
      ...draft,
      [dimension]: draft[dimension].includes(value)
        ? draft[dimension].filter((v) => v !== value)
        : [...draft[dimension], value],
    });
  const needle = search.trim().toLowerCase();
  const shown = DIMENSIONS.filter((d) => props.options[d].length > (d === "repo" ? 1 : 0));
  return (
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a click outside the picker closes it */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes it too */}
      <div class="menu-shade" onClick={props.onClose} />
      <div class="menu picker" role="dialog" aria-label="Select what to look at">
        <input
          type="search"
          placeholder="Find a team, product, repo or person"
          aria-label="Find"
          value={search}
          onInput={(e) => setSearch(e.currentTarget.value)}
        />
        <div class="picker-columns">
          {shown.map((dimension) => {
            const matches = props.options[dimension].filter(
              (value) => needle === "" || value.toLowerCase().includes(needle),
            );
            const visible = matches.slice(0, 60);
            return (
              <fieldset key={dimension} class="picker-column">
                <legend class="menu-title">
                  {LABELS[dimension].plural}
                  {draft[dimension].length > 0 ? ` · ${draft[dimension].length}` : ""}
                </legend>
                {visible.map((value) => (
                  <label key={value}>
                    <input
                      type="checkbox"
                      checked={draft[dimension].includes(value)}
                      onChange={() => toggle(dimension, value)}
                    />
                    <span>{value}</span>
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
