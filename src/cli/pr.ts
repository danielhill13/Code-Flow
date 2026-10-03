import { existsSync } from "node:fs";
import type { Exclusion, PrFact } from "../core/facts.ts";
import { duration } from "../core/format.ts";
import { CodeflowError } from "../errors.ts";
import { deriveFacts } from "../pipeline/derive.ts";
import { Store } from "../store/store.ts";
import { bold, dim, num, plural, status } from "./format.ts";
import { type OrgOptions, orgsFor, type Print } from "./session.ts";

export type PrOptions = OrgOptions;

const EXCLUSIONS: Record<Exclusion, (pr: PrFact) => string> = {
  bot: () => "a bot opened it",
  base: (pr) => `it targets ${pr.baseBranch}, which isn't a measured branch`,
  promotion: (pr) => `it promotes ${pr.headBranch}, a long-lived branch, rather than adding work`,
  rule: (pr) => `rule ${pr.excludedBy} says not to count it`,
};

/** How codeflow reads one PR: every derived value next to the timestamps it came from. */
export async function showPr(target: string, options: PrOptions): Promise<number> {
  const print: Print = (line = "") => console.log(line);
  const {
    orgs: [org],
  } = await orgsFor(options, true);
  if (!org) throw new CodeflowError("No org to read.");
  const { config, dbPath } = org;
  if (!existsSync(dbPath)) throw new CodeflowError("Nothing synced yet. Run: codeflow sync");

  const match = /^(?:([\w.-]+\/[\w.-]+))?#?(\d+)$/.exec(target.trim());
  if (!match) throw new CodeflowError(`Expected a PR like owner/name#123 or 123, got "${target}".`);
  const [, repo, number] = match;

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
    printPr(found[0] as PrFact, print);
    return 0;
  } finally {
    store.close();
  }
}

function printPr(pr: PrFact, print: Print): void {
  print(`${bold(`${pr.repo}#${pr.number}`)}  ${pr.title}`);
  print(dim(`  ${pr.url}`));
  print();

  const by = `${pr.author}${pr.authorIsBot ? " (bot)" : ""}`;
  const relation = [pr.authorAssociation?.toLowerCase(), pr.fromFork && "from a fork"]
    .filter(Boolean)
    .join(", ");
  const state =
    pr.state === "merged"
      ? `merged into ${pr.baseBranch}${pr.selfMerged ? " by its author" : ""}`
      : pr.state === "closed"
        ? "closed without merging"
        : `open${pr.draft ? ", a draft" : ""}, into ${pr.baseBranch}`;
  print(status("info", "State", `${state} · opened by ${by}${relation ? ` (${relation})` : ""}`));
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
    print(status("warn", "Size", "unknown: GitHub didn't list every changed file"));
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

  print(
    pr.truncated.length === 0
      ? status("ok", "Data", "complete")
      : status("warn", "Data", `GitHub sent only part of: ${pr.truncated.join(", ")}`),
  );
}

const when = (iso: string) =>
  new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
