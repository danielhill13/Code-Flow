import { duration, formatValue, num, percent, prs, statLabel } from "../../core/format.ts";
import { REVERT_WINDOW_DAYS } from "../../core/metrics.ts";
import { isEverything } from "../../core/selection.ts";
import type { ReviewModel } from "../../core/views/review.ts";
import { listHref, metricList, selectionHref, setList } from "../links.ts";
import type { ReportState } from "../state.ts";
import {
  type BreakdownChoice,
  BreakdownControl,
  breakdownLabel,
  ChangeArrow,
  MetricTile,
  SingleBreakdown,
} from "../ui.tsx";

const LABELS: Record<string, string> = {
  pickup: "Pickup",
  review: "Review time",
  reviewsPerPr: "Reviews per PR",
  repushed: "Re-pushed after review",
  reviewed: "Reviewed before merge",
  commented: "Commented",
  reverted: `Reverted within ${REVERT_WINDOW_DAYS} d`,
  rework: "Changed after review",
  touchedAgain: "Changed again soon",
  followUp: "Followed up by the author",
  rewritten: "Lines rewritten soon",
};

/** Tiles judged a while after merging: they describe PRs merged earlier, old enough to tell. */
const LAGGED = new Set(["reverted", "touchedAgain", "followUp", "rewritten"]);

export function Review(props: {
  model: ReviewModel;
  state: ReportState;
  breakdown: BreakdownChoice;
  name: string;
}) {
  const { model, state } = props;
  const span = model.window.current;
  return (
    <>
      <div class="grid tiles-5">
        {model.tiles.map((tile) => (
          <MetricTile
            key={tile.key}
            tile={tile}
            label={LABELS[tile.key] ?? tile.key}
            small
            href={listHref(state, metricList(tile.key, tile.span, `Review › ${LABELS[tile.key]}`))}
          >
            {tile.key === "reviewed" && (
              <div class="soft" style={{ fontSize: "12px" }}>
                approved {formatValue(model.approved)} ·{" "}
                {model.unreviewed > 0 ? (
                  <a
                    class="link"
                    href={listHref(
                      state,
                      metricList("reviewed", span, "Review › Merged without review", [
                        { kind: "is", metric: "reviewed", value: false },
                      ]),
                    )}
                  >
                    {num(model.unreviewed)} merged without review
                  </a>
                ) : (
                  "none merged without review"
                )}
              </div>
            )}
          </MetricTile>
        ))}
      </div>

      {model.teams.length > 0 ? (
        <TeamLoad model={model} state={state} breakdown={props.breakdown} />
      ) : (
        <>
          {isEverything(state.selection) && (
            <SingleBreakdown choice={props.breakdown} name={props.name} />
          )}
          <ReviewerLoad model={model} state={state} />
        </>
      )}

      <section style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        <div class="card-head">
          <h2>After review and merge</h2>
          <span class="note">
            If pickup gets faster while re-pushes rise, review may be getting shallower. Code
            changed again soon after merging is often work that wasn't finished.
          </span>
        </div>
        <div class="grid tiles-3">
          {model.after.map((tile) => (
            <MetricTile
              key={tile.key}
              tile={tile}
              label={LABELS[tile.key] ?? tile.key}
              small
              more={
                LAGGED.has(tile.key)
                  ? ` · of PRs merged ${tile.span.label}, old enough to tell`
                  : tile.key === "rework"
                    ? " · lines, GitHub only"
                    : ""
              }
              href={listHref(
                state,
                metricList(tile.key, tile.span, `Review › ${LABELS[tile.key]}`),
              )}
            />
          ))}
        </div>
      </section>
    </>
  );
}

