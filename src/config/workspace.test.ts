import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorkspace, pickOrgs, SINGLE_ORG } from "./workspace.ts";

async function folder(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codeflow-ws-"));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
}

const org = (owner: string) => `sources:\n  - owner: ${owner}\nsince: 2025-10-01\n`;

describe("loadWorkspace", () => {
  it("reads a single-file config as one org, its data where it always was", async () => {
    const root = await folder({ "codeflow.yml": org("acme") });
    const workspace = await loadWorkspace(join(root, "codeflow.yml"));
    expect(workspace.single).toBe(true);
    expect(workspace.orgs.map((o) => [o.name, o.dbPath])).toEqual([
      [SINGLE_ORG, join(root, ".codeflow", "codeflow.db")],
    ]);
  });

  it("reads each org from its folder, with its own database", async () => {
    const root = await folder({
      "codeflow.yml": "orgs:\n  acme: {}\n  client-b: { dir: clients/b }\n",
      "orgs/acme/org.yml": org("acme"),
      "orgs/acme/groups.yml": "teams:\n  Core:\n    people: [ana]\n",
      "clients/b/org.yml": org("client-b"),
    });
    const workspace = await loadWorkspace(join(root, "codeflow.yml"));
    expect(workspace.single).toBe(false);
    expect(workspace.orgs.map((o) => [o.name, o.dbPath])).toEqual([
      ["acme", join(root, ".codeflow", "acme", "codeflow.db")],
      ["client-b", join(root, ".codeflow", "client-b", "codeflow.db")],
    ]);
    expect(workspace.orgs[0]?.config.teams.Core?.people[0]?.login).toBe("ana");
    expect(workspace.orgs[1]?.config.teams).toEqual({});
  });

  it("names the file a problem is in, and the file a misplaced key belongs in", async () => {
    const root = await folder({
      "codeflow.yml": "orgs:\n  acme: {}\n",
      "orgs/acme/org.yml": org("acme"),
      "orgs/acme/groups.yml": "teams:\n  Core: {}\n",
    });
    await expect(loadWorkspace(join(root, "codeflow.yml"))).rejects.toThrow(
      /groups\.yml is not valid:\n {2}teams\.Core\.people/,
    );
    await writeFile(join(root, "orgs/acme/org.yml"), `${org("acme")}teams: {}\n`);
    await expect(loadWorkspace(join(root, "codeflow.yml"))).rejects.toThrow(
      /`teams` belongs in groups\.yml/,
    );
  });

  it("refuses an org name that can't be a file name, and a missing org.yml", async () => {
    const bad = await folder({ "codeflow.yml": "orgs:\n  Acme Corp: {}\n" });
    await expect(loadWorkspace(join(bad, "codeflow.yml"))).rejects.toThrow(/lowercase letters/);
    const missing = await folder({ "codeflow.yml": "orgs:\n  acme: {}\n" });
    await expect(loadWorkspace(join(missing, "codeflow.yml"))).rejects.toThrow(/has no org\.yml/);
  });
});

describe("pickOrgs", () => {
  it("picks the named org, every org, or asks which when a command needs one", async () => {
    const root = await folder({
      "codeflow.yml": "orgs:\n  acme: {}\n  beta: {}\n",
      "orgs/acme/org.yml": org("acme"),
      "orgs/beta/org.yml": org("beta"),
    });
    const workspace = await loadWorkspace(join(root, "codeflow.yml"));
    expect(pickOrgs(workspace, "beta").map((o) => o.name)).toEqual(["beta"]);
    expect(pickOrgs(workspace, undefined).map((o) => o.name)).toEqual(["acme", "beta"]);
    expect(() => pickOrgs(workspace, undefined, true)).toThrow(/say which with --org/);
    expect(() => pickOrgs(workspace, "gamma")).toThrow(/No org called "gamma"/);
  });
});
