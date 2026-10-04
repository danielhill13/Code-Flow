// One person, several accounts (decision D42): people at a company that uses both GitHub and
// Azure DevOps have a login on each, and their PRs on both should be theirs, and their team's.
// This lists every account the synced PRs show, suggests which GitHub and Azure DevOps accounts
// look like the same person, and merges accounts into one person in people.yml's terms. All pure:
// the CLI, the server and the page call the same functions.
import type { PrFact } from "./facts.ts";

export type Host = "github" | "ado";

/** An account as the PRs show it, and the person config makes it, if any. */
export type Identity = {
  login: string;
  host: Host;
  /** The name the provider shows, or config's name for its person. */
  name: string | null;
  /** PRs it opened, and PRs it took part in (opened, reviewed or commented on). */
  authored: number;
  involved: number;
  lastSeen: string | null;
  /** The person key config gives it; null for an account config doesn't list. */
  person: string | null;
};

export type MergeSuggestion = {
  github: string;
  ado: string;
  /** Why they look alike, in a few words. */
  reason: string;
  strength: "strong" | "likely";
  /** The person they'd merge into: whichever of them already is one, or null for a new one. */
  person: string | null;
  /** Another account matches as well, so look before merging. */
  ambiguous: boolean;
};

/** A person as people.yml writes them. */
export type PersonRaw = {
  name?: string;
  github?: string[];
  ado?: string[];
  internal?: boolean;
  bot?: boolean;
};

const lower = (s: string) => s.toLowerCase();

/** Every account in the PRs, with its host, activity and person, most active first. */
export function identitiesOf(
  facts: readonly PrFact[],
  hostOf: (repoId: string) => Host,
  people: Record<string, PersonRaw>,
): Identity[] {
  const owner = personByLogin(people);
  const byKey = new Map<string, Identity>();
  for (const pr of facts) {
    const host = hostOf(pr.repoId);
    for (const { login, name } of pr.identities ?? []) {
      if (isServiceAccount(login)) continue;
      const key = `${host}:${lower(login)}`;
      let identity = byKey.get(key);
      if (!identity) {
        const person = owner.get(lower(login)) ?? null;
        identity = {
          login: lower(login),
          host,
          name: (person && people[person]?.name) || name,
          authored: 0,
          involved: 0,
          lastSeen: null,
          person,
        };
        byKey.set(key, identity);
      }
      if (!identity.name && name) identity.name = name;
      identity.involved += 1;
      if (lower(pr.author) === lower(login)) identity.authored += 1;
      if (identity.lastSeen === null || pr.createdAt > identity.lastSeen)
        identity.lastSeen = pr.createdAt;
    }
  }
  return [...byKey.values()].sort(
    (a, b) => b.involved - a.involved || a.login.localeCompare(b.login),
  );
}

/** Accounts that are services, not people: they never merge with anyone. */
function isServiceAccount(login: string): boolean {
  return /\[bot\]$|^build\\|^microsoft\.visualstudio/i.test(login);
}

/** Each login config lists, to the key of the person who has it. */
export function personByLogin(people: Record<string, PersonRaw>): Map<string, string> {
  const owner = new Map<string, string>();
  for (const [key, person] of Object.entries(people)) {
    for (const login of [...(person.github ?? [key]), ...(person.ado ?? [])]) {
      owner.set(lower(login), key);
    }
  }
  return owner;
}

/** Letters and digits only: "Ana.Ruiz", "ana-ruiz" and "Ana Ruiz" all read "anaruiz". */
const squash = (s: string) => lower(s).replace(/[^a-z0-9]/g, "");

/**
 * GitHub and Azure DevOps accounts that look like one person and aren't one yet: the part of an
 * address before the @ is the GitHub login (strong), or the shown name is, or its initials and
 * surname are (likely). Pairs already in one person, and accounts already in different people,
 * aren't suggested.
 */
