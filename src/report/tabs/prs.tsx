import type { PrFact } from "../../core/facts.ts";
import { duration, num, waitingOnText } from "../../core/format.ts";
import { isCatchAll, isInternal } from "../../core/selection.ts";
import { ageDays } from "../../core/views/flow.ts";
import {
  COLUMNS,
  filterLabel,
  OPEN_STATE_LABELS,
  type PrColumn,
  type PrListModel,
  type PrSet,
} from "../../core/views/prs.ts";
import { prHref } from "../links.ts";
import type { ListState, ReportState } from "../state.ts";
import { Segmented, shortDate } from "../ui.tsx";

/** A column as the table shows it. `waiting` is display only: it has no order of its own. */
type Column = { key: PrColumn | "waiting"; label: string; width: string };

const COLUMN: Record<PrColumn | "waiting", Omit<Column, "key">> = {
  number: { label: "#", width: "70px" },
  title: { label: "Pull request", width: "minmax(260px,1fr)" },
  author: { label: "Author", width: "110px" },
  merged: { label: "Merged", width: "80px" },
  closed: { label: "Closed", width: "80px" },
  age: { label: "Age", width: "74px" },
  cycle: { label: "Cycle", width: "70px" },
  coding: { label: "Coding", width: "70px" },
  pickup: { label: "Pickup", width: "70px" },
  review: { label: "Review", width: "70px" },
  mergeWait: { label: "Merge wait", width: "84px" },
  timeToApproval: { label: "To approval", width: "84px" },
  size: { label: "Size", width: "64px" },
  reviews: { label: "Reviews", width: "64px" },
  state: { label: "State", width: "150px" },
  waiting: { label: "Waiting on", width: "minmax(190px,.7fr)" },
};

function columnsOf(list: ListState): Column[] {
  const keys: (PrColumn | "waiting")[] = [...COLUMNS[list.set]];
  if (list.set === "open") keys.splice(keys.indexOf("state") + 1, 0, "waiting");
  // A list sorted by a column it doesn't show gets that column, after the title.
  if (!keys.includes(list.sort.key)) keys.splice(keys.indexOf("author") + 1, 0, list.sort.key);
  return keys.map((key) => ({
    key,
    ...COLUMN[key],
    label: list.set === "abandoned" && key === "age" ? "Open for" : COLUMN[key].label,
  }));
}

const SETS: readonly { value: PrSet; label: string }[] = [
  { value: "merged", label: "Merged" },
  { value: "open", label: "Open" },
  { value: "abandoned", label: "Abandoned" },
];

