// The Setup tab, in `codeflow serve` only: everything an org's config holds, edited in place and
// written to the org's own files (decisions D33, D39). Every save is checked by the server
// as a whole, exactly as `codeflow import` checks a bundle, and refused with the reason when it
// wouldn't be valid or the file changed meanwhile.
import { useEffect, useState } from "preact/hooks";
import { Accounts } from "./accounts.tsx";
import type { Opened, Preview } from "./api.ts";
import { Choice, Field, List, Problem, Text, Ticks } from "./fields.tsx";
import {
  Actions,
  clean,
  Form,
  Head,
  message,
  type SectionProps,
  summary,
  Table,
  usePart,
  Waiting,
  without,
} from "./kit.tsx";
import { Bots, Branches, Paths, Repos, Settings, Sync } from "./org.tsx";

type Section =
  | "repos"
  | "branches"
  | "bots"
  | "paths"
  | "people"
  | "teams"
  | "groups"
  | "rules"
  | "sync"
  | "settings"
  | "transfer";

/** Setup's sections, grouped by the question each answers. */
const NAV: readonly { group: string; items: readonly { key: Section; label: string }[] }[] = [
  {
    group: "What to measure",
    items: [
      { key: "repos", label: "Repos" },
      { key: "branches", label: "Branches" },
      { key: "bots", label: "Bots" },
      { key: "paths", label: "Paths" },
    ],
  },
  {
    group: "Who's who",
    items: [
      { key: "people", label: "People" },
      { key: "teams", label: "Teams" },
      { key: "groups", label: "Groups" },
    ],
  },
  { group: "What counts", items: [{ key: "rules", label: "Rules" }] },
  {
    group: "This org",
    items: [
      { key: "sync", label: "Sync" },
      { key: "settings", label: "Settings" },
      { key: "transfer", label: "Import & export" },
    ],
  },
];

export function Setup(props: SectionProps) {
  // An org without data starts where it needs attention: what it measures.
  const [section, setSection] = useState<Section>(props.meta ? "teams" : "repos");
  return (
    <div class="setup-layout">
      <nav class="setup-nav" aria-label="Setup">
        {NAV.map((group) => (
          <div key={group.group} class="setup-group">
            <span class="setup-group-name">{group.group}</span>
            {group.items.map((item) => (
              <button
                key={item.key}
                type="button"
                class="setup-link"
                aria-pressed={section === item.key}
                onClick={() => setSection(item.key)}
              >
                {item.label}
              </button>
            ))}
          </div>
        ))}
        <p class="muted setup-note">
          Saved to {props.api.org}'s config files, which you can also edit by hand. Each save is
          checked first.
        </p>
      </nav>
      <div class="setup-body">
        {section === "repos" && <Repos {...props} />}
        {section === "branches" && <Branches {...props} />}
        {section === "bots" && <Bots {...props} />}
        {section === "paths" && <Paths {...props} />}
        {section === "people" && <People {...props} />}
        {section === "teams" && <Teams {...props} />}
        {section === "groups" && <GroupsSection {...props} />}
        {section === "rules" && <Rules {...props} />}
        {section === "sync" && <Sync {...props} />}
        {section === "settings" && <Settings {...props} />}
        {section === "transfer" && <Transfer {...props} />}
      </div>
    </div>
  );
}

// People ---------------------------------------------------------------------------------------

type PersonRaw = {
  name?: string;
  github?: string[];
  ado?: string[];
  internal?: boolean;
  bot?: boolean;
};

