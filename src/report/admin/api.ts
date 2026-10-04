// The calls the Setup tab makes to `codeflow serve` for one org. Each part of the config is read
// with a version and written back whole, with that version, so an edit made meanwhile (in the
// file, or another tab) is never overwritten unseen.
import { call } from "../../core/http-source.ts";

export type ConfigPart = "people" | "groups" | "rules" | "settings";

/** A part as its files hold it: plain YAML values, before defaults and shorthand. */
export type PartValue = Record<string, unknown>;

export type Opened = { value: PartValue; version: string };

export type Preview =
  | { synced: false }
  | {
      synced: true;
      leftOut: Changed;
      broughtIn: Changed;
      internal: Changed;
      external: Changed;
      applied: Record<string, number>;
    };

export type Changed = {
  count: number;
  examples: { id: string; repo: string; number: number; title: string }[];
};

/** How fresh the org's data is, and when the server syncs it next (server/scheduler.ts). */
export type SyncStatus = {
  every: string;
  lastSync: string | null;
  nextSync: string | null;
  running: boolean;
  queued: boolean;
  lastError: string | null;
  log: string[];
  progress: string | null;
};

/** Whether codeflow reaches GitHub, and as whom (cli/session.ts, GitHubCheck). */
export type GitHubCheck =
  | {
      ok: true;
      login: string;
      source: string;
      kind: string;
      writeScopes: string[];
      remaining: number;
      limit: number;
    }
  | { ok: false; error: string };

export type GitHubSettings = { api_url?: string; token_env?: string };
export type AdoSettings = { url?: string; token_env?: string };

/** Whether codeflow reads an Azure DevOps organization, and as whom (server/admin.ts). */
export type AdoCheck =
  | { ok: true; who: string; source: string; kind: string; organization: string }
  | { ok: false; error: string };

/** A source as org.yml writes it: on GitHub (owner, repo) or Azure DevOps (ado). */
export type RawSource =
  | { owner: string; include?: string[]; exclude?: string[]; archived?: boolean; forks?: boolean }
  | { repo: string }
  | { ado: string; project?: string; include?: string[]; exclude?: string[]; forks?: boolean };

/** What a set of sources would measure (server/admin.ts, SourcesPreview). */
export type SourcesPreview = {
  github: GitHubCheck | null;
  sources: {
    name: string;
    ownerType: string | null;
    error: string | null;
    repos: {
      fullName: string;
      defaultBranch: string | null;
      archived: boolean;
      fork: boolean;
      /** Null on Azure DevOps, which can't count PRs without reading them. */
      prs: { open: number; merged: number; closed: number } | null;
      lastPrActivity: string | null;
    }[];
    skipped: { repo: string; reason: string }[];
  }[];
  firstSync: { prs: number; olderOpen: number; seconds: number; shareOfHour: number } | null;
};

/** What to measure, before it's saved: what a preview is asked about. */
export type SourcesDraft = {
  sources: RawSource[];
  since: string;
  github: GitHubSettings;
  azure_devops?: AdoSettings;
};

export type SyncedRepos = {
  repos: { fullName: string; defaultBranch: string; measured: string[] }[];
  advice: { repo: string; branch: string; into: number; merged: number; counted: number }[];
  /** Every branch PRs went into, busiest first. */
  branches: { name: string; prs: number }[];
};

/** A stored repo no source selects any more, with how many PRs it holds. */
export type Unmeasured = { id: string; fullName: string; provider: string; prs: number };

/** Accounts the org's PRs show, and merge suggestions (core/identities.ts). */
export type Identities = {
  identities: {
    login: string;
    host: "github" | "ado";
    name: string | null;
    authored: number;
    involved: number;
    lastSeen: string | null;
    person: string | null;
  }[];
  suggestions: {
    github: string;
    ado: string;
    reason: string;
    strength: "strong" | "likely";
    person: string | null;
    ambiguous: boolean;
  }[];
  /** Service accounts the PRs show, with how many PRs each took part in. */
  bots: { login: string; prs: number }[];
};

export interface AdminApi {
  readonly org: string;
  identities(): Promise<Identities>;
  /** Stored repos the sources no longer select (decision D43). */
  unmeasured(): Promise<{ repos: Unmeasured[] }>;
  /** Removes their data. */
  prune(): Promise<{ removed: Unmeasured[] }>;
  status(): Promise<SyncStatus>;
  syncNow(): Promise<SyncStatus>;
  repos(): Promise<SyncedRepos>;
  /** Takes the org off the workspace's list; its files and data stay. */
  remove(): Promise<void>;
  checkGitHub(github: GitHubSettings): Promise<GitHubCheck>;
  checkAdo(settings: AdoSettings & { organization?: string; project?: string }): Promise<AdoCheck>;
  previewSources(draft: SourcesDraft): Promise<SourcesPreview>;
  open(part: ConfigPart): Promise<Opened>;
  save(
    part: ConfigPart,
    value: PartValue,
    version: string,
  ): Promise<{ version: string; changes: string[] }>;
  preview(rules: unknown[]): Promise<Preview>;
  exportUrl(parts: string[], format: string): string;
  importText(
    text: string,
    options: { format: string; mode: string; only: string[]; dryRun: boolean },
  ): Promise<{ changes: string[]; applied: boolean }>;
}