export function suggestMerges(identities: readonly Identity[]): MergeSuggestion[] {
  const github = identities.filter((i) => i.host === "github");
  const ado = identities.filter((i) => i.host === "ado");
  const found: Omit<MergeSuggestion, "ambiguous">[] = [];
  for (const a of ado) {
    const local = a.login.split("@")[0] ?? a.login;
    const words = (a.name ?? local.replace(/[._-]+/g, " "))
      .trim()
      .split(/\s+/)
      .map(squash)
      .filter(Boolean);
    const first = words[0] ?? "";
    const last = words.at(-1) ?? "";
    const forms = new Map<string, { reason: string; strength: MergeSuggestion["strength"] }>([
      [squash(local), { reason: "the address's name is the login", strength: "strong" }],
    ]);
    const likely = (form: string, reason: string) => {
      if (form.length >= 3 && !forms.has(form)) forms.set(form, { reason, strength: "likely" });
    };
    likely(squash(a.name ?? ""), "the shown name is the login");
    if (words.length >= 2) {
      likely(`${first[0]}${last}`, "initial and surname");
      likely(`${first}${last[0]}`, "first name and initial");
      likely(`${last}${first[0]}`, "surname and initial");
      likely(first, "first name");
    }
    for (const g of github) {
      const match = forms.get(squash(g.login));
      if (!match) continue;
      if (a.person && g.person && a.person === g.person) continue; // already one person
      if (a.person && g.person) continue; // two people: merging them is a bigger call
      found.push({ github: g.login, ado: a.login, ...match, person: a.person ?? g.person });
    }
  }
  const count = (side: "github" | "ado", login: string) =>
    found.filter((f) => f[side] === login).length;
  const strengthOrder = { strong: 0, likely: 1 };
  return found
    .map((f) => ({ ...f, ambiguous: count("github", f.github) > 1 || count("ado", f.ado) > 1 }))
    .sort(
      (a, b) =>
        strengthOrder[a.strength] - strengthOrder[b.strength] ||
        Number(a.ambiguous) - Number(b.ambiguous) ||
        a.github.localeCompare(b.github),
    );
}

export type MergeRequest = {
  /** The person's key: an existing person's to add to it, or a new one. */
  key: string;
  name?: string;
  github: string[];
  ado: string[];
};

/**
 * people.yml's people with accounts merged into one person. The accounts leave any other person
 * that had them; a person left with no account at all is removed, its name and flags carried over
 * when the merged person has none. Teams can go on naming either login or either key: config
 * resolves them all to the merged person.
 */
export function mergePeople(
  people: Record<string, PersonRaw>,
  request: MergeRequest,
): Record<string, PersonRaw> {
  const key = request.key.trim();
  const moving = new Set([...request.github, ...request.ado].map(lower));
  const next: Record<string, PersonRaw> = {};
  let inherited: PersonRaw = {};
  for (const [other, person] of Object.entries(people)) {
    if (other === key) continue;
    const github = (person.github ?? [other]).filter((l) => !moving.has(lower(l)));
    const ado = (person.ado ?? []).filter((l) => !moving.has(lower(l)));
    const lost =
      github.length !== (person.github ?? [other]).length ||
      ado.length !== (person.ado ?? []).length;
    if (!lost) {
      next[other] = person;
      continue;
    }
    if (github.length + ado.length === 0) {
      inherited = { ...person, ...inherited };
      continue;
    }
    // With no GitHub login left, `[]` says so: left out, the key would stand in as one.
    next[other] = compact({ ...person, github, ado: ado.length > 0 ? ado : undefined });
  }
  const existing = people[key] ?? {};
  const github = unique([...(existing.github ?? (people[key] ? [key] : [])), ...request.github]);
  const ado = unique([...(existing.ado ?? []), ...request.ado]);
  next[key] = compact({
    name: request.name?.trim() || existing.name || inherited.name,
    // The key stands for a GitHub login unless logins are listed: list them when it isn't one.
    github: github.length === 1 && github[0] === key ? undefined : github.length > 0 ? github : [],
    ado: ado.length > 0 ? ado : undefined,
    internal: existing.internal ?? inherited.internal,
    bot: existing.bot ?? inherited.bot,
  });
  return next;
}

/** Takes one account off its person, so it's measured on its own again. */
export function separate(
  people: Record<string, PersonRaw>,
  login: string,
): Record<string, PersonRaw> {
  const next: Record<string, PersonRaw> = {};
  for (const [key, person] of Object.entries(people)) {
    const github = (person.github ?? [key]).filter((l) => lower(l) !== lower(login));
    const ado = (person.ado ?? []).filter((l) => lower(l) !== lower(login));
    if (github.length + ado.length === 0) continue;
    const changed =
      github.length !== (person.github ?? [key]).length || ado.length !== (person.ado ?? []).length;
    // A person whose GitHub login was only ever their key keeps it that way.
    const implicit = person.github === undefined && github.length === 1 && github[0] === key;
    next[key] = changed
      ? compact({
          ...person,
          github: implicit ? undefined : github,
          ado: ado.length > 0 ? ado : undefined,
        })
      : person;
  }
  return next;
}

function unique(logins: readonly string[]): string[] {
  const seen = new Set<string>();
  return logins.filter((l) => {
    const k = lower(l);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Drops fields that say nothing. An empty `github` stays: it says "no GitHub account". */
function compact(person: PersonRaw): PersonRaw {
  return Object.fromEntries(
    Object.entries(person).filter(([, v]) => v !== undefined && v !== ""),
  ) as PersonRaw;
}