function People({ api, onSaved }: SectionProps) {
  const part = usePart(api, "people", onSaved);
  const [editing, setEditing] = useState<{
    key: string;
    original: string | null;
    person: PersonRaw;
  } | null>(null);
  if (!part.opened) return <Waiting problem={part.problem} />;
  const people = (part.opened.value.people ?? {}) as Record<string, PersonRaw>;
  const save = async () => {
    if (!editing) return;
    if (!editing.key.trim())
      return part.setProblem("Give the person a key, such as their usual login.");
    const next = without(people, editing.original);
    next[editing.key.trim()] = clean(editing.person);
    if (await part.save({ people: next })) setEditing(null);
  };
  const edit = (change: (e: NonNullable<typeof editing>) => NonNullable<typeof editing>) =>
    setEditing((e) => e && change(e));
  const person = (patch: Partial<PersonRaw>) =>
    edit((e) => ({ ...e, person: { ...e.person, ...patch } }));
  const cols = "minmax(140px,1fr) minmax(140px,1fr) minmax(200px,1.5fr) 110px 110px 130px";
  return (
    <>
      <Accounts
        api={api}
        people={people}
        version={part.opened.version}
        save={(next) => part.save({ people: next })}
        saveProblem={editing ? null : part.problem}
        busy={part.busy}
      />
      <Head
        title="People"
        note="Only people with several logins, or something config should say about them. Everyone else is measured as their login."
        onAdd={() => setEditing({ key: "", original: null, person: {} })}
      />
      {editing && (
        <Form
          title={editing.original ? `Edit ${editing.original}` : "Add a person"}
          problem={part.problem}
          busy={part.busy}
          onSave={save}
          onCancel={() => setEditing(null)}
        >
          <Text
            label="Key"
            value={editing.key}
            onChange={(key) => edit((e) => ({ ...e, key }))}
            hint="How teams and rules name them: usually their login."
          />
          <Text
            label="Name"
            value={editing.person.name ?? ""}
            onChange={(name) => person({ name })}
          />
          <List
            label="GitHub logins"
            value={editing.person.github ?? []}
            onChange={(github) => person({ github })}
            hint="Every login they use, current first. Empty: the key is their login."
          />
          <List
            label="Azure DevOps sign-ins"
            value={editing.person.ado ?? []}
            onChange={(ado) => person({ ado })}
            placeholder="ana@acme.com"
            hint="Usually their email address: their PRs in Azure DevOps are theirs too."
          />
          <Choice
            label="Internal"
            value={editing.person.internal}
            onChange={(internal) => person({ internal })}
            unset="As GitHub says"
            yes="Internal"
            no="External"
          />
          <Choice
            label="Bot"
            value={editing.person.bot}
            onChange={(bot) => person({ bot })}
            unset="As GitHub says"
            yes="A bot"
            no="A person"
            hint="A service account: its PRs aren't counted, its reviews aren't review."
          />
        </Form>
      )}
      <Table
        cols={cols}
        head={["Key", "Name", "Logins", "Internal", "Bot", ""]}
        empty="Nobody listed yet."
      >
        {Object.entries(people).map(([key, person]) => (
          <div key={key} class="row dense" style={{ "--cols": cols }}>
            <span style={{ fontWeight: 500 }}>{key}</span>
            <span>{person.name ?? ""}</span>
            <span class="soft">
              {[...(person.github ?? [key]), ...(person.ado ?? [])].join(", ")}
            </span>
            <span>
              {person.internal === undefined ? "" : person.internal ? "internal" : "external"}
            </span>
            <span>{person.bot ? "bot" : ""}</span>
            <Actions
              onEdit={() => setEditing({ key, original: key, person })}
              onRemove={() => part.save({ people: without(people, key) })}
            />
          </div>
        ))}
      </Table>
    </>
  );
}

// Teams ----------------------------------------------------------------------------------------

type MemberRaw = string | { login: string; from?: string; to?: string; secondary?: boolean };
type MemberRow = { login: string; from: string; to: string; secondary: boolean };
type GroupsValue = {
  teams: Record<string, { people: MemberRaw[] }>;
  groups: Record<string, GroupRaw>;
  products: Record<string, GroupRaw>;
};
type GroupRaw = { kind?: string; repos?: string[]; teams?: string[]; people?: string[] };

const groupsValue = (opened: Opened): GroupsValue => ({
  teams: (opened.value.teams ?? {}) as GroupsValue["teams"],
  groups: (opened.value.groups ?? {}) as GroupsValue["groups"],
  products: (opened.value.products ?? {}) as GroupsValue["products"],
});

const rowOf = (m: MemberRaw): MemberRow =>
  typeof m === "string"
    ? { login: m, from: "", to: "", secondary: false }
    : { login: m.login, from: m.from ?? "", to: m.to ?? "", secondary: m.secondary ?? false };

const memberOf = (row: MemberRow): MemberRaw =>
  row.from || row.to || row.secondary
    ? clean({
        login: row.login,
        from: row.from || undefined,
        to: row.to || undefined,
        secondary: row.secondary || undefined,
      })
    : row.login;

