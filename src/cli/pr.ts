import { existsSync } from "node:fs";
import type { Org } from "../config/workspace.ts";
import type { Exclusion, PrFact } from "../core/facts.ts";
import { duration, hostOf } from "../core/format.ts";
import { isStale } from "../core/stale.ts";
import { CodeflowError } from "../errors.ts";
import { deriveFacts } from "../pipeline/derive.ts";
import { Store } from "../store/store.ts";
import { bold, dim, num, plural, status } from "./format.ts";
import { type OrgOptions, orgsFor, type Print } from "./session.ts";

export type PrOptions = OrgOptions & { raw?: boolean };

const EXCLUSIONS: Record<Exclusion, (pr: PrFact) => string> = {
  bot: () => "a bot opened it",
  base: (pr) => `it targets ${pr.baseBranch}, which isn't a measured branch`,
  promotion: (pr) => `it promotes ${pr.headBranch}, a long-lived branch, rather than adding work`,
  rule: (pr) => `rule ${pr.excludedBy} says not to count it`,
};

/** How codeflow reads one PR: every derived value next to the timestamps it came from. */
export async function showPr(target: string, options: PrOptions): Promise<number> {
  const print: Print = (line = "") => console.log(line);
  // owner/name#123 (organization/project/repo#123 on Azure DevOps), #123, 123, or the PR's
  // address on GitHub or Azure DevOps, as copied from the browser.
  const text = target.trim();
  const ado =
    /^https?:\/\/[^/]+\/(?:tfs\/)?([^/]+)\/([^/]+)\/_git\/([^/]+)\/pullrequest\/(\d+)\b/i.exec(
      text,
    );
  // The older address: https://<organization>.visualstudio.com/<project>/_git/<repo>/pullrequest/N
  const legacy =
    /^https?:\/\/([^./]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/]+)\/pullrequest\/(\d+)\b/i.exec(
      text,
    );
  const address = legacy ?? ado;
  const match = address
    ? ([text, address.slice(1, 4).map(decodeURIComponent).join("/"), address[4]] as const)
    : (/^(?:([\w.-]+\/(?:[^/#]+\/)?[\w.-]+))?#?(\d+)$/.exec(text) ??
      /^https?:\/\/[^/]+\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\b/.exec(text));
  if (!match) {
    throw new CodeflowError(
      `Expected a PR like owner/name#123, 123, or its address on GitHub or Azure DevOps; got "${target}".`,
    );
  }
  const [, repo, number] = match;
  const org = await orgOf(options, repo);
  const { config, dbPath } = org;
  if (!existsSync(dbPath)) throw new CodeflowError("Nothing synced yet. Run: codeflow sync");

  const store = Store.open(dbPath);
  try {
    deriveFacts(store, config);
    const found = store
      .facts()
      .filter(
        (pr) =>
          pr.number === Number(number) && (!repo || pr.repo.toLowerCase() === repo.toLowerCase()),
      );
    if (found.length === 0) throw new CodeflowError(`${target} isn't in the synced data.`);
    if (found.length > 1) {
      throw new CodeflowError(
        `#${number} is in several repos; say which: ${found.map((pr) => `${pr.repo}#${number}`).join(", ")}`,
      );
    }
    const asOf = new Date(store.dataThrough() ?? Date.now());
    const fact = found[0] as PrFact;
    if (options.raw) {
      // Exactly what the host returned, as stored: to check what codeflow read against it.
      for (const version of store.latestPrs(fact.repoId)) {
        if (version.id === fact.id) console.log(JSON.stringify(version.payload, null, 2));
      }
      return 0;
    }
    printPr(fact, print, { asOf, staleAfterDays: config.stale_after_days });
    return 0;
  } finally {
    store.close();
  }
}

/**
 * The org a PR belongs to: the one named with --org, the only one, or, among several, the one
 * whose synced data holds the PR's repo.
 */
async function orgOf(options: PrOptions, repo: string | undefined): Promise<Org> {
  const { orgs } = await orgsFor(options, options.org !== undefined || !repo);
  if (orgs.length === 1 && orgs[0]) return orgs[0];
  const holding = orgs.filter((org) => {
    if (!existsSync(org.dbPath)) return false;
    const store = Store.open(org.dbPath);
    try {
      return store.repos().some((r) => r.fullName.toLowerCase() === repo?.toLowerCase());
    } finally {
      store.close();
    }
  });
  if (holding.length === 1 && holding[0]) return holding[0];
  const names = (holding.length > 0 ? holding : orgs).map((org) => org.name).join(", ");
  throw new CodeflowError(
    holding.length === 0
      ? `No org has ${repo} in its synced data. Orgs: ${names}.`
      : `${repo} is in several orgs: say which with --org (${names}).`,
  );
}

function printPr(pr: PrFact, print: Print, context: { asOf: Date; staleAfterDays: number }): void {
  print(`${bold(`${pr.repo}#${pr.number}`)}  ${pr.title}`);
  print(dim(`  ${pr.url}`));
  print();

  const account = pr.person.toLowerCase() === pr.author.toLowerCase() ? "" : ` (as ${pr.author})`;
  const by = `${pr.person}${account}${pr.authorIsBot ? " (bot)" : ""}`;
  const association = pr.authorAssociation?.toLowerCase();
  const relation = [association !== "none" && association, pr.fromFork && "from a fork"]
    .filter(Boolean)
    .join(", ");
  const state =
    pr.state === "merged"
      ? `merged into ${pr.baseBranch}${pr.selfMerged ? " by its author" : ""}`
      : pr.state === "closed"
        ? "closed without merging"
        : `open${pr.draft ? ", a draft" : ""}, into ${pr.baseBranch}`;
  print(status("info", "State", `${state} · opened by ${by}${relation ? ` (${relation})` : ""}`));
  if (isStale(pr, context.asOf, context.staleAfterDays) && pr.lastActivityAt) {
    print(
      status(
        "warn",
        "Stale",
        `no activity since ${pr.lastActivityAt.slice(0, 10)}, more than ${context.staleAfterDays} days: listed apart from open PRs`,
      ),
    );
  }
  print(
    pr.counted
      ? status("ok", "Counted", "yes")
      : status("warn", "Counted", `no: ${pr.exclusion ? EXCLUSIONS[pr.exclusion](pr) : "unknown"}`),
  );
  if (pr.rules.length > 0) print(status("info", "Rules", pr.rules.join(", ")));

  const moments: [string, string | null, string?][] = [
    ["first commit", pr.firstCommitAt],
    ["opened", pr.createdAt],
    [
      "ready",
      pr.readyAt,
      pr.readyAt === null
        ? "still a draft"
        : pr.readyAt === pr.createdAt
          ? ""
          : "was a draft until then",
    ],
    ["first review", pr.firstReviewAt, pr.firstReviewAt === null ? "none by someone else" : ""],
    ["approved", pr.firstApprovalAt],
    ["review ended", pr.reviewEndAt],
    ["merged", pr.mergedAt],
    ["closed", pr.state === "closed" ? pr.closedAt : null],
  ];
  const timeline = moments.filter(([, time, why]) => time !== null || why);
  timeline.forEach(([label, time, why], i) => {
    const text = `${label.padEnd(13)}${time ? when(time) : "—"}${why ? dim(`  ${why}`) : ""}`;
    print(status("info", i === 0 ? "Timeline" : "", text));
  });

  if (pr.cycleHours !== null) {
    const phase = (label: string, hours: number | null) =>
      `${label} ${hours === null ? "—" : duration(hours)}`;
    const phases = [
      phase("coding", pr.codingHours),
      phase("pickup", pr.pickupHours),
      phase("review", pr.reviewHours),
      phase("merge wait", pr.mergeWaitHours),
    ].join(" · ");
    print(status("info", "Phases", `${phases} = cycle ${duration(pr.cycleHours)}`));
  }

  if (pr.linesByBucket === null) {
    print(status("warn", "Size", `unknown: ${hostOf(pr.url)} didn't give every file's lines`));
  } else {
    const other = Object.entries(pr.linesByBucket)
      .filter(([bucket, lines]) => bucket !== "product" && lines > 0)
      .map(([bucket, lines]) => `${bucket} ${num(lines)}`);
    print(
      status(
        "info",
        "Size",
        `${plural(pr.sizeLines ?? 0, "product line")} (${num(pr.addedLines ?? 0)} added) in ` +
          `${plural(pr.productFiles ?? 0, "file")}${other.length > 0 ? dim(`; also ${other.join(", ")}`) : ""}`,
      ),
    );
  }

  const reviewers = pr.reviewers.length > 0 ? ` (${pr.reviewers.join(", ")})` : "";
  print(
    status(
      "info",
      "Review",
      `${plural(pr.reviewers.length, "reviewer")}${reviewers} · ${plural(pr.reviews, "review")}: ` +
        `${plural(pr.approvals, "approval")}, ${plural(pr.changesRequested, "change request")} · ` +
        `${plural(pr.rounds, "round")} of new commits after review · ${plural(pr.comments, "comment")}`,
    ),
  );

  const reverts = [
    pr.reverts.length > 0 && `reverts ${pr.reverts.map((n) => `#${n}`).join(", ")}`,
    pr.revertedBy !== null &&
      pr.revertedAt !== null &&
      `reverted by #${pr.revertedBy} on ${when(pr.revertedAt)}`,
  ].filter(Boolean);
  if (reverts.length > 0) print(status("info", "Reverts", reverts.join("; ")));
  if (pr.reviewed && pr.state === "merged") {
    print(
      status(
        "info",
        "Rework",
        pr.reworkLines === null
          ? "lines changed after review unknown: the host doesn't give lines per commit"
          : `${plural(pr.reworkLines, "line")} changed after the first review`,
      ),
    );
  }
  const later = [
    pr.touchedAgainBy !== null &&
      pr.touchedAgainAt !== null &&
      `files changed again by #${pr.touchedAgainBy} on ${when(pr.touchedAgainAt)}`,
    pr.followUpBy !== null &&
      pr.followUpAt !== null &&
      `followed up by the author in #${pr.followUpBy} on ${when(pr.followUpAt)}`,
  ].filter(Boolean);
  if (later.length > 0) print(status("info", "Churn", later.join("; ")));

  print(
    pr.truncated.length === 0
      ? status("ok", "Data", "complete")
      : status("warn", "Data", `${hostOf(pr.url)} sent only part of: ${pr.truncated.join(", ")}`),
  );
}

const when = (iso: string) =>
  new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
