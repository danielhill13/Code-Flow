// One company on two code hosts: an org that measures Acme's GitHub organization and Contoso's
// Azure DevOps project together, with the same people on both. The real CLI, against a fake
// GitHub and a fake Azure DevOps.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ADO_ORG,
  ADO_PROJECT,
  acmeRepos,
  adoLogin,
  contosoRepos,
  countedAdoMerges,
  countedMerges,
  OWNER,
  PEOPLE,
  scenarioStart,
} from "../../src/testing/scenario.ts";
import { TOKEN_ENV, type Workspace, workspace } from "./support.ts";

const github = acmeRepos();
const ado = contosoRepos();
const since = new Date(scenarioStart() - 14 * 86_400_000).toISOString().slice(0, 10);

type Summary = {
  period: { start: string; end: string };
  metrics: { key: string; value: number | null }[];
};

describe("an org spanning GitHub and Azure DevOps", () => {
  let ws: Workspace;
  beforeAll(async () => {
    ws = await workspace(github, { ado });
    await ws.addOrg(
      "acme",
      "--owner",
      OWNER,
      "--ado",
      `${ADO_ORG}/${ADO_PROJECT}`,
      "--since",
      since,
    );
    // The same people on both hosts: one team, whichever host their PR is on.
    await ws.write(
      "orgs/acme/people.yml",
      `people:\n${PEOPLE.staff.map((p) => `  ${p}:\n    github: [${p}]\n    ado: [${adoLogin(p)}]`).join("\n")}\n`,
    );
    await ws.write("orgs/acme/groups.yml", "teams:\n  Platform:\n    people: [ana, devon]\n");
  });
  afterAll(() => ws.stop());

  it("TC-113 doctor checks both hosts and lists what each selects", async () => {
    const result = await ws.run("doctor");
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("3 repos selected; skipped 1 archived");
    expect(result.out).toMatch(new RegExp(`ADO org\\s+${ADO_ORG} .* as Codeflow Tester`));
    expect(result.out).toMatch(/contoso\/Platform \(Azure DevOps\): 2 repos selected; left out 1/);
    expect(result.out).toContain("at most two requests a second");
    expect(result.out).toMatch(
      /PR sizes\s+contoso\/Platform\/\w+#\d+: \d+ files?, [\d,]+ lines? changed/,
    );
    expect(result.out).toContain("everything checks out");
  });

  it("TC-114 sync reads both hosts into one database, and counts both as one company", async () => {
    const sync = await ws.run("sync");
    expect(sync.code, sync.out).toBe(0);
    expect(sync.out).toContain("5 repos selected");
    for (const repo of [
      `${OWNER}/api`,
      `${ADO_ORG}/${ADO_PROJECT}/billing`,
      `${ADO_ORG}/${ADO_PROJECT}/portal`,
    ]) {
      expect(sync.out).toContain(`${repo}:`);
    }
    const summary = JSON.parse((await ws.run("summary", "--json")).stdout) as Summary;
    const merged = summary.metrics.find((m) => m.key === "merged")?.value;
    const { start, end } = summary.period;
    expect(merged).toBe(countedMerges(github, start, end) + countedAdoMerges(ado, start, end));

    const again = await ws.run("sync");
    expect(again.out).toContain("0 new or changed");
  });

  it("TC-123 a later sync checks each open Azure DevOps PR with one request, and reads again only one that moved", async () => {
    if (!ws.ado) throw new Error("no fake Azure DevOps");
    const billing = ado[0];
    const open = billing?.prs.filter((p) => p.pr.status === "active") ?? [];
    expect(open.length).toBeGreaterThan(1);
    const from = ws.ado.calls.length;
    const quiet = await ws.run("sync");
    expect(quiet.out).toMatch(/billing: 0 PRs fetched, 0 new or changed; \d+ open PRs unchanged/);
    const calls = ws.ado.calls.slice(from);
    expect(calls.some((c) => /\/iterations|\/commits|filediffs/.test(c))).toBe(false);

    // A reviewer comments on one open PR: that one is read whole again, the rest aren't.
    const [moved] = open;
    if (!billing || !moved) throw new Error("scenario lacks open PRs");
    const at = new Date().toISOString();
    ws.ado.put("billing", {
      ...moved,
      threads: [
        ...moved.threads,
        {
          id: 9999,
          publishedDate: at,
          lastUpdatedDate: at,
          comments: [
            {
              id: 1,
              author: { displayName: "Rui", uniqueName: "rui@acme.example" },
              content: "One question",
              publishedDate: at,
              commentType: "text",
            },
          ],
        },
      ],
    });
    const before = ws.ado.calls.length;
    const one = await ws.run("sync");
    expect(one.out).toMatch(/billing: 1 PR fetched, 1 new or changed; \d+ open PRs unchanged/);
    const read = ws.ado.calls.slice(before).filter((c) => c.endsWith("/iterations"));
    expect(read).toEqual([expect.stringContaining(`/pullRequests/${moved.pr.pullRequestId}/`)]);
  });

  it("TC-115 a person's PRs on either host are theirs, and their team's", async () => {
    const ana = (await ws.run("summary", "--json", "--repo", `${ADO_ORG}/*/*`)).stdout;
    expect(
      (JSON.parse(ana) as Summary).metrics.find((m) => m.key === "merged")?.value,
    ).toBeGreaterThan(0);
    const build = await ws.run("build");
    expect(build.code, build.out).toBe(0);
    const html = await ws.read("codeflow-report-acme.html");
    expect(html).toContain(`${ADO_ORG}/${ADO_PROJECT}/billing`);
    expect(html).toContain(`${OWNER}/web`);
    // ana's Azure DevOps PRs carry her person key and her team, as her GitHub ones do.
    expect(html).toMatch(/"author":"ana@acme\.example"[^}]*?"person":"ana","team":"Platform"/);
  });

  it("TC-116 pr explains an Azure DevOps PR from its address, and knows a build service for a bot", async () => {
    const [billing] = ado;
    const reviewed = billing?.prs.find(
      (p) => p.pr.status === "completed" && p.iterations.length > 1,
    );
    const bot = billing?.prs.find((p) => p.pr.createdBy.uniqueName?.startsWith("Build\\"));
    if (!reviewed || !bot) throw new Error("scenario lacks PRs");
    const url = `https://dev.azure.com/${ADO_ORG}/${ADO_PROJECT}/_git/billing/pullrequest/${reviewed.pr.pullRequestId}`;
    const shown = await ws.run("pr", url);
    expect(shown.code, shown.out).toBe(0);
    expect(shown.out).toMatch(/Counted\s+yes/);
    expect(shown.out).toMatch(/rounds? of new commits after review/);
    // Its size, from Azure DevOps's wrapped diff answer: the product lines its files changed.
    const lines = (reviewed.files ?? [])
      .filter((f) => f.path.startsWith("src/"))
      .reduce((n, f) => n + f.additions + f.deletions, 0);
    expect(lines).toBeGreaterThan(0);
    expect(shown.out).toContain(`${lines.toLocaleString("en-US")} product lines`);
    const left = await ws.run("pr", `${ADO_ORG}/${ADO_PROJECT}/billing#${bot.pr.pullRequestId}`);
    // A build service is a bot, and its PRs count like any bot's: by default (D45).
    expect(left.out).toMatch(/opened by build\\[^\n]*\(bot\)/);
    expect(left.out).toMatch(/Counted\s+yes/);
  });

  it("TC-121 sync --refetch clears a repo's stored PRs and fetches them all again", async () => {
    const before = (await ws.run("status")).out;
    expect(before).toContain(`${ADO_ORG}/${ADO_PROJECT}/billing`);
    const result = await ws.run("sync", "--refetch", `${ADO_ORG}/${ADO_PROJECT}/bill*`);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toMatch(
      new RegExp(`Refetch\\s+${ADO_ORG}/${ADO_PROJECT}/billing: \\d+ PRs cleared, fetching again`),
    );
    expect(result.out).not.toMatch(/Refetch\s+[^\n]*portal/);
    const after = (await ws.run("status")).out;
    const count = (text: string) =>
      new RegExp(`${ADO_ORG}/${ADO_PROJECT}/billing\\s+(\\d+)`).exec(text)?.[1];
    expect(Number(count(before))).toBeGreaterThan(0);
    expect(count(after)).toBe(count(before));
    const none = await ws.run("sync", "--refetch", "nothing/like/this");
    expect(none.out).toContain("no stored repo matches nothing/like/this");
  });

  it("TC-122 a size Azure DevOps won't give is unknown, and says why, in pr and doctor", async () => {
    if (!ws.ado) throw new Error("no fake Azure DevOps");
    ws.ado.refuseDiffs = true;
    const id = `${ADO_ORG}/${ADO_PROJECT}/billing`;
    try {
      const doctor = await ws.run("doctor");
      expect(doctor.out).toMatch(/PR sizes\s+[^\n]*unknown, Azure DevOps said 403: TF401027/);
      const pr = ado[0]?.prs.find((p) => p.pr.status === "completed");
      if (!pr) throw new Error("scenario lacks PRs");
      expect((await ws.run("sync", "--refetch", id)).code).toBe(0);
      const shown = await ws.run("pr", `${id}#${pr.pr.pullRequestId}`);
      expect(shown.out).toMatch(/Size\s+unknown: Azure DevOps said 403: TF401027/);
    } finally {
      ws.ado.refuseDiffs = false;
      await ws.run("sync", "--refetch", id);
    }
  });

  it("TC-124 local copies without git: doctor says what to do, and sync carries on through the API", async () => {
    const file = "orgs/acme/org.yml";
    const before = await ws.read(file);
    await ws.write(file, `${before}\nlocal_copies: ["${ADO_ORG}/*/billing"]\n`);
    try {
      // This test's PATH holds node alone: no git, as on a machine without it.
      const doctor = await ws.run("doctor");
      expect(doctor.out).toMatch(/Local copies\s+git isn't installed, or isn't on the PATH/);
      const sync = await ws.run("sync");
      expect(sync.code, sync.out).toBe(0);
      expect(sync.out).toMatch(
        new RegExp(
          `Local copy\\s+${ADO_ORG}/${ADO_PROJECT}/billing: git isn't installed[^\\n]*Sizes come from the host's API instead`,
        ),
      );
    } finally {
      await ws.write(file, before);
    }
  });
});

