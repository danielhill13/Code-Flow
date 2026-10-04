// A small, made-up org with the cases codeflow has to get right, for tests that run the whole
// tool: ordinary reviewed PRs, PRs merged without review, chores, a bot, a promotion between
// long-lived branches, a revert, outside contributors from forks, open and abandoned PRs, and a
// repo whose work lands on a branch that isn't measured. Deterministic, except that it is dated
// relative to today: the PRs end in the last few days, so every window has data whenever tests run.

import type { AdoIdentity, AdoIteration, AdoPayload, AdoThread } from "../providers/ado/types.ts";
import type { GhActor, GhPayload } from "../providers/github/normalize.ts";
import type { FakeAdoRepo } from "./ado-server.ts";
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
          additions: plan.files.reduce((n, f) => n + f.additions, 0),
          deletions: plan.files.reduce((n, f) => n + f.deletions, 0),
          parents: { totalCount: 1 },
        },
      },
      // A change asked for is made: a push after that review, so rework has lines to show.
      ...reviewed
        .filter((r) => r.state === "CHANGES_REQUESTED")
        .slice(0, 1)
        .map((r) => ({
          commit: {
            oid: `f${repo}${plan.number}`.padEnd(12, "0"),
            authoredDate: iso(r.at + 3 * 3_600_000),
            committedDate: iso(r.at + 3 * 3_600_000),
            message: "Address review",
            additions: 6 + (plan.number % 20),
            deletions: 2,
            parents: { totalCount: 1 },
          },
        })),
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
        // Some code is changed again soon after it merges: churn has something to find.
        ...(i % 4 === 0 ? [{ path: `src/${repo}/shared.ts`, additions: 5, deletions: 3 }] : []),
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

// Azure DevOps ---------------------------------------------------------------------------------

/** Acme's Azure DevOps organization: the same people, other repos, one company. */
export const ADO_ORG = "contoso";
export const ADO_PROJECT = "Platform";

/** People's Azure DevOps sign-ins: the address they use there. */
export const adoLogin = (person: string) => `${person}@acme.example`;

const identity = (person: string): AdoIdentity => ({
  id: `id-${person}`,
  displayName: person[0]?.toUpperCase() + person.slice(1),
  uniqueName: adoLogin(person),
});
const BUILD: AdoIdentity = {
  id: "id-build",
  displayName: "Project Collection Build Service (contoso)",
  uniqueName: "Build\\5f3c1a7e",
};

type AdoPlan = {
  id: number;
  repo: string;
  author: AdoIdentity;
  title: string;
  opened: number;
  reviewer: string;
  /** Hours from opening: a comment, an optional "wait for author", and approval. */
  commentAfter: number | null;
  waitAfter: number | null;
  approveAfter: number | null;
  end: "completed" | "abandoned" | "active";
  labels: string[];
  target?: string;
  files: { path: string; additions: number; deletions: number }[];
};

function adoPayload(plan: AdoPlan): AdoPayload {
  const at = (hours: number) => iso(plan.opened + hours * 3_600_000);
  const reviewer = identity(plan.reviewer);
  const last = Math.max(plan.commentAfter ?? 0, plan.waitAfter ?? 0, plan.approveAfter ?? 0);
  const closed = plan.end === "active" ? undefined : at(last + 2);
  const threads: AdoThread[] = [
    {
      id: 1,
      publishedDate: at(0.2),
      comments: [
        {
          id: 1,
          author: plan.author,
          publishedDate: at(0.2),
          commentType: "system",
          content: "added a reviewer",
        },
      ],
      properties: {
        CodeReviewThreadType: { $value: "ReviewersUpdate" },
        CodeReviewReviewersUpdatedAddedIdentity: { $value: "1" },
      },
      identities: { "1": reviewer },
    },
  ];
  if (plan.commentAfter !== null) {
    threads.push({
      id: 2,
      publishedDate: at(plan.commentAfter),
      comments: [
        {
          id: 1,
          author: reviewer,
          publishedDate: at(plan.commentAfter),
          commentType: "text",
          content: "Why this way?",
        },
        {
          id: 2,
          parentCommentId: 1,
          author: plan.author,
          publishedDate: at(plan.commentAfter + 1),
          commentType: "text",
          content: "Simpler.",
        },
      ],
      threadContext: { filePath: plan.files[0]?.path },
    });
  }
  const vote = (id: number, hours: number, value: number): AdoThread => ({
    id,
    publishedDate: at(hours),
    comments: [
      {
        id: 1,
        author: reviewer,
        publishedDate: at(hours),
        commentType: "system",
        content: `voted ${value}`,
      },
    ],
    properties: {
      CodeReviewThreadType: { $value: "VoteUpdate" },
      CodeReviewVoteResult: { $value: String(value) },
    },
  });
  if (plan.waitAfter !== null) threads.push(vote(3, plan.waitAfter, -5));
  if (plan.approveAfter !== null) threads.push(vote(4, plan.approveAfter, 10));
  const commit = (n: number) => `${plan.repo}${plan.id}c${n}`.padEnd(40, "0");
  const iterations: AdoIteration[] = [
    {
      id: 1,
      createdDate: at(0),
      sourceRefCommit: { commitId: commit(1) },
      commonRefCommit: { commitId: "base".padEnd(40, "0") },
    },
  ];
  if (plan.waitAfter !== null) {
    iterations.push({
      id: 2,
      createdDate: at(plan.waitAfter + 2),
      sourceRefCommit: { commitId: commit(2) },
      commonRefCommit: { commitId: "base".padEnd(40, "0") },
    });
  }
  return {
    pr: {
      pullRequestId: plan.id,
      status: plan.end,
      title: plan.title,
      description: "",
      isDraft: false,
      createdBy: plan.author,
      creationDate: at(0),
      ...(closed && { closedDate: closed, closedBy: reviewer }),
      sourceRefName: `refs/heads/feature/${plan.repo}-${plan.id}`,
      targetRefName: `refs/heads/${plan.target ?? "main"}`,
      mergeStatus: plan.end === "completed" ? "succeeded" : "notSet",
      ...(plan.end === "completed" && { lastMergeCommit: { commitId: commit(9) } }),
      labels: plan.labels.map((name) => ({ name, active: true })),
      repository: { id: `repo-${plan.repo}`, name: plan.repo, project: { name: ADO_PROJECT } },
    },
    webUrl: "",
    threads,
    iterations,
    commits: [
      {
        commitId: commit(1),
        author: { name: plan.author.displayName, date: at(-20) },
        committer: { name: plan.author.displayName, date: at(-2) },
        comment: plan.title,
      },
    ],
    files: plan.files,
    truncated: [],
  };
}

