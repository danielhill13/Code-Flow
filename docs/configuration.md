# Configuration

Everything on this page can be set in the web app: `npm start`, then the first steps for a new
org, and the **Setup** tab for everything else. The web app writes these same files, keeping
their comments, so you can switch between the two whenever you like. This page is for those who
prefer the files, and describes every option.

## Workspace and orgs

A workspace, `codeflow.yml` by default (or any file passed with `--config`), lists the orgs
codeflow measures. An org is a tenant: one or more GitHub organizations and repos (Azure DevOps
and Jira later), with its own people, teams, rules and data. Nothing is shared between orgs.

```yaml
# codeflow.yml
orgs:
  acme: {}                    # config in orgs/acme/, data in .codeflow/acme/
  client-b: { dir: clients/b } # config somewhere else
```

Each org is a folder of YAML files:

| File | Holds |
| ---- | ----- |
| `org.yml` | `sources`, `since`, `github`, `data_dir`, `branches`, `promotions`, `bots`, `paths` |
| `people.yml` | `people` |
| `groups.yml` | `teams`, `groups` and `products` |
| `rules.yml` | `rules` |

`codeflow init --org <name>` adds an org. Org names use lowercase letters, digits, `-` and `_`.

A single `codeflow.yml` holding everything below, as before workspaces, still works as one org;
`codeflow migrate` turns it into a workspace.
[codeflow.example.yml](../codeflow.example.yml) shows every option in that single-file form.

## The options

Only `sources` and `since` are required. Everything else has a default that suits a repo whose
work merges into its default branch.

Changing anything except `sources`, `since` and `github` takes effect on the next `summary`,
`status` or `build`, with no new sync: codeflow keeps every PR's raw data and recomputes from it.

## sources

What to measure, on GitHub, Azure DevOps or both: one org can span them, as one company, and
every number covers all of its repos. Mix organizations, users, projects and single repos; a repo
selected twice counts once.

```yaml
sources:
  - owner: your-org              # GitHub: every repo an organization or user owns
    include: ["*"]               # repo-name patterns, case-insensitive (default: all)
    exclude: ["sandbox-*"]       # applied after include
    archived: false              # also measure archived repos (default: no)
    forks: false                 # also measure forks (default: no)
  - repo: other-org/tool         # GitHub: one repo, even if archived or a fork
  - ado: contoso                 # Azure DevOps: an organization (dev.azure.com/contoso)
    project: Platform            # one project (default: every project the token can see)
    include: ["billing", "portal-*"]
    exclude: ["*-spike"]
    forks: false
```

Azure DevOps repos are named `organization/project/repo` in the report, such as
`contoso/Platform/billing`, so patterns elsewhere (branches, groups, paths) can match them like
GitHub's: `contoso/Platform/*`. Disabled and empty Azure DevOps repos are always left out.

`codeflow doctor --all` lists every repo a source sees, and why any were left out.

## since

```yaml
since: 2025-10-01
```

The first day to measure. Sync fetches every PR updated on or after it, plus older PRs that are
still open. No number is shown for any time before it, because that stretch would hold only the
older PRs that happened to change later. Moving it earlier extends the next sync; moving it later
needs no sync.

## github

```yaml
github:
  api_url: https://api.github.com      # GitHub Enterprise Server: https://HOST/api/v3
  token_env: GITHUB_TOKEN              # the variable to read the token from
```

