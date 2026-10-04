# Getting started

Four steps, about five minutes, then the first sync runs while you set up teams. Everything after
step 2 happens in your browser.

## 1. Install

You need [Node.js 24 or later](https://nodejs.org) (`node --version` to check) and git.
codeflow runs on macOS, Linux and Windows and needs no database server.

```bash
git clone https://github.com/danielhill13/Code-Flow.git
cd Code-Flow
npm ci
```

## 2. Let codeflow read your code

codeflow only reads, from GitHub, Azure DevOps or both. One org can measure repos on each, as one
company.

**GitHub.** The easiest way, if you use the [GitHub CLI](https://cli.github.com):

```bash
gh auth login
```

Or make a read-only token and put it in `GITHUB_TOKEN` before starting codeflow. On GitHub:
Settings › Developer settings › Fine-grained tokens; choose the organization that owns the repos,
and grant read-only **Contents**, **Pull requests** and **Metadata**. Nothing else.

```bash
export GITHUB_TOKEN=github_pat_...
```

**Azure DevOps.** Make a personal access token (User settings › Personal access tokens) in the
organization you'll measure, with **Code (Read)** and **Project and Team (Read)**, and put it in
`AZURE_DEVOPS_TOKEN` in the terminal you start codeflow from. Or sign in with the
[Azure CLI](https://learn.microsoft.com/cli/azure/): `az login`.

```bash
export AZURE_DEVOPS_TOKEN=...
```

In PowerShell on Windows:

```powershell
$env:AZURE_DEVOPS_TOKEN = "..."
```

Set it before `npm start`: codeflow can't see a variable set after it started, so set one later
and stop codeflow (Ctrl-C) and start it again.

codeflow never writes a token into its files. The token must belong to someone who can see the
repos. codeflow paces its Azure DevOps requests (at most two a second, slower when Azure DevOps
says so), so a sync never runs into its rate limits.

## 3. Start it

```bash
npm start
```

Your browser opens codeflow's first steps. If it doesn't, open <http://localhost:4317>.

1. **Connect to your code.** It shows whether codeflow can read GitHub and Azure DevOps, and how
   to fix it if not. For GitHub Enterprise Server or Azure DevOps Server, open the link under
   each and give its address.
2. **Choose what to measure:** a GitHub organization or user, single GitHub repos, an Azure
   DevOps organization or project, or any mix, and from which day. "Show what this measures"
   lists the repos, the ones left out and why, and for GitHub how long the first sync will take.
3. **Create the org and sync.** The first sync runs in the background; a repo with 2,500 PRs a
   year takes about 25 minutes, most take a few.

When it's done, open the report. Add more orgs from the org picker at the top (Add an org…).

## 4. Set it up

Everything an org can be told is in the **Setup** tab, saved to its config files:

| Section | What it holds |
| ------- | ------------- |
| Repos | what the org measures, on GitHub and Azure DevOps, and from which day |
| Branches | which branches count, with a one-click fix when a repo's work lands on `develop` |
| Bots | service accounts, bots whose reviews count, boilerplate comments to ignore |
| Paths | which files are tests, docs or generated, so PR size counts product code |
| People | every account on both hosts, suggested matches to merge into one person, and staff GitHub doesn't show as staff |
| Teams | who works together, with dates when someone moves |
| Groups | products, areas or any grouping of repos, teams and people |
| Rules | what counts: leave out chores, count a repo's `develop`, and more, with a live preview |
| Sync | when it last synced and next will, and Sync now |
| Settings | how often to sync, when a PR is stale, person-level views, the connections |
| Import & export | copy a setup between orgs, or bring teams in from a spreadsheet |

Teams are what make the report most useful: with them, every number can be looked at per team.

## Check the first numbers

After the first sync, check a few PRs you know against their host, especially on Azure DevOps,
whose reviews codeflow reads from votes and comment threads:

```bash
npm run codeflow -- pr https://github.com/your-org/api/pull/123
npm run codeflow -- pr https://dev.azure.com/your-org/Project/_git/repo/pullrequest/456
```

Each shows the timeline codeflow read (opened, first review, approval, merge), who reviewed, how
many rounds, and whether the PR counts and why. The side panel in the report shows the same. If
something looks wrong, `--raw` prints exactly what the host returned for that PR, which is what
an issue report needs (it holds titles and names: look before sharing).

Then Setup › People: merge the GitHub and Azure DevOps accounts of people who use both, so their
work counts as one person's, and put people into teams.

## Keeping it current

While codeflow runs, it syncs every org once a day (Setup › Settings changes how often), and the
page picks up new data by itself. Leave it running, or start it when you want fresh numbers.

To run it without a terminal open, a scheduler can start `npm start` at login, or run
`npm run codeflow -- run` (sync, then build a report file) on a schedule:

```bash
0 6 * * * cd /path/to/Code-Flow && npm run codeflow -- run >> codeflow.log 2>&1
```

codeflow listens only on this machine and has no sign-in yet, so don't put it on a shared
network.

## A report to send

The web app is the light way to read the report: each view loads as you move around. To send
someone a snapshot that opens offline, with no server, build one file per org:

```bash
npm run codeflow -- build
```

It writes `codeflow-report-<org>.html`. The file carries every PR, so for a large org it is a few
megabytes.

## Prefer the command line or the files?

Everything the web app does, the command line and the files do too. The files are plain YAML:
`codeflow.yml` lists the orgs, and `orgs/<org>/` holds `org.yml` (what to measure),
`people.yml`, `groups.yml` and `rules.yml`. Edit them by hand whenever you like; the web app
picks up the change. [configuration.md](configuration.md) describes every option.

| Command | What it does |
| ------- | ------------ |
| `init --owner your-org` | adds an org that measures every repo of `your-org` (`--ado contoso/Platform` for Azure DevOps) |
| `doctor` | checks the token and repos, and estimates the first sync |
| `sync` | fetches PRs; stop and resume any time |
| `summary` | every metric for the last complete month |
| `pr 123` | how codeflow read one PR, to check it against GitHub |
| `build` | the report as a file that opens offline |
| `run` | `sync`, then `build` |
| `prune` | lists repos stored but no longer measured; `--yes` removes their data |
| `sync --refetch <repos>` | clears those repos' stored PRs and fetches them all again |
| `serve` | the web app (`npm start` builds the page and opens it) |

Run them as `npm run codeflow -- <command>`. With several orgs, add `--org <name>` to work on one.
The README lists them all.

## Where things live

| What | Where |
| ---- | ----- |
| The list of orgs | `codeflow.yml` |
| Each org's config | `orgs/<org>/`: `org.yml`, `people.yml`, `groups.yml`, `rules.yml` |
| Each org's data | `.codeflow/<org>/codeflow.db` |

These name your organization and people, so this repository keeps them out of git. To start an
org over, delete its `.codeflow/<org>/` folder. To remove codeflow, delete the clone.

An older single-file `codeflow.yml` still works. The first steps offer to convert it, so you can
add more orgs (or run `npm run codeflow -- migrate --org <name>`).

## When something goes wrong

- **"No GitHub token found"**: step 2, then Check again. In a terminal, `gh auth status` or
  `echo $GITHUB_TOKEN` shows what codeflow will find.
- **Azure DevOps won't connect**: step 1 says why once you name the organization in step 2. A
  token set after codeflow started isn't seen: stop it and start it again from that terminal. A
  personal access token must be made in that organization (or for all accessible ones), with
  Code (Read) and Project and Team (Read). On a network that needs a proxy, start codeflow with
  `HTTPS_PROXY` set and `NODE_USE_ENV_PROXY=1`.
- **"Create" stays greyed out**: choose "Show what this measures" first; step 3 says what else
  is missing. To start with GitHub alone, remove the Azure DevOps source and add it later in
  Setup › Repos.
- **PR sizes from Azure DevOps show as unknown**: PRs synced before codeflow read Azure
  DevOps's line counts correctly have no size. Setup › Sync › Fetch repos again (or
  `npm run codeflow -- sync --refetch "your-org/Project/*"`) reads them again. The same brings
  "changed after review" to GitHub PRs synced before codeflow asked for commit lines.
- **Repos you no longer measure still show**: narrowing a source doesn't delete what was
  synced. Setup › Repos lists them under "Stored, but no longer measured" and removes their
  data, or run `npm run codeflow -- prune --yes`.
- **A repo is missing**: the token can't see it, or the source leaves it out. "Show what this
  measures" in Setup › Repos lists every repo left out, and why.
- **A metric shows "—"**: too few PRs to show honestly (a median needs 10), or the data doesn't
  reach back that far. The reason is next to it.
- **Staff show as outside contributors**: GitHub hides private organization memberships from
  tokens outside the organization. Put them in a team, or mark them internal in Setup › People.
- **A repo's numbers look too low**: its work may land on a branch that isn't measured. Setup ›
  Branches says so and offers the fix.
- **A save says "changed since you opened it"**: someone, or an editor, changed the file
  meanwhile. Reload to see their change, then make yours again.
- **An unexpected error**: run the command with `--debug` for the full stack trace, and open an
  issue with it.

## Working on codeflow itself

See [CONTRIBUTING.md](../CONTRIBUTING.md) and [testing.md](testing.md). In short: `npm run check`
before any change, `npm run verify` before a pull request.
