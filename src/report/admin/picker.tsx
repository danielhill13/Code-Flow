// Choosing several names from what codeflow knows: people (by name, key or any of their logins
// on GitHub or Azure DevOps), repos, teams and groups. A search box opens a list to tick from; what
// is chosen shows as chips above it. Where config also takes things the list can't know (a repo
// pattern, a login with no PR yet), what is typed can be added as it is.
import { useEffect, useRef, useState } from "preact/hooks";
import { num } from "../../core/format.ts";
import type { PersonRaw } from "../../core/identities.ts";
import type { AdminApi, Identities } from "./api.ts";

export type Option = {
  /** What config is given when it is chosen. */
  value: string;
  label: string;
  /** A line under the label, searched too: logins, host, activity. */
  detail?: string;
  /** Other names config may use for the same thing (a person's logins), lowercased. */
  aliases?: readonly string[];
};

const lower = (s: string) => s.toLowerCase();

/** Whether a value config holds is this option. */
const names = (option: Option, value: string) =>
  lower(option.value) === lower(value) || (option.aliases ?? []).includes(lower(value));

/** At most this many rows show at once; searching narrows the rest. */
const SHOWN = 100;

export function Picker(props: {
  label: string;
  options: readonly Option[];
  value: readonly string[];
  onChange: (value: string[]) => void;
  hint?: string;
  /** The search box's placeholder. */
  placeholder?: string;
  /** What typing something not in the list adds, such as "Add the pattern"; absent: only the list. */
  free?: string;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLFieldSetElement>(null);
  const id = useRef(`picker-${Math.random().toString(36).slice(2, 8)}`).current;

  // Closes when a click lands outside it: on the click, not the press, so whatever was clicked
  // (Save, say) gets the click before the list folds away and the page moves up.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("click", away);
    return () => document.removeEventListener("click", away);
  }, [open]);

  const chosen = (option: Option) => props.value.some((v) => names(option, v));
  const known = props.value.map((v) => props.options.find((o) => names(o, v)) ?? null);
  const toggle = (option: Option) =>
    props.onChange(
      chosen(option)
        ? props.value.filter((v) => !names(option, v))
        : [...props.value, option.value],
    );
  const remove = (value: string) => props.onChange(props.value.filter((v) => v !== value));

  const text = query.trim();
  const q = lower(text);
  const found = props.options.filter(
    (o) =>
      !q ||
      lower(o.label).includes(q) ||
      lower(o.value).includes(q) ||
      lower(o.detail ?? "").includes(q) ||
      (o.aliases ?? []).some((a) => a.includes(q)),
  );
  // What's chosen first, then the rest, each in the order given.
  const listed = [...found.filter(chosen), ...found.filter((o) => !chosen(o))];
  const exact = props.options.some((o) => names(o, text)) || props.value.includes(text);
  const addable = props.free !== undefined && text !== "" && !exact;
  const add = () => {
    if (!addable) return;
    props.onChange([...props.value, text]);
    setQuery("");
  };

  return (
    <fieldset
      ref={box}
      class="field wide-field choose"
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <legend class="field-label">{props.label}</legend>
      {props.value.length > 0 && (
        <ul class="choose-chips" aria-label={`${props.label} chosen`}>
          {props.value.map((value, i) => (
            <li key={value} class="choose-chip">
              <span class="choose-chip-text">{known[i]?.label ?? value}</span>
              <button
                type="button"
                class="choose-chip-remove"
                aria-label={`Remove ${known[i]?.label ?? value}`}
                onClick={() => remove(value)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <div class="choose-search">
        <input
          type="search"
          class="choose-query"
          aria-label={`Search ${lower(props.label)}`}
          aria-controls={id}
          placeholder={props.placeholder ?? `Search ${lower(props.label)}…`}
          value={query}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onInput={(e) => {
            setQuery(e.currentTarget.value);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            if (text === "") return;
            // The option named exactly what was typed, or the only one it matches.
            const only =
              props.options.find((o) => names(o, text)) ??
              (found.length === 1 ? found[0] : undefined);
            if (only) {
              toggle(only);
              setQuery("");
            } else add();
          }}
        />
        <button
          type="button"
          class="button choose-toggle"
          aria-expanded={open}
          aria-controls={id}
          aria-label={
            open ? `Close the ${lower(props.label)} list` : `Open the ${lower(props.label)} list`
          }
          onClick={() => setOpen(!open)}
        >
          {open ? "Done" : "Choose"}
        </button>
      </div>
      {open && (
        <div id={id} class="choose-panel">
          {listed.slice(0, SHOWN).map((option) => (
            <label key={option.value} class="choose-option">
              <input
                class="choose-tick"
                type="checkbox"
                checked={chosen(option)}
                onChange={() => toggle(option)}
              />
              <span class="choose-text">
                <span class="choose-label">{option.label}</span>
                {option.detail && <span class="choose-detail">{option.detail}</span>}
              </span>
            </label>
          ))}
          {listed.length > SHOWN && (
            <p class="choose-note">{num(listed.length - SHOWN)} more: type to narrow the list.</p>
          )}
          {listed.length === 0 && !addable && (
            <p class="choose-note">
              {props.options.length === 0 ? "Nothing to choose from yet." : "Nothing matches."}
            </p>
          )}
          {addable && (
            <button type="button" class="link-button choose-add" onClick={add}>
              {props.free} “{text}”
            </button>
          )}
        </div>
      )}
      {props.hint && <span class="field-hint">{props.hint}</span>}
    </fieldset>
  );
}

const HOST = { github: "GitHub", ado: "Azure DevOps" } as const;

/** A name with the key or login it goes by, unless the name already says it. */
const named = (name: string | null | undefined, id: string) =>
  !name ? id : lower(name).includes(lower(id)) ? name : `${name} (${id})`;

/**
 * Everyone a team, group or rule can name: each person in people.yml, under their name, found by
 * any of their logins; and every account the PRs show that isn't in a person yet.
 */
export function peopleOptions(
  identities: Identities["identities"],
  people: Record<string, PersonRaw>,
): Option[] {
  const prs = new Map<string, number>();
  const accounts = new Map<string, string[]>();
  for (const identity of identities) {
    if (!identity.person) continue;
    prs.set(identity.person, (prs.get(identity.person) ?? 0) + identity.authored);
    accounts.set(identity.person, [
      ...(accounts.get(identity.person) ?? []),
      `${HOST[identity.host]} ${identity.login}`,
    ]);
  }
  const persons: Option[] = Object.entries(people)
    .filter(([, person]) => !person.bot)
    .map(([key, person]) => {
      const logins = [...(person.github ?? [key]), ...(person.ado ?? [])];
      const seen = accounts.get(key);
      return {
        value: key,
        label: named(person.name, key),
        detail: [
          seen?.join(" · ") ?? logins.join(" · "),
          prs.has(key) ? `${num(prs.get(key) ?? 0)} PRs opened` : null,
        ]
          .filter(Boolean)
          .join(" · "),
        aliases: logins.map(lower),
      };
    });
  const loose: Option[] = identities
    .filter((identity) => identity.person === null)
    .map((identity) => ({
      value: identity.login,
      label: named(identity.name, identity.login),
      detail: `${HOST[identity.host]} · ${num(identity.authored)} PRs opened`,
    }));
  return [...persons, ...loose].sort((a, b) => a.label.localeCompare(b.label));
}

/** What Setup's pickers offer about people, read once per editor. */
export type Accounts = {
  /** People and the accounts not in a person yet: what teams, groups and rules name. */
  people: Option[];
  /** Every account the PRs show, by its login, and the service accounts among them. */
  accounts: Option[];
  bots: Option[];
};

export function useAccounts(api: AdminApi): Accounts {
  const [accounts, setAccounts] = useState<Accounts>({ people: [], accounts: [], bots: [] });
  useEffect(() => {
    Promise.all([
      api.identities().catch((): Identities => ({ identities: [], suggestions: [], bots: [] })),
      api.open("people").catch(() => null),
    ]).then(([data, opened]) => {
      const people = (opened?.value.people ?? {}) as Record<string, PersonRaw>;
      const bots = (data.bots ?? []).map((bot) => ({
        value: bot.login,
        label: bot.login,
        detail: `bot · ${num(bot.prs)} PRs`,
      }));
      setAccounts({
        people: peopleOptions(data.identities, people),
        accounts: [
          ...bots,
          ...data.identities.map((identity) => ({
            value: identity.login,
            label: identity.login,
            detail: [HOST[identity.host], identity.name, `${num(identity.involved)} PRs`]
              .filter(Boolean)
              .join(" · "),
          })),
        ],
        bots,
      });
    });
  }, [api]);
  return accounts;
}

/** Synced repos, each marked with its host. */
export function repoOptions(repos: readonly string[]): Option[] {
  return repos.map((repo) => ({
    value: repo,
    label: repo,
    detail: repo.split("/").length > 2 ? "Azure DevOps" : "GitHub",
  }));
}

/** Branches PRs went into, busiest first, with any others config already names. */
export function branchOptions(
  seen: readonly { name: string; prs: number }[],
  named: readonly string[] = [],
): Option[] {
  const options: Option[] = seen.map((b) => ({
    value: b.name,
    label: b.name,
    detail: `${num(b.prs)} PRs went into it`,
  }));
  for (const name of named) {
    if (!options.some((o) => o.value === name)) options.push({ value: name, label: name });
  }
  return options;
}

/** Plain names: teams, groups. */
export function nameOptions(names: readonly string[]): Option[] {
  return names.map((name) => ({ value: name, label: name }));
}
