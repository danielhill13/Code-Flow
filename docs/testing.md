# Testing

Everything here runs offline: no test reaches GitHub, and none can use your own GitHub token.
You need Node 24 or later and a clone with `npm ci` done.

## Before you change anything

```bash
npm ci
npm run check     # typecheck, lint, unit and scenario tests: about 40 seconds
```

`npm run check` should pass on a fresh clone. Run it again before calling a change done. Before
opening a pull request, run everything CI runs:

```bash
npm run verify    # check, build, then the browser tests in Chromium
```

The first `verify` downloads Chromium for Playwright (about 100 MB, once).

## Commands

| Command | What it runs | Time |
| ------- | ------------ | ---- |
| `npm run check` | typecheck, lint, and every Vitest test (unit and scenarios) | ~40 s |
| `npm run verify` | `check`, `build`, then `test:e2e` | ~1.5 min |
| `npm test` | every Vitest test | ~30 s |
| `npm run test:unit` | the tests beside the code, in `src/` | ~10 s |
| `npm run test:scenarios` | the CLI run end to end against a fake GitHub, in `test/` | ~20 s |
| `npm run test:watch` | unit tests, again on every save | |
| `npm run test:e2e` | the report and `codeflow serve` in a real browser | ~30 s |
| `npm run coverage` | every Vitest test, with a coverage report in `coverage/index.html` | ~40 s |

Coverage counts code run inside the test process. The CLI commands in `src/cli/` run in the
scenarios' child processes, which it can't see, so they show as uncovered there.

To run one file or one test:

```bash
npx vitest run src/core/derive.test.ts
npx vitest run -t "TC-104"
npx playwright test test/e2e/serve.spec.ts
npx playwright test -g "TC-604" --headed
```

## The layers

| Layer | Where | What it proves |
| ----- | ----- | -------------- |
| Unit | `src/**/*.test.ts` | Each module on its own: derive, metrics, aggregation, rules, groups, config, the store, sync's paging against `FakeGitHub`, the server's API and its size budgets, the scheduler. |
| Report sweep | `src/report/sweep.test.tsx` | Every tab at every scope, window, statistic and filter renders without `undefined`, `NaN` or `Infinity`, and shows core's numbers. In happy-dom, fast. |
| Scenarios | `test/scenarios/` | The real `codeflow` CLI, as its own process, against a fake GitHub server: what a person typing the commands sees. |
| Browser | `test/e2e/` | The built report opened from disk, and `codeflow serve`, in Chromium, driven as a person would: clicks, forms, downloads, phone width. |
| Guards | `test/catalog.test.ts` | Every measurement rule has a test, and the catalog below matches the tests there are. |

### The fake GitHub and the Acme org

Scenario and browser tests run against `src/testing/github-server.ts`, a small HTTP server that
answers the GraphQL queries codeflow sends, pages PRs the way GitHub does and refuses any token
but its own. It serves a made-up org from `src/testing/scenario.ts`, **acme-co**:

- `api` and `web`: a PR every other day for 25 weeks, by four staff and one outside contributor
  from a fork. Most are reviewed, some have change requests, some merge unreviewed, a few are
  chores, a few are abandoned, and the newest are still open (some as drafts).
- A Dependabot PR (not counted), a release branch promoted into `main` (not counted), a revert
  of an earlier PR, and a forgotten PR from months ago that only a stale-bot has touched since
  (stale).
- `legacy`: early work merged into `main`, then everything into `develop`, so codeflow should
  warn that the repo's work lands on a branch it doesn't measure.
- `attic`: archived, so discovery should skip it.

`src/testing/ado-server.ts` does the same for Azure DevOps's REST API, serving **contoso**'s
project Platform (`contosoRepos()`): two repos and a disabled one, PRs by the same people with
comment threads, votes (approve, wait for author), pushes after review, a build service's PR,
chores, abandoned and open PRs. `countedAdoMerges()` is its oracle.

The PRs are dated relative to today, so every window has data whenever the tests run.
`countedMerges()` works out, the plain way, how many PRs codeflow should count in a period; the
scenarios compare `summary` with it. Syncing against the fake takes about a second, because
codeflow doesn't pace requests to an API on this machine.

