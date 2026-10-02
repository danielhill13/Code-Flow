# Architecture

codeflow measures how pull requests move from first commit, through review, to merge. This page
is the design. [roadmap.md](roadmap.md) tracks what is built, and [decisions.md](decisions.md)
records why.

## Pipeline

```
GitHub GraphQL ─ sync ─▶ .codeflow/codeflow.db (SQLite)
                           raw_pr     provider-native payload per PR version, append-only
                           repos      default-branch history, sync watermarks
                           runs       calls, points, rows and errors per run
               derive ─▶   pr_facts   one row per PR = f(raw, config)
               build  ─▶ report.html  static track: one self-contained file
               serve  ─▶ http://…     hosted track: the same report, served
```

- **Raw data is the system of record.** It is never edited. Every metric is a pure function of
  raw data plus config, so changing a definition costs a re-derive, not a re-fetch.
- **Facts re-derive themselves.** Each `pr_facts` row records the config and code version it was
  computed with, and a change to either recomputes it. There are no cache flags to remember.
- **One PR stream covers every state.** Open, merged and closed PRs come through the same sync, so
  work in progress and abandon rate need no separate pipeline.
- **No git clones.** GitHub's API returns per-file additions and deletions, which is enough for
  sizes and line counts. Clones return only for rework, opt-in (roadmap phase 7).

## Code layout

```
src/config/             codeflow.yml schema and loader
src/providers/github/   auth, GraphQL client, queries, repo discovery
src/core/               provider-neutral PR model, derive, path buckets, metric registry, aggregation
src/cli/                init · doctor · sync · build · serve · summary
src/report/             the report UI
src/server/             the hosted track's HTTP API
```

So far only `config`, `providers/github` and `cli` exist.

A provider's job ends at the neutral PR model. Adding Azure DevOps or GitLab later means a new
`src/providers/<name>`, with no change to any metric.

## Two delivery tracks, one implementation

The report UI reads all of its data through one interface:

```ts
interface DataSource {
  meta(): Promise<Meta>;                        // repos, people, date range, freshness
  query(q: MetricQuery): Promise<MetricResult>; // aggregated tiles and series
  prs(q: PrQuery): Promise<PrRow[]>;            // the PRs behind any number
}
```

|                  | Static                               | Hosted                                     |
| ---------------- | ------------------------------------ | ------------------------------------------ |
| Command          | `codeflow build`                     | `codeflow serve`                           |
| Data lives in    | the HTML file itself                 | SQLite on the server                       |
| Aggregation runs | in the browser                       | in Node, on the server                     |
| Suits            | one team, snapshots, sharing a file  | an organization, many repos, always current |

Both tracks call the same `core/aggregate` code, so there is no second implementation to drift. A
conformance test runs every query the UI can issue through both tracks and requires identical
results.

**Scaling the hosted track**, in this order and only when needed: GitHub App authentication
(org-wide, higher rate limits, no personal token); syncing repos concurrently within the
rate-limit budget; webhooks for near-real-time updates, with polling as the backstop; pushing
filters into SQL before aggregating. Storage sits behind a `Store` interface, so Postgres can
replace SQLite without touching any metric. Any aggregation moved into SQL must pass the same
conformance suite.

## Work items (designed, not built)

Jira issues and Azure Boards work items will attach to PRs in a later phase. These are in place
now, so that phase needs no rework:

- Raw data keeps PR titles, bodies, branch names and commit messages, so links can be derived
  later without re-fetching.
- The neutral PR model reserves `workItemRefs: { system, key, source }[]`.
- Work items will come from a `WorkItemProvider` (Jira, Azure Boards) into their own tables.

Rules for that phase: prefer the links the trackers record (Jira's development panel, Azure
Boards' artifact links) over parsing text, which misses links and invents some; validate parsed
keys against projects that exist, since a Jira-style pattern also matches `UTF-8` and `SHA-256`;
and report link coverage rather than assuming it.

## Measurement rules

These hold everywhere. Each gets a test as it is built.

1. **A PR counts once**, where it lands on the measured branch: each repo's default branch unless
   configured otherwise. A PR whose head is itself a long-lived branch (main, develop,
   release/\*) is a promotion or back-merge. It is excluded, with the reason recorded.
2. **Watch the measured branch.** A default-branch change, or a repo's PR volume dropping to near
   zero, raises a flag. Otherwise a renamed branch silently zeroes a repo's numbers.
3. **Size counts product code.** Files fall into buckets: product, test, docs, generated,
   vendored, lockfile. Patterns are case-insensitive, with generic defaults and per-repo overrides.
4. **Null is not zero.** Missing and still-maturing values stay null in every metric, chart and
   table. Limits are never applied silently: a PR the API truncates is flagged, not estimated.
5. **Medians don't add up.** The cycle-time breakdown uses total hours per phase, because stacked
   medians don't sum to the median cycle time.
6. **A quantile needs data behind it.** A percentile p is shown only with at least 5/(1−p)
   non-null observations (P90 needs 50). Hidden points are counted and explained on the chart.
7. **Compare like with like.** The default period is the last complete one. A partial period's
   running totals are pace-projected once enough days have passed, and a partial period is never
   the baseline.
8. **Every number opens its PRs** and says how many there are. Coverage is always shown, and so is
   concentration when a few PRs carry a number.
9. **Bots are not reviewers.** Accounts GitHub reports as bots, plus any named in config, are
   left out of review metrics, and their PRs are left out of flow metrics by default. Config can
   count named bot accounts as reviewers. Boilerplate bot comments never count as review.
10. **No leaderboards.** Per-person views exist so people can read their own flow. Nothing ranks
    people.
11. **Labels come from one place.** A statistic's name (median, P75, …) comes from one function,
    and the URL captures the whole view.
12. **Stale data looks stale.** The report always shows the data-through date and the last
    successful sync.

## Per-PR timeline

Each PR has five points in time:

- **start**: the first commit, or the PR's creation if that is earlier
- **ready**: creation, or the first ready-for-review event if the PR opened as a draft
- **first review**: the first review or review comment by someone other than the author
- **approval**: the last approval before merge
- **merge**

The four phases between them (coding, pickup, review and merge wait) add up exactly to cycle
time. When a point is missing, the phases around it merge: a PR merged without review has no
pickup or review phase. A point that comes early, such as a review during the draft, is clamped
so no phase is negative. Draft time never counts as pickup.
