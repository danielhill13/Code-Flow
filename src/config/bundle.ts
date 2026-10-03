// Export and import of an org's config (decision D32). A bundle holds any of an org's people,
// groups (teams included), rules and settings, in the same form its files use, so a bundle can
// move between orgs, be kept as a backup, or come from another system. Importing checks the
// result as a whole before writing anything, says what changes, and keeps the comments in the
// org's files wherever it doesn't change them.
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  type Document,
  isMap,
  isNode,
  isSeq,
  parseDocument,
  stringify,
  YAMLMap,
  YAMLSeq,
} from "yaml";
import { CodeflowError } from "../errors.ts";
import { formatIssues } from "./load.ts";
import { BUNDLE_VERSION, BundleSchema, ConfigSchema } from "./schema.ts";
import { ORG_FILES, type Org, partOfKey } from "./workspace.ts";

/** What a bundle can hold. `settings` is org.yml: what to measure, and the older rule keys. */
export type Part = "settings" | "people" | "groups" | "rules";

export const PARTS: readonly Part[] = ["settings", "people", "groups", "rules"];

/** What export and import cover unless told otherwise: sources and dates are each org's own. */
export const DEFAULT_PARTS: readonly Part[] = ["people", "groups", "rules"];

const SETTINGS = [
  "sources",
  "since",
  "github",
  "data_dir",
  "branches",
  "promotions",
  "bots",
  "paths",
];

const KEYS: Record<Part, readonly string[]> = {
  settings: SETTINGS,
  people: ["people"],
  groups: ["teams", "groups", "products"],
  rules: ["rules"],
};

/** Keys whose values are maps of named entries, merged entry by entry. */
const NAMED = new Set(["people", "teams", "groups", "products", "branches"]);

export type Bundle = { codeflow: number; org?: string; exported?: string } & Record<
  string,
  unknown
>;

export type Format = "yaml" | "json" | "csv";

export function parseParts(text: string | undefined): Part[] {
  if (text === undefined) return [...DEFAULT_PARTS];
  const parts = text.split(",").map((p) => p.trim()) as Part[];
  const unknown = parts.filter((p) => !PARTS.includes(p));
  if (unknown.length > 0) {
    throw new CodeflowError(`--only takes ${PARTS.join(", ")}; not ${unknown.join(", ")}.`);
  }
  return parts;
}

export function formatOf(file: string, given?: string): Format {
  const format = given ?? (/\.csv$/i.test(file) ? "csv" : /\.json$/i.test(file) ? "json" : "yaml");
  if (format !== "yaml" && format !== "json" && format !== "csv") {
    throw new CodeflowError(`--format takes yaml, json or csv; not ${format}.`);
  }
  return format;
}

/** An org's config as written in its files, key by key, before defaults and shorthand. */
export async function readRaw(org: Org): Promise<Record<string, unknown>> {
  const raw: Record<string, unknown> = {};
  for (const file of new Set(Object.values(org.files))) {
    if (!existsSync(file)) continue;
    const doc = parseDocument(await readFile(file, "utf8"));
    const content = doc.toJS() as unknown;
    if (content && typeof content === "object") Object.assign(raw, content);
  }
  return raw;
}

/** The parts of an org's config as a bundle. */
export async function exportBundle(
  org: Org,
  parts: readonly Part[],
  now = new Date(),
): Promise<Bundle> {
  const raw = await readRaw(org);
  const bundle: Bundle = { codeflow: BUNDLE_VERSION, org: org.name, exported: now.toISOString() };
  if (parts.includes("settings")) {
    const settings = Object.fromEntries(SETTINGS.filter((k) => k in raw).map((k) => [k, raw[k]]));
    if (Object.keys(settings).length > 0) bundle.settings = settings;
  }
  for (const part of parts) {
    if (part === "settings") continue;
    for (const key of KEYS[part]) if (raw[key] !== undefined) bundle[key] = raw[key];
  }
  return bundle;
}

export function renderBundle(bundle: Bundle, format: Format): string {
  switch (format) {
    case "json":
      return `${JSON.stringify(bundle, null, 2)}\n`;
    case "yaml":
      return `# A codeflow bundle: import it with \`codeflow import <file> --org <name>\`.\n${stringify(bundle)}`;
    case "csv":
      return teamsCsv(bundle);
  }
}

/** A bundle from a file's text: checked for shape, values kept as they were written. */
export function readBundle(text: string, format: Format, source: string): Bundle {
  if (format === "csv") return csvBundle(text, source);
  let raw: unknown;
  if (format === "json") {
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new CodeflowError(`${source}: ${(err as Error).message}`);
    }
  } else {
    const doc = parseDocument(text);
    const [yamlError] = doc.errors;
    if (yamlError) throw new CodeflowError(`${source}: ${yamlError.message}`);
    raw = doc.toJS();
  }
  const result = BundleSchema.safeParse(raw);
  if (!result.success) {
    throw new CodeflowError(`${source} is not valid:\n${formatIssues(result.error.issues)}`);
  }
  return raw as Bundle;
}

