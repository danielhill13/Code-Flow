// The calls the Setup tab makes to `codeflow serve` for one org. Each part of the config is read
// with a version and written back whole, with that version, so an edit made meanwhile (in the
// file, or another tab) is never overwritten unseen.
import { call } from "../../core/http-source.ts";

export type ConfigPart = "people" | "groups" | "rules";

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

export interface AdminApi {
  readonly org: string;
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
