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

**D29 · 2026-10-03 · A workspace holds orgs; each org is a folder, a database and a report.**
An org is a tenant: its own sources (GitHub organizations and repos now; Azure DevOps and Jira
later), people, groups, rules and token. `codeflow.yml` lists the orgs, and each org's config
lives in `orgs/<name>/` (`org.yml`, `groups.yml`, and in time `people.yml` and `rules.yml`).
Its data is `.codeflow/<name>/codeflow.db` and its report `codeflow-report-<name>.html`.
Isolation is physical, not a filter: nothing of one org is ever in another org's database or
report file, so a report can be handed to one client without exposing another (a test checks
this). Config stays in files, which people can edit, review and commit; the planned web app
edits the same files. A single-file config from before workspaces still loads as one org, and
`codeflow migrate` turns it into a workspace, keeping its comments and moving its data.

**D30 · 2026-10-03 · People have identities; groups have kinds. Supersedes the naming in D25.**
`people.yml` maps a person to every GitHub login they use (and, later, their Azure DevOps and
Jira identities), with an optional display name and what config says about them: `bot`
(a service account) and `internal`. Each fact carries the author's `person`; reviews, review
load, "waiting on" and selections count people, not logins, so a renamed or second account is
the same person, and can't review its owner's PRs. Products generalize to groups of any `kind`
(product, area, program…), holding repos, teams and people; `products:` stays as shorthand for
kind `product`. Each kind is its own breakdown with its own catch-all ("No area"), and in a
selection groups of different kinds narrow (product Checkout and area Mobile) while groups of
one kind widen. Teams keep D25's rules: people, with dates, one primary team per day.

**D31 · 2026-10-03 · Each org has a rule engine; rules are data.** A rule in `rules.yml` has a
scope (the org, repos, teams, groups, people), optional conditions on the PR (labels, title,
branches, author association, fork, draft, bot author) and effects of one kind: what counts
(`count`, `internal`, `ignore_comments`), repo rules (`measured_branches`,
`promotion_branches`, `paths`) or people rules (`bot`, `bot_reviews_count`). Each effect is
resolved on its own, the more specific scope winning (org, group, team, repo, person) and then
the later rule; branch exclusions come first and no rule overrides them, so a change is never
counted twice. Rules aren't code: they validate with the same schema everywhere, can be shared
between orgs and are part of the derive fingerprint. The older config keys compile into rules
(ids starting `config:`), so existing configs behave as before. Every fact records the rules
that applied to it and, when one left it out, which. `codeflow rules test` derives in memory to
show what a draft would change; the web app's rule editor will use the same comparison.

**D32 · 2026-10-03 · People, groups and rules travel as versioned bundles.** `codeflow export`
writes any of an org's people, groups (teams included), rules and settings as one YAML or JSON
document headed `codeflow: 1`, in the same form as the org's files; CSV covers teams, the form
HR spreadsheets and directories export. `codeflow import` validates the whole resulting config
before writing anything, lists what it adds, changes and removes (merge adds and updates;
replace also removes), and with `--dry-run` writes nothing. It edits the YAML files entry by
entry, so comments on untouched entries survive, and writes each file by rename so a crash
can't leave half of one. The bundle's JSON Schema is generated from the config schema and a test
keeps the published copy current. Settings stay behind by default, since sources and dates are
each org's own, and bundles never hold tokens.

