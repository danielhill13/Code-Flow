# Architecture

codeflow measures how pull requests move from first commit, through review, to merge. This page
is the design. [roadmap.md](roadmap.md) tracks what is built, and [decisions.md](decisions.md)
records why.

## Workspace and orgs

A workspace (`codeflow.yml`) lists orgs. Each org is a tenant with its own config folder
(`orgs/<name>/`), database (`.codeflow/<name>/codeflow.db`) and report file, and the pipeline
below runs per org. No command, file or report mixes two orgs (D29).

## Pipeline

```
GitHub GraphQL ─ sync ─▶ .codeflow/codeflow.db (SQLite)
                           raw_prs           every version of every PR, provider-native, insert-only
                           repos             what discovery saw, plus each repo's sync progress
                           default_branches  when each repo's default branch changed
                           runs              outcome, calls and points of every run
               derive ─▶   pr_facts          one row per PR = f(raw, config)
                           derivations       what each repo's facts were derived from
               summary ─▶ the metrics for a period, in the terminal or as JSON
               build  ─▶ report.html         static track: one self-contained file
               serve  ─▶ http://…            hosted track: the same report, served
```

- **Raw data is the system of record.** It is never edited. Every metric is a pure function of
  raw data plus config, so changing a definition costs a re-derive, not a re-fetch.
- **Facts re-derive themselves.** Each repo's facts carry a fingerprint of what they came from:
  its raw data, the config that affects them, its measured branches, and `DERIVE_VERSION`. A
  change to any of those re-derives that repo on the next `sync`, `summary` or `pr`. There are no
  cache flags to remember. Deriving all 2,575 PRs of usebruno/bruno takes under a second.
- **One PR stream covers every state.** Open, merged and closed PRs come through the same sync, so
  work in progress and abandon rate need no separate pipeline.
- **No git clones.** GitHub's API returns per-file additions and deletions, which is enough for
  sizes and line counts. Clones return only for rework, opt-in (roadmap phase 7).

## Sync

GitHub lists a repo's PRs ordered by last update, and pages through them with keyset cursors
that encode the last PR's `(updatedAt, id)`. A cursor therefore stays valid however long it is
kept, and a PR that changes jumps to the top instead of shifting the pages below it. Sync makes
three walks over that order:

| Walk | Order | Runs | Stops at |
| ---- | ----- | ---- | -------- |
| backfill | newest first | until it has reached `since` | the first PR updated before `since` |
| updates | newest first | when the repo's latest PR activity is past the watermark | the watermark |
| open sweep | oldest first, open PRs only | once per repo | the first PR updated on or after `since` |

- The watermark is the newest `updatedAt` up to which every PR's current version is stored. A
  repo whose latest activity, which discovery already reports, is not past it costs no calls.
- Each page is stored in the same transaction as its walk's progress. A run stopped at any point,
  even by a crash, resumes from the last stored page and fetches nothing twice. Moving `since`
  earlier extends the backfill from its kept cursor.
- The open sweep exists because the backfill never reaches an open PR that has sat untouched since
  before `since`. That PR is still work in progress.
- A page is 25 PRs with their commits, reviews, comments, files and timeline events, at 2 points.
  A connection longer than 100 nodes is completed with follow-up queries.
- GitHub sometimes times out on a big page, and sometimes answers 200 OK with the body cut off
  (seen on pages over a megabyte). The client retries a cut-off response twice. If a page still
  fails either way, sync halves it and carries on: the cursor doesn't care how big a page was.
- A run takes a lock, so two syncs never write the same database, and leaves a record in `runs`.
- Requests go one at a time, at most one per second, the spacing Octokit applies to all GraphQL
  because GitHub asks for it between writes. Sync only reads, so this is conservative. Measured on
  usebruno/bruno, a page takes about 10 s and the first backfill of 2,552 PRs about 25 minutes;
  later runs take seconds. Parallel repos and looser pacing are roadmap phase 5.

## From raw data to numbers

1. **Normalize.** The provider maps each PR's newest raw version to the neutral model
   (`core/model.ts`), and notes any list it returned only part of.
2. **Derive.** `core/derive.ts` turns one model into one fact (`core/facts.ts`): its timeline,
   phases, size by path bucket, review numbers, and whether it counts. Revert links need the
   whole repo, so they come after, from a few clues per PR (`core/reverts.ts`). Only one PR is in
   memory at a time.