To try the CLI against the same data by hand, see how `test/scenarios/support.ts` sets up a
workspace: `init`, then point `github.api_url` in the org's `org.yml` at the fake server.

## Measurement rules

Each of the twelve measurement rules in [architecture.md](architecture.md#measurement-rules)
has at least one test whose title ends with its tag, such as `[rule 4]`. The guard fails if a
rule has none. Changing a rule means changing its tests and adding a decision.

```bash
npx vitest run -t "rule 9"     # the tests for one rule
```

## Test-case catalog

The behaviours a person relies on, each automated by one test whose title starts with its ID.
The guard keeps this table and the tests in step: a new scenario or browser test needs a row
here.

### The CLI, first run (`test/scenarios/first-run.test.ts`)

| ID | Behaviour |
| -- | --------- |
| TC-101 | `init` writes a workspace and the org's folder of config files |
| TC-102 | `doctor` checks the token and repos, skips archived ones, estimates the first sync, and stores nothing |
| TC-103 | `sync` stores every PR since `since`, reporting each repo |
| TC-104 | A second `sync` fetches only what changed |
| TC-105 | `status` shows what is stored and flags work landing on an unmeasured branch, naming the file to edit |
| TC-106 | `summary` counts what a person counting by hand would, and shows no number it can't back |
| TC-107 | `pr` explains how one PR was read: a bot's, a promotion, a revert, by number or by its GitHub address |
| TC-108 | `build` writes one report file holding the org's data |
| TC-109 | A config change takes effect without a new sync |
| TC-110 | `rules` lists the org's rules, and `rules test` previews a draft without saving it |
| TC-111 | Stale PRs are counted apart from open ones, a bot's nudge doesn't revive one, and the window is the org's |
| TC-112 | `run` syncs and then builds, for a scheduler such as cron |
| TC-120 | `prune` lists repos stored but no longer selected by any source, and `--yes` removes their data |

### GitHub and Azure DevOps together (`test/scenarios/azure-devops.test.ts`)

| ID | Behaviour |
| -- | --------- |
| TC-113 | `doctor` checks both hosts and lists what each selects |
| TC-114 | `sync` reads both hosts into one database, and counts both as one company |
| TC-115 | A person's PRs on either host are theirs, and their team's |
| TC-116 | `pr` explains an Azure DevOps PR from its address, and leaves a build service's out |
| TC-117 | An org only on Azure DevOps syncs without a GitHub token, and a missing Azure DevOps token is explained |
| TC-118 | `people` lists both hosts' accounts and suggests which are one person |
| TC-119 | Merging puts a person's Azure DevOps PRs on their team, with no new sync |
| TC-121 | `sync --refetch` clears a repo's stored PRs and fetches them all again; a size comes from Azure DevOps's wrapped diff answer |
| TC-122 | A PR size Azure DevOps won't give is unknown, never zero, and `pr` and `doctor` say what Azure DevOps answered |
| TC-123 | A later sync checks each open Azure DevOps PR with one request, and reads again only one that moved |

### Orgs, config and errors (`test/scenarios/orgs.test.ts`)

| ID | Behaviour |
| -- | --------- |
| TC-201 | `sync` and `build` cover every org, each into its own database and report, naming no other org |
| TC-202 | A command about one org asks which, and names the orgs there are |
| TC-203 | `export` then `import` moves teams and rules to another org, previewed first with `--dry-run` |
| TC-204 | Teams import from a spreadsheet's CSV |
| TC-205 | An invalid import or config is refused, naming the file and the fix, writing nothing |
| TC-206 | No token, a rejected token, and GitHub unreachable each say what to do, without a stack trace |
| TC-207 | Commands that need data say to sync first |
| TC-208 | `migrate` turns a single-file config into a workspace, keeping its comments, data and numbers |

### `codeflow serve` over HTTP (`test/scenarios/serve.test.ts`)

| ID | Behaviour |
| -- | --------- |
| TC-301 | Each org has its own address, and an unsynced org says so |
| TC-302 | Answers for one org hold nothing of another's |
| TC-303 | An edit through the app writes the org's file, keeps its comments, and applies at once |
| TC-304 | A save based on a file someone changed meanwhile is refused |
| TC-305 | A sync running beside `serve` shows up without a restart |
| TC-306 | `serve` syncs an org on its own schedule, reports when it did and will next, and shows the new data |
| TC-307 | The org's settings (schedule, stale window, people views) are edited through the app and apply at once |

### The static report in a browser (`test/e2e/report.spec.ts`)

| ID | Behaviour |
| -- | --------- |
| TC-501 | Opens offline from the file, with its org, its data-through date and six tabs |
| TC-502 | Every tab, window and statistic shows numbers, never broken values |
| TC-503 | A headline number opens the PRs behind it, and a PR opens how it was read |
| TC-504 | The whole view lives in the URL: reload or share it and it comes back |
| TC-505 | Picking a team narrows every number to it, and back |
| TC-506 | The theme the viewer picks stays picked |
| TC-507 | At phone width, no tab scrolls sideways |
| TC-508 | Stale PRs are shown on Flow apart from those open now, and listed on request |
| TC-509 | Changes read as a neutral increase or decrease, in one unit |

### Setup in the served app (`test/e2e/serve.spec.ts`)

| ID | Behaviour |
| -- | --------- |
| TC-601 | The org picker switches orgs, and each shows nothing of the other |
| TC-602 | A team added in Setup, its people searched for and ticked in a list, is in the report straight away, and the file keeps its comments |
| TC-603 | A team that breaks a rule is refused with the reason, and nothing is saved |
| TC-604 | A rule shows what it would change as it is written, then changes the numbers; turning it off restores them |
| TC-605 | Export downloads a bundle, and import previews before it applies |
| TC-606 | A save over a file changed meanwhile is refused, and says to reload |
| TC-607 | An org not synced yet offers only its setup |
| TC-608 | Org settings change the stale window and turn people views off |
| TC-609 | The header says how fresh the data is and when it syncs next |

### First steps and Setup in the browser (`test/e2e/welcome.spec.ts`)

| ID | Behaviour |
| -- | --------- |
| TC-610 | An empty folder becomes a synced org, set up entirely in the browser: connect, preview, create, sync, report |
| TC-611 | The org's repos, branches, bots and paths are edited in Setup, land in org.yml, and Sync now runs |
| TC-612 | An Azure DevOps project becomes an org the same way, beside the GitHub one |
| TC-613 | A suggested match is merged in a click, shown as one person, and can be separated (`test/e2e/people.spec.ts`) |
| TC-615 | The accounts table is searched by login, name or person, and sorted by any column (`test/e2e/people.spec.ts`) |
| TC-614 | A source codeflow can't read says why in step 1, and can be removed to start without it; a pasted Azure DevOps address fills organization and project |

## Writing tests

- **Unit tests** sit beside the code as `*.test.ts`. Build test data with `src/testing/factories.ts`
  (`prModel`, `prFact`, `ghPayload`, …) and override only what the test is about.
- **Sync logic** is tested against `src/testing/fake-github.ts` and a real in-memory `Store`.
- **A user-visible behaviour** gets a scenario or browser test with the next free `TC-` ID, and a
  row in the catalog above.
- **Real PR data** comes only from public repos, anonymized with `scripts/fixture.ts`. Never
  commit tokens or private data.
- **Null is not zero** in tests too: assert `null` for a value that doesn't apply.
- Keep tests independent of the clock and the time zone: date data relative to now, as the Acme
  org does, or pass `asOf` explicitly.

## When a test fails

- **A Vitest failure** prints the assertion and the values. Scenario failures include the
  command's whole output.
- **A Playwright failure** saves a screenshot and a trace in `test-results/`. Open the trace with
  `npx playwright show-trace test-results/<test>/trace.zip` to step through it, or rerun with
  `--headed` or `--ui` to watch.
- **`Executable doesn't exist` from Playwright**: run `npx playwright install chromium`.
- **The browser or serve tests can't find the report page**: they build it if it's missing; if
  that fails, run `npm run build:report` and read its error.
- **A test passes alone but fails in the full run**: it probably depends on another test's
  state or on timing. Wait for what the page says (`main[data-ready=true]` and its `data-view`),
  never for a fixed time.

## Continuous integration

`.github/workflows/ci.yml` runs `npm run check` and `npm run build` on every push and pull request,
then the browser tests, uploading Playwright's report when they fail.
