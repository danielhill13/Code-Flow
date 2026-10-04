# Contributing

Thanks for helping. Before you change anything:

```bash
npm ci
npm run check     # typecheck, lint, unit and scenario tests; should pass on a fresh clone
```

Then make your change, add or update its tests, and before opening a pull request:

```bash
npm run fix       # format and safe lint fixes
npm run verify    # everything CI runs, including the browser tests
```

- [docs/testing.md](docs/testing.md): how the tests are organized, how to run one, the test-case
  catalog, and what to do when one fails.
- [docs/architecture.md](docs/architecture.md): the design and the measurement rules every change
  must keep.
- [docs/decisions.md](docs/decisions.md): why things are the way they are. A change to a
  measurement rule needs a new decision.

Test data comes only from public repos, or the made-up Acme org in `src/testing/scenario.ts`.
Never commit tokens or private data.