describe("an org only on Azure DevOps", () => {
  it("TC-117 syncs without any GitHub token, and says plainly when the Azure DevOps one is missing", async () => {
    const ws = await workspace([], { ado });
    try {
      await ws.addOrg("contoso", "--ado", ADO_ORG, "--since", since);
      const noGitHub = await ws.runWith({ [TOKEN_ENV]: undefined }, "sync");
      expect(noGitHub.code, noGitHub.out).toBe(0);
      expect(noGitHub.out).not.toContain("GitHub");
      expect(noGitHub.out).toContain(`${ADO_ORG}/${ADO_PROJECT}/portal:`);
      const none = await ws.runWith({ CODEFLOW_TEST_ADO_TOKEN: undefined }, "doctor");
      expect(none.code).toBe(1);
      expect(none.out).toContain("No Azure DevOps token found. Set CODEFLOW_TEST_ADO_TOKEN");
      expect(none.out).not.toMatch(/\n\s+at\s/);
    } finally {
      await ws.stop();
    }
  });
});

describe("people who work on both hosts", () => {
  let ws: Workspace;
  beforeAll(async () => {
    ws = await workspace(github, { ado });
    await ws.addOrg(
      "acme",
      "--owner",
      OWNER,
      "--ado",
      `${ADO_ORG}/${ADO_PROJECT}`,
      "--since",
      since,
    );
    await ws.write("orgs/acme/groups.yml", "teams:\n  Platform:\n    people: [ana, devon]\n");
    expect((await ws.run("sync")).code).toBe(0);
  });
  afterAll(() => ws.stop());

  it("TC-118 people lists both hosts' accounts and suggests which are one person", async () => {
    const result = await ws.run("people");
    expect(result.code, result.out).toBe(0);
    expect(result.out).toMatch(/Accounts\s+\d+ in acme's PRs, on GitHub and Azure DevOps/);
    expect(result.out).toContain("ana@acme.example");
    expect(result.out).toContain("Same person on GitHub and Azure DevOps?");
    expect(result.out).toMatch(
      /ana and ana@acme\.example\s+likely: the address's name is the login/,
    );
    expect(result.out).toContain("codeflow people merge ana ana@acme.example");
  });

  it("TC-119 merging puts a person's Azure DevOps PRs on their team, with no new sync", async () => {
    const team = async () => {
      expect((await ws.run("build")).code).toBe(0);
      return /"author":"ana@acme\.example"[^}]*?"person":"([^"]+)","team":(null|"[^"]+")/.exec(
        await ws.read("codeflow-report-acme.html"),
      );
    };
    expect((await team())?.slice(1)).toEqual(["ana@acme.example", "null"]);

    const dry = await ws.run("people", "merge", "ana", "ana@acme.example", "--dry-run");
    expect(dry.out).toContain("people: added ana");
    expect(await ws.read("orgs/acme/people.yml")).not.toContain("ana@acme.example");

    const calls = ws.github.calls.length;
    const merged = await ws.run("people", "merge", "ana", "ana@acme.example");
    expect(merged.code, merged.out).toBe(0);
    const yml = await ws.read("orgs/acme/people.yml");
    expect(yml).toMatch(/ana:[\s\S]*name: Ana[\s\S]*ado:[\s\S]*ana@acme\.example/);
    expect((await team())?.slice(1)).toEqual(["ana", '"Platform"']);
    expect(ws.github.calls.length).toBe(calls);

    const after = await ws.run("people");
    expect(after.out).not.toMatch(/ana and ana@acme\.example/);
  });
});
