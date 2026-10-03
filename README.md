# codeflow

Code flow metrics for GitHub: how pull requests move from first commit, through review, to merge.
Every number traces back to the pull requests behind it.

> **Early development.** Phases 0–2 of the [roadmap](docs/roadmap.md) are done: sync, and every
> metric below, in the terminal. The report comes next.

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

## Requirements

- Node.js 24 or later
- Read access to the repositories you want to measure, through a `GITHUB_TOKEN` or a logged-in
  [GitHub CLI](https://cli.github.com) (`gh auth login`). codeflow only reads.

## Try it

From a clone of this repository:

```bash
npm install
npm run codeflow -- init --repo usebruno/bruno
npm run codeflow -- doctor
npm run codeflow -- sync
npm run codeflow -- summary
npm run codeflow -- pr 9000
```

- `init` writes a `codeflow.yml`.
- `doctor` checks your token, lists the repos your config selects, and works out what the first
  sync will cost in time and API rate limit, from a dry run of the real sync query. It is
  read-only and spends a few rate-limit points.
- `sync` fetches every pull request updated since the config's `since` date, plus older ones still
  open. After that, each run fetches only what changed. You can stop it at any time (Ctrl-C), and
  the next run picks up where it stopped.
- `summary` shows every metric for the last complete month (or `--period 2026-Q3`), from local
  data. `--explain` defines each one, `--percentile 75` swaps the median for P75, and `--json`
  is for scripts.
- `pr` shows how codeflow read one pull request: its timeline, phases, size and reviews, ready
  to check against GitHub.
- `status` shows what is stored locally and how the last sync went, without going online.

## Configuration

`codeflow.yml` says what to measure: whole organizations or users, filtered by repo name, and
single repos. [codeflow.example.yml](codeflow.example.yml) shows every option.

## Privacy

codeflow talks only to GitHub's API. What it fetches stays on your machine, in a `.codeflow/`
folder next to your config.

## How it works

[docs/architecture.md](docs/architecture.md) covers the design, including the measurement rules
every metric follows.

## Development

```bash
npm run check   # typecheck, lint, tests
npm run build   # compile to dist/, only needed for publishing
```

## License

[MIT](LICENSE)