**D33 · 2026-10-03 · `codeflow serve` edits the files, not a second store.** The report also
runs as a local web app: `codeflow serve` answers the same `DataSource` calls over HTTP, from
the same view builders (D5, D18), and adds a Setup tab to edit an org's people, teams, groups and
rules. Saves write the org's YAML files, entry by entry, through the same checked path as
`codeflow import`, so a hand edit and an app edit are the same thing and comments on untouched
entries survive. Each save carries the version of the file it was based on and is refused if the
file changed meanwhile, rather than overwriting it unseen. Every API path names its org and each
org loads alone, from its own files and database, so nothing crosses between orgs; the org
picker loads the other org's page afresh. The server binds to 127.0.0.1, refuses requests
addressed to any other host (DNS rebinding) and writes without its `x-codeflow` header (another
site's form). Sign-in arrives with the hosted track; until then, serve is for one machine.

**D34 · 2026-10-04 · Four layers of tests, all offline, with a catalog kept true by a test.**
Unit tests stay beside the code. Scenario tests run the real CLI as its own process against a
fake GitHub server (`src/testing/github-server.ts`) that answers codeflow's GraphQL and pages
as GitHub does, serving a made-up org dated relative to today, so every window has data
whenever the tests run. Browser tests drive the built report and `codeflow serve` in Chromium
with Playwright. This adds two development dependencies, `@playwright/test` and
`@vitest/coverage-v8`, an exception to keeping dependencies few: only a real browser shows
layout, downloads, file uploads and navigation as people meet them, and neither ships with
codeflow. `npm run check` stays fast and needs no browser; `npm run verify` and CI add it. Each
user-visible behaviour has a `TC-` ID in docs/testing.md, each measurement rule a `[rule N]`
tag, and a guard test fails when either drifts from the tests. codeflow doesn't pace requests
to an API on this machine, so a sync against the fake takes a second rather than a minute.

**D35 · 2026-10-04 · Changes are an increase or a decrease, in one unit.** The report states
direction, never judgement: "135% increase from 1.3 d", not "slower" or a red arrow, since
whether more review time is bad depends on why. Both values are in the current value's unit, so
3.1 d is compared with 1.3 d, not with 31.6 h. A base under an hour, or a count under five,
moves by an absolute amount ("6 min increase from 1 min"), because a percentage of a tiny base
makes noise look like news. Dense tables keep an arrow, with "increase" or "decrease" as its
accessible name.

**D36 · 2026-10-04 · Stale open PRs are counted apart.** An open PR with no activity by a person
(push, review, comment, review request, draft flip) for longer than the org's
`stale_after_days`, 90 by default, is stale. Bots don't count, or a stale-bot would keep every PR
alive. Stale PRs stay visible (a line on Flow, a Stale set in the PR list, a line in `summary`,
the side panel saying so) but are not in "Open now", the age chart or the waiting counts, where
a years-old backlog would bury what is waiting today. Facts record each open PR's last activity
(`lastActivityAt`); only the latest is known, so a PR quiet for a while and then active again
counts as active over its quiet stretch in the open-PR trend.

**D37 · 2026-10-04 · `serve` syncs each org on a schedule, daily by default.** Fresh data
shouldn't depend on someone setting up cron. While `serve` runs, each org syncs when its last
clean sync is older than its `sync_every` (24h by default, at least 15m, or off), one org at a
time, through the same code as `codeflow sync` and its lock, so a sync started by hand and a
scheduled one never overlap. A failed sync waits half an hour before trying again. The schedule
is read from the org's files on each check, so an edit applies without a restart. The page asks
for the sync status every minute and reloads its view when a sync has finished. Without
`serve`, `codeflow run` (sync, then build) is the one command a scheduler needs.

**D38 · 2026-10-04 · The served page is light; the static file carries the data.** Served, the
page is the report's code alone, about 40 KB with brotli, revalidated by ETag. Each view is
computed on the server and sent as JSON, a few KB compressed, so the page stays the same size
however many PRs an org has; a test holds those budgets for a 3,000-PR org. The static report
still embeds every PR, since that is what lets it open offline, and `build` suggests `serve`
when the file passes 2 MB.

**D39 · 2026-10-04 · Set up in the browser; the files stay the source of truth.** Getting started
is `npm start`: an empty folder opens on first steps (connect to GitHub, choose what to measure
and preview it, create the org and watch its first sync), and every option in an org's files has
a Setup section: repos, branches, bots, paths, people, teams, groups, rules, sync, settings,
import and export. The web app writes the same YAML files as `init`, `migrate` and hand edits,
through the same checks, sending only the keys a section changed, so defaults stay unwritten.
Tokens are never typed into the web app: it says where codeflow looks (`GITHUB_TOKEN`, another
variable, the GitHub CLI) and checks the connection, so no secret reaches a file or the page.
Taking an org off the list keeps its files and data. Azure DevOps sources, next, join GitHub's in
the same Repos section, so one org can span both as one company.

**D40 · 2026-10-04 · Azure DevOps is a second provider; one org can span both hosts.** A source is
on GitHub (`owner`, `repo`) or Azure DevOps (`ado`, with an optional `project` and repo-name
patterns), and an org may hold any mix, so a company's GitHub organization and Azure DevOps
project are measured as one, with one database and one report. Azure DevOps PRs are stored as
fetched (the PR, its threads, pushes, commits and per-file line counts from its file-diff API)
and mapped onto the same PR model, so every metric reads them unchanged: a vote is a review
(approve, or wait-for-author and reject as a change request), a thread someone other than the
author starts is a commented review, each push after the first is new commits, and reviewer
additions are review requests. Its repos are named `organization/project/repo`. Azure DevOps
can't list PRs by last change, so each sync re-reads open PRs and those closed since the last
sync, after a first backfill by creation date. People may list Azure DevOps sign-ins beside
their GitHub logins, so one person, and their team, spans both hosts. Everyone who can open a PR
in an Azure DevOps organization belongs to it, so its authors count as internal. Tokens come
from a variable, `AZURE_DEVOPS_EXT_PAT`, or the Azure CLI's sign-in, never from a file.

**D41 · 2026-10-04 · Azure DevOps requests are paced.** Azure DevOps meters each user's use over a
sliding five-minute window and throttles beyond it. Every call goes through `AdoClient`, which
sends one request at a time with at least half a second between them, stretches the gap when the
server's `X-RateLimit-Remaining` falls below a fifth of `X-RateLimit-Limit`, pauses as long as
`X-RateLimit-Delay` asks, and on a 429 or 503 waits for `Retry-After` before trying again (five
times at most). A PR's details are fetched one call after another, never in parallel. This keeps
a sync well inside the limit at the cost of time (about five requests per PR), which the docs and
`doctor` state. A server on this machine (a test's fake) isn't paced.

**D42 · 2026-10-04 · One person across GitHub and Azure DevOps.** People at a company on both
hosts have an account on each; their PRs on both should be theirs, and their team's. Facts now
keep every account on a PR as the provider names it (author, reviewers, commenters, with Azure
DevOps's display names), so codeflow can list every account the org's PRs show, by host, with
its activity and person. It suggests GitHub and Azure DevOps accounts that look like one person:
strongly when the part of an address before the @ is a GitHub login, possibly when the shown name,
or its initials and surname, is one; an account matching more than one is flagged, and accounts
already in different people aren't suggested, since merging two people is a bigger call. A merge
writes `people.yml` (the accounts leave any other person, whose name carries over if it would be
left with none), from Setup › People or `codeflow people merge`, through the same checks as any
edit, and applies with no new sync. `github: []` now means "no GitHub account", so an Azure
DevOps-only person's key doesn't claim a GitHub login.

**D43 · 2026-10-04 · Removing the data of repos no longer measured.** The store kept every repo
ever synced, and the report showed them all, so narrowing a source (a whole organization down to
a few repos) left the others in the report. Which stored repos the sources still select is now
read from names alone (`config/scope.ts`: owner, project and the include and exclude patterns),
with no call to the host. `codeflow prune` lists the others and `--yes` removes their data;
Setup › Repos lists them too and removes them after a second click. Removing a whole repo's data
is the one exception to raw rows being only ever inserted: it happens only when the user asks,
takes the sync lock so it never races a sync, and syncing the repo again brings it back.

**D44 · 2026-10-04 · Churn, rework and the size target.** Three questions leaders ask after "how
fast": do PRs stay small, how much changes once review starts, and does merged code stick.
*Size target*: the share of merged PRs at or under `size_target_lines` (400 by default), beside
the size bands Speed already shows. *Rework*: lines changed by commits pushed after the first
review, merges of the target branch left out; GitHub gives lines per commit (asked for from now
on, so older PRs gain it only when fetched again), Azure DevOps doesn't, so it is null there rather
than estimated. *Churn*: file-level, from the files each PR changed, which both hosts already give:
a merged PR is "changed again" when a later merged PR into the same branch, not a bot's, changes one
of its product files within `churn_window_days` (30 by default), and "followed up" when that later
PR is its own author's. Line-level churn (blame) would need clones of every repo; file-level
answers the leadership question with data already synced. Both churn shares lag by the window, as
the revert rate does, and are null for PRs too young to tell. They are worded neutrally: some
change is normal evolution, a rise is worth a look.

