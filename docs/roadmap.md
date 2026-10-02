# Roadmap

| Phase | Scope | Done when | Status |
| ----- | ----- | --------- | ------ |
| 0 | Project scaffold, config, `init`, `doctor` | `doctor` checks a real repo and estimates the first sync | Done |
| 1 | `sync`: every PR state into SQLite, incremental by `updatedAt`, throttled, resumable, with a run record | A full backfill works; a re-run fetches only changed PRs; an interrupted run resumes | Next |
| 2 | `derive` and `summary`: neutral PR model, bot handling, path buckets, origin-PR rule, `pr_facts` | 10–20 PRs checked by hand against GitHub; fixture tests built from public repos | |
| 3 | Report UI on the `DataSource` contract, plus the static track (`build`, `run`) | A Playwright sweep of every view and control finds no `undefined`, `NaN` or `Infinity`, and the numbers match `summary` | |
| 4 | Hosted track: `serve`, scheduler, GitHub App auth, Docker image | The same report is served, and the conformance suite passes on both tracks | |
| 5 | Scale: concurrent sync, webhooks, anomaly flags | Runs within budget against hundreds of repos | |
| 6 | Work items: Jira and Azure Boards links | Link coverage is reported; work-item cycle time works | |
| 7 | Rework ratio from git clones, opt-in per repo | Rework shows for opted-in repos | |

**Validation repo:** [usebruno/bruno](https://github.com/usebruno/bruno). It is public, so its
data can go into test fixtures. In October 2026 it had about 4,400 PRs in total, 2,552 of them
updated in the past year, on default branch `main`.

**Metrics planned for phases 2 and 3:**

- Speed: cycle time and its four phases, time to first review, time to approval
- Throughput: PRs merged, PR size and lines merged (product files only)
- Review: share reviewed, share approved, share merged without approval, comments per PR, review
  rounds
- Stability: revert rate within 30 days (null until 30 days have passed)
- Flow: work in progress per weekday including open PRs, aging open PRs, abandon rate

**Deferred, with no phase yet:** fix and defect rate, deployment (DORA) metrics, teams, other code
hosts.

**Out of scope:** an AI-involvement segment, and commits per day.

**Before the first release:** choose the npm package name. `codeflow` and `codeflow-cli` are
taken; `code-flow` is free.
