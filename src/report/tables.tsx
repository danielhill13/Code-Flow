import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import type { Measurement } from "../core/aggregate.ts";
import { change, formatChange } from "../core/compare.ts";
import type { PrFact } from "../core/facts.ts";
import { duration, formatValue, num, statLabel, valueNote } from "../core/format.ts";
import type { PrRow } from "../core/source.ts";

/** Every metric for the period, beside the previous period. Click a metric to list its PRs. */
export function SummaryTable(props: {
  current: Measurement;
  previous: Measurement | null;
  complete: boolean;
  selected: string;
  onPick: (metricKey: string) => void;
}) {
  const { current, previous } = props;
  let group = "";
  const rows: ComponentChildren[] = [];
  current.values.forEach((value, i) => {
    const before = previous?.values[i] ?? null;
    if (value.metric.group !== group) {
      group = value.metric.group;
      rows.push(
        <tr key={group} class="group">
          <th colSpan={6}>{group}</th>
        </tr>,
      );
    }
    const key = value.metric.key;
    rows.push(
      <tr key={key} class={key === props.selected ? "selected" : undefined}>
        <td>
          <button type="button" class="link" onClick={() => props.onPick(key)}>
            {value.metric.label}
          </button>
        </td>
        <td class="num">{formatValue(value)}</td>
        <td class="num muted">{before ? formatValue(before) : ""}</td>
        <td class="num">{formatChange(change(value, before, props.complete))}</td>
        <td class="num">{num(value.n)}</td>
        <td class="muted">{valueNote(value)}</td>
      </tr>,
    );
  });
  return (
    <table class="summary">
      <caption class="muted">
        Times, sizes and reviews per PR are the {statLabel(current.percentile)} of their PRs.
      </caption>
      <thead>
        <tr>
          <th>Metric</th>
          <th class="num">Value</th>
          <th class="num">Previous</th>
          <th class="num">Change</th>
          <th class="num">PRs</th>
          <th />
        </tr>
      </thead>
      <tbody>{rows}</tbody>
    </table>
  );
}

type Column<T> = {
  label: string;
  /** What the column sorts by; null values always sort last. */
  sort: (row: T) => number | string | null;
  cell: (row: T) => ComponentChildren;
  numeric?: boolean;
};