3. **Measure.** `core/aggregate.ts` computes every metric in the registry (`core/metrics.ts`) for
   a period. A metric is one registry entry, holding its definition, population and computation.
   `summary`, `pr` and, later, the report all read from it.

Who counts as a reviewer: anyone except the author and bots, before the PR merged or closed.
The author is excluded because GitHub records a reply in a review thread as a review by whoever
replied: 1,672 of usebruno/bruno's reviews are authors answering their reviewers. Bots are
excluded unless config names them: in the same repo, CodeRabbit alone left 3,390 reviews,
usually within minutes. Comments and reviews matching `bots.ignore_bodies` are boilerplate and
never count.

A merged PR reverts another when its body names it ("Reverts owner/name#123", as GitHub's Revert
button writes) or a commit message reverts one of its commits ("This reverts commit <sha>").
A revert title alone isn't enough, and neither is a commit that reverts another commit of the
same PR. That is ordinary work in progress: 11 of usebruno/bruno's 24 revert-looking PRs were
exactly that.

A metric's function returns null for a PR it doesn't apply to: pickup for an unreviewed PR, or
the revert rate for a merge less than 30 days old. That PR then neither helps nor hurts, and
stays out of the metric's n. `summary` refuses a period that starts before the synced data
does, since such a period holds only the PRs that happened to be updated later.

## Code layout

```
src/config/             config schema, the workspace loader (orgs and their files), bundles for
                        export and import, and their JSON Schema
src/store/              the SQLite database: schema migrations, raw PRs, facts, sync state, runs
src/providers/github/   auth, GraphQL client, queries, repo discovery, sync walks, normalize
src/providers/ado/      Azure DevOps: token, paced REST client, discovery, PR details, sync, normalize
src/core/               provider-neutral PR model, derive, path buckets, metric registry, aggregation,
                        people and groups, the rule engine, selections, rolling windows
src/core/views/         one pure model builder per report tab, and the PR list's filters
src/pipeline/           steps that tie config, store and core together (derive, report data)
src/cli/                init · doctor · sync · status · summary · pr · build · serve
src/report/             the report UI; admin/ holds the Setup tab, shown only when served
src/server/             `codeflow serve`: the HTTP API, per org, and its org registry
scripts/                developer tools, such as making anonymized test fixtures
```

A provider's job ends at the neutral PR model. `src/providers/github` and `src/providers/ado`
(Azure DevOps, D40) each discover repos, sync PRs into the store as fetched, and map them onto it;
derive picks the mapping by the repo's provider. Adding GitLab later means a new
`src/providers/<name>`, with no change to any metric.

## Two delivery tracks, one implementation

The report UI reads all of its data through one interface:

```ts
interface DataSource {
  meta(): Promise<Meta>;                          // scope tree, date range, freshness
  overview(q: ViewQuery): Promise<OverviewModel>; // one call per tab, each a plain-data model
  speed(q: ViewQuery): Promise<SpeedModel>;
  review(q: ViewQuery): Promise<ReviewModel>;
  flow(q: ViewQuery): Promise<FlowModel>;
  compare(q: CompareQuery): Promise<CompareModel>;
  prs(q: PrQuery): Promise<PrListModel>;          // the PRs behind any number
  pr(id: string): Promise<PrDetail | null>;       // one PR, as `codeflow pr` reads it
}
```

Each model comes from a pure function in `src/core/views` of the facts, the scope tree and the
query (decision D18). The static report runs those functions in the page (`EmbeddedSource`);
`codeflow serve` runs them per request and sends the result as JSON (`HttpSource` in the page).
Served, the report also gets an `AdminApi` for the Setup tab, which reads each part of an org's
config with a version and writes it back whole (D33).

|                  | Static                               | Hosted                                     |
| ---------------- | ------------------------------------ | ------------------------------------------ |
| Command          | `codeflow build`                     | `codeflow serve`                           |
| Data lives in    | the HTML file itself                 | SQLite on the server                       |
| Aggregation runs | in the browser                       | in Node, on the server                     |
| Suits            | one team, snapshots, sharing a file  | an organization, many repos, always current |

Both tracks call the same `core/views` builders, so there is no second implementation to drift.
A conformance test runs every query the UI can issue through both tracks and requires identical
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

## The report

