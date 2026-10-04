# Getting started

From nothing to a report in your browser. Every step is a command you can copy. It takes about
ten minutes of your time, plus however long the first sync runs (roughly 25 minutes for a repo
with 2,500 pull requests a year; minutes for most).

## 1. What you need

- **Node.js 24 or later.** Check with `node --version`. Install it from
  [nodejs.org](https://nodejs.org) or with a version manager such as `nvm install 24`.
- **git**, to clone this repository.
- **Read access to the repositories you want to measure**, and a way for codeflow to use it
  (step 3).

codeflow runs on macOS, Linux and Windows. It needs no database server: it keeps its data in a
SQLite file next to your config, using Node's built-in SQLite.

## 2. Install

codeflow isn't on npm yet, so run it from a clone:

```bash
git clone https://github.com/danielhill13/Code-Flow.git
cd Code-Flow
npm install
npm run build
```

`npm run build` compiles the command-line tool and the report page into `dist/`. From the clone
you can now run any command as `npm run codeflow -- <command>`, which is how the rest of this
guide writes them.

To have a `codeflow` command available everywhere instead, link it once:

```bash
npm link
```

Then `codeflow sync` works from any folder; drop the `npm run codeflow --` prefix from the
commands below. Run `npm run build` again after pulling new changes.

## 3. Give codeflow a GitHub token

codeflow only reads from GitHub. It looks for a token in this order:

1. the environment variable `GITHUB_TOKEN` (or another name, set by `github.token_env` in the
   config),
2. the environment variable `GH_TOKEN`,
3. the [GitHub CLI](https://cli.github.com)'s login, if you have run `gh auth login`.

The easiest route, if you use the GitHub CLI already:

```bash
gh auth login
```

Otherwise create a token and export it:

- **Fine-grained token (recommended):** GitHub → Settings → Developer settings → Fine-grained
  tokens. Choose the organization or account that owns the repos, select the repos (or all), and
  grant read-only **Contents**, **Pull requests** and **Metadata**. Nothing else.
- **Classic token:** `repo` scope for private repositories; for public ones, no scope at all.

```bash
export GITHUB_TOKEN=github_pat_...
```

To measure an organization's private repos, the token must belong to someone who can see them,
and the organization may need to approve fine-grained tokens first.

## 4. Say what to measure

codeflow measures **orgs**. An org is yours to define: one GitHub organization, several, or a
handful of repos, with its own teams, rules and data. Most people start with one.

Create one. Measure a whole GitHub organization (or user) with `--owner`, single repos with
`--repo`, or both; each can repeat:

```bash
npm run codeflow -- init --owner your-org
npm run codeflow -- init --org web-team --repo your-org/api --repo your-org/web
```

That writes a workspace, `codeflow.yml`, listing your orgs, and a folder for each org:

```
codeflow.yml              the workspace: which orgs exist
orgs/your-org/org.yml     what the org measures, from a year back
orgs/your-org/people.yml  people with several logins, bots, staff (commented out)
orgs/your-org/groups.yml  its teams, products and areas (commented out, to fill in)
orgs/your-org/rules.yml   its own rules: what counts, repo rules, people rules (commented out)
```

Run `init` again with another `--org` to add more orgs; nothing is shared between them.
[configuration.md](configuration.md) covers every option. Three you will likely want:

- `since`: how far back to measure. Further back means a longer first sync.
- `teams` and `groups`: who works together, and what they work on (products, areas). The
  report can then look at any team, group, repo or person, or any mix of them.
- `rules`: anything particular to the org, such as leaving out chore PRs or a service
  account, or measuring `develop` in a repo whose work merges there (step 6 tells you which).
  `codeflow rules test draft.yml` shows what a draft would change before you save it.

Setting up a second org like the first? `codeflow export --org first -o setup.yml` then
`codeflow import setup.yml --org second` copies people, teams, groups and rules. Teams can
also come from a spreadsheet: `codeflow import teams.csv --org your-org`.

These files name your organization and people, so this repository keeps `codeflow.yml` and
`orgs/` out of git. In a repository of your own, commit them if you want a history of changes.

With several orgs, every command works on all of them, or on one with `--org your-org`.
`summary` and `pr` need `--org` when there is more than one.

## 5. Check, then sync

```bash
npm run codeflow -- doctor
```

`doctor` reads your config, checks the token, lists the repos it selects, and estimates how long
the first sync will take and how much of GitHub's hourly rate limit it will use. It spends a few
rate-limit points and writes nothing.

```bash
npm run codeflow -- sync
```

`sync` fetches every pull request updated since `since`, plus older ones still open, into the
org's own database, `.codeflow/<org>/codeflow.db`. You can stop it at any time with Ctrl-C; the next `sync` carries on
where it stopped. If GitHub's rate limit runs out, sync waits for it to reset. After the first
sync, each run fetches only what changed, usually in seconds.

## 6. Look at the numbers

```bash
npm run codeflow -- status
npm run codeflow -- summary
```

- `status` shows what is stored and how the last sync went. If a repo's work lands on a branch
  codeflow doesn't measure (say features merge into `develop`), it says so here and prints the
  `branches:` line to add.
- `summary` prints every metric for the last complete month. Try `--period 2026-Q3`,
  `--percentile 75`, `--repo your-org/api` or `--explain`.
- `npm run codeflow -- pr 123` (or `pr your-org/api#123`) shows how codeflow read one pull
  request, to check against GitHub.

## 7. Build and open the report

```bash
npm run codeflow -- build
```

That writes one file per org, `codeflow-report-<org>.html`, holding the page and that org's data,
and nothing of any other org. Open it in a browser by double-clicking it, or:

```bash
open codeflow-report-your-org.html        # macOS
xdg-open codeflow-report-your-org.html    # Linux
start codeflow-report-your-org.html       # Windows
```

It works offline and makes no network requests. Send the file to anyone who should see it; the
view is in the URL, so a link can point at a tab, a team or a filtered list of PRs.

## 8. Or run it as a web app

```bash
npm run build                    # once, and after pulling changes: builds the page serve uses
npm run codeflow -- serve
```

Then open <http://localhost:4317>. It is the same report, answered live from each org's data.
The page is about 40 KB; each view's numbers come from the server as you move around, a few KB
at a time, however many PRs the org has. It adds:

- **An org picker** at the top left. Each org is at its own address, `/orgs/<org>/`, and shows
  nothing of any other.
- **A Setup tab**, to edit the org's people, teams, groups, rules and settings, and to import and
  export them. Saving writes the org's own files in `orgs/<org>/` (you can keep editing those by
  hand too) and the report recomputes at once. While you write a rule, Setup shows how many PRs
  it would change, and which.
- **Fresh data, on a schedule.** While it runs, `serve` syncs each org daily (or as often as the
  org's `sync_every` says), one org at a time. The header shows when the data runs through, how
  long ago that was, and when the next sync is; it turns amber if a sync is overdue. A page
  that's open picks up new data by itself. Start it with `--no-schedule` to sync only by hand.

An org that hasn't synced yet shows only Setup, so you can set it up before its first sync.
`serve` only listens on this machine (`--port` and `--host` change that); there is no sign-in
yet, so don't expose it to a network. Stop it with Ctrl-C.

## 9. Keep it current

With `codeflow serve` running, there is nothing to do: it syncs every org daily by default. To
change how often, set `sync_every` in the org's `org.yml` (`6h`, `24h`, `7d`, or `off`), or in
Setup › Settings.

Without `serve`, run `codeflow run` (sync, then build) from a scheduler. A daily cron job:

```bash
0 6 * * * cd /path/to/Code-Flow && npm run codeflow -- run >> codeflow.log 2>&1
```

On Windows, Task Scheduler can run `npm run codeflow -- run` in the clone's folder the same way.

Changing an org's config (teams, branches, bots, paths) needs no new sync: the next `summary` or
`build` recomputes everything from the stored data, in about a second per few thousand PRs.

## Where things live

| What | Where |
| ---- | ----- |
| The workspace | `codeflow.yml` (or `--config path/to/file.yml` on any command) |
| Each org's config | `orgs/<org>/`: `org.yml`, `people.yml`, `groups.yml`, `rules.yml` |
| Each org's data | `.codeflow/<org>/codeflow.db` |
| Each org's report | `codeflow-report-<org>.html` (`build --org <org> --out file` moves it) |

To start an org over, delete its `.codeflow/<org>/` folder. To remove codeflow entirely, delete the clone (and run
`npm unlink -g codeflow` if you linked it).

## Upgrading from a single config file

Before workspaces, codeflow kept everything in one `codeflow.yml`. That still works, as one org
with its data in `.codeflow/`. To turn it into a workspace, so you can add orgs:

```bash
npm run codeflow -- migrate --org your-org
```

That splits the file into `orgs/your-org/`, keeping its comments, moves the data to
`.codeflow/your-org/`, and keeps the old file as `codeflow.yml.single.bak`.

## When something goes wrong

- **"No GitHub token found"**: step 3. Check with `echo $GITHUB_TOKEN` or `gh auth status`.
- **A repo is missing from `doctor`**: the token can't see it, or the source's `include` /
  `exclude` patterns skip it. `doctor --all` lists skipped repos with the reason.
- **A metric shows "—"**: it has too few PRs to show honestly (a median needs 10), or the data
  doesn't reach back that far. The reason is next to it.
- **Staff show as outside contributors**: GitHub hides private organization memberships from
  tokens outside the organization. List those people in a team and they count as internal.
- **Numbers look too low for a repo**: run `status`; the repo's work may land on a branch that
  isn't measured.
- **`serve` says the page isn't built**: run `npm run build` first.
- **Setup won't save: "changed since you opened it"**: someone (or an editor) changed the file
  meanwhile. Reload the page to see their change, then make yours again.
- **An unexpected error**: run the command again with `--debug` for the full stack trace, and
  open an issue with it.

## Working on codeflow itself

```bash
npm run check        # typecheck, lint and every test, including a sweep of every report view
npm run report:dev   # the report with live reload, on your synced data
npm run fix          # format and apply safe lint fixes
```

[architecture.md](architecture.md) explains the design and the measurement rules,
[decisions.md](decisions.md) why things are the way they are, and [roadmap.md](roadmap.md)
what comes next.