function Teams({ api, meta, onSaved }: SectionProps) {
  const part = usePart(api, "groups", onSaved);
  const [editing, setEditing] = useState<{
    name: string;
    original: string | null;
    rows: MemberRow[];
  } | null>(null);
  if (!part.opened) return <Waiting problem={part.problem} />;
  const value = groupsValue(part.opened);
  const save = async () => {
    if (!editing) return;
    if (!editing.name.trim()) return part.setProblem("Give the team a name.");
    const teams = without(value.teams, editing.original);
    teams[editing.name.trim()] = {
      people: editing.rows.filter((r) => r.login.trim()).map(memberOf),
    };
    // A renamed team keeps its place in groups that list it.
    const renamed = (list: Record<string, GroupRaw>) =>
      Object.fromEntries(
        Object.entries(list).map(([name, g]) => [
          name,
          editing.original && g.teams?.includes(editing.original)
            ? {
                ...g,
                teams: g.teams.map((t) => (t === editing.original ? editing.name.trim() : t)),
              }
            : g,
        ]),
      );
    if (
      await part.save({ teams, groups: renamed(value.groups), products: renamed(value.products) })
    )
      setEditing(null);
  };
  const people = meta?.choices.people.map((p) => p.key) ?? [];
  const edit = (change: (e: NonNullable<typeof editing>) => NonNullable<typeof editing>) =>
    setEditing((e) => e && change(e));
  const update = (i: number, patch: Partial<MemberRow>) =>
    edit((e) => ({ ...e, rows: e.rows.map((r, j) => (j === i ? { ...r, ...patch } : r)) }));
  const cols = "minmax(160px,1fr) 90px minmax(260px,3fr) 130px";
  return (
    <>
      <Head
        title="Teams"
        note="Who works together. A PR counts for its author's team on the day it opened; give dates when someone moves."
        onAdd={() =>
          setEditing({
            name: "",
            original: null,
            rows: [{ login: "", from: "", to: "", secondary: false }],
          })
        }
      />
      {editing && (
        <Form
          title={editing.original ? `Edit ${editing.original}` : "Add a team"}
          problem={part.problem}
          busy={part.busy}
          onSave={save}
          onCancel={() => setEditing(null)}
        >
          <Text
            label="Name"
            value={editing.name}
            onChange={(name) => edit((e) => ({ ...e, name }))}
          />
          <datalist id="known-people">
            {people.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
          <div class="field wide-field">
            <span class="field-label">People</span>
            <div class="members">
              <span class="field-hint">Person or login</span>
              <span class="field-hint">From</span>
              <span class="field-hint">To</span>
              <span class="field-hint">Secondary</span>
              <span />
              {editing.rows.map((row, i) => (
                <div key={i} class="member-row">
                  <input
                    type="text"
                    list="known-people"
                    aria-label="Person or login"
                    value={row.login}
                    onInput={(e) => update(i, { login: e.currentTarget.value })}
                  />
                  <input
                    type="date"
                    aria-label="From"
                    value={row.from}
                    onChange={(e) => update(i, { from: e.currentTarget.value })}
                  />
                  <input
                    type="date"
                    aria-label="To"
                    value={row.to}
                    onChange={(e) => update(i, { to: e.currentTarget.value })}
                  />
                  <input
                    type="checkbox"
                    aria-label="Secondary"
                    checked={row.secondary}
                    onChange={(e) => update(i, { secondary: e.currentTarget.checked })}
                  />
                  <button
                    type="button"
                    class="link-button"
                    onClick={() => edit((e) => ({ ...e, rows: e.rows.filter((_, j) => j !== i) }))}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              class="link-button"
              onClick={() =>
                edit((e) => ({
                  ...e,
                  rows: [...e.rows, { login: "", from: "", to: "", secondary: false }],
                }))
              }
            >
              + Add someone
            </button>
            <span class="field-hint">
              A person is in one team at a time. Secondary lists them here while their PRs count for
              their main team.
            </span>
          </div>
        </Form>
      )}
      <Table cols={cols} head={["Team", "People", "Members", ""]} empty="No teams yet.">
        {Object.entries(value.teams).map(([name, team]) => {
          const rows = (team.people ?? []).map(rowOf);
          return (
            <div key={name} class="row dense" style={{ "--cols": cols }}>
              <span style={{ fontWeight: 500 }}>{name}</span>
              <span class="num">{rows.length}</span>
              <span class="soft cell-title">
                <span>
                  {rows
                    .map(
                      (r) =>
                        r.login +
                        (r.from || r.to ? ` (${r.from || "…"} – ${r.to || "now"})` : "") +
                        (r.secondary ? " (secondary)" : ""),
                    )
                    .join(", ")}
                </span>
              </span>
              <Actions
                onEdit={() => setEditing({ name, original: name, rows })}
                onRemove={() => part.save({ ...value, teams: without(value.teams, name) })}
              />
            </div>
          );
        })}
      </Table>
    </>
  );
}

// Groups ---------------------------------------------------------------------------------------

type GroupEntry = {
  name: string;
  kind: string;
  repos: string[];
  teams: string[];
  people: string[];
  /** Whether it is written under `products:` (the shorthand) or `groups:`. */
  home: "groups" | "products";
};

function GroupsSection({ api, meta, onSaved }: SectionProps) {
  const part = usePart(api, "groups", onSaved);
  const [editing, setEditing] = useState<{ entry: GroupEntry; original: GroupEntry | null } | null>(
    null,
  );
  if (!part.opened) return <Waiting problem={part.problem} />;
  const value = groupsValue(part.opened);
  const entries: GroupEntry[] = [
    ...Object.entries(value.groups).map(([name, g]) => ({
      name,
      kind: g.kind ?? "group",
      repos: g.repos ?? [],
      teams: g.teams ?? [],
      people: g.people ?? [],
      home: "groups" as const,
    })),
    ...Object.entries(value.products).map(([name, g]) => ({
      name,
      kind: "product",
      repos: g.repos ?? [],
      teams: g.teams ?? [],
      people: g.people ?? [],
      home: "products" as const,
    })),
  ];
  const kinds = [...new Set(["product", "area", ...entries.map((e) => e.kind)])];
  const write = async (next: GroupEntry[]) => {
    const groups: Record<string, GroupRaw> = {};
    const products: Record<string, GroupRaw> = {};
    for (const e of next) {
      const body = clean({ repos: e.repos, teams: e.teams, people: e.people });
      // A product stays in the shorthand; anything else, or a product made into another kind, is a group.
      if (e.home === "products" && e.kind === "product") products[e.name] = body;
      else groups[e.name] = clean({ kind: e.kind === "group" ? undefined : e.kind, ...body });
    }
    return part.save({ teams: value.teams, groups, products });
  };
  const save = async () => {
    if (!editing) return;
    const { entry, original } = editing;
    if (!entry.name.trim()) return part.setProblem("Give the group a name.");
    const rest = entries.filter((e) => e !== original);
    if (await write([...rest, { ...entry, name: entry.name.trim() }])) setEditing(null);
  };
  const set = (patch: Partial<GroupEntry>) =>
    setEditing((e) => e && { ...e, entry: { ...e.entry, ...patch } });
  const cols =
    "minmax(150px,1fr) 100px minmax(160px,1.4fr) minmax(120px,1fr) minmax(120px,1fr) 130px";
  return (
    <>
      <Head
        title="Groups"
        note="Products, areas, programs: anything to look at the report by. A group holds repos, teams and people, and groups may overlap."
        onAdd={() =>
          setEditing({
            entry: { name: "", kind: "product", repos: [], teams: [], people: [], home: "groups" },
            original: null,
          })
        }
      />
      {editing && (
        <Form
          title={editing.original ? `Edit ${editing.original.name}` : "Add a group"}
          problem={part.problem}
          busy={part.busy}
          onSave={save}
          onCancel={() => setEditing(null)}
        >
          <Text label="Name" value={editing.entry.name} onChange={(name) => set({ name })} />
          <Text
            label="Kind"
            value={editing.entry.kind}
            onChange={(kind) => set({ kind: kind.trim().toLowerCase() })}
            list="known-kinds"
            hint="One lowercase word. Each kind is its own breakdown in the report."
          />
          <datalist id="known-kinds">
            {kinds.map((k) => (
              <option key={k} value={k} />
            ))}
          </datalist>
          <List
            label="Repos"
            lines
            value={editing.entry.repos}
            onChange={(repos) => set({ repos })}
            placeholder="your-org/api-*"
            hint={`One per line; * matches anything. Synced: ${meta?.repos.slice(0, 3).join(", ") ?? ""}${(meta?.repos.length ?? 0) > 3 ? "…" : ""}`}
          />
          <Ticks
            label="Teams"
            options={Object.keys(value.teams)}
            value={editing.entry.teams}
            onChange={(teams) => set({ teams })}
            hint="Their PRs in any repo."
          />
          <List
            label="People"
            value={editing.entry.people}
            onChange={(people) => set({ people })}
            hint="Person keys or logins: their PRs in any repo."
          />
        </Form>
      )}
      <Table
        cols={cols}
        head={["Group", "Kind", "Repos", "Teams", "People", ""]}
        empty="No groups yet."
      >
        {entries.map((entry) => (
          <div key={`${entry.home}:${entry.name}`} class="row dense" style={{ "--cols": cols }}>
            <span style={{ fontWeight: 500 }}>{entry.name}</span>
            <span class="soft">{entry.kind}</span>
            <span class="soft">{entry.repos.join(", ")}</span>
            <span class="soft">{entry.teams.join(", ")}</span>
            <span class="soft">{entry.people.join(", ")}</span>
            <Actions
              onEdit={() => setEditing({ entry, original: entry })}
              onRemove={() => write(entries.filter((e) => e !== entry))}
            />
          </div>
        ))}
      </Table>
    </>
  );
}

// Rules ----------------------------------------------------------------------------------------

type RuleRaw = {
  id: string;
  description?: string;
  enabled?: boolean;
  scope?: Record<string, string[]>;
  when?: Record<string, unknown>;
  then?: Record<string, unknown>;
};

type Kind = "pr" | "repo" | "person";

type Draft = {
  id: string;
  description: string;
  enabled: boolean;
  kind: Kind;
  repos: string[];
  teams: string[];
  groups: string[];
  people: string[];
  labels: string[];
  title: string;
  base: string[];
  head: string[];
  association: string[];
  fromFork: boolean | undefined;
  draft: boolean | undefined;
  authorBot: boolean | undefined;
  count: boolean | undefined;
  internal: boolean | undefined;
  ignore: string[];
  measured: string[];
  promotion: string[];
  paths: { match: string; bucket: string }[];
  bot: boolean | undefined;
  botReviews: boolean | undefined;
};

const ASSOCIATIONS = [
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
  "CONTRIBUTOR",
  "FIRST_TIME_CONTRIBUTOR",
  "FIRST_TIMER",
  "NONE",
];
const BUCKETS = ["product", "test", "docs", "generated", "vendored", "lockfile"];
const KINDS: readonly { value: Kind; label: string; hint: string }[] = [
  {
    value: "pr",
    label: "What counts",
    hint: "leave PRs out, count them, say who is internal, ignore boilerplate comments",
  },
  { value: "repo", label: "Repo rules", hint: "which branches count, what is product code" },
  { value: "person", label: "People rules", hint: "who is a bot, which bots' reviews count" },
];

const strings = (value: unknown) => (Array.isArray(value) ? value.map(String) : []);
const flag = (value: unknown) => (typeof value === "boolean" ? value : undefined);

function draftOf(raw: RuleRaw | null): Draft {
  const then = raw?.then ?? {};
  const when = raw?.when ?? {};
  const scope = raw?.scope ?? {};
  const kind: Kind = ["measured_branches", "promotion_branches", "paths"].some((k) => k in then)
    ? "repo"
    : ["bot", "bot_reviews_count"].some((k) => k in then)
      ? "person"
      : "pr";
  return {
    id: raw?.id ?? "",
    description: raw?.description ?? "",
    enabled: raw?.enabled ?? true,
    kind,
    repos: strings(scope.repos),
    teams: strings(scope.teams),
    groups: strings(scope.groups),
    people: strings(scope.people),
    labels: strings(when.labels),
    title: typeof when.title === "string" ? when.title : "",
    base: strings(when.base),
    head: strings(when.head),
    association: strings(when.author_association),
    fromFork: flag(when.from_fork),
    draft: flag(when.draft),
    authorBot: flag(when.author_bot),
    count: flag(then.count),
    internal: flag(then.internal),
    ignore: strings(then.ignore_comments),
    measured: strings(then.measured_branches),
    promotion: strings(then.promotion_branches),
    paths: (Array.isArray(then.paths) ? then.paths : []).map(
      (p: { match?: unknown; bucket?: unknown }) => ({
        match: (Array.isArray(p.match) ? p.match : [p.match]).filter(Boolean).join(", "),
        bucket: String(p.bucket ?? "test"),
      }),
    ),
    bot: flag(then.bot),
    botReviews: flag(then.bot_reviews_count),
  };
}

/** The rule as rules.yml holds it: only the fields that say something, for its kind. */
function rawOf(d: Draft): RuleRaw {
  const scope =
    d.kind === "repo"
      ? clean({ repos: d.repos })
      : d.kind === "person"
        ? clean({ people: d.people })
        : clean({ repos: d.repos, teams: d.teams, groups: d.groups, people: d.people });
  const when =
    d.kind === "pr"
      ? clean({
          labels: d.labels,
          title: d.title || undefined,
          base: d.base,
          head: d.head,
          author_association: d.association,
          from_fork: d.fromFork,
          draft: d.draft,
          author_bot: d.authorBot,
        })
      : {};
  const then =
    d.kind === "pr"
      ? clean({ count: d.count, internal: d.internal, ignore_comments: d.ignore })
      : d.kind === "repo"
        ? clean({
            measured_branches: d.measured,
            promotion_branches: d.promotion,
            paths: d.paths
              .filter((p) => p.match.trim())
              .map((p) => ({
                match: p.match
                  .split(",")
                  .map((m) => m.trim())
                  .filter(Boolean),
                bucket: p.bucket,
              })),
          })
        : clean({ bot: d.bot, bot_reviews_count: d.botReviews });
  return clean({
    id: d.id.trim(),
    description: d.description.trim() || undefined,
    enabled: d.enabled ? undefined : false,
    scope: Object.keys(scope).length > 0 ? scope : undefined,
    when: Object.keys(when).length > 0 ? when : undefined,
    then,
  }) as RuleRaw;
}

function Rules({ api, onSaved }: SectionProps) {
  const part = usePart(api, "rules", onSaved);
  const groups = usePart(api, "groups", () => {});
  const [editing, setEditing] = useState<{ draft: Draft; index: number | null } | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const rules = ((part.opened?.value.rules ?? []) as RuleRaw[]).slice();
  const key = JSON.stringify(rules);
  // How many PRs each saved rule applies to: a preview of the rules as they are.
  useEffect(() => {
    if (!part.opened) return;
    api.preview(rules).then(
      (p) => setCounts(p.synced ? p.applied : {}),
      () => setCounts({}),
    );
  }, [key]);
  if (!part.opened || !groups.opened) return <Waiting problem={part.problem ?? groups.problem} />;
  const known = groupsValue(groups.opened);
  const teamNames = Object.keys(known.teams);
  const groupNames = [...Object.keys(known.groups), ...Object.keys(known.products)];
  const candidate = (draft: Draft, index: number | null) =>
    index === null
      ? [...rules, rawOf(draft)]
      : rules.map((r, i) => (i === index ? rawOf(draft) : r));
  const save = async () => {
    if (!editing) return;
    if (!editing.draft.id.trim()) return part.setProblem("Give the rule an id, such as no-chores.");
    if (await part.save({ rules: candidate(editing.draft, editing.index) })) setEditing(null);
  };
  const move = (i: number, by: number) => {
    const next = rules.slice();
    const [rule] = next.splice(i, 1);
    if (rule) next.splice(i + by, 0, rule);
    return part.save({ rules: next });
  };
  const cols =
    "70px minmax(150px,1fr) 110px minmax(150px,1.2fr) minmax(150px,1.2fr) minmax(150px,1.2fr) 60px 190px";
  return (
    <>
      <Head
        title="Rules"
        note="What counts, how repos are read, how people are treated, for the whole org or part of it. A more specific rule wins, then a later one."
        onAdd={() => setEditing({ draft: draftOf(null), index: null })}
      />
      {editing && (
        <RuleForm
          draft={editing.draft}
          onChange={(change) => setEditing((e) => e && { ...e, draft: change(e.draft) })}
          teams={teamNames}
          groups={groupNames}
          problem={part.problem}
          busy={part.busy}
          onSave={save}
          onCancel={() => setEditing(null)}
          preview={() => api.preview(candidate(editing.draft, editing.index))}
          title={editing.index === null ? "Add a rule" : `Edit ${rules[editing.index]?.id ?? ""}`}
        />
      )}
      <Table
        cols={cols}
        head={["On", "Rule", "Kind", "Where", "When", "Then", "PRs", ""]}
        empty="No rules yet: the org counts PRs as codeflow does by default."
      >
        {rules.map((rule, i) => {
          const draft = draftOf(rule);
          return (
            <div key={rule.id} class="row dense" style={{ "--cols": cols }}>
              <input
                type="checkbox"
                aria-label={`${rule.id} on`}
                checked={rule.enabled !== false}
                onChange={(e) =>
                  part.save({
                    rules: rules.map((r, j) =>
                      j === i ? rawOf({ ...draftOf(r), enabled: e.currentTarget.checked }) : r,
                    ),
                  })
                }
              />
              <span class="cell-title">
                <span style={{ fontWeight: 500 }}>{rule.id}</span>
                {rule.description && <span class="sub">{rule.description}</span>}
              </span>
              <span class="soft">{KINDS.find((k) => k.value === draft.kind)?.label}</span>
              <span class="soft">{summary(rule.scope) || "the whole org"}</span>
              <span class="soft">{summary(rule.when)}</span>
              <span class="soft">{summary(rule.then)}</span>
              <span class="num">{draft.kind === "pr" ? (counts[rule.id] ?? 0) : ""}</span>
              <span style={{ display: "flex", gap: "10px" }}>
                <button
                  type="button"
                  class="link-button"
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                  aria-label={`Move ${rule.id} up`}
                >
                  ↑
                </button>
                <button
                  type="button"
                  class="link-button"
                  disabled={i === rules.length - 1}
                  onClick={() => move(i, 1)}
                  aria-label={`Move ${rule.id} down`}
                >
                  ↓
                </button>
                <Actions
                  onEdit={() => setEditing({ draft, index: i })}
                  onRemove={() => part.save({ rules: rules.filter((_, j) => j !== i) })}
                />
              </span>
            </div>
          );
        })}
      </Table>
      <p class="muted" style={{ fontSize: "12px", margin: 0 }}>
        Rules from org.yml's older keys (branches, promotions, bots, paths) apply first; `codeflow
        rules` lists them with these.
      </p>
    </>
  );
}

function RuleForm(props: {
  title: string;
  draft: Draft;
  onChange: (change: (draft: Draft) => Draft) => void;
  teams: string[];
  groups: string[];
  problem: string | null;
  busy: boolean;
  onSave: () => void;
  onCancel: () => void;
  preview: () => Promise<Preview>;
}) {
  const { draft } = props;
  const set = (patch: Partial<Draft>) => props.onChange((d) => ({ ...d, ...patch }));
  const [preview, setPreview] = useState<{ result?: Preview; problem?: string } | null>(null);
  const key = JSON.stringify(draft);
  useEffect(() => {
    if (!draft.id.trim()) return;
    const timer = setTimeout(() => {
      props.preview().then(
        (result) => setPreview({ result }),
        (err: unknown) => setPreview({ problem: message(err) }),
      );
    }, 400);
    return () => clearTimeout(timer);
  }, [key]);
  return (
    <Form
      title={props.title}
      problem={props.problem}
      busy={props.busy}
      onSave={props.onSave}
      onCancel={props.onCancel}
    >
      <Text
        label="Id"
        value={draft.id}
        onChange={(id) => set({ id })}
        placeholder="no-chores"
        hint="Lowercase letters, digits, - _ and ."
      />
      <Text
        label="Description"
        value={draft.description}
        onChange={(description) => set({ description })}
        placeholder="Why the rule exists"
      />
      <Field label="Kind">
        <select value={draft.kind} onChange={(e) => set({ kind: e.currentTarget.value as Kind })}>
          {KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}: {k.hint}
            </option>
          ))}
        </select>
      </Field>
      <h3 class="form-section">Where</h3>
      {draft.kind !== "person" && (
        <List
          label="Repos"
          value={draft.repos}
          onChange={(repos) => set({ repos })}
          placeholder="your-org/legacy-*"
          hint="Globs. Empty: every repo."
        />
      )}
      {draft.kind === "pr" && (
        <>
          <Ticks
            label="Teams"
            options={props.teams}
            value={draft.teams}
            onChange={(teams) => set({ teams })}
          />
          <Ticks
            label="Groups"
            options={props.groups}
            value={draft.groups}
            onChange={(groups) => set({ groups })}
          />
        </>
      )}
      {draft.kind !== "repo" && (
        <List
          label="People"
          value={draft.people}
          onChange={(people) => set({ people })}
          placeholder="deploy-svc"
          hint="Person keys or logins."
        />
      )}
      {draft.kind === "pr" && (
        <>
          <h3 class="form-section">Which PRs</h3>
          <List
            label="Labels"
            value={draft.labels}
            onChange={(labels) => set({ labels })}
            placeholder="chore, dependencies"
            hint="Any of them."
          />
          <Text
            label="Title matches"
            value={draft.title}
            onChange={(title) => set({ title })}
            placeholder="^chore"
            hint="A regular expression, ignoring case."
          />
          <List
            label="Base branch"
            value={draft.base}
            onChange={(base) => set({ base })}
            placeholder="release/*"
          />
          <List
            label="Head branch"
            value={draft.head}
            onChange={(head) => set({ head })}
            placeholder="deps/*"
          />
          <Ticks
            label="Author's association"
            options={ASSOCIATIONS}
            value={draft.association}
            onChange={(association) => set({ association })}
            hint="As GitHub reports it."
          />
          <Choice
            label="From a fork"
            value={draft.fromFork}
            onChange={(fromFork) => set({ fromFork })}
            unset="Either"
            yes="Only from forks"
            no="Only from the repo"
          />
          <Choice
            label="Draft"
            value={draft.draft}
            onChange={(d) => set({ draft: d })}
            unset="Either"
            yes="Only drafts"
            no="Only ready PRs"
          />
          <Choice
            label="Opened by a bot"
            value={draft.authorBot}
            onChange={(authorBot) => set({ authorBot })}
            unset="Either"
            yes="Only bots'"
            no="Only people's"
          />
          <h3 class="form-section">Then</h3>
          <Choice
            label="Count"
            value={draft.count}
            onChange={(count) => set({ count })}
            unset="Unchanged"
            yes="Count them"
            no="Leave them out"
            hint="Counting can't bring back a PR into a branch that isn't measured: that is a repo rule."
          />
          <Choice
            label="Author is"
            value={draft.internal}
            onChange={(internal) => set({ internal })}
            unset="Unchanged"
            yes="Internal"
            no="External"
          />
          <List
            label="Ignore comments matching"
            lines
            value={draft.ignore}
            onChange={(ignore) => set({ ignore })}
            placeholder="^Thanks for your contribution"
            hint="Regular expressions, one per line."
          />
        </>
      )}
      {draft.kind === "repo" && (
        <>
          <h3 class="form-section">Then</h3>
          <List
            label="Measured branches"
            value={draft.measured}
            onChange={(measured) => set({ measured })}
            placeholder="develop"
            hint="The branches whose PRs count. Default: the repo's default branch."
          />
          <List
            label="Promotion branches"
            value={draft.promotion}
            onChange={(promotion) => set({ promotion })}
            placeholder="main, release/*"
            hint="Same-repo heads that promote work already counted."
          />
          <div class="field wide-field">
            <span class="field-label">Product code paths</span>
            {draft.paths.map((path, i) => (
              <div key={i} class="path-row">
                <input
                  type="text"
                  aria-label="Paths"
                  value={path.match}
                  placeholder="e2e/**, *.snap"
                  onInput={(e) =>
                    set({
                      paths: draft.paths.map((p, j) =>
                        j === i ? { ...p, match: e.currentTarget.value } : p,
                      ),
                    })
                  }
                />
                <select
                  aria-label="Bucket"
                  value={path.bucket}
                  onChange={(e) =>
                    set({
                      paths: draft.paths.map((p, j) =>
                        j === i ? { ...p, bucket: e.currentTarget.value } : p,
                      ),
                    })
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
                  onClick={() => set({ paths: draft.paths.filter((_, j) => j !== i) })}
                >
                  Remove
                </button>
              </div>
            ))}
            <button
              type="button"
              class="link-button"
              onClick={() => set({ paths: [...draft.paths, { match: "", bucket: "test" }] })}
            >
              + Add paths
            </button>
          </div>
        </>
      )}
      {draft.kind === "person" && (
        <>
          <h3 class="form-section">Then</h3>
          <Choice
            label="Bot"
            value={draft.bot}
            onChange={(bot) => set({ bot })}
            unset="Unchanged"
            yes="A bot"
            no="A person"
          />
          <Choice
            label="Their reviews"
            value={draft.botReviews}
            onChange={(botReviews) => set({ botReviews })}
            unset="Unchanged"
            yes="Count as review"
            no="Don't count"
          />
        </>
      )}
      <Field label="State" hint="An off rule is kept in rules.yml but skipped.">
        <select
          value={draft.enabled ? "on" : "off"}
          onChange={(e) => set({ enabled: e.currentTarget.value === "on" })}
        >
          <option value="on">On</option>
          <option value="off">Off</option>
        </select>
      </Field>
      <PreviewBox preview={preview} />
    </Form>
  );
}

function PreviewBox({ preview }: { preview: { result?: Preview; problem?: string } | null }) {
  if (!preview) return null;
  if (preview.problem) return <p class="problem wide-field">{preview.problem}</p>;
  const result = preview.result;
  if (!result) return null;
  if (!result.synced)
    return <p class="muted wide-field">Sync this org to see what the rule would change.</p>;
  const parts = [
    ["stop counting", result.leftOut],
    ["start counting", result.broughtIn],
    ["count as internal", result.internal],
    ["count as external", result.external],
  ] as const;
  const shown = parts.filter(([, c]) => c.count > 0);
  return (
    <div class="preview wide-field" aria-live="polite">
      <b>With this rule saved:</b>{" "}
      {shown.length === 0
        ? "no PR would be counted differently."
        : shown.map(([label, c]) => `${c.count} PRs would ${label}`).join(" · ")}
      {shown.map(([label, c]) => (
        <ul key={label}>
          {c.examples.map((e) => (
            <li key={e.id}>
              <span class="mono soft">
                {e.repo}#{e.number}
              </span>{" "}
              {e.title}
            </li>
          ))}
        </ul>
      ))}
    </div>
  );
}

// Import and export ----------------------------------------------------------------------------

const PARTS = [
  { key: "people", label: "People" },
  { key: "groups", label: "Teams and groups" },
  { key: "rules", label: "Rules" },
  { key: "settings", label: "Settings (sources, dates)" },
] as const;

function Transfer({ api, onSaved }: SectionProps) {
  const [parts, setParts] = useState<string[]>(["people", "groups", "rules"]);
  const [format, setFormat] = useState("yaml");
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [mode, setMode] = useState("merge");
  const [result, setResult] = useState<{ changes: string[]; applied: boolean } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const formatOfFile = (name: string) =>
    /\.csv$/i.test(name) ? "csv" : /\.json$/i.test(name) ? "json" : "yaml";
  const run = async (dryRun: boolean) => {
    if (!file) return;
    setProblem(null);
    try {
      const outcome = await api.importText(file.text, {
        format: formatOfFile(file.name),
        mode,
        only: formatOfFile(file.name) === "csv" ? [] : parts,
        dryRun,
      });
      setResult(outcome);
      if (outcome.applied) onSaved();
    } catch (err) {
      setProblem(message(err));
    }
  };
  return (
    <div class="grid halves">
      <section class="card">
        <h2 style={{ fontSize: "14px" }}>Export</h2>
        <p class="muted" style={{ margin: 0, fontSize: "13px" }}>
          A bundle of this org's config, to copy to another org, keep, or share. It never holds
          tokens.
        </p>
        <Ticks
          label="What"
          options={PARTS.map((p) => p.label)}
          value={PARTS.filter((p) => parts.includes(p.key)).map((p) => p.label)}
          onChange={(labels) =>
            setParts(PARTS.filter((p) => labels.includes(p.label)).map((p) => p.key))
          }
        />
        <Field label="Format">
          <select value={format} onChange={(e) => setFormat(e.currentTarget.value)}>
            <option value="yaml">YAML</option>
            <option value="json">JSON</option>
            <option value="csv">CSV (teams only)</option>
          </select>
        </Field>
        <a
          class="button"
          href={api.exportUrl(format === "csv" ? ["people", "groups"] : parts, format)}
          download
        >
          Download
        </a>
      </section>
      <section class="card">
        <h2 style={{ fontSize: "14px" }}>Import</h2>
        <p class="muted" style={{ margin: 0, fontSize: "13px" }}>
          A bundle, or a CSV of teams (team, login, from, to, secondary, name). Checked as a whole
          before anything is written.
        </p>
        <Field label="File">
          <input
            type="file"
            accept=".yml,.yaml,.json,.csv"
            onChange={async (e) => {
              const chosen = e.currentTarget.files?.[0];
              setResult(null);
              setFile(chosen ? { name: chosen.name, text: await chosen.text() } : null);
            }}
          />
        </Field>
        <Field label="Mode">
          <select value={mode} onChange={(e) => setMode(e.currentTarget.value)}>
            <option value="merge">Merge: add and update, remove nothing</option>
            <option value="replace">Replace: the file's parts replace this org's</option>
          </select>
        </Field>
        <div style={{ display: "flex", gap: "8px" }}>
          <button type="button" class="button" disabled={!file} onClick={() => run(true)}>
            Preview
          </button>
          <button
            type="button"
            class="button primary"
            disabled={!file || result === null || result.applied}
            onClick={() => run(false)}
          >
            Apply
          </button>
        </div>
        <Problem text={problem} />
        {result && (
          <div class="preview">
            <b>{result.applied ? "Applied:" : "Would change:"}</b>
            {result.changes.length === 0 ? (
              " nothing."
            ) : (
              <ul>
                {result.changes.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