Six tabs, each answering one set of questions, so a CTO and a manager read the same numbers at
different depths:

| Tab | Question | Holds |
| --- | -------- | ----- |
| Overview | Are we getting faster or slower? | cycle time, PRs merged, pickup and revert rate, each with its change and trend; where the time went; a row per team or repo; notes on the data |
| Speed | Where does the time go? | cycle-time trend (statistic and P85), predictability, the four phases and time to approval, PR size against cycle time, throughput |
| Review | Is review holding us up? | pickup, review time, reviews per PR, re-pushes, coverage; review load; what happened after review |
| Flow | What's stuck right now? | open PRs as of the data: counts, the open trend, abandon rate, age by state, oldest first with whose move it is |
| Compare | Did the change work? | two calendar periods (or custom dates): every metric, its PR counts, the middle half of its PRs, where the time went |
| Pull requests | Which PRs are behind this number? | a filtered, sortable list, and a side panel showing how codeflow read one PR |

- **Selection** is any mix of teams, groups, repos and people (D26, D30), shown as crumbs in
  the header and built with a picker. Tables break it down by team, each kind of group, or repo.
- **Window** is 30, 60 or 90 days, or year to date, ending when the data does (D19). Compare uses
  calendar periods instead.
- **Statistic** is the median or P75, everywhere. Predictability adds P85; Compare adds P25 and
  P75 for the middle half.
- **Contributors** is all, internal or external, a filter only (D20, D25).
- **Change** reads "↑ 125% from 1.3 d", "↓ 10 pts from 32%" or "same as before (2)": shares move
  in points, the rest relatively, and moves under 3% (or half a point) are the same. Never
  coloured good or bad.
- **Every number is a link** to the Pull requests tab, filtered with the same tests the metric
  uses, so the list holds the PRs the number rests on. A test checks this for every metric.
- **The URL holds the view**: tab, scope, window, statistic, contributors, Compare's periods, the
  PR list's filters and sort, and the open PR. Theme is the viewer's, kept in their browser.
- **Open PRs** are draft, waiting for a first review, in review, or approved, and wait on the
  author, reviewers or the merge (D23).

`npm run check` includes a sweep that renders every tab at every scope, window, statistic and
contributors filter, opens PR lists and side panels, and fails on `undefined`, `NaN`,
`Infinity` or `[object Object]`.

## People, teams and groups

Three kinds of definition, all from an org's config (`core/groups.ts`):

- A **person** has one or more logins (D30). Everything that counts people counts persons, so
  a renamed or second account is the same person.
- A **team** is people. A PR belongs to its author's team on the day it opened; membership can
  have dates, and a person is in one team at a time, so team rows add up to the total and a move
  keeps its history. A `secondary` membership lists someone with a second team without counting
  their PRs there.
- A **group** has a kind (product, area…) and holds repos, teams and people. Groups may overlap;
  the report says how many PRs count for more than one, and totals count each PR once.

Derive stamps each fact with its `person`, `team`, `alsoTeams`, `groups` and `internal` (D27).
Where definitions come from is open: GitHub teams, CODEOWNERS (paths within a monorepo) or an HR
export can feed the same definitions later.

## Rules

Each org's rules (`core/rules.ts`, D31) decide what counts, how its repos are read and how its
people are treated, scoped to the org, repos, teams, groups or people. Derive asks one engine
three questions: per repo (measured and promotion branches, product-code paths), per person
(bot, bot reviews count) and per PR (count, internal, comments to ignore). The older config keys
compile into rules ahead of `rules.yml`'s. The compiled rules are part of each repo's derive
fingerprint, so editing a rule re-derives.

## Serving

`codeflow serve` (`src/server/`) uses Node's own `http` module. Each org lives at `/orgs/<org>/`
and its API at `/api/orgs/<org>/`: `meta`, `views/<tab>`, `prs/<id>`, `config/<part>` (people,
groups, rules; read and write), `rules/preview`, `export` and `import`. The registry loads each
org on its own, from its files and database, and loads it again when either changes, whether
through the app, a hand edit or a sync running beside it. Writes go through the bundle code
(`planImport`, `applyImport`), so the app, the CLI and hand edits share one validation. It binds
to 127.0.0.1, checks the Host header against DNS rebinding and requires an `x-codeflow` header
on writes, which a form on another site can't send (D33).

