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

**D18 · 2026-10-03 · The report computes its views in the page, with core's builders.** The
design handoff (October 2026) suggested precomputing a view model for every combination of
scope, window, statistic and contributors, so the page never aggregates. Instead each tab's
model is a pure function in `src/core/views`, which the static report runs in the browser on the
embedded facts and `codeflow serve` will run per request. The numbers are the same by
construction, since it is the same function. Precomputing would have multiplied the file's size
(bruno alone needs 72 models before Compare), could not serve Compare's custom dates, and would
still have needed the facts for PR lists. The UI itself never aggregates: it renders models and
filters PRs with core's own tests.

**D19 · 2026-10-03 · The report's tabs use rolling windows; Compare uses calendar periods.**
Overview, Speed, Review and Flow look back 30, 60 or 90 days, or year to date, from the moment
the data was complete, and compare with the window before (year to date: the same span a year
earlier). A window that ends with the data is never partial, so its counts compare fairly (rule
7). Trends inside a window are whole Monday weeks, or calendar months for a year to date past
13 weeks; the last point is still running and drawn hollow. Compare and `summary` keep calendar
periods (D17). A metric with a lag, the revert rate, is measured on the window moved back 30
days, so every PR in it is old enough to judge.

**D20 · 2026-10-03 · Teams own repos, people, or both, and a PR belongs to every team that
claims it.** `teams` in codeflow.yml maps a name to repos (globs) and logins. A PR is a team's if
the team owns its repo or its author is one of the team's people, so with people in two teams a
PR can count for both. Repos no team owns form "Unassigned repos". Where teams come from is still
open (a directory, CODEOWNERS), so membership is answered in one place, `core/scope.ts`. That
file also decides who is internal: team people, bots, anyone GitHub calls owner, member or
collaborator, and anyone who opened the PR from a branch of the repo itself. GitHub hides private
organization memberships from tokens outside the organization, so staff can appear as outside
contributors; listing them in a team fixes that.

**D21 · 2026-10-03 · Review load names reviewers inside a team. Amends rule 10.** The Review tab
lists reviewers by reviews given, with their share, the open PRs waiting on them and their first
response, but only inside a team or repo, and framed as capacity: who carries review, and who is
waited on. At the top level it shows one row per team, with how concentrated review is and no
names. There are still no author output totals anywhere. Busiest first is the point of the list,
since the question is whether review rests on a few people.

**D22 · 2026-10-03 · A low percentile needs as much data as a high one.** Rule 6 asked for
5 ÷ (1 − p) observations, written with upper percentiles in mind. The middle-half bars need P25,
so the rule now asks for five observations beyond the percentile on its thinner side:
5 ÷ min(p, 1 − p). P25 and P75 both need 20. The handoff's "fewer than 5 PRs" threshold was the
prototype's and isn't used.

**D23 · 2026-10-03 · An open PR's state is read from its reviews, pushes and review requests.**
Draft, waiting for a first review, in review, or approved, plus whose move it is: the author
(draft, changes asked, review comments), reviewers (asked, or asked to look again after a push),
or the merge. One approval with no standing change request counts as approved, since codeflow
doesn't know how many a repo requires. Sync doesn't fetch review-request removals, so a reviewer
whose request was withdrawn still counts as asked. GitHub's own `reviewDecision` would be more
exact but needs a query change and a refetch of open PRs; revisit if the heuristic misleads.

**D24 · 2026-10-03 · The report makes no network requests.** It uses the system's Helvetica,
Arial or Arimo and its monospace font instead of loading Arimo and IBM Plex Mono from Google
Fonts as the handoff suggested. The file opens offline, and opening it tells no third party
anything.

**D25 · 2026-10-03 · Teams are people, with dates; products are repos and teams. Supersedes
D20's teams.** A team lists its people, each optionally with `from` and `to` dates. A PR belongs
to its author's team on the day the PR opened, so teams that share repos don't claim each other's
work, and a person who moves keeps their history with the old team. A person is in one team at
a time: config that puts someone in two teams on the same day is refused, unless one membership
is marked `secondary`, which lists them with that team without counting their PRs there. Team
rows therefore add up to the total. A product holds repos (globs) and teams, and products may
overlap: a PR counts for each product it belongs to, the report notes how many PRs count twice,
and totals count each PR once. PRs outside every team or product go to "No team" and "No
product". D20's contributors test stands, with team people counting as internal. Paths within a
repo (monorepos) and team definitions from GitHub teams, CODEOWNERS or HR exports come later,
behind `core/groups.ts`.

**D26 · 2026-10-03 · The report looks at a selection, not a scope. Amends D21.** A selection is
any mix of teams, products, repos and people: a PR matches any value within one of them and
every one that is set. There is no minimum number of people. The URL holds it, the header shows
it as crumbs with menus, and a picker builds any mix. Tables break down the selection by team,
product or repo, whichever it hasn't narrowed to one value. Review load lists reviewers by name
whenever the selection is narrowed; with nothing selected it shows one row per team (or product,
or repo). There is still no breakdown by person, so nothing ranks authors' output.

**D27 · 2026-10-03 · A PR's team and products are derived with its facts.** Each fact carries
`team`, `alsoTeams` and `products`, worked out by derive from config (`DERIVE_VERSION` 3), so
the static report, the CLI and a future server read the same answer, and a server can filter on
it in SQL. The groups are part of each repo's fingerprint: editing teams or products re-derives
every repo, which takes about a second for bruno's 2,575 PRs.

**D28 · 2026-10-03 · codeflow warns when work lands on a branch it doesn't measure (rule 2).**
`status`, `summary` and `doctor` look at each repo's PRs merged in the last 90 days. When more of
them went into one unmeasured branch than were counted at all, and at least 10 did, they say so
and print the `branches:` line that would measure it. That catches git-flow repos, where
features merge into `develop` and only promotions reach `main`, which would otherwise count
almost nothing. PRs into release, feature and stacked branches stay uncounted, which is what
keeps a change from counting again at each promotion.
