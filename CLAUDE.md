# codeflow

Open-source tool that measures code flow (first commit → review → merge) for GitHub repos.

- Design and measurement rules: [docs/architecture.md](docs/architecture.md)
- What is built and what is next: [docs/roadmap.md](docs/roadmap.md)
- Why things are the way they are: [docs/decisions.md](docs/decisions.md)

## Commands

```bash
npm run check                # typecheck + lint + tests. Run before calling anything done.
npm run fix                  # Biome formatting and safe lint fixes
npm run codeflow -- doctor   # read-only GitHub check; needs a codeflow.yml (gitignored)
npm run codeflow -- sync     # fetch PRs into .codeflow/codeflow.db (gitignored); resumable
npm run codeflow -- status   # what is stored locally; no network
npm run codeflow -- summary  # metrics for the last complete month; --explain defines them
npm run codeflow -- pr 9000  # how one PR was read, to check against GitHub
node scripts/fixture.ts usebruno/bruno 9000 7719   # anonymized test fixtures from synced PRs
npm run build                # compile to dist/, to check the publish path
```

The validation repo is usebruno/bruno (public). `npm run codeflow -- init --repo usebruno/bruno`
sets it up.

## Rules

- Raw data is never edited. Metrics are pure functions of raw data plus config.
- One metric is one registry entry in `src/core`, holding its definition, help text and
  aggregation together. Aggregation lives only in `src/core`. Never add a second implementation
  (in the server, in SQL, in the UI) without the conformance suite.
- Null is not zero. Never coerce a missing value to 0 in a metric, chart or table.
- Each measurement rule in docs/architecture.md gets a test. Changing a rule means changing its
  test and adding a decision.
- Fixtures come from public repos only. Never commit tokens or private data.
- `CodeFlow_reference/` holds private notes from an earlier internal tool. It is gitignored. Read
  it for lessons, but never copy names, numbers or URLs from it into the repo.
- Keep this file to commands and rules. Status belongs in docs/roadmap.md; history belongs in git
  and docs/decisions.md.

## Conventions

- Node 24+, ESM. Node runs the TypeScript directly, so use erasable syntax only (no enums,
  namespaces or parameter properties), and import local files with their `.ts` extension.
- Tests sit next to the code as `*.test.ts`. Shared test builders live in `src/testing/`.
- Failures the user can fix throw `CodeflowError`, with a message saying what to do. The CLI
  prints it without a stack trace.
- Every GitHub call goes through `GitHubClient`, which counts calls and points. Queries select
  `rateLimit { cost }`.
- All SQL lives in `src/store/`. Schema changes are new entries appended to `migrations.ts`; never
  edit a migration that has shipped. Rows in `raw_prs` are only ever inserted.
- Test sync logic against `src/testing/fake-github.ts`, which reproduces GitHub's ordering and
  keyset paging, and a real in-memory `Store`.
- Bump `DERIVE_VERSION` in `src/core/facts.ts` whenever derive's logic changes what a fact holds:
  that re-derives every repo. Config changes need no bump; they're in the fingerprint already.
- A new metric is one entry in `METRICS` (`src/core/metrics.ts`). A per-PR value of null means
  "doesn't apply"; never return 0 for that.
- Keep dependencies few. Check Node's standard library before adding one.
