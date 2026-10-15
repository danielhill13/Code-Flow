// What an org's PRs change, by the kinds of file and the folders counted as code (decision D56):
// the evidence to choose path rules from. A `thoughts/` tree of notes, a folder of exported data,
// or a build's output all look like code until a rule says otherwise; they show as the extensions
// and folders with the most file changes, and, above all, the most files per PR. Read from the
// stored PRs, with the org's own path rules, so it shows the numbers as they stand now.
import picomatch from "picomatch";
import type { Config } from "../config/schema.ts";
import type { FileUsage, UsageRow } from "../core/file-usage.ts";
import { BUCKETS, type Bucket } from "../core/paths.ts";
import type { Store } from "../store/store.ts";
import { measuredBranches, normalize, rulesFor } from "./derive.ts";

/** At least this many changes, and this many per PR, for a row to be flagged. */
const BULK_CHANGES = 200;
const BULK_PER_PR = 50;
const EXAMPLES = 2;
const ROOT = "(repo root)";

type Tally = {
  changes: number;
  prs: number;
  whole: boolean;
  lastPr: string;
  examples: string[];
  extensions: Map<string, number>;
};

const tally = (): Tally => ({
  changes: 0,
  prs: 0,
  whole: false,
  lastPr: "",
  examples: [],
  extensions: new Map(),
});

/** ".ts" for "src/a.ts"; the name itself for a file with none ("Dockerfile"). */
export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : name;
}

/**
 * A file's folders, widest first: "thoughts/shared/x.md" is under "thoughts" and
 * "thoughts/shared"; "src/a.ts" under "src"; "a.ts" under the repo root.
 */
export function foldersOf(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  if (parts.length === 0) return [ROOT];
  return parts.length === 1 ? [parts[0] ?? ROOT] : [parts[0] ?? ROOT, parts.slice(0, 2).join("/")];
}

export async function fileUsage(
  store: Store,
  config: Config,
  options: { repo?: string; limit?: number } = {},
): Promise<FileUsage> {
  const limit = options.limit ?? 15;
  const wanted = options.repo ? picomatch(options.repo, { nocase: true, dot: true }) : () => true;
  const byBucket = new Map<Bucket, number>(BUCKETS.map((bucket) => [bucket, 0]));
  const extensions = new Map<string, Tally>();
  const folders = new Map<string, Tally>();
  let prs = 0;
  let changes = 0;
  let codeChanges = 0;
  let read = 0;

  for (const repo of store.repos()) {
    if (!wanted(repo.fullName)) continue;
    const rules = rulesFor(config, repo.fullName, measuredBranches(config, repo));
    for (const version of store.latestPrs(repo.id)) {
      // The PR server's busy answering as this runs: let it breathe now and then.
      if (++read % 250 === 0) await new Promise((resolve) => setImmediate(resolve));
      const pr = normalize(repo, version.payload, version.updatedAt);
      // A PR whose file list was cut short would count only some of its files.
      if (pr.truncated.includes("files") || pr.files.length === 0) continue;
      prs += 1;
      for (const file of pr.files) {
        const bucket = rules.classify(repo.fullName, file.path);
        byBucket.set(bucket, (byBucket.get(bucket) ?? 0) + 1);
        changes += 1;
        if (bucket !== "product" && bucket !== "test") continue;
        codeChanges += 1;
        const extension = extensionOf(file.path);
        const whole = extension === file.path.slice(file.path.lastIndexOf("/") + 1);
        const add = (map: Map<string, Tally>, name: string, folder: boolean) => {
          let row = map.get(name);
          if (!row) {
            row = tally();
            row.whole = !folder && whole;
            map.set(name, row);
          }
          row.changes += 1;
          if (row.lastPr !== version.id) {
            row.prs += 1;
            row.lastPr = version.id;
          }
          if (row.examples.length < EXAMPLES && !row.examples.includes(file.path)) {
            row.examples.push(file.path);
          }
          if (folder) row.extensions.set(extension, (row.extensions.get(extension) ?? 0) + 1);
        };
        add(extensions, extension, false);
        for (const folder of foldersOf(file.path)) add(folders, folder, true);
      }
    }
  }

  const rows = (map: Map<string, Tally>): UsageRow[] =>
    [...map]
      .map(([name, t]) => ({
        name,
        changes: t.changes,
        prs: t.prs,
        perPr: t.prs > 0 ? Math.round(t.changes / t.prs) : 0,
        whole: t.whole,
        bulk: t.changes >= BULK_CHANGES && t.changes / t.prs >= BULK_PER_PR,
        examples: t.examples,
        extensions: [...t.extensions]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([ext]) => ext),
      }))
      .sort((a, b) => b.changes - a.changes || a.name.localeCompare(b.name))
      .slice(0, limit);

  return {
    prs,
    changes,
    byBucket: [...byBucket].map(([bucket, n]) => ({ bucket, changes: n })),
    codeChanges,
    extensions: rows(extensions),
    folders: rows(folders),
  };
}
