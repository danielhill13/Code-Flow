// The side panel: how codeflow read one PR, ready to check against GitHub. It shows what
// `codeflow pr` shows.
import { Fragment } from "preact";
import { useEffect } from "preact/hooks";
import { PHASES } from "../core/aggregate.ts";
import type { PrFact } from "../core/facts.ts";
import { duration, names, num, PHASE_LABELS, waitingOnText } from "../core/format.ts";
import { REVERT_WINDOW_DAYS } from "../core/metrics.ts";
import { isCatchAll, isInternal } from "../core/selection.ts";
import { OPEN_STATE_LABELS } from "../core/views/prs.ts";
import { capital } from "./ui.tsx";

const PHASE_HOURS = {
  coding: "codingHours",
  pickup: "pickupHours",
  review: "reviewHours",
  mergeWait: "mergeWaitHours",
} as const;

const EXCLUSIONS = {
  rule: "Not counted: an org rule leaves it out.",
  bot: "Not counted: a bot opened it.",
  base: "Not counted: it merged into a branch that isn't measured.",
  promotion: "Not counted: it promotes work between long-lived branches.",
} as const;

export function Drawer(props: { pr: PrFact; asOf: Date; onClose: () => void }) {
  const { pr, asOf, onClose } = props;
  const internal = isInternal(pr);
  // Its team and groups, leaving out catch-alls such as "No product".
  const teams = [pr.team, ...pr.groups.filter((g) => !isCatchAll(g))].filter(
    (name): name is string => name !== null,
  );
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);

  const state =
    pr.state === "merged"
      ? "Merged"
      : pr.state === "closed"
        ? "Closed without merging"
        : `Open · ${pr.openState ? OPEN_STATE_LABELS[pr.openState] : ""}`;
  const firstReviewer = pr.reviewLog[0]?.by;
  const events: { label: string; at: string | null; note?: string; color: string }[] = [
    { label: "First commit", at: pr.firstCommitAt, color: "var(--c-coding)" },
    {
      label: "Opened",
      at: pr.createdAt,
      note: pr.draft || (pr.readyAt && pr.readyAt !== pr.createdAt) ? "as a draft" : "",
      color: "var(--c-coding)",
    },
  ];
  if (pr.readyAt && pr.readyAt !== pr.createdAt) {
    events.push({ label: "Ready for review", at: pr.readyAt, color: "var(--c-coding)" });
  }
  if (pr.firstReviewAt) {
    events.push({
      label: "First review",
      at: pr.firstReviewAt,
      note: firstReviewer,
      color: "var(--c-pickup)",
    });
  }
  if (pr.firstApprovalAt)
    events.push({ label: "Approved", at: pr.firstApprovalAt, color: "var(--c-review)" });
  if (pr.state === "merged")
    events.push({ label: "Merged", at: pr.mergedAt, color: "var(--c-merge)" });
  if (pr.state === "closed")
    events.push({ label: "Closed", at: pr.closedAt, color: "var(--text3)" });

  const reverted =
    pr.state !== "merged"
      ? null
      : pr.revertedBy !== null &&
          pr.revertedAt &&
          pr.mergedAt &&
          Date.parse(pr.revertedAt) - Date.parse(pr.mergedAt) <= REVERT_WINDOW_DAYS * 86_400_000
        ? `Yes, by #${pr.revertedBy}, within ${REVERT_WINDOW_DAYS} days`
        : pr.mergedAt && asOf.getTime() - Date.parse(pr.mergedAt) < REVERT_WINDOW_DAYS * 86_400_000
          ? "Too recent to tell"
          : "No";
  const facts: [string, string][] = [
    [
      "Size",
      pr.sizeLines === null
        ? "Unknown: GitHub didn't list every file"
        : `${num(pr.sizeLines)} lines of product code`,
    ],
    ["Reviews", pr.reviews === 0 ? "None" : `${num(pr.reviews)} by ${names(pr.reviewers, [], 4)}`],
    [
      "Re-pushed",
      !pr.reviewed
        ? "Not reviewed"
        : pr.rounds > 0
          ? `Yes, ${pr.rounds === 1 ? "once" : `${num(pr.rounds)} times`} after review`
          : "No",
    ],
    [
      "Commented",
      pr.comments > 0
        ? `Yes, ${num(pr.comments)} ${pr.comments === 1 ? "comment" : "comments"}`
        : "No",
    ],
  ];
  if (reverted) facts.push(["Reverted", reverted]);
  if (pr.reverts.length > 0) facts.push(["Reverts", pr.reverts.map((n) => `#${n}`).join(", ")]);

  return (
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the backdrop is a mouse shortcut; Escape and the close button do the same */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: as above */}
      <div class="shade" onClick={onClose} />
      <aside class="drawer" aria-label={`Pull request #${pr.number}`}>
        <header>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <span class="mono soft" style={{ fontSize: "13px" }}>
              #{pr.number}
            </span>
            <span class="pill">{state}</span>
            <button type="button" class="close" aria-label="Close" onClick={onClose}>
              ×
            </button>
          </div>
          <div style={{ fontSize: "16px", fontWeight: 600, lineHeight: 1.3 }}>{pr.title}</div>
          <div class="soft" style={{ fontSize: "12.5px" }}>
            {[`${pr.author}${internal ? "" : " (outside contributor)"}`, pr.repo, ...teams].join(
              " · ",
            )}
          </div>
          {!pr.counted && pr.exclusion && (
            <div class="muted" style={{ fontSize: "12px" }}>
              {pr.exclusion === "rule" && pr.excludedBy
                ? `Not counted: rule ${pr.excludedBy} leaves it out.`
                : EXCLUSIONS[pr.exclusion]}
            </div>
          )}
          {pr.rules.length > 0 && (
            <div class="muted" style={{ fontSize: "12px" }}>
              Rules that apply: {pr.rules.join(", ")}
            </div>
          )}
        </header>

        {pr.state === "merged" && pr.cycleHours !== null && (
          <section>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12.5px" }}>
              <span class="soft">Cycle time</span>
              <b>{duration(pr.cycleHours)}</b>
            </div>
            <div
              class="share-bar"
              style={{
                height: "14px",
                borderRadius: "3px",
                gap: "1px",
                background: "var(--surface2)",
              }}
            >
              {PHASES.map((phase) => {
                const hours = pr[PHASE_HOURS[phase]] ?? 0;
                return (
                  <div
                    key={phase}
                    class={`phase-${phase}`}
                    style={{
                      width: `${pr.cycleHours ? (hours / pr.cycleHours) * 100 : 0}%`,
                      padding: 0,
                      minWidth: 0,
                    }}
                    title={`${capital(PHASE_LABELS[phase])}: ${duration(hours)}`}
                  />
                );
              })}
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(2,minmax(0,1fr))",
                gap: "6px 16px",
              }}
            >
              {PHASES.map((phase) => {
                const hours = pr[PHASE_HOURS[phase]];
                return (
                  <div
                    key={phase}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "7px",
                      fontSize: "12.5px",
                    }}
                  >
                    <span class={`swatch phase-${phase}`} style={{ width: "9px", height: "9px" }} />
                    <span class="soft">{capital(PHASE_LABELS[phase])}</span>
                    <span class="num" style={{ marginLeft: "auto" }}>
                      {hours === null ? "—" : duration(hours)}
                    </span>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        <section>
          <div class="section-label">Timeline</div>
          <div class="timeline">
            {events
              .filter((e) => e.at !== null)
              .map((e) => (
                <Fragment key={e.label}>
                  <span class="ring" style={{ borderColor: e.color }} />
                  <span class="soft">{e.label}</span>
                  <span class="num">
                    {stamp(e.at ?? "")}
                    {e.note ? ` · ${e.note}` : ""}
                  </span>
                </Fragment>
              ))}
            {pr.state === "open" && (
              <>
                <span class="ring" />
                <span class="soft">Now</span>
                <span>waiting on {waitingOnText(pr, asOf)}</span>
              </>
            )}
          </div>
        </section>

        <section style={{ borderBottom: "none" }}>
          <div class="facts">
            {facts.map(([key, value]) => (
              <Fragment key={key}>
                <span class="soft">{key}</span>
                <span>{value}</span>
              </Fragment>
            ))}
          </div>
        </section>
        <p class="muted" style={{ margin: 0, padding: "4px 22px 22px", fontSize: "12px" }}>
          This is how codeflow read the pull request. Check it against GitHub:{" "}
          <a class="link" href={pr.url} target="_blank" rel="noopener noreferrer">
            open on GitHub ↗
          </a>
        </p>
      </aside>
    </>
  );
}

/** "Sep 18, 2026, 07:38" in UTC, like every time in the report's numbers. */
function stamp(iso: string): string {
  const date = new Date(iso);
  const day = date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  return `${day}, ${iso.slice(11, 16)} UTC`;
}
