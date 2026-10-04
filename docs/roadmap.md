# Roadmap

| Phase | Scope | Done when | Status |
| ----- | ----- | --------- | ------ |
| 0 | Project scaffold, config, `init`, `doctor` | `doctor` checks a real repo and estimates the first sync | Done |
| 1 | `sync`: every PR state into SQLite, incremental by `updatedAt`, throttled, resumable, with a run record | A full backfill works; a re-run fetches only changed PRs; an interrupted run resumes | Done |
| 2 | `derive` and `summary`: neutral PR model, bot handling, path buckets, origin-PR rule, `pr_facts` | 10–20 PRs checked by hand against GitHub; fixture tests built from public repos | Done |
| 3 | Report UI on the `DataSource` contract, plus the static track (`build`, `run`) | A sweep of every view and control finds no `undefined`, `NaN` or `Infinity`, and the numbers match `summary` | In progress |
| 4 | Hosted track: `serve`, scheduler, GitHub App auth, Docker image | The same report is served, and the conformance suite passes on both tracks | |
| 5 | Scale: concurrent sync, webhooks, anomaly flags | Runs within budget against hundreds of repos | |
| 6 | Work items: Jira and Azure Boards links | Link coverage is reported; work-item cycle time works | |
| 7 | Rework ratio from git clones, opt-in per repo | Rework shows for opted-in repos | |

**Validation repo:** [usebruno/bruno](https://github.com/usebruno/bruno). It is public, so its
data can go into test fixtures. In October 2026 it had about 4,400 PRs in total, 2,552 of them
updated in the past year, on default branch `main`.

**Phase 1, as measured on that repo:** the first backfill stored 2,575 PRs in about 25 minutes
and 300 points. It was interrupted twice, by Ctrl-C and by a hard kill, and each time it resumed
from the last stored page. Afterwards a sync of the idle repo took 1 second and 2 points. An
independent listing of the repo's PRs found none missing and none stale. GitHub cut off two
responses mid-body during the backfill: the first exposed a crash, since fixed, and the second
was retried. `doctor`'s time estimate came out about a third too low, because it times one page
and later pages include PRs big enough to need follow-up queries.

**Phase 2, as measured on that repo:** all 2,575 stored PRs are derived in under a second. For
18 PRs chosen to cover every rule (drafts, change-request rounds, self-merges, a fork's `main`, a
bot PR, a stacked PR, two reverts, an unreviewed merge, an abandoned PR, an open draft, the one
truncated PR), 20 values each were recomputed independently from GitHub's REST API, which sync
doesn't use: none differed. Eight of those PRs, anonymized, are now test fixtures. The data shows
bruno starting to require reviews in spring 2026: unreviewed merges went from 14–53 a month to
none from June.

**Metrics built** (`codeflow summary --explain` defines each):

- Speed: cycle time, coding, pickup, review, merge wait, time to approval, plus where the time
  went (each phase's share of all cycle hours, and any single PR holding a quarter of a phase)
- Throughput: PRs merged, PR size, lines merged (product files only)
- Review: reviewed, approved, reviews per PR, commented, re-pushed after review
- Stability: reverted within 30 days (merges under 30 days old are left out, not counted as fine)
- Flow: abandoned, and open PRs now

**Phase 3, so far.** The report follows the design handoff of October 2026: six tabs by
question (Overview, Speed, Review, Flow, Compare, Pull requests), scopes from config `teams`,
rolling windows, median or P75, and an internal/external filter. Its views are pure builders in
`src/core/views` (D18). New since phase 2: rolling windows and weekly or monthly trends (D19);
teams, the unassigned group and the contributors test (D20); per-reviewer review load inside a
team (D21); P25 for the middle-half bars (D22); each open PR's state and whose move it is (D23);
size bands; the open-PR count at any moment; the revert rate on a 30-day lag. Facts gained each
review with its time, each reviewer's first response and the open state (`DERIVE_VERSION` 2).
No view shows numbers for time before the synced data.

Teams are people with dated membership and products are repos and teams (D25), stamped on each
fact at derive time (D27). The report looks at any selection of teams, products, repos and
people, and breaks it down by team, product or repo (D26). `status`, `summary` and `doctor`
warn when a repo's work lands on a branch that isn't measured (D28).

On usebruno/bruno every tab builds in a few milliseconds. The sweep in `npm run check` renders
all six tabs at every scope, window, statistic and filter, with and without teams, and Compare's
months match `summary`.

A workspace holds several orgs, each with its own config folder, database and report (D29).
Every command takes `--org`; `migrate` upgrades a single-file config.

People have identities (several logins each) and groups have kinds, so products, areas and
programs are all groups, each its own breakdown (D30).

Each org has a rule engine (D31): what counts, repo rules and people rules, scoped to the org,
repos, teams, groups or people. `codeflow rules` lists them and `rules test` previews a draft.

People, groups and rules export and import as versioned bundles (YAML, JSON, CSV for teams),
checked as a whole and previewed with `--dry-run` (D32).

`codeflow serve` runs the report as a local web app (D33): an org picker, and a Setup tab to edit
people, teams, groups and rules, with a live preview of what a rule would change, and import and
export. It writes the same files, and its answers match the static report's (a conformance
test compares them). Phase 4 still needs sign-in, a scheduler and a Docker image before serve
can be hosted.

Getting started is `npm start` and the browser (D39): first steps connect to GitHub, preview what
an org measures and run its first sync, and the Setup tab covers every option in an org's files.
Azure DevOps is a second provider (D40): an org can measure a GitHub organization and an Azure
DevOps project together, as one company, with people's sign-ins on both mapped to one person.
Its requests are paced to stay inside its rate limits (D41).

`codeflow serve` keeps data fresh by itself: each org syncs on its `sync_every`, daily by default
(D37), and `codeflow run` (sync, then build) serves cron. The served page stays about 40 KB
compressed and asks the server for each view, a few KB at a time, whatever the org's size
(D38). Changes read as a neutral increase or decrease, in one unit (D35). Open PRs quiet for
longer than the org's `stale_after_days` are stale, counted apart from the PRs open now (D36),
and an org can turn person-level views off.

Tests run in four layers, all offline (D34): unit tests, a sweep of every report view, scenario
tests running the real CLI against a fake GitHub, and browser tests of the report and `serve` in
Chromium. `npm run check` runs the first three; `npm run verify` adds the browser. Every
measurement rule and every catalogued behaviour in [testing.md](testing.md) has a test.

**Still to do in phase 3:**

- Print: check each tab on paper, and that Compare fits on one page.
- The scope menus could show each team's merged count, as the design does.
- Report size: 3.8 MB for bruno's 2,575 PRs. Facts could drop what no view reads.
- Pace projection for a partial period (rule 7), and work in progress per weekday, are still
  unbuilt; the design doesn't call for them.

**Deferred, with no phase yet:** fix and defect rate, deployment (DORA) metrics, other code
hosts. For groups: a `codeflow teams import` that drafts teams from GitHub org teams; ownership
by path within a repo (monorepos, CODEOWNERS); people from an HR export; GitHub user IDs in the
sync query, so a renamed login stays the same person.

**Out of scope:** an AI-involvement segment, and commits per day.

**Before the first release:** choose the npm package name. `codeflow` and `codeflow-cli` are
taken; `code-flow` is free.
