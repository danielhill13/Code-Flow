# Decisions

Short and append-only. To change a decision, add a new entry that supersedes it.

**D1 · 2026-10-02 · TypeScript end to end.** The CLI, the server and the report share one metric
implementation in `src/core`. An earlier Python-and-JavaScript version of this tool kept
aggregation logic in both languages, and the two drifted.

**D2 · 2026-10-02 · Open source, under MIT.** The working name is `codeflow`. The npm package name
gets chosen before the first release.

**D3 · 2026-10-02 · GitHub first.** Other code hosts come later as providers that map to the same
neutral PR model.

**D4 · 2026-10-02 · No git clones in v1.** GitHub's API returns per-file additions and deletions,
which covers sizes and line counts. Clones come back only for rework, opt-in.

**D5 · 2026-10-02 · Two delivery tracks, one implementation.** A static HTML file and a hosted app
share the UI and `core/aggregate`. A conformance suite requires them to return identical results.

**D6 · 2026-10-02 · Work items later, seams now.** Jira and Azure Boards links are a later phase.
Raw data and the PR model already leave room for them; see architecture.md.

**D7 · 2026-10-02 · No AI-involvement segment.** Out of scope.

**D8 · 2026-10-02 · Bots are a generic concept.** Bot accounts are left out of review metrics, and
their PRs out of flow metrics, by default. Config can count named bot accounts as reviewers.

**D9 · 2026-10-02 · Node 24+, ESM, erasable TypeScript.** Node runs the source directly by
stripping types, so development has no build step. The npm package ships compiled JavaScript,
because Node does not strip types inside `node_modules`.

**D10 · 2026-10-02 · SQLite through Node's built-in `node:sqlite`.** There is no native module
to compile at install time, which is a common way open-source CLIs break. Node still labels the
module experimental and warns on load, so `src/store/sqlite.ts` filters out exactly that warning.
Raw payloads are stored as gzipped JSON.

**D11 · 2026-10-02 · Sync walks GitHub's update order with kept cursors.** There are three walks
(backfill, updates, open sweep), and each page is stored with its walk's progress in one
transaction. Runs are therefore incremental and resumable, and idle repos cost nothing. See
architecture.md, "Sync".

**D12 · 2026-10-02 · Review threads are counted, not fetched.** Selecting each thread's author
would nest a connection inside a connection and raise a page from 2 points to about 27. Sync
stores `reviewThreads.totalCount`, plus every review and conversation comment with its author.
"Comments per PR" will therefore count discussions, not replies, and cannot exclude threads the
PR's author opened. Revisit if that distinction turns out to matter.

**D13 · 2026-10-02 · Comments count people, not threads. Supersedes the metric half of D12.**
`reviewThreads.totalCount` turned out to include threads that bots open, and on usebruno/bruno
CodeRabbit opens them on most PRs. So review metrics count what can be attributed: review
submissions ("Reviews per PR") and conversation comments ("Commented"), both by people other
than the author. Inline threads stay in the facts for display only. Sync still doesn't fetch
thread authors (D12's cost reasoning holds).

**D14 · 2026-10-02 · A revert needs a link, not a title.** A merged PR reverts another when its
body names it or a commit message reverts one of its commits. Of 24 revert-looking PRs on
usebruno/bruno, 11 only reverted a commit of their own and 3 never merged. Reverts that name
nothing are not counted, so the revert rate is a floor.

**D15 · 2026-10-02 · Facts are derived per repo, whole, from a fingerprint.** A repo is derived
again when its raw data, its relevant config, its measured branches or `DERIVE_VERSION`
changes. Whole repos, because revert links cross PRs. One PR at a time in memory, because
payloads are large. Under a second for 2,575 PRs.

**D16 · 2026-10-02 · No numbers for periods the data doesn't fully cover.** `summary` refuses a
period that starts before `since`, or any period while a repo's first sync is unfinished,
because such a period holds only the PRs that happened to be updated later and would look real
without being real.

**D17 · 2026-10-02 · Periods are calendar months, quarters and years in UTC.** A team-local time
zone can come later as config. Until then, a PR merged late on the last day of a month in the
Americas may land in the next month.