Setup beyond one org's parts goes through `server/admin.ts` (D39): `GET /api/workspace`,
`POST /api/workspace/orgs` (as `init`), `POST /api/workspace/convert` (as `migrate`),
`POST /api/github/check` and `POST /api/github/preview` (what sources would measure, before an
org exists), and per org `POST sync` (sync now), `GET repos` and `POST remove`. The page at
`/welcome/` is the first steps; `/` leads there until an org exists.

A scheduler (`server/scheduler.ts`, D37) syncs each org on its `sync_every` while `serve` runs,
and `GET /api/orgs/<org>/status` says when it last did and when it will next. Responses are
compressed with brotli or gzip; the page is revalidated by its ETag, and answers about data are
never cached (D38).

## Measurement rules

These hold everywhere. Each gets a test as it is built.

1. **A PR counts once**, where it lands on the measured branch: each repo's default branch unless
   configured otherwise. A PR whose head is itself a long-lived branch (main, develop,
   release/\*) is a promotion or back-merge. It is excluded, with the reason recorded.
2. **Watch the measured branch.** A default-branch change, or a repo's work landing mostly on a
   branch that isn't measured, raises a flag (D28). Otherwise a renamed branch, or features
   merging into `develop`, silently zeroes a repo's numbers.
3. **Size counts product code.** Files fall into buckets: product, test, docs, generated,
   vendored, lockfile. Patterns are case-insensitive, with generic defaults and per-repo overrides.
4. **Null is not zero.** Missing and still-maturing values stay null in every metric, chart and
   table. Limits are never applied silently: a PR the API truncates is flagged, not estimated.
5. **Medians don't add up.** The cycle-time breakdown uses total hours per phase, because stacked
   medians don't sum to the median cycle time.
6. **A quantile needs data behind it.** A percentile p is shown only with at least
   5/min(p, 1−p) non-null observations: five beyond it on its thinner side (P50 needs 10, P25
   and P75 20, P90 50). Hidden points are counted and explained on the chart.
7. **Compare like with like.** The default period is the last complete one. A partial period's
   running totals are pace-projected once enough days have passed, and a partial period is never
   the baseline.
8. **Every number opens its PRs** and says how many there are. Coverage is always shown, and so is
   concentration when a few PRs carry a number.
9. **Bots are not reviewers.** Accounts GitHub reports as bots, plus any named in config, are
   left out of review metrics, and their PRs are left out of flow metrics by default. Config can
   count named bot accounts as reviewers. Boilerplate bot comments never count as review.
10. **No leaderboards.** Nothing breaks numbers down by author. People can be selected, alone or
    together (D26), and review load names reviewers, as capacity (D21).
11. **Labels come from one place.** A statistic's name (median, P75, …) comes from one function,
    and the URL captures the whole view.
12. **Stale data looks stale.** The report always shows the data-through date and the last
    successful sync.
13. **Churn is product code changed again soon.** A merged PR is changed again when a later PR
    merged into the same branch, not a bot's, changes one of its product files within the org's
    churn window (`churn_window_days`, 30 by default); a follow-up is the same by its own author.
    A PR younger than the window, or whose files weren't all listed, is null, never "no".
14. **Rework is lines changed after the first review**, by commits pushed after it, merges of the
    target branch left out. Null without a review, or where the host gives no lines per commit
    (Azure DevOps), never zero.
15. **Size is read against the org's target.** A merged PR of known size is within the target
    when its product lines are at most `size_target_lines` (400 by default).

## Per-PR timeline

Each merged PR has five points in time:

- **start**: the first commit, or the PR's creation if that is earlier
- **ready**: creation, or the first ready-for-review event if the PR opened as a draft. A PR that
  opened ready and was later turned into a draft was ready at creation.
- **first review**: the first review submitted by someone who counts as a reviewer (above): an
  approval, a change request, or a comment-review
- **review end**: the last approval before merge, or the last review when nobody approved
- **merge**

The four phases between them (coding, pickup, review and merge wait) add up exactly to cycle
time. When a point is missing, the phases around it merge: a PR merged without review has no
pickup or review phase, so all its time after ready is merge wait. A point that comes early,
such as a review during the draft, is clamped so no phase is negative. Draft time never counts
as pickup.

Two more values come from the same points: **time to approval** (from ready to the first
approval) and **rounds** (how many times new commits arrived after a review).