export type Change = {
  key: string;
  /** The entry: a person, team, group or rule; empty for a setting as a whole. */
  name: string;
  action: "added" | "changed" | "removed";
};

export type ImportPlan = {
  /** The org's config after the import, as it would be written. */
  next: Record<string, unknown>;
  changes: Change[];
  /** Top-level keys whose values change. */
  keys: string[];
  mode: "merge" | "replace";
};

/**
 * What importing a bundle would do. In `merge` mode, entries are added or updated and nothing
 * is removed; in `replace` mode, each key the bundle holds replaces the org's whole key. Throws,
 * naming the file each problem would be in, if the result wouldn't be a valid config.
 */
export async function planImport(
  org: Org,
  bundle: Bundle,
  parts: readonly Part[],
  mode: "merge" | "replace",
): Promise<ImportPlan> {
  const current = await readRaw(org);
  const incoming: Record<string, unknown> = {};
  if (parts.includes("settings") && bundle.settings && typeof bundle.settings === "object") {
    Object.assign(incoming, bundle.settings);
  }
  for (const part of parts) {
    if (part === "settings") continue;
    for (const key of KEYS[part]) if (bundle[key] !== undefined) incoming[key] = bundle[key];
  }

  const next = { ...current };
  const changes: Change[] = [];
  for (const [key, value] of Object.entries(incoming)) {
    const before = current[key];
    if (NAMED.has(key) && isRecord(value)) {
      const old = isRecord(before) ? before : {};
      const merged: Record<string, unknown> = mode === "merge" ? { ...old } : {};
      for (const [name, entry] of Object.entries(value)) {
        if (!(name in old)) changes.push({ key, name, action: "added" });
        else if (!same(old[name], entry)) changes.push({ key, name, action: "changed" });
        merged[name] = entry;
      }
      if (mode === "replace") {
        for (const name of Object.keys(old)) {
          if (!(name in value)) changes.push({ key, name, action: "removed" });
        }
      }
      next[key] = merged;
    } else if (key === "rules" && Array.isArray(value)) {
      const old = Array.isArray(before) ? (before as { id?: string }[]) : [];
      const merged = mode === "merge" ? [...old] : [];
      for (const rule of value as { id?: string }[]) {
        const at = old.findIndex((r) => r.id === rule.id);
        if (at === -1) changes.push({ key, name: rule.id ?? "", action: "added" });
        else if (!same(old[at], rule))
          changes.push({ key, name: rule.id ?? "", action: "changed" });
        const place = merged.findIndex((r) => r.id === rule.id);
        if (place === -1) merged.push(rule);
        else merged[place] = rule;
      }
      if (mode === "replace") {
        for (const rule of old) {
          if (!(value as { id?: string }[]).some((r) => r.id === rule.id)) {
            changes.push({ key, name: rule.id ?? "", action: "removed" });
          }
        }
      }
      next[key] = merged;
    } else if (!same(before, value)) {
      changes.push({ key, name: "", action: before === undefined ? "added" : "changed" });
      next[key] = value;
    }
  }

  const result = ConfigSchema.safeParse(next);
  if (!result.success) {
    const lines = result.error.issues.map((issue) => {
      const file = ORG_FILES[partOfKey(String(issue.path[0] ?? ""))];
      return `${file}: ${formatIssues([issue]).trim()}`;
    });
    throw new CodeflowError(
      `Importing would leave org "${org.name}" invalid:\n  ${lines.join("\n  ")}`,
    );
  }
  const keys = [...new Set(changes.map((c) => c.key))];
  return { next, changes, keys, mode };
}

/**
 * Writes a planned import into the org's files. Entries of named maps are set one by one, so
 * comments on the others stay; a setting or the list of rules is replaced whole. Each file is
 * written to a temporary name and renamed into place, so a crash can't leave half a file.
 */