/** A table that sorts by any column on click, keeping nulls last both ways. */
function SortableTable<T>(props: { rows: readonly T[]; columns: Column<T>[]; limit: number }) {
  const [sort, setSort] = useState<{ column: number; descending: boolean } | null>(null);
  const [showAll, setShowAll] = useState(false);
  const column = sort === null ? null : props.columns[sort.column];
  const rows = column
    ? [...props.rows].sort((a, b) => {
        const x = column.sort(a);
        const y = column.sort(b);
        if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
        const order = x < y ? -1 : x > y ? 1 : 0;
        return sort?.descending ? -order : order;
      })
    : props.rows;
  const shown = showAll ? rows : rows.slice(0, props.limit);

  return (
    <>
      <table class="rows">
        <thead>
          <tr>
            {props.columns.map((c, i) => (
              <th key={c.label} class={c.numeric ? "num" : undefined}>
                <button
                  type="button"
                  class="link"
                  onClick={() =>
                    setSort({
                      column: i,
                      descending: sort?.column === i ? !sort.descending : c.numeric === true,
                    })
                  }
                >
                  {c.label}
                  {sort?.column === i ? (sort.descending ? " ↓" : " ↑") : ""}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((row, i) => (
            <tr key={i}>
              {props.columns.map((c) => (
                <td key={c.label} class={c.numeric ? "num" : undefined}>
                  {c.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > shown.length && (
        <button type="button" class="link more" onClick={() => setShowAll(true)}>
          Show all {num(rows.length)}
        </button>
      )}
    </>
  );
}

const date = (iso: string | null) =>
  iso === null ? "" : new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });
const hours = (value: number | null) => (value === null ? "" : duration(value));
const link = (pr: PrFact) => (
  <a href={pr.url} target="_blank" rel="noreferrer">
    #{pr.number}
  </a>
);

/** What stands out about a PR, in a few words. */
function flags(pr: PrFact): string {
  return [
    pr.state === "merged" && !pr.reviewed && "unreviewed",
    pr.selfMerged && "self-merged",
    pr.revertedBy !== null && `reverted by #${pr.revertedBy}`,
    pr.reverts.length > 0 && `reverts ${pr.reverts.map((n) => `#${n}`).join(", ")}`,
    pr.truncated.length > 0 && "incomplete data",
  ]
    .filter(Boolean)
    .join(", ");
}

/** The PRs behind one metric in one period. */
export function PrTable(props: { rows: readonly PrRow[]; showRepo: boolean }) {
  const columns: Column<PrRow>[] = [
    { label: "#", sort: ({ pr }) => pr.number, cell: ({ pr }) => link(pr), numeric: true },
    { label: "Title", sort: ({ pr }) => pr.title.toLowerCase(), cell: ({ pr }) => pr.title },
    ...(props.showRepo
      ? [{ label: "Repo", sort: ({ pr }: PrRow) => pr.repo, cell: ({ pr }: PrRow) => pr.repo }]
      : []),
    { label: "Author", sort: ({ pr }) => pr.author.toLowerCase(), cell: ({ pr }) => pr.author },
    {
      label: "Ended",
      sort: ({ pr }) => pr.mergedAt ?? pr.closedAt,
      cell: ({ pr }) =>
        `${date(pr.mergedAt ?? pr.closedAt)}${pr.state === "closed" ? " (closed)" : ""}`,
    },
    {
      label: "Cycle",
      sort: ({ pr }) => pr.cycleHours,
      cell: ({ pr }) => hours(pr.cycleHours),
      numeric: true,
    },
    {
      label: "Coding",
      sort: ({ pr }) => pr.codingHours,
      cell: ({ pr }) => hours(pr.codingHours),
      numeric: true,
    },
    {
      label: "Pickup",
      sort: ({ pr }) => pr.pickupHours,
      cell: ({ pr }) => hours(pr.pickupHours),
      numeric: true,
    },
    {
      label: "Review",
      sort: ({ pr }) => pr.reviewHours,
      cell: ({ pr }) => hours(pr.reviewHours),
      numeric: true,
    },
    {
      label: "Merge wait",
      sort: ({ pr }) => pr.mergeWaitHours,
      cell: ({ pr }) => hours(pr.mergeWaitHours),
      numeric: true,
    },
    {
      label: "Size",
      sort: ({ pr }) => pr.sizeLines,
      cell: ({ pr }) => (pr.sizeLines === null ? "" : num(pr.sizeLines)),
      numeric: true,
    },
    {
      label: "Reviews",
      sort: ({ pr }) => pr.reviews,
      cell: ({ pr }) => num(pr.reviews),
      numeric: true,
    },
    {
      label: "Notes",
      sort: ({ pr }) => flags(pr) || null,
      cell: ({ pr }) => <span class="muted">{flags(pr)}</span>,
    },
  ];
  return <SortableTable rows={props.rows} columns={columns} limit={50} />;
}

/** Open PRs, oldest first: work in progress as of the data. */
export function OpenTable(props: { prs: readonly PrFact[]; asOf: Date; showRepo: boolean }) {
  const days = (iso: string | null) =>
    iso === null ? null : Math.floor((props.asOf.getTime() - Date.parse(iso)) / 86_400_000);
  const columns: Column<PrFact>[] = [
    { label: "#", sort: (pr) => pr.number, cell: link, numeric: true },
    { label: "Title", sort: (pr) => pr.title.toLowerCase(), cell: (pr) => pr.title },
    ...(props.showRepo
      ? [{ label: "Repo", sort: (pr: PrFact) => pr.repo, cell: (pr: PrFact) => pr.repo }]
      : []),
    { label: "Author", sort: (pr) => pr.author.toLowerCase(), cell: (pr) => pr.author },
    {
      label: "Age (days)",
      sort: (pr) => days(pr.createdAt),
      cell: (pr) => num(days(pr.createdAt) ?? 0),
      numeric: true,
    },
    {
      label: "State",
      sort: (pr) => (pr.draft ? "draft" : "ready"),
      cell: (pr) => (pr.draft ? "draft" : "ready"),
    },
    {
      label: "Waiting for review (days)",
      sort: (pr) => (pr.draft || pr.reviewed ? null : days(pr.readyAt)),
      cell: (pr) => (pr.draft || pr.reviewed ? "" : num(days(pr.readyAt) ?? 0)),
      numeric: true,
    },
    { label: "Reviews", sort: (pr) => pr.reviews, cell: (pr) => num(pr.reviews), numeric: true },
  ];
  return <SortableTable rows={props.prs} columns={columns} limit={25} />;
}
