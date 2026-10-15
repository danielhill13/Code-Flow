// `codeflow files`: what an org's PRs change, by the kinds of file and the folders counted as
// code, with the ones that change many files per PR flagged (decision D56). The evidence to
// choose path rules from. Local only: no network.
import { existsSync } from "node:fs";
import type { Org } from "../config/workspace.ts";
import type { FileUsage, UsageRow } from "../core/file-usage.ts";
import { BUCKETS } from "../core/paths.ts";
import { fileUsage } from "../pipeline/files.ts";
import { Store } from "../store/store.ts";
import { dim, num, status, table } from "./format.ts";
import { type OrgOptions, orgHeading, orgsFor, type Print } from "./session.ts";

export type FilesOptions = OrgOptions & { repo?: string; top?: string };

export async function files(options: FilesOptions): Promise<number> {
  const print: Print = (line = "") => console.log(line);
  const top = Math.max(1, Number(options.top) || 15);
  const { workspace, orgs } = await orgsFor(options);
  for (const [i, org] of orgs.entries()) {
    if (i > 0) print();
    orgHeading(workspace, org, print);
    await filesOf(org, { repo: options.repo, limit: top }, print);
  }
  return 0;
}

async function filesOf(
  org: Org,
  options: { repo?: string; limit: number },
  print: Print,
): Promise<void> {
  if (!existsSync(org.dbPath)) {
    print(status("warn", "Data", "nothing synced yet. Run: codeflow sync"));
    return;
  }
  const store = Store.open(org.dbPath);
  try {
    const usage = await fileUsage(store, org.config, options);
    if (usage.prs === 0) {
      print(status("warn", "Files", "no stored PR lists its files yet"));
      return;
    }
    print(
      status(
        "ok",
        "Files",
        `${num(usage.changes)} file changes in ${num(usage.prs)} PRs${options.repo ? ` of ${options.repo}` : ""}`,
      ),
    );
    print();
    print(
      table(
        ["bucket", "changes", "share"],
        BUCKETS.map((bucket) => usage.byBucket.find((b) => b.bucket === bucket)).flatMap((b) =>
          b ? [[b.bucket, num(b.changes), share(b.changes, usage.changes)]] : [],
        ),
        { rightAlign: [1, 2], indent: "  " },
      ),
    );
    print(
      dim("  Code is product and test; the rest are docs, notes, assets, generated and the like."),
    );
    section("Extensions counted as code", usage.extensions, usage, print, false);
    section(
      "Folders counted as code (a folder includes its subfolders)",
      usage.folders,
      usage,
      print,
      true,
    );
    const bulk = usage.folders.find((row) => row.bulk && row.name !== "(repo root)");
    if (bulk) {
      print();
      print(
        status(
          "warn",
          "Not code?",
          `${bulk.name}/ changes ${num(bulk.perPr)} files per PR. If it holds notes or data, add to org.yml, or in Setup › Paths:`,
        ),
      );
      print(dim("    paths:"));
      print(dim(`      - { match: "${bulk.name}/**", bucket: docs }`));
    }
  } finally {
    store.close();
  }
}

const share = (part: number, whole: number) =>
  whole > 0 ? `${((part / whole) * 100).toFixed(part / whole < 0.1 ? 1 : 0)}%` : "—";

function section(
  title: string,
  rows: readonly UsageRow[],
  usage: FileUsage,
  print: Print,
  folders: boolean,
): void {
  print();
  print(title);
  if (rows.length === 0) {
    print(dim("  none"));
    return;
  }
  print(
    table(
      ["", "changes", "share", "PRs", "per PR", folders ? "mostly" : "example", ""],
      rows.map((row) => [
        folders && row.name !== "(repo root)" ? `${row.name}/` : row.name,
        num(row.changes),
        share(row.changes, usage.codeChanges),
        num(row.prs),
        num(row.perPr),
        folders ? row.extensions.join(" ") : (row.examples[0] ?? ""),
        row.bulk ? "bulk" : "",
      ]),
      { rightAlign: [1, 2, 3, 4], indent: "  " },
    ),
  );
}
