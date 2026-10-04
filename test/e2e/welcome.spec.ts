// A first run in the browser: an empty folder, `codeflow serve`, and the web app's first steps
// against the fake GitHub, through to a synced org and its report. Then the org's settings,
// edited in Setup, land in org.yml.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "@playwright/test";
import { definedOnly, ROOT } from "../scenarios/support.ts";
import { BAD, ready } from "./helpers.ts";

const GITHUB = process.env.E2E_GITHUB ?? "";
const TOKEN_ENV = process.env.E2E_TOKEN_ENV ?? "";

test.describe.configure({ mode: "serial" });

let dir: string;
let child: ChildProcess;
let url: string;

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "codeflow-welcome-"));
  // Nobody's real token: none in the environment, no GitHub CLI login.
  const env = definedOnly({
    ...process.env,
    GITHUB_TOKEN: undefined,
    GH_TOKEN: undefined,
    GH_CONFIG_DIR: join(dir, ".no-gh"),
    // No GitHub CLI at all: on macOS it finds a login in the keychain whatever its config.
    Path: undefined,
    PATH: dirname(process.execPath),
    [TOKEN_ENV]: process.env.E2E_TOKEN,
    [process.env.E2E_ADO_TOKEN_ENV ?? ""]: process.env.E2E_ADO_TOKEN,
    AZURE_DEVOPS_EXT_PAT: undefined,
  });
  child = spawn(
    process.execPath,
    [join(ROOT, "src/cli/main.ts"), "serve", "--port", "0", "--no-schedule"],
    { cwd: dir, env },
  );
  url = await new Promise<string>((resolve, reject) => {
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const found = /http:\/\/localhost:\d+/.exec(output);
      if (found) resolve(found[0]);
    });
    child.on("exit", () => reject(new Error(`serve exited:\n${output}`)));
  });
});

test.afterAll(() => {
  child?.kill();
});

test("TC-610 an empty folder becomes a synced org, set up entirely in the browser", async ({
  page,
}) => {
  await page.goto(url);
  await expect(page).toHaveURL(/\/welcome\/$/);
  await expect(page.getByRole("heading", { name: "Set up codeflow" })).toBeVisible();

  // Step 1: no token yet, so it says how to give one; this test's GitHub is an Enterprise one.
  const githubStatus = page.locator(".github-status").first();
  await expect(githubStatus).toContainText("No GitHub token found");
  await page.getByText("GitHub Enterprise, or a token in another variable").click();
  await page.getByLabel("API address").fill(GITHUB);
  await page.getByLabel("Token variable", { exact: true }).fill(TOKEN_ENV);
  await githubStatus.getByRole("button", { name: "Check again" }).click();
  await expect(githubStatus).toContainText("Connected as codeflow-tester");

  // Step 2: what to measure, and what that means.
  await page.getByLabel("Organization or user", { exact: true }).fill("acme-co");
  await page.getByRole("button", { name: "Show what this measures" }).click();
  const preview = page.locator(".preview-repos");
  await expect(preview).toContainText("acme-co (organization): 3 repos, 1 left out");
  await expect(preview).toContainText(/First sync: about \d+ PRs/);
  for (const repo of ["acme-co/api", "acme-co/web", "acme-co/legacy"]) {
    await expect(preview).toContainText(repo);
  }

  // Step 3: create it and watch the first sync.
  await page.getByRole("button", { name: "Create acme-co and start syncing" }).click();
  await expect(page.getByText("acme-co is synced")).toBeVisible({ timeout: 30_000 });
  const org = await readFile(join(dir, "orgs/acme-co/org.yml"), "utf8");
  expect(org).toContain("owner: acme-co");
  expect(org).toContain(`api_url: ${GITHUB}`);
  expect(org).toContain(`token_env: ${TOKEN_ENV}`);
  expect(existsSync(join(dir, "codeflow.yml"))).toBe(true);

  await page.getByRole("link", { name: "Open the report" }).click();
  const text = await ready(page);
  expect(text).toContain("Are we getting faster or slower?");
  expect(text).not.toMatch(BAD);
  await expect(page.locator(".org-picker")).toHaveValue("acme-co");
});