function TeamLoad(props: { model: ReviewModel; state: ReportState; breakdown: BreakdownChoice }) {
  const { model, state } = props;
  const cols = "minmax(200px,1.6fr) repeat(4,minmax(110px,1fr))";
  const by = model.teams[0]?.by ?? "team";
  const label = breakdownLabel(by);
  return (
    <section class="card flush">
      <div class="card-head">
        <h2>Review load by {label.toLowerCase()}</h2>
        <span class="note">
          How concentrated review is. Open a {label.toLowerCase()} to see who carries it.
        </span>
        <span class="end">
          <BreakdownControl choice={props.breakdown} value={by} />
        </span>
      </div>
      <div class="table">
        <div class="table-inner" style={{ "--min": "720px" }}>
          <div class="row head" style={{ "--cols": cols }}>
            <span>{label}</span>
            <span>Active reviewers</span>
            <span>Top 2 share</span>
            <span>Pickup</span>
            <span>Reviews per PR</span>
          </div>
          {model.teams.map((row) => (
            <a
              key={row.name}
              class="row"
              style={{ "--cols": cols }}
              href={selectionHref(state, row.selection)}
            >
              <span style={{ fontWeight: 500 }}>{row.name}</span>
              <span>{num(row.reviewers)}</span>
              <span style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <span class="track" style={{ flex: "none", width: "60px", height: "6px" }}>
                  <i class="track-fill" style={{ width: `${(row.topTwo ?? 0) * 100}%` }} />
                </span>
                {row.topTwo === null ? "—" : percent(row.topTwo)}
              </span>
              <Paired value={row.pickup} />
              <Paired value={row.reviewsPerPr} />
            </a>
          ))}
        </div>
      </div>
    </section>
  );
}

function Paired({
  value,
}: {
  value: {
    value: Parameters<typeof formatValue>[0];
    previous: Parameters<typeof formatValue>[0] | null;
  };
}) {
  return (
    <span title={value.value.hidden}>
      {formatValue(value.value)}
      <ChangeArrow value={value.value} previous={value.previous} />
    </span>
  );
}

function ReviewerLoad({ model, state }: { model: ReviewModel; state: ReportState }) {
  const cols = "160px minmax(160px,1fr) 70px 130px 150px";
  const max = Math.max(...model.reviewers.map((r) => r.reviews), model.others?.reviews ?? 0, 1);
  const { topTwo, reviewers } = model.load;
  const headline =
    topTwo === null
      ? reviewers === 0
        ? "No reviews in this window"
        : "Too few reviewers to say how concentrated review is"
      : `The top 2 of ${num(reviewers)} reviewers did ${percent(topTwo)} of reviews`;
  return (
    <section class="card flush">
      <div class="card-head">
        <h2>Review load</h2>
        <span class="headline">{headline}</span>
        <span class="note">
          Who carries review for this selection. This is about capacity, not performance.
        </span>
      </div>
      <div class="table">
        <div class="table-inner" style={{ "--min": "720px" }}>
          <div class="row head" style={{ "--cols": cols }}>
            <span>Reviewer</span>
            <span>Reviews given</span>
            <span>Share</span>
            <span>Waiting on them</span>
            <span>First response ({statLabel(state.percentile)})</span>
          </div>
          {model.reviewers.map((r) => (
            <div key={r.login} class="row dense" style={{ "--cols": cols }}>
              <span style={{ fontWeight: 500 }}>{r.login}</span>
              <span style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <span class="track">
                  <i class="track-fill" style={{ width: `${(r.reviews / max) * 100}%` }} />
                </span>
                <span style={{ width: "34px", textAlign: "right" }}>{num(r.reviews)}</span>
              </span>
              <span>{percent(r.share)}</span>
              {r.waiting > 0 ? (
                <a
                  class="link"
                  href={listHref(
                    state,
                    setList("open", `Review › Waiting on ${r.login}`, [
                      { kind: "waiting", reviewer: r.login },
                    ]),
                  )}
                >
                  {prs(r.waiting)} ›
                </a>
              ) : (
                <span class="muted">none</span>
              )}
              <span class="soft" title={r.response.hidden}>
                {r.response.value === null ? "—" : duration(r.response.value)}
              </span>
            </div>
          ))}
          {model.others && (
            <div class="row dense" style={{ "--cols": cols }}>
              <span class="soft">
                {num(model.others.count)} {model.reviewers.length > 0 ? "others" : "reviewers"}
              </span>
              <span style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <span class="track">
                  <i
                    class="track-fill"
                    style={{ width: `${(Math.min(model.others.reviews, max) / max) * 100}%` }}
                  />
                </span>
                <span style={{ width: "34px", textAlign: "right" }}>
                  {num(model.others.reviews)}
                </span>
              </span>
              <span>{percent(model.others.share)}</span>
              <span class="muted">{model.others.waiting > 0 ? prs(model.others.waiting) : ""}</span>
              <span />
            </div>
          )}
          {model.reviewers.length === 0 && (
            <div class="empty">Nobody reviewed a PR in this window.</div>
          )}
        </div>
      </div>
    </section>
  );
}
