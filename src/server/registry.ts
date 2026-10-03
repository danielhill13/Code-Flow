// The orgs a server answers for, each loaded on its own: its config, its database, its facts.
// An org is reloaded when its files or its data change, so hand edits and a sync running beside
// the server show up on the next request. Nothing is shared between orgs (decision D29).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { loadWorkspace, type Org, type OrgPart, type Workspace } from "../config/workspace.ts";
import { EmbeddedSource } from "../core/source.ts";
import { CodeflowError } from "../errors.ts";
import { deriveFacts } from "../pipeline/derive.ts";
import { reportData } from "../pipeline/report.ts";
import { Store } from "../store/store.ts";

type Loaded = {
  org: Org;
  /** Null until the org has synced data. */
  source: EmbeddedSource | null;
  /** What the load was made from: the org's files and data, by modification time. */
  stamp: string;
};

export class Registry {
  readonly #path: string;
  #workspace: Workspace | null = null;
  #workspaceStamp = "";
  readonly #orgs = new Map<string, Loaded>();

  constructor(path: string) {
    this.#path = path;
  }

  /** The workspace, read again if its file has changed. */
  async workspace(): Promise<Workspace> {
    const stamp = mtimes([this.#path]);
    if (!this.#workspace || stamp !== this.#workspaceStamp) {
      this.#workspace = await loadWorkspace(this.#path);
      this.#workspaceStamp = stamp;
      this.#orgs.clear();
    }
    return this.#workspace;
  }

  async names(): Promise<string[]> {
    return (await this.workspace()).orgs.map((org) => org.name);
  }

  /** An org by name, loaded again if its config or data changed since it was last loaded. */
  async org(name: string): Promise<Loaded> {
    const workspace = await this.workspace();
    const found = workspace.orgs.find((org) => org.name === name);
    if (!found) throw new NotFound(`No org called "${name}".`);
    const stampOf = (org: Org) =>
      mtimes([...new Set(Object.values(org.files)), org.dbPath, `${org.dbPath}-wal`]);
    const cached = this.#orgs.get(name);
    if (cached && cached.stamp === stampOf(found)) return cached;
    // Reload the workspace so the org's config is read fresh, not from the first load.
    this.#workspace = await loadWorkspace(this.#path);
    const org = this.#workspace.orgs.find((o) => o.name === name) ?? found;
    const source = load(org, workspace.single);
    // Stamped after loading: deriving may itself write the database.
    const loaded: Loaded = { org, source, stamp: stampOf(org) };
    this.#orgs.set(name, loaded);
    return loaded;
  }

  /** Forgets an org, after its files were written: the next request loads it again. */
  forget(name: string): void {
    this.#orgs.delete(name);
  }
}

/** The org's data, derived under its current config, as the report's source; null if unsynced. */
function load(org: Org, single: boolean): EmbeddedSource | null {
  if (!existsSync(org.dbPath)) return null;
  const store = Store.open(org.dbPath);
  try {
    deriveFacts(store, org.config);
    if (!store.dataThrough()) return null;
    return new EmbeddedSource(reportData(store, org.config, single ? null : org.name));
  } catch (err) {
    if (err instanceof CodeflowError) return null; // e.g. a first sync still running
    throw err;
  } finally {
    store.close();
  }
}

/** A version for the files behind a part of an org's config: changes whenever they do. */
export function partVersion(org: Org, part: OrgPart): string {
  const file = org.files[part];
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function mtimes(paths: readonly string[]): string {
  return paths.map((path) => (existsSync(path) ? statSync(path).mtimeMs : 0)).join("|");
}

/** A request for something that doesn't exist: answered 404. */
export class NotFound extends Error {}