export class ServerAdmin implements AdminApi {
  readonly org: string;
  readonly #base: string;

  constructor(org: string) {
    this.org = org;
    this.#base = `/api/orgs/${encodeURIComponent(org)}`;
  }

  status(): Promise<SyncStatus> {
    return call(this.#base, "/status");
  }

  syncNow(): Promise<SyncStatus> {
    return call(this.#base, "/sync", { method: "POST", body: {} });
  }

  repos(): Promise<SyncedRepos> {
    return call(this.#base, "/repos");
  }

  identities(): Promise<Identities> {
    return call(this.#base, "/identities");
  }

  unmeasured(): Promise<{ repos: Unmeasured[] }> {
    return call(this.#base, "/unmeasured");
  }

  prune(): Promise<{ removed: Unmeasured[] }> {
    return call(this.#base, "/prune", { method: "POST", body: {} });
  }

  async remove(): Promise<void> {
    await call(this.#base, "/remove", { method: "POST", body: {} });
  }

  checkGitHub(github: GitHubSettings): Promise<GitHubCheck> {
    return workspaceApi.checkGitHub(github);
  }

  checkAdo(settings: AdoSettings & { organization?: string; project?: string }): Promise<AdoCheck> {
    return workspaceApi.checkAdo(settings);
  }

  previewSources(draft: SourcesDraft) {
    return workspaceApi.previewSources(draft);
  }

  open(part: ConfigPart): Promise<Opened> {
    return call(this.#base, `/config/${part}`);
  }

  save(part: ConfigPart, value: PartValue, version: string) {
    return call<{ version: string; changes: string[] }>(this.#base, `/config/${part}`, {
      method: "PUT",
      body: { value, version },
    });
  }

  preview(rules: unknown[]): Promise<Preview> {
    return call(this.#base, "/rules/preview", { method: "POST", body: { rules } });
  }

  exportUrl(parts: string[], format: string): string {
    return `${this.#base}/export?only=${parts.join(",")}&format=${format}`;
  }

  importText(
    text: string,
    options: { format: string; mode: string; only: string[]; dryRun: boolean },
  ) {
    const query = new URLSearchParams({
      format: options.format,
      mode: options.mode,
      ...(options.only.length > 0 && { only: options.only.join(",") }),
      ...(options.dryRun && { dryRun: "1" }),
    });
    return call<{ changes: string[]; applied: boolean }>(this.#base, `/import?${query}`, {
      method: "POST",
      body: { text },
    });
  }
}

/** The orgs a server holds, by name. */
export async function serverOrgs(): Promise<string[]> {
  return (await call<{ orgs: string[] }>("/api/orgs", "")).orgs;
}

export type WorkspaceInfo = {
  exists: boolean;
  /** A single-file config from before workspaces: it must be converted to add orgs. */
  single: boolean;
  orgs: { name: string; synced: boolean }[];
  /** The `since` a new org gets unless told otherwise: a year back. */
  since: string;
};

const failed = (err: unknown): { ok: false; error: string } => ({
  ok: false,
  error: `codeflow couldn't check: ${err instanceof Error ? err.message : String(err)}`,
});

/** The calls about the workspace as a whole, before or besides any one org. */
export const workspaceApi = {
  info: (): Promise<WorkspaceInfo> => call("/api/workspace", ""),
  // The checks never throw: a request that fails is a failed check, with its reason, so the page
  // never waits on one that will not answer.
  checkGitHub: (github: GitHubSettings): Promise<GitHubCheck> =>
    call<GitHubCheck>("/api/github", "/check", { method: "POST", body: github }).catch(failed),
  checkAdo: (
    settings: AdoSettings & { organization?: string; project?: string },
  ): Promise<AdoCheck> =>
    call<AdoCheck>("/api/ado", "/check", { method: "POST", body: settings }).catch(failed),
  previewSources: (draft: SourcesDraft): Promise<SourcesPreview> =>
    call("/api/github", "/preview", { method: "POST", body: draft }),
  createOrg: (input: {
    name?: string;
    owners?: string[];
    repos?: string[];
    ado?: { organization: string; project?: string; include?: string[] }[];
    since?: string;
    github?: GitHubSettings;
    azure_devops?: AdoSettings;
  }): Promise<{ name: string }> => call("/api/workspace", "/orgs", { method: "POST", body: input }),
  convert: (name: string): Promise<{ name: string }> =>
    call("/api/workspace", "/convert", { method: "POST", body: { name } }),
};