export async function applyImport(org: Org, plan: ImportPlan): Promise<string[]> {
  const byFile = new Map<string, string[]>();
  for (const key of plan.keys) {
    const file = org.files[partOfKey(key)];
    byFile.set(file, [...(byFile.get(file) ?? []), key]);
  }
  const written: string[] = [];
  for (const [file, keys] of byFile) {
    // A file of comments only (as init writes) has no map yet: give it one, keeping the comments.
    const doc: Document = parseDocument(existsSync(file) ? await readFile(file, "utf8") : "");
    if (!isMap(doc.contents)) doc.contents = new YAMLMap();
    for (const key of keys) {
      const value = plan.next[key];
      const node = doc.get(key);
      if (NAMED.has(key) && isRecord(value) && isMap(node)) {
        for (const change of plan.changes.filter((c) => c.key === key)) {
          if (change.action === "removed") doc.deleteIn([key, change.name]);
          else doc.setIn([key, change.name], doc.createNode(value[change.name]));
        }
      } else if (Array.isArray(value) && isSeq(node)) {
        doc.set(key, reuseItems(doc, node, value));
      } else {
        doc.set(key, doc.createNode(value));
      }
    }
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.importing`;
    await writeFile(temporary, doc.toString());
    await rename(temporary, file);
    written.push(file);
  }
  return written;
}

/**
 * A list as `value` says, made of the existing entries wherever an entry is unchanged: a rule
 * that wasn't edited keeps its comments and layout, wherever it now sits in the list.
 */
function reuseItems(doc: Document, node: YAMLSeq, value: readonly unknown[]): YAMLSeq {
  const unused = node.items.map((item) => ({
    item,
    same: canonical(isNode(item) ? item.toJSON() : item),
  }));
  const seq = new YAMLSeq();
  seq.flow = node.flow;
  seq.commentBefore = node.commentBefore;
  seq.comment = node.comment;
  for (const entry of value) {
    const same = canonical(entry);
    const found = unused.findIndex((u) => u.same === same);
    const [reused] = found === -1 ? [] : unused.splice(found, 1);
    seq.items.push(reused ? reused.item : doc.createNode(entry));
  }
  return seq;
}

/** A value as text, the same whatever order its keys are in. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** "teams: added Core, changed App · rules: added no-chores". */
export function describeChanges(changes: readonly Change[]): string[] {
  const lines: string[] = [];
  for (const key of [...new Set(changes.map((c) => c.key))]) {
    const parts = (["added", "changed", "removed"] as const).flatMap((action) => {
      const names = changes.filter((c) => c.key === key && c.action === action).map((c) => c.name);
      if (names.length === 0) return [];
      return [names.every((n) => n === "") ? action : `${action} ${names.join(", ")}`];
    });
    lines.push(`${key}: ${parts.join("; ")}`);
  }
  return lines;
}

const CSV_HEADER = ["team", "login", "from", "to", "secondary", "name"];

/** Teams as CSV, one member per row: what HR spreadsheets and directories export. */
function teamsCsv(bundle: Bundle): string {
  const teams = isRecord(bundle.teams) ? bundle.teams : {};
  const people = isRecord(bundle.people) ? bundle.people : {};
  const nameOf = (login: string) => {
    for (const [key, person] of Object.entries(people)) {
      if (!isRecord(person)) continue;
      const logins = Array.isArray(person.github) ? person.github : [key];
      if (key === login || logins.includes(login))
        return typeof person.name === "string" ? person.name : "";
    }
    return "";
  };
  const rows = [CSV_HEADER];
  for (const [team, def] of Object.entries(teams)) {
    const members = isRecord(def) && Array.isArray(def.people) ? def.people : [];
    for (const member of members) {
      const m =
        typeof member === "string" ? { login: member } : (member as Record<string, unknown>);
      const login = String(m.login ?? "");
      rows.push([
        team,
        login,
        String(m.from ?? ""),
        String(m.to ?? ""),
        m.secondary === true ? "true" : "",
        nameOf(login),
      ]);
    }
  }
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

/** Teams (and people's names) from CSV with a header row: team and login, at least. */
function csvBundle(text: string, source: string): Bundle {
  const [header, ...rows] = parseCsv(text);
  const columns = (header ?? []).map((h) => h.trim().toLowerCase());
  for (const needed of ["team", "login"]) {
    if (!columns.includes(needed)) {
      throw new CodeflowError(
        `${source}: the first row must name the columns, including ${needed} (${CSV_HEADER.join(",")}).`,
      );
    }
  }
  const at = (row: string[], column: string) => (row[columns.indexOf(column)] ?? "").trim();
  const teams: Record<string, { people: unknown[] }> = {};
  const people: Record<string, { name: string }> = {};
  rows.forEach((row, i) => {
    if (row.every((cell) => cell.trim() === "")) return;
    const team = at(row, "team");
    const login = at(row, "login");
    if (!team || !login)
      throw new CodeflowError(`${source}, row ${i + 2}: needs a team and a login.`);
    const from = at(row, "from");
    const to = at(row, "to");
    const secondary = /^(true|yes|1)$/i.test(at(row, "secondary"));
    const member =
      from || to || secondary
        ? { login, ...(from && { from }), ...(to && { to }), ...(secondary && { secondary }) }
        : login;
    const entry = teams[team] ?? { people: [] };
    entry.people.push(member);
    teams[team] = entry;
    const name = at(row, "name");
    if (name) people[login] = { name };
  });
  const bundle: Bundle = { codeflow: BUNDLE_VERSION, teams };
  if (Object.keys(people).length > 0) bundle.people = people;
  const result = BundleSchema.safeParse(bundle);
  if (!result.success) {
    throw new CodeflowError(`${source} is not valid:\n${formatIssues(result.error.issues)}`);
  }
  return bundle;
}

/** RFC 4180 CSV: commas, quoted cells, doubled quotes inside them, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += char;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
