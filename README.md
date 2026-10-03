# codeflow

Code flow metrics for GitHub: how pull requests move from first commit, through review, to merge.
Every number traces back to the pull requests behind it.

> **Early development.** Phases 0–2 of the [roadmap](docs/roadmap.md) are done: sync, and every
> metric below, in the terminal. The report (phase 3) works and is being finished.

## What it measures

- **Speed:** cycle time, split into coding, pickup, review and merge wait; time to first review;
  time to approval
- **Throughput:** PRs merged, PR size and lines merged, counting product code only (not lockfiles
  or generated files)
- **Review:** how many PRs get reviewed and approved, reviews per PR, comments, and how often work
  goes round again after review
- **Stability:** revert rate
- **Flow:** work in progress, aging open PRs, abandon rate

codeflow describes how work flows through a team. It does not rank people.

## Get started

You need Node.js 24 or later, git, and read access to the repos you want to measure.

```bash
git clone https://github.com/danielhill13/Code-Flow.git
cd Code-Flow
npm install
npm run build
gh auth login                                  # or: export GITHUB_TOKEN=...
npm run codeflow -- init --owner your-org      # or: --repo your-org/api; --org names it
npm run codeflow -- doctor                     # check the token and estimate the first sync
npm run codeflow -- sync                       # fetch PRs; stop and resume any time
npm run codeflow -- build                      # write codeflow-report.html
open codeflow-report-your-org.html
```

[docs/getting-started.md](docs/getting-started.md) walks through every step: token permissions,
what each command does, keeping the report current, and what to do when something goes wrong.

## Commands

| Command | What it does |
| ------- | ------------ |
| `init` | adds an org to the workspace (`codeflow.yml` and `orgs/<org>/`), creating it if needed |
| `migrate` | turns a single-file config from before workspaces into a workspace |
| `doctor` | checks the token and the repos the config selects, and estimates the first sync; read-only |
| `sync` | fetches PRs updated since `since`, then only what changed; resumable |
| `status` | what is stored, how the last sync went, and any branch that isn't measured but should be |
| `summary` | every metric for a period (`--period 2026-Q3`, `--percentile 75`, `--json`, `--explain`) |
| `pr` | how codeflow read one pull request, to check against GitHub |
| `rules` | an org's rules, where each came from and how many PRs it applies to; `rules test <file>` previews a draft |
| `export` | an org's people, groups and rules as a bundle (YAML, JSON, or CSV for teams) |
| `import` | a bundle or CSV into an org: checked as a whole first, `--dry-run` to preview, merge or replace |
| `build` | the report: one HTML file per org, with its data inside, that opens offline |
| `serve` | the report as a web app on this machine, with an org picker and a Setup tab to edit people, teams, groups and rules |

Every command takes `--org` to work on one org of several.

The report has six tabs, each answering one question: Overview (faster or slower?), Speed
(where does the time go?), Review (is review holding us up?), Flow (what's stuck right now?),
Compare (did the change work?) and Pull requests (which PRs are behind this number?). Every
number opens the PRs behind it. The view is in the URL, so a link can point at any tab,
selection or filtered list.

## Configuration

Each org's config says what to measure and how: organizations, users and single repos; teams
(people, with dates when someone moves), people with several logins, and groups of any kind
(products, areas: repos, teams and people), so the report can look at any team, group, repo or
person, or any mix; and the org's own rules: what counts, how its repos are read (branches,
product code) and how its people are treated (bots, internal), each scoped to the org, repos,
teams, groups or people. [docs/configuration.md](docs/configuration.md) covers every option.

codeflow counts each PR once, where it lands on a measured branch: by default each repo's
default branch. PRs into feature, release or `develop` branches, and promotions such as
`develop` → `main` → `prod`, aren't counted again. If a repo's work lands somewhere else, say
features into `develop`, `status` says so and prints the `branches:` line to measure it.

## Privacy

codeflow talks only to GitHub's API. What it fetches stays on your machine, in a `.codeflow/`
folder next to your config.

## How it works

[docs/architecture.md](docs/architecture.md) covers the design, including the measurement rules
every metric follows.

## Development

```bash
npm run check        # typecheck, lint, tests (including a sweep of every report view)
npm run report:dev   # the report with live reload, on the data your last sync stored
npm run build        # compile to dist/, only needed for publishing
```

## License

[MIT](LICENSE)