test("TC-611 the org's repos, branches, bots and paths are edited in Setup, and land in org.yml", async ({
  page,
}) => {
  const setup = async (section: string) => {
    await page.goto(`${url}/orgs/acme-co/#tab=setup`);
    await ready(page);
    await page.getByRole("button", { name: section, exact: true }).click();
  };
  const yml = () => readFile(join(dir, "orgs/acme-co/org.yml"), "utf8");

  await setup("Repos");
  await page.getByLabel("Leave out").fill("legacy");
  await page.getByLabel("Leave out").blur();
  await page.getByRole("button", { name: "Show what this measures" }).click();
  await expect(page.locator(".preview-repos")).toContainText("2 repos, 2 left out");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved to org.yml.")).toBeVisible();
  expect(await yml()).toMatch(/exclude:\s*\n?\s*-?\s*\[?\s*legacy/);

  await setup("Branches");
  await expect(page.getByText("acme-co/legacy")).toBeVisible();
  await page.getByRole("button", { name: "Work lands on develop: measure it" }).click();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved to org.yml.")).toBeVisible();
  expect(await yml()).toMatch(/acme-co\/legacy:[\s\S]*develop/);

  await setup("Bots");
  await page.getByLabel("Also bots").fill("deploy-svc");
  await page.getByLabel("Also bots").blur();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved to org.yml.")).toBeVisible();
  expect(await yml()).toContain("deploy-svc");

  await setup("Paths");
  await page.getByRole("button", { name: "+ Add a rule" }).click();
  await page.getByLabel("Files").fill("e2e/**");
  await page.getByLabel("Files").blur();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved to org.yml.")).toBeVisible();
  expect(await yml()).toContain("e2e/**");

  await setup("Sync");
  await page.getByRole("button", { name: "Sync now" }).click();
  await expect(page.locator(".sync-log")).toContainText("acme-co/api", { timeout: 30_000 });
});

test("TC-612 an Azure DevOps project becomes an org the same way, beside the GitHub one", async ({
  page,
}) => {
  await page.goto(`${url}/welcome/`);
  await expect(page.getByRole("heading", { name: "Add an org" })).toBeVisible();
  const adoStatus = page.locator(".github-status").nth(1);
  await page.getByText("Azure DevOps Server, or a token in another variable").click();
  await page.getByLabel("Server address").fill(process.env.E2E_ADO ?? "");
  await page.getByLabel("Azure DevOps token variable").fill(process.env.E2E_ADO_TOKEN_ENV ?? "");
  await adoStatus.getByRole("button", { name: "Check again" }).click();
  await expect(adoStatus).toContainText("A token is ready");

  await page
    .getByRole("combobox", { name: "Kind" })
    .selectOption({ label: "Azure DevOps: an organization's or a project's repos" });
  await page.getByLabel("Azure DevOps organization").fill("contoso");
  await page.getByLabel("Project", { exact: true }).fill("Platform");
  await page.getByLabel("Name in codeflow").fill("contoso");
  await page.getByRole("button", { name: "Show what this measures" }).click();
  const preview = page.locator(".preview-repos");
  await expect(preview).toContainText("contoso/Platform/billing");
  await expect(preview).toContainText("contoso/Platform/portal");

  await page.getByRole("button", { name: "Create contoso and start syncing" }).click();
  await expect(page.getByText("contoso is synced")).toBeVisible({ timeout: 60_000 });
  const org = await readFile(join(dir, "orgs/contoso/org.yml"), "utf8");
  expect(org).toMatch(/ado: contoso[\s\S]*project: Platform/);
  await page.getByRole("link", { name: "Open the report" }).click();
  const text = await ready(page);
  expect(text).not.toMatch(BAD);
  await page.getByRole("link", { name: "Pull requests", exact: true }).click();
  expect(await ready(page)).toContain("contoso/Platform/billing");
});

test("TC-614 a source codeflow can't read says why, and can be left out to start without it", async ({
  page,
}) => {
  await page.goto(`${url}/welcome/`);
  const githubStatus = page.locator(".github-status").first();
  const adoStatus = page.locator(".github-status").nth(1);
  await page.getByText("GitHub Enterprise, or a token in another variable").click();
  await page.getByLabel("API address").fill(GITHUB);
  await page.getByLabel("Token variable", { exact: true }).fill(TOKEN_ENV);
  await githubStatus.getByRole("button", { name: "Check again" }).click();
  await expect(githubStatus).toContainText("Connected as codeflow-tester");
  await page.getByLabel("Organization or user", { exact: true }).fill("acme-co");

  // An Azure DevOps source, pasted as its address, with no Azure DevOps token anywhere.
  await page.getByRole("button", { name: "+ Add a source" }).click();
  await page
    .getByRole("combobox", { name: "Kind" })
    .nth(1)
    .selectOption({ label: "Azure DevOps: an organization's or a project's repos" });
  await page.getByLabel("Azure DevOps organization").fill("https://dev.azure.com/contoso/Platform");
  await expect(page.getByLabel("Azure DevOps organization")).toHaveValue("contoso");
  await expect(page.getByLabel("Project", { exact: true })).toHaveValue("Platform");
  await expect(adoStatus).toContainText("No Azure DevOps token found");
  await expect(adoStatus).toContainText("start it again");
  await expect(page.getByText("codeflow can't read Azure DevOps yet")).toContainText(
    "To start with GitHub alone, remove the Azure DevOps source",
  );
  await expect(page.getByRole("button", { name: "Show what this measures" })).toBeDisabled();

  // Left out, GitHub alone goes ahead.
  await page.getByRole("button", { name: "Remove" }).nth(1).click();
  await expect(page.getByText("codeflow can't read Azure DevOps yet")).toHaveCount(0);
  await page.getByRole("button", { name: "Show what this measures" }).click();
  await expect(page.locator(".preview-repos")).toContainText("acme-co (organization): 3 repos");
});
