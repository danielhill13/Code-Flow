// A small, made-up org with the cases codeflow has to get right, for tests that run the whole
// tool: ordinary reviewed PRs, PRs merged without review, chores, a bot, a promotion between
// long-lived branches, a revert, outside contributors from forks, open and abandoned PRs, and a
// repo whose work lands on a branch that isn't measured. Deterministic, except that it is dated
// relative to today: the PRs end in the last few days, so every window has data whenever tests run.
import type { GhActor, GhPayload } from "../providers/github/normalize.ts";
import { ghPayload } from "./factories.ts";
import type { FakeRepo } from "./github-server.ts";

export const OWNER = "acme-co";

/** Who works at Acme, and who doesn't. */
export const PEOPLE = {
  staff: ["ana", "devon", "mika", "rui"],
  outside: ["sam"],
  bot: "dependabot[bot]",
} as const;

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");

/** 09:00 UTC on the Monday 25 weeks before the week of `now`: when the scenario's first PR opens. */
export function scenarioStart(now = Date.now()): number {
  const today = new Date(now);
  today.setUTCHours(9, 0, 0, 0);
  const sinceMonday = (today.getUTCDay() + 6) % 7;
  return today.getTime() - (sinceMonday + 25 * 7) * DAY;
}

const user = (login: string): GhActor => ({ __typename: "User", login });
const bot = (login: string): GhActor => ({ __typename: "Bot", login });
const connection = <T>(nodes: T[], extra: { filteredCount?: number } = {}) => ({
  totalCount: nodes.length,
  pageInfo: { hasNextPage: false, endCursor: null },
  nodes,
  ...extra,
});

type Plan = {
  number: number;
  author: string;
  title: string;
  opened: number;
  /** Hours from opening to each review, and the review's state; empty for none. */
  reviews: { after: number; state: "COMMENTED" | "APPROVED" | "CHANGES_REQUESTED"; by: string }[];
  /** "merged" hours after the last review (or opening), "closed", or "open". */
  end: { kind: "merged"; after: number } | { kind: "closed"; after: number } | { kind: "open" };
  base?: string;
  head?: string;
  fork?: boolean;
  draft?: boolean;
  labels?: string[];
  body?: string;
  files: { path: string; additions: number; deletions: number }[];
  isBot?: boolean;
};

function payload(repo: string, plan: Plan): GhPayload {
  const opened = plan.opened;
  const reviewed = plan.reviews.map((r) => ({ ...r, at: opened + r.after * 3_600_000 }));
  const lastActivity = reviewed.at(-1)?.at ?? opened;
  const ended = plan.end.kind === "open" ? null : lastActivity + plan.end.after * 3_600_000;
  const merged = plan.end.kind === "merged" ? ended : null;
  const updated = ended ?? lastActivity + 3_600_000;
  const author = plan.isBot ? bot(plan.author) : user(plan.author);
  return ghPayload({
    id: `PR_${repo}_${plan.number}`,
    number: plan.number,
    title: plan.title,
    body: plan.body ?? "",
    url: `https://github.com/${OWNER}/${repo}/pull/${plan.number}`,
    state: plan.end.kind === "merged" ? "MERGED" : plan.end.kind === "closed" ? "CLOSED" : "OPEN",
    isDraft: plan.draft ?? false,
    isCrossRepository: plan.fork ?? false,
    createdAt: iso(opened),
    updatedAt: iso(updated),
    mergedAt: merged === null ? null : iso(merged),
    closedAt: ended === null ? null : iso(ended),
    baseRefName: plan.base ?? "main",
    headRefName: plan.head ?? `feat/${repo}-${plan.number}`,
    additions: plan.files.reduce((n, f) => n + f.additions, 0),
    deletions: plan.files.reduce((n, f) => n + f.deletions, 0),
    author,
    authorAssociation: plan.isBot
      ? "NONE"
      : (PEOPLE.staff as readonly string[]).includes(plan.author)
        ? "MEMBER"
        : "CONTRIBUTOR",
    mergedBy: merged === null ? null : user("ana"),
    mergeCommit: merged === null ? null : { oid: `m${repo}${plan.number}`.padEnd(12, "0") },
    labels: { nodes: (plan.labels ?? []).map((name) => ({ name })) },
    commits: connection([
      {
        commit: {
          oid: `c${repo}${plan.number}`.padEnd(12, "0"),
          authoredDate: iso(opened - 20 * 3_600_000),
          committedDate: iso(opened - 2 * 3_600_000),
          message: plan.title,
        },
      },
    ]),
    reviews: connection(
      reviewed.map((r) => ({
        author: user(r.by),
        state: r.state,
        submittedAt: iso(r.at),
        body: "",
      })),
    ),
    files: connection(plan.files),
  });
}