export function PullRequests(props: {
  model: PrListModel;
  state: ReportState;
  asOf: Date;
  onList: (list: ListState) => void;
  onSet: (set: PrSet) => void;
  onMore: () => void;
}) {
  const { model, state, asOf, onList } = props;
  const { list } = state;
  const columns = columnsOf(list);
  const grid = columns.map((c) => c.width).join(" ");
  const sortBy = (key: PrColumn) =>
    onList({
      ...list,
      sort:
        list.sort.key === key
          ? { key, dir: list.sort.dir === "desc" ? "asc" : "desc" }
          : { key, dir: key === "title" || key === "author" ? "asc" : "desc" },
    });
  return (
    <>
      <section
        class="card"
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          gap: "8px",
          padding: "12px 16px",
        }}
      >
        <span class="muted" style={{ fontSize: "12.5px" }}>
          {list.from ? `From ${list.from} ›` : "Showing"}
        </span>
        {list.filters.map((filter, i) => (
          <span key={`${filter.kind}${i}`} class="chip">
            {filterLabel(filter, list.set)}
            <button
              type="button"
              class="chip-remove"
              title="Remove filter"
              aria-label={`Remove filter: ${filterLabel(filter, list.set)}`}
              onClick={() => onList({ ...list, filters: list.filters.filter((_, j) => j !== i) })}
            >
              ×
            </button>
          </span>
        ))}
        <div style={{ marginLeft: "8px" }}>
          <Segmented
            label="Pull requests"
            hideLabel
            small
            options={SETS}
            value={list.set}
            onChange={props.onSet}
          />
        </div>
        <span class="num" style={{ marginLeft: "auto", fontSize: "13px", fontWeight: 600 }}>
          {num(model.total)} {model.total === 1 ? "pull request" : "pull requests"}
        </span>
      </section>

      <section class="card flush" style={{ padding: "4px 0 6px" }}>
        <div class="table">
          <div class="table-inner" style={{ "--min": "1000px" }}>
            <div class="row head" style={{ "--cols": grid, padding: "10px 20px" }}>
              {columns.map((column) =>
                column.key === "waiting" ? (
                  <span key={column.key}>{column.label}</span>
                ) : (
                  <button
                    key={column.key}
                    type="button"
                    class={list.sort.key === column.key ? "sort sorted" : "sort"}
                    onClick={() => sortBy(column.key as PrColumn)}
                  >
                    {column.label}
                    {list.sort.key === column.key ? (list.sort.dir === "desc" ? " ↓" : " ↑") : ""}
                  </button>
                ),
              )}
            </div>
            {model.rows.map((pr) => (
              <a
                key={pr.id}
                class={`row dense${state.pr === pr.id ? " selected" : ""}`}
                style={{ "--cols": grid }}
                href={prHref(state, pr.id)}
              >
                {columns.map((column) => (
                  <Cell
                    key={column.key}
                    column={column.key}
                    pr={pr}
                    sorted={list.sort.key === column.key}
                    asOf={asOf}
                  />
                ))}
              </a>
            ))}
            {model.total === 0 && (
              <div class="empty">
                No pull requests match these filters. Remove a filter to widen the list.
              </div>
            )}
          </div>
        </div>
        {model.total > model.rows.length && (
          <div class="more">
            <button type="button" class="more-button" onClick={props.onMore}>
              Show {num(Math.min(50, model.total - model.rows.length))} more
            </button>
          </div>
        )}
      </section>
    </>
  );
}

function Cell(props: { column: PrColumn | "waiting"; pr: PrFact; sorted: boolean; asOf: Date }) {
  const { column, pr, sorted, asOf } = props;
  const year = asOf.getUTCFullYear();
  const hours = (value: number | null) => (value === null ? "—" : duration(value));
  const plain = (text: string) => <span class={sorted ? "sorted-col" : undefined}>{text}</span>;
  switch (column) {
    case "number":
      return <span class="mono soft">#{pr.number}</span>;
    case "title": {
      return (
        <span class="cell-title">
          <span style={{ fontWeight: 500 }}>{pr.title}</span>
          <span class="sub">
            {[
              pr.repo,
              pr.team ?? "",
              ...pr.groups.filter((g) => !isCatchAll(g)),
              isInternal(pr) ? "" : "outside contributor",
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </span>
      );
    }
    case "author":
      return <span class="soft">{pr.author}</span>;
    case "merged":
      return plain(pr.mergedAt ? shortDate(pr.mergedAt, year) : "—");
    case "closed":
      return plain(pr.closedAt ? shortDate(pr.closedAt, year) : "—");
    case "age":
      return plain(
        pr.state === "open"
          ? duration(ageDays(pr, asOf) * 24)
          : pr.closedAt
            ? duration((Date.parse(pr.closedAt) - Date.parse(pr.createdAt)) / 3_600_000)
            : "—",
      );
    case "cycle":
      return plain(hours(pr.cycleHours));
    case "coding":
      return plain(hours(pr.codingHours));
    case "pickup":
      return plain(hours(pr.pickupHours));
    case "review":
      return plain(hours(pr.reviewHours));
    case "mergeWait":
      return plain(hours(pr.mergeWaitHours));
    case "timeToApproval":
      return plain(hours(pr.timeToApprovalHours));
    case "size":
      return plain(pr.sizeLines === null ? "—" : num(pr.sizeLines));
    case "reviews":
      return plain(num(pr.reviews));
    case "state":
      return (
        <span
          class={sorted ? "sorted-col" : undefined}
          style={{ display: "flex", alignItems: "center", gap: "6px" }}
        >
          {pr.openState && <span class={`dot state-${pr.openState}`} />}
          {pr.openState ? OPEN_STATE_LABELS[pr.openState] : ""}
        </span>
      );
    case "waiting":
      return <span class="soft">{waitingOnText(pr, asOf)}</span>;
  }
}
