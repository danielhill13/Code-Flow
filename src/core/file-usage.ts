// What an org's PRs change (decision D56): the result of looking, shared by the command, the
// server and the page. Pure types: the looking is pipeline/files.ts.
import type { Bucket } from "./paths.ts";

/** A kind of file, or a folder, among those counted as code. */
export type UsageRow = {
  /** ".md", "Dockerfile"; or "thoughts" (a folder, with its subfolders), "thoughts/shared". */
  name: string;
  /** File changes: each file in each PR counts once. */
  changes: number;
  /** PRs that changed at least one. */
  prs: number;
  /** Changes per PR: a tree with hundreds is rarely code. */
  perPr: number;
  /** Many files per PR, in quantity: worth a look. */
  bulk: boolean;
  /** A kind of file that is a whole name (Dockerfile, .gitignore), not an extension. */
  whole: boolean;
  /** A few paths, to recognise it by. */
  examples: string[];
  /** For a folder: the extensions most of its files have. */
  extensions: string[];
};

export type FileUsage = {
  /** PRs whose files were all listed, and the file changes in them. */
  prs: number;
  changes: number;
  /** Every change, by the bucket the org's rules put it in. */
  byBucket: { bucket: Bucket; changes: number }[];
  /** File changes counted as code (product and test): their kinds and their folders. */
  codeChanges: number;
  extensions: UsageRow[];
  folders: UsageRow[];
};