codeflow reads the variable `token_env` names, then `GH_TOKEN`, then the GitHub CLI's login. See
[getting-started.md](getting-started.md#2-let-codeflow-read-your-code) for the permissions a
token needs.

## azure_devops

```yaml
azure_devops:
  url: https://dev.azure.com           # Azure DevOps Server: its address, https://HOST/tfs
  token_env: AZURE_DEVOPS_TOKEN        # the variable to read a personal access token from
```

codeflow reads the variable `token_env` names, then `AZURE_DEVOPS_EXT_PAT` (what the Azure CLI's
DevOps extension uses), then a sign-in with the Azure CLI (`az login`). A personal access token
needs **Code (Read)**, and **Project and Team (Read)** for a source that names no `project`
(listing an organization's projects needs it). Make it in the organization you measure, or for
all accessible organizations.

Azure DevOps can't list PRs by when they last changed, so each sync reads every open PR again,
plus those closed since the last sync; the first sync reads every PR created since `since`. Each
PR takes about five requests (its threads, pushes, commits, files and line counts). codeflow
sends them one at a time, at most two a second, and slows down further when Azure DevOps's
rate-limit headers say its budget is running low, or waits as long as it asks when it throttles.
A repo with 1,000 PRs a year takes about 40 minutes the first time and a few minutes a day after.

codeflow asks for API version 7.1. An older Azure DevOps Server that doesn't know it says so,
and codeflow steps down to 7.0, then 6.0.

## data_dir

```yaml
data_dir: .codeflow
```

Where the org's data is kept, relative to its folder. By default each org has its own,
`.codeflow/<org>/` next to the workspace (for a single-file config, `.codeflow/`). Don't point
two orgs at the same place: they would share one database.

## branches and promotions

codeflow counts each PR once, where it lands on a measured branch. By default that is each
repo's default branch, plus any branch that was the default before, so a rename from `master` to
`main` keeps its history.

```yaml
branches:
  your-org/legacy-app: [develop]        # owner/name glob → the branches to measure
  "your-org/*-service": [main, prod]    # hotfixes that go straight to prod count too
```

PRs into other branches (features, releases, stacked PRs) are not counted. Neither is a PR whose
head is a long-lived branch of the same repo: it promotes work that was already counted, such as
`develop` → `main` → `prod`. `promotions` lists those long-lived branch names; setting it
replaces the defaults:

```yaml
promotions: [main, master, trunk, develop, development, dev, staging, stage, production, prod,
  release, "release/*", "releases/*"]
```

If most of a repo's recent work merges into a branch that isn't measured, `status`, `summary`
and `doctor` say so and print the `branches:` line that would fix it.

## bots

```yaml
bots:
  accounts: [ci-helper]                 # more logins to treat as bots (GitHub's own always are)
  reviewers: [coderabbitai]             # bots whose reviews count as review (default: none)
  include_prs: false                    # count PRs that bots open (default: no)
  ignore_bodies: ["^Thanks for your contribution"]   # comments matching these never count
```

By default, bot PRs aren't counted, and bot reviews and comments don't count as review.

## sync_every, stale_after_days, people_views, size_target_lines and churn_window_days

How the org's data is kept current and how its report reads it. All are also in the web app,
under Setup › Settings.

```yaml
sync_every: 24h          # how often `codeflow serve` syncs: 30m, 6h, 24h, 7d … or off
stale_after_days: 90     # an open PR with no activity for longer is stale
people_views: true       # false: no picking people, no reviewers by name
size_target_lines: 400   # merged PRs at or under this many product lines are within the target
churn_window_days: 30    # product files changed again within this many days of merging
```

- **`sync_every`** (default `24h`, at least `15m`) applies while `codeflow serve` runs: it syncs
  each org when its last clean sync is that old, one org at a time, and tries a failed sync
  again after half an hour. `off` leaves syncing to you (`codeflow sync`, or `codeflow run`
  from cron).
- **`stale_after_days`** (default 90): an open PR that nobody has pushed to, reviewed, commented
  on or asked for review on for longer is **stale**. Bots don't count, so a stale-bot's nudge
  doesn't revive a PR. Stale PRs are counted apart from the PRs open now: Flow shows them on a
  line of their own, the PR list has a Stale set, and `summary` prints them separately.
- **`people_views`** (default `true`): `false` removes people from the selection picker (a link
  that names a person shows everyone instead), and review load counts reviewers without naming
  them. Teams, groups and repos are unchanged, and the PR list still shows each PR's author.
- **`size_target_lines`** (default 400): Speed shows the share of merged PRs at or under it, in
  lines of product code, beside the size bands.
- **`churn_window_days`** (default 30): a merged PR is **changed again soon** when a later PR
  merged into the same branch changes one of its product files within this many days, and
  **followed up by the author** when that later PR is the author's own. Review shows both, for
  PRs old enough to tell, beside **changed after review** (lines pushed after the first review;
  GitHub only). See decision D44.

## paths

What counts as product code, for PR size and lines merged. Every changed file falls into one
bucket: `product`, `test`, `docs`, `generated`, `vendored` or `lockfile`. Only product lines
count. Built-in rules recognize common lockfiles, vendored and generated folders, tests and docs;
your rules run first, and the first match wins.

```yaml
paths:
  - { match: "packages/*-tests/**", bucket: test }
  - { match: ["schema/**", "*.graphql"], bucket: generated, repos: [your-org/api] }
```

## people

Optional. Anyone who opens or reviews a PR is measured as their GitHub login without being
listed. List people when one person uses several logins, or when config should say something
about them:

```yaml
people:
  ana:
    name: Ana Ruiz                    # shown in the report
    github: [ana-r, ana-old-login]    # every login they use (default: the key)
    ado: [ana@acme.com]               # their Azure DevOps sign-ins, usually an email address
  deploy:
    github: [deploy-svc]
    bot: true                         # a service account: PRs not counted, reviews not review
  jo:
    internal: true                    # count as internal whatever GitHub says
```

Teams, groups and the report then use the person, not the login: a review from Ana's old
account counts as Ana's, and her own second account can't review her PRs. With `ado`, her Azure
DevOps PRs are hers too, and count for her team like her GitHub ones. A login may belong to one
person only. Someone with no GitHub account at all gets `github: []` and their `ado` sign-ins;
otherwise their key would stand in as a GitHub login.

### Merging accounts across GitHub and Azure DevOps

People who work on both hosts have an account on each. You rarely need to type them in:

- **In the web app**, Setup › People lists every account the PRs show, on both hosts, and
  suggests which look like one person: the part of an address before the @ is a GitHub login
  (likely the same), or the name Azure DevOps shows matches one (possibly). Merge a suggestion in
  a click, or tick any accounts and merge them into one person. Separate undoes it.
- **From the command line**, `codeflow people` lists accounts not yet in a person and the
  suggestions, each with the command that merges it:

```bash
npm run codeflow -- people                                   # accounts and suggested merges
npm run codeflow -- people merge ana ana@acme.com            # one person, both accounts
npm run codeflow -- people merge dlee devon.lee@acme.com --as devon --name "Devon Lee"
```

Either way the merge is written to `people.yml`, checked like any other edit, and the report uses
it at once, with no new sync.

## teams

Who works together. A PR belongs to its author's team on the day it opened.

```yaml
teams:
  Platform:
    people: [mika, { login: devon, to: 2026-05-31 }]
  Payments:
    people:
      - ana
      - { login: devon, from: 2026-06-01 }       # devon moved to Payments in June
      - { login: mika, secondary: true }         # listed here; mika's PRs count for Platform
```

- Members are person keys or logins.
- A person is in one team on any given day, so team numbers add up to the total. codeflow
  refuses a config that puts someone in two teams at once, unless one membership is `secondary`.
- Dates are inclusive, `YYYY-MM-DD`, and either can be left out.
- PRs by people in no team go to "No team", which includes outside contributors.
- Team members count as internal contributors, whatever GitHub reports about them.

## groups

Everything else you want to look at by: products, areas, programs, initiatives. A group has a
`kind` (one lowercase word, `group` by default) and holds repos (globs), teams and people:

```yaml
groups:
  Checkout:
    kind: product
    repos: ["your-org/cart-*", your-org/payments-api]
    teams: [Payments]                 # Payments' PRs in any repo
  Mobile:
    kind: area
    people: [mika, devon]
```

- A PR belongs to every group its repo, team or author is in. Groups may overlap: the report
  notes how many PRs count for more than one, and totals still count each PR once.
- Each kind is its own breakdown in the report ("Product", "Area"), and PRs in no group of a
  kind go to its catch-all: "No product", "No area".
- Selecting groups of different kinds narrows to PRs in both (product Checkout *and* area
  Mobile); several groups of one kind widen (Checkout *or* Cart).

`products:` is shorthand for groups of kind `product`:

```yaml
products:
  Checkout: { repos: ["your-org/cart-*"], teams: [Payments] }
```

## rules

Each org can have its own rules, in `rules.yml`. A rule says **where** it applies (`scope`),
optionally **which PRs** (`when`), and **what it does** (`then`):

```yaml
rules:
  - id: no-chores
    description: Housekeeping PRs aren't delivery.
    scope: { teams: [Platform] }          # leave out to cover the whole org
    when: { labels: [chore], title: "^chore" }
    then: { count: false }

  - id: legacy-branches
    scope: { repos: ["your-org/legacy-*"] }
    then: { measured_branches: [develop] }

  - id: deploy-account
    scope: { people: [deploy-svc] }
    then: { bot: true }
```

**Where** (`scope`): `repos` (globs), `teams`, `groups`, `people` (keys or logins). Every field
given must match; within one, any value. With no scope, a rule covers the whole org.

**Which PRs** (`when`, for rules about what counts): `labels` (any of them), `title` (a
regular expression, ignoring case), `base` and `head` (branch globs), `author_association`
(GitHub's `MEMBER`, `CONTRIBUTOR`, `NONE`…), `from_fork`, `draft`, `author_bot`.

**What it does** (`then`). A rule's effects are all of one kind:

| Kind | Effect | Scope it can have |
| ---- | ------ | ----------------- |
| What counts | `count: false` leaves the PR out, `count: true` counts it despite a bot author or another rule | any, with `when` |
| | `internal: true` or `false` decides internal or external | any, with `when` |
| | `ignore_comments: [regex]`: matching comments and review bodies don't count | any, with `when` |
| Repo rules | `measured_branches: [globs]`: the branches whose PRs count | `repos` only |
| | `promotion_branches: [globs]`: same-repo heads that make a PR a promotion | `repos` only |
| | `paths: [{ match, bucket }]`: what counts as product code | `repos` only |
| People rules | `bot: true`: their PRs aren't counted and their reviews aren't review | `people` only |
| | `bot_reviews_count: true`: a bot whose reviews count as review | `people` only |

**Which rule wins.** Each effect is decided on its own. Rules apply from the least specific
scope to the most (the whole org, then groups, teams, repos, people), so a more specific rule
wins, and among rules of the same level the later one does. `enabled: false` keeps a rule but
skips it. Branches always decide first: no rule counts a PR into a branch that isn't measured,
so a change is never counted twice; change `measured_branches` instead.

**The older keys are rules too.** `branches`, `promotions`, `bots`, `paths` and what `people`
says about a person still work, as shorthand for rules that apply before `rules.yml`'s. Their
ids start with `config:`, which ids in `rules.yml` can't.

**Checking rules.**

```bash
npm run codeflow -- rules --org your-org              # every rule, where it came from, PRs it applies to
npm run codeflow -- rules test draft.yml --org your-org  # what a draft rules file would change
```

`rules test` derives everything again with the draft in place of `rules.yml` and lists the PRs
that would stop or start counting and the authors who would change sides. It saves nothing.
Every PR records the rules that applied to it: `codeflow pr` and the report's side panel show
them, and a PR a rule leaves out says which rule.

## Export and import

An org's people, groups (teams included) and rules can be exported as a **bundle**, and
imported into the same org or another one: to copy a setup between orgs, keep a backup, or
bring teams in from another system.

```bash
npm run codeflow -- export --org acme -o acme.yml                  # people, groups, rules
npm run codeflow -- export --org acme --only rules -o rules.json   # just the rules, as JSON
npm run codeflow -- export --org acme --format csv -o teams.csv    # teams, one member a row
npm run codeflow -- import acme.yml --org client-b --dry-run       # what would change
npm run codeflow -- import acme.yml --org client-b                 # do it
npm run codeflow -- import teams.csv --org acme --mode replace     # teams from a spreadsheet
```

- **What moves.** `--only` takes any of `people`, `groups`, `rules` and `settings` (org.yml:
  sources, dates and the older rule keys). By default `settings` stays behind, since what an
  org measures is its own.
- **Merge or replace.** `--mode merge` (the default) adds and updates people, teams, groups and
  rules by name or id, and removes nothing. `--mode replace` makes each part in the bundle
  replace the org's whole part.
- **Checked first.** An import is validated as a whole, with the org's existing config, before
  anything is written: a person put in two teams at once, a rule naming a team that doesn't
  exist, a malformed pattern. Problems name the file they would be in. `--dry-run` lists what
  would change and writes nothing.
- **Comments stay.** Imports change the org's YAML files entry by entry, so comments on entries
  they don't touch survive. Rules keep their order from the bundle; a rule that is unchanged
  keeps its comments and layout.
- **CSV** holds teams, one member per row, with a header: `team,login,from,to,secondary,name`
  (only `team` and `login` are required). A `name` fills in the person's display name.
- **The format.** A bundle is YAML or JSON with `codeflow: 1` at the top, then any of
  `people`, `teams`, `groups`, `products`, `rules` and `settings`, in the same form as the
  org's files. [schema/codeflow-bundle.schema.json](schema/codeflow-bundle.schema.json) is its
  JSON Schema, for editors and for tools that produce bundles. Bundles never hold tokens: config
  names the environment variable a token is in, never the token.

## Editing in the web app

`codeflow serve` (see [getting-started](getting-started.md#8-or-run-it-as-a-web-app)) has a
Setup tab with the same parts: People, Teams, Groups, Rules, Settings (`sync_every`,
`stale_after_days`, `people_views`), and Import & export. It writes the files described above,
so both ways of editing can be mixed. Each save is checked as a whole, as an import is, and
refused with the reason if the org would be invalid, or if the file changed since the page read
it. The rest of `org.yml` (sources, dates, the older rule keys) is edited by hand.

"No team", and "No" followed by a kind ("No product", "No area"), are reserved for the report's
catch-alls.
