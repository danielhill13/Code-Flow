# Roadmap

| Phase | Scope | Done when | Status |
| ----- | ----- | --------- | ------ |
| 0 | Project scaffold, config, `init`, `doctor` | `doctor` checks a real repo and estimates the first sync | Done |
| 1 | `sync`: every PR state into SQLite, incremental by `updatedAt`, throttled, resumable, with a run record | A full backfill works; a re-run fetches only changed PRs; an interrupted run resumes | Done |
| 2 | `derive` and `summary`: neutral PR model, bot handling, path buckets, origin-PR rule, `pr_facts` | 10–20 PRs checked by hand against GitHub; fixture tests built from public repos | Done |
| 3 | Report UI on the `DataSource` contract, plus the static track (`build`, `run`) | A Playwright sweep of every view and control finds no `undefined`, `NaN` or `Infinity`, and the numbers match `summary` | Next |
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

**Notes for phase 3:**

- Work in progress per weekday and aging open PRs are still to build. The facts have what they
  need (`startAt`, `readyAt`, end times, `draft`).
- Pace projection for a partial period (rule 7) is still to build. `summary` only warns that the
  period isn't over.
- The report needs `summary`'s coverage guard: no numbers for periods before the synced data.

**Deferred, with no phase yet:** fix and defect rate, deployment (DORA) metrics, teams, other code
hosts.

**Out of scope:** an AI-involvement segment, and commits per day.

**Before the first release:** choose the npm package name. `codeflow` and `codeflow-cli` are
taken; `code-flow` is free.
