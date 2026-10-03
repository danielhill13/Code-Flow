/**
 * Copies synced PRs into test fixtures, anonymized, for tests that need real GitHub payloads.
 *
 *   node scripts/fixture.ts usebruno/bruno 9000 7719 7921
 *
 * Reads the local database (sync first) and writes src/testing/fixtures/github/<owner>-<name>.json.
 * People become user1, user2… (the same person keeps the same name across the file); bots keep
 * their names, since they are products, not people. Titles, bodies, commit messages and
 * comments are blanked, except the revert markers tests depend on. Paths, timestamps, counts
 * and states are kept: they are what the tests are about.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadWorkspace } from "../src/config/workspace.ts";
import { Store } from "../src/store/store.ts";

const [repo, ...numbers] = process.argv.slice(2);
if (!repo || numbers.length === 0) {
  console.error("usage: node scripts/fixture.ts <owner/name> <number>...");
  process.exit(1);
}

// The org that synced the repo: each org has its own database.
let store: Store | undefined;
let repoId: string | undefined;
for (const org of (await loadWorkspace("codeflow.yml")).orgs) {
  const candidate = Store.open(org.dbPath);
  repoId = candidate.repos().find((r) => r.fullName === repo)?.id;
  if (repoId) {
    store = candidate;
    break;
  }
  candidate.close();
}
if (!store || !repoId) throw new Error(`${repo} is not synced by any org`);
const wanted = new Set(numbers.map(Number));
const prs = [...store.latestPrs(repoId)]
  .filter((pr) => wanted.has(pr.number))
  .map((pr) => pr.payload);
store.close();

const people = new Map<string, string>();
const pseudonym = (login: string) => {
  const key = login.toLowerCase();
  if (!people.has(key)) people.set(key, `user${people.size + 1}`);
  return people.get(key) as string;
};

const keepLines = (text: string, pattern: RegExp) =>
  text
    .split("\n")
    .filter((line) => pattern.test(line))
    .join("\n");

/** Walks the payload, replacing people and prose; everything else passes through. */
function scrub(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) return value.map((item) => scrub(item, key));
  if (value === null || typeof value !== "object") {
    if (typeof value !== "string") return value;
    if (key === "title") return /^revert\b/i.test(value) ? 'Revert "…"' : "…";
    if (key === "body")
      return keepLines(value, /^Reverts\s+[\w.-]+\/[\w.-]+#\d+/) || (value ? "…" : "");
    if (key === "message") return keepLines(value, /This reverts commit [0-9a-f]{7,40}/) || "…";
    return value;
  }
  const object = value as Record<string, unknown>;
  const isActor = typeof object.login === "string" && typeof object.__typename === "string";
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(object)) {
    if (k === "login" && typeof v === "string" && (!isActor || object.__typename !== "Bot")) {
      out[k] = pseudonym(v);
    } else if (k === "slug" && typeof v === "string") {
      out[k] = "team1";
    } else {
      out[k] = scrub(v, k);
    }
  }
  return out;
}

const here = dirname(fileURLToPath(import.meta.url));
const file = join(
  here,
  "..",
  "src",
  "testing",
  "fixtures",
  "github",
  `${repo.replace("/", "-")}.json`,
);
mkdirSync(dirname(file), { recursive: true });
writeFileSync(
  file,
  `${JSON.stringify(
    prs.map((pr) => scrub(pr)),
    null,
    1,
  )}\n`,
);
console.log(`Wrote ${prs.length} PRs to ${file}`);