/** The repo's ordinary PRs: one every `spacing` days, by a rotating author, mostly reviewed. */
function everyday(
  start: number,
  repo: string,
  count: number,
  offsetDays: number,
  spacing = 2,
): Plan[] {
  const authors = [...PEOPLE.staff, ...PEOPLE.outside];
  const plans: Plan[] = [];
  for (let i = 0; i < count; i++) {
    const author = authors[i % authors.length] ?? "ana";
    const reviewer = PEOPLE.staff[(i + 1) % PEOPLE.staff.length] ?? "devon";
    const outside = (PEOPLE.outside as readonly string[]).includes(author);
    const chore = i % 9 === 4;
    const recent = i >= count - 4;
    const reviews: Plan["reviews"] =
      i % 6 === 5
        ? []
        : [
            { after: 2 + (i % 7) * 3, state: "COMMENTED", by: reviewer },
            ...(i % 8 === 3
              ? [{ after: 30 + (i % 4) * 5, state: "CHANGES_REQUESTED" as const, by: reviewer }]
              : []),
            { after: 40 + (i % 5) * 9, state: "APPROVED", by: reviewer },
          ];
    plans.push({
      number: 1 + i,
      author,
      title: chore ? `chore: tidy ${repo} ${i}` : `Improve ${repo} part ${i}`,
      opened: start + (offsetDays + i * spacing) * DAY + (i % 5) * 3_600_000,
      reviews: recent ? reviews.slice(0, i % 2) : reviews,
      end: recent
        ? { kind: "open" }
        : i % 17 === 9
          ? { kind: "closed", after: 20 }
          : { kind: "merged", after: 1 + (i % 4) },
      fork: outside,
      draft: recent && i % 3 === 0,
      labels: chore ? ["chore"] : [],
      files: [
        { path: `src/${repo}/part${i}.ts`, additions: 10 + ((i * 37) % 400), deletions: i % 23 },
        ...(i % 3 === 0 ? [{ path: `test/part${i}.test.ts`, additions: 40, deletions: 2 }] : []),
        ...(i % 10 === 0 ? [{ path: "docs/guide.md", additions: 12, deletions: 0 }] : []),
      ],
    });
  }
  return plans;
}

/** The org: four repos as GitHub would list them, with their PRs, dated relative to `now`. */
export function acmeRepos(now = Date.now()): FakeRepo[] {
  const start = scenarioStart(now);
  const api = everyday(start, "api", 85, 0);
  const web = everyday(start, "web", 84, 1);
  const reverted = api[10];
  if (!reverted) throw new Error("unreachable");
  api.push(
    {
      number: 200,
      author: PEOPLE.bot,
      isBot: true,
      title: "Bump yaml from 2.8.0 to 2.9.1",
      opened: start + 60 * DAY,
      reviews: [],
      end: { kind: "merged", after: 3 },
      head: "dependabot/npm_and_yarn/yaml-2.9.1",
      labels: ["dependencies"],
      files: [{ path: "package-lock.json", additions: 30, deletions: 30 }],
    },
    {
      number: 201,
      author: "devon",
      title: `Revert "${reverted.title}"`,
      body: `Reverts ${OWNER}/api#${reverted.number}`,
      opened: reverted.opened + 5 * DAY,
      reviews: [{ after: 1, state: "APPROVED", by: "ana" }],
      end: { kind: "merged", after: 1 },
      files: [{ path: `src/api/part10.ts`, additions: 0, deletions: 50 }],
    },
  );
  // Opened long ago and left alone: stale, though a bot nudged it last week.
  const forgotten = payload("api", {
    number: 202,
    author: "sam",
    title: "Add a Klingon locale",
    opened: start + 5 * DAY,
    reviews: [],
    end: { kind: "open" },
    fork: true,
    files: [{ path: "src/api/locale.ts", additions: 80, deletions: 0 }],
  });
  const nudged = new Date(now - 7 * DAY).toISOString().replace(/\.\d+Z$/, "Z");
  forgotten.comments = connection([
    { author: bot("stale[bot]"), createdAt: nudged, body: "This PR has been quiet for a while." },
  ]);
  forgotten.updatedAt = nudged;
  web.push({
    number: 300,
    author: "ana",
    title: "Release 2026.6",
    opened: start + 100 * DAY,
    reviews: [{ after: 1, state: "APPROVED", by: "mika" }],
    end: { kind: "merged", after: 1 },
    base: "main",
    head: "release/2026.6",
    files: [{ path: "src/web/app.ts", additions: 900, deletions: 300 }],
  });
  // Early work merged into main, then the team moved to develop: codeflow should notice.
  const legacy = everyday(start, "legacy", 42, 3, 4).map((plan, i) =>
    i < 12 ? plan : { ...plan, base: "develop" },
  );
  return [
    {
      owner: OWNER,
      name: "api",
      defaultBranch: "main",
      prs: [...api.map((p) => payload("api", p)), forgotten],
    },
    { owner: OWNER, name: "web", defaultBranch: "main", prs: web.map((p) => payload("web", p)) },
    {
      owner: OWNER,
      name: "legacy",
      defaultBranch: "main",
      prs: legacy.map((p) => payload("legacy", p)),
    },
    { owner: OWNER, name: "attic", defaultBranch: "main", archived: true, prs: [] },
  ];
}

/**
 * PRs merged between two days (UTC, end exclusive) that codeflow should count, worked out the
 * plain way: into the default branch, not by a bot, not from a long-lived branch. An oracle for
 * the scenario tests, independent of derive.
 */
export function countedMerges(repos: readonly FakeRepo[], from: string, to: string): number {
  let count = 0;
  for (const repo of repos) {
    for (const pr of repo.prs) {
      if (!pr.mergedAt || pr.mergedAt < from || pr.mergedAt >= to) continue;
      if (pr.baseRefName !== repo.defaultBranch) continue;
      if (pr.author?.__typename === "Bot") continue;
      if (/^(main|master|develop|release\/.*)$/.test(pr.headRefName)) continue;
      count++;
    }
  }
  return count;
}
