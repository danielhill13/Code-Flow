// Test data builders. Excluded from the published build.
import type { OwnerSource } from "../config/schema.ts";
import type { DeriveRules } from "../core/derive.ts";
import type { Actor, PrModel } from "../core/model.ts";
import { pathClassifier } from "../core/paths.ts";
import type { Repo } from "../providers/github/discover.ts";
import type { GhPayload } from "../providers/github/normalize.ts";

export const alice: Actor = { login: "alice", bot: false };
export const bob: Actor = { login: "bob", bot: false };
export const carol: Actor = { login: "carol", bot: false };
export const rabbit: Actor = { login: "coderabbitai", bot: true };

/** `2026-03-02T10:00:00Z` from `"03-02 10:00"`: test timelines read better short. */
export const at = (monthDayTime: string) => {
  const [date, time = "00:00"] = monthDayTime.split(" ");
  return `2026-${date}T${time}:00Z`;
};

/**
 * A merged PR by alice into main: first commit 03-01 10:00, opened 03-02 10:00, merged
 * 03-04 10:00 by bob, unreviewed. Override what a test is about.
 */
export function prModel(overrides: Partial<PrModel> = {}): PrModel {
  return {
    id: "PR_1",
    repoId: "R_1",
    repo: "acme/api",
    number: 1,
    url: "https://github.com/acme/api/pull/1",
    title: "Add a thing",
    body: "",
    state: "merged",
    draft: false,
    author: alice,
    authorAssociation: "MEMBER",
    fromFork: false,
    baseBranch: "main",
    headBranch: "feat/thing",
    createdAt: at("03-02 10:00"),
    updatedAt: at("03-04 10:00"),
    mergedAt: at("03-04 10:00"),
    closedAt: at("03-04 10:00"),
    mergedBy: bob,
    mergeCommitSha: "m0000001",
    labels: [],
    commits: [
      {
        sha: "c0000001",
        authoredAt: at("03-01 10:00"),
        committedAt: at("03-01 10:00"),
        message: "Add a thing",
      },
    ],
    reviews: [],
    comments: [],
    reviewThreads: 0,
    files: [],
    events: [],
    additions: 0,
    deletions: 0,
    truncated: [],
    ...overrides,
  };
}

/** Rules as a plain repo would have them: main is measured, bots are not reviewers. */
export function deriveRules(overrides: Partial<DeriveRules> = {}): DeriveRules {
  return {
    isMeasuredBranch: (_repo, branch) => branch === "main",
    isPromotionBranch: (branch) => ["main", "master", "develop", "release"].includes(branch),
    classify: pathClassifier(),
    isBot: (actor) => actor.bot,
    isBotReviewer: () => false,
    isIgnoredBody: () => false,
    includeBotPrs: false,
    ...overrides,
  };
}

export function repo(name: string, overrides: Partial<Repo> = {}): Repo {
  return {
    id: `id-${name}`,
    owner: "acme",
    name,
    fullName: `acme/${name}`,
    defaultBranch: "main",
    archived: false,
    fork: false,
    empty: false,
    private: false,
    prs: { open: 0, merged: 0, closed: 0 },
    lastPrActivity: null,
    ...overrides,
  };
}

export function ownerSource(overrides: Partial<OwnerSource> = {}): OwnerSource {
  return {
    kind: "owner",
    owner: "acme",
    include: ["*"],
    exclude: [],
    archived: false,
    forks: false,
    ...overrides,
  };
}

const connection = <T>(nodes: T[], extra: { filteredCount?: number } = {}) => ({
  totalCount: nodes.length,
  pageInfo: { hasNextPage: false, endCursor: null },
  nodes,
  ...extra,
});

/** A stored GitHub payload for the same PR prModel() describes. Override what a test needs. */
export function ghPayload(overrides: Partial<GhPayload> = {}): GhPayload {
  return {
    id: "PR_1",
    number: 1,
    title: "Add a thing",
    body: "",
    url: "https://github.com/acme/api/pull/1",
    state: "MERGED",
    isDraft: false,
    isCrossRepository: false,
    createdAt: at("03-02 10:00"),
    updatedAt: at("03-04 10:00"),
    mergedAt: at("03-04 10:00"),
    closedAt: at("03-04 10:00"),
    baseRefName: "main",
    headRefName: "feat/thing",
    additions: 0,
    deletions: 0,
    author: { __typename: "User", login: "alice" },
    authorAssociation: "MEMBER",
    mergedBy: { __typename: "User", login: "bob" },
    mergeCommit: { oid: "m0000001" },
    labels: { nodes: [] },
    reviewThreads: { totalCount: 0 },
    commits: connection([
      {
        commit: {
          oid: "c0000001",
          authoredDate: at("03-01 10:00"),
          committedDate: at("03-01 10:00"),
          message: "Add a thing",
        },
      },
    ]),
    reviews: connection<GhPayload["reviews"]["nodes"][number]>([]),
    comments: connection<GhPayload["comments"]["nodes"][number]>([]),
    files: connection<{ path: string; additions: number; deletions: number }>([]),
    timelineItems: connection<GhPayload["timelineItems"]["nodes"][number]>([], {
      filteredCount: 0,
    }),
    ...overrides,
  };
}