/**
 * Contoso's Azure DevOps project: two active repos and a disabled one, with PRs by the same
 * staff as Acme's GitHub org, reviewed with comments and votes, some waiting for the author, a
 * build service's PR, chores, abandoned and open PRs. Dated relative to `now`.
 */
export function contosoRepos(now = Date.now()): FakeAdoRepo[] {
  const start = scenarioStart(now);
  let id = 5000;
  const plans = (repo: string, count: number, offset: number): AdoPlan[] =>
    Array.from({ length: count }, (_, i) => {
      const author = PEOPLE.staff[i % PEOPLE.staff.length] ?? "ana";
      const reviewer = PEOPLE.staff[(i + 2) % PEOPLE.staff.length] ?? "mika";
      const chore = i % 9 === 4;
      const recent = i >= count - 3;
      return {
        id: ++id,
        repo,
        author: identity(author),
        reviewer,
        title: chore ? `chore: tidy ${repo} ${i}` : `Improve ${repo} part ${i}`,
        opened: start + (offset + i * 3) * DAY + (i % 4) * 3_600_000,
        commentAfter: i % 5 === 2 ? null : 3 + (i % 6) * 2,
        waitAfter: i % 8 === 3 ? 20 : null,
        approveAfter: recent && i % 2 === 0 ? null : 30 + (i % 5) * 7,
        end: recent ? "active" : i % 13 === 6 ? "abandoned" : "completed",
        labels: chore ? ["chore"] : [],
        files: [
          {
            path: `src/${repo}/module${i}.cs`,
            additions: 15 + ((i * 29) % 300),
            deletions: i % 17,
          },
          ...(i % 4 === 0
            ? [{ path: `tests/${repo}/Module${i}Tests.cs`, additions: 35, deletions: 1 }]
            : []),
        ],
      };
    });
  const billing = plans("billing", 55, 2);
  billing.push({
    id: ++id,
    repo: "billing",
    author: BUILD,
    reviewer: "ana",
    title: "Update pipeline agents",
    opened: start + 80 * DAY,
    commentAfter: null,
    waitAfter: null,
    approveAfter: 1,
    end: "completed",
    labels: [],
    files: [{ path: "azure-pipelines.yml", additions: 4, deletions: 4 }],
  });
  const portal = plans("portal", 45, 4);
  const repo = (name: string, prs: AdoPlan[], extra: Partial<FakeAdoRepo> = {}): FakeAdoRepo => ({
    organization: ADO_ORG,
    project: ADO_PROJECT,
    name,
    id: `repo-${name}`,
    defaultBranch: "refs/heads/main",
    prs: prs.map(adoPayload),
    ...extra,
  });
  return [
    repo("billing", billing),
    repo("portal", portal),
    repo("retired", [], { disabled: true }),
  ];
}

/** Azure DevOps PRs codeflow should count in a period, worked out the plain way. */
export function countedAdoMerges(repos: readonly FakeAdoRepo[], from: string, to: string): number {
  let count = 0;
  for (const repo of repos) {
    if (repo.disabled) continue;
    for (const { pr } of repo.prs) {
      if (pr.status !== "completed" || !pr.closedDate) continue;
      if (pr.closedDate < from || pr.closedDate >= to) continue;
      if (pr.targetRefName !== repo.defaultBranch) continue;
      if (pr.createdBy.uniqueName?.startsWith("Build\\")) continue;
      count++;
    }
  }
  return count;
}
