# codeflow

Code flow metrics for GitHub: how pull requests move from first commit, through review, to merge.
Every number traces back to the pull requests behind it.

> **Early development.** Phase 0 of the [roadmap](docs/roadmap.md) is done: configuration and
> `codeflow doctor`. Syncing and the report come next.

## What it measures

- **Speed:** cycle time, split into coding, pickup, review and merge wait; time to first review;
  time to approval
- **Throughput:** PRs merged, PR size and lines merged, counting product code only (not lockfiles
  or generated files)
- **Review:** how many PRs get reviewed and approved, comments per PR, review rounds
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
```

`init` writes a `codeflow.yml`. `doctor` checks your token, lists the repos your config selects,
and works out what the first sync will cost in time and API rate limit. It gets that cost from a
dry run of the real sync query. `doctor` is read-only and spends a few rate-limit points.

## Configuration

`codeflow.yml` says what to measure: whole organizations or users, filtered by repo name, and
single repos. [codeflow.example.yml](codeflow.example.yml) shows every option.

## Privacy

codeflow talks only to GitHub's API, and keeps what it fetches on your machine.

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
