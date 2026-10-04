// `codeflow serve` in a browser: switching orgs, and setting an org up through the Setup tab.
// The tests run in order and build on each other, as a person setting up an org would.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { BAD, numberIn, ready } from "./helpers.ts";

const URL = process.env.E2E_URL ?? "";
const DIR = process.env.E2E_DIR ?? "";

test.describe.configure({ mode: "serial" });

async function setup(page: Page, org: string, section: string): Promise<void> {
  await page.goto(`${URL}/orgs/${org}/#tab=setup`);
  await ready(page);
  await page.getByRole("button", { name: section, exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: section === "Import & export" ? "Export" : section,
      exact: true,
    }),
  ).toBeVisible();
}

/** PRs merged in the last 90 days, from the Overview tile: what a rule leaving PRs out changes. */
async function merged90(page: Page, org: string): Promise<number> {
  await page.goto(`${URL}/orgs/${org}/#w=90d`);
  await ready(page);
  return numberIn(page, "PRs merged");
}

test("TC-601 the org picker switches orgs, and each shows nothing of the other", async ({
  page,
}) => {
  await page.goto(URL);
  await ready(page);
  expect(page.url()).toContain("/orgs/acme/");
  const picker = page.getByLabel("Org");
  await expect(picker.locator("option")).toHaveText(["acme", "beta", "gamma"]);
  await picker.selectOption("beta");
  await page.waitForURL(/\/orgs\/beta\//);
  await ready(page);
  await page.getByRole("link", { name: "Pull requests", exact: true }).click();
  const text = await ready(page);
  expect(text).toContain("acme-co/web");
  expect(text).not.toContain("acme-co/api");
  expect(text).not.toContain("Platform");
});

test("TC-602 a team added in Setup is in the report straight away", async ({ page }) => {
  await setup(page, "acme", "Teams");
  await expect(page.getByText("ana, devon")).toBeVisible();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Outside");
  await page.getByLabel("Person or login").first().fill("sam");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Add a team")).toHaveCount(0);
  await expect(page.locator(".row").filter({ hasText: "Outside" })).toBeVisible();
  expect(await readFile(join(DIR, "orgs/acme/groups.yml"), "utf8")).toContain(
    "# who builds the API",
  );

  await page.getByRole("link", { name: "Overview", exact: true }).click();
  const text = await ready(page);
  expect(text).toContain("Outside");
  expect(text).not.toMatch(BAD);
});

test("TC-603 a team that breaks a rule is refused with the reason, and nothing is saved", async ({
  page,
}) => {
  await setup(page, "acme", "Teams");
  const before = await readFile(join(DIR, "orgs/acme/groups.yml"), "utf8");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Shadow");
  await page.getByLabel("Person or login").first().fill("ana");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("alert")).toContainText("ana is in");
  expect(await readFile(join(DIR, "orgs/acme/groups.yml"), "utf8")).toBe(before);
});

test("TC-604 a rule shows what it would change as it is written, then changes the numbers", async ({
  page,
}) => {
  const before = await merged90(page, "acme");
  await setup(page, "acme", "Rules");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByLabel("Id", { exact: true }).fill("no-chores");
  await page.getByLabel("Labels", { exact: true }).fill("chore");
  await page.getByLabel("Labels", { exact: true }).blur();
  await page
    .getByRole("combobox", { name: "Count", exact: true })
    .selectOption({ label: "Leave them out" });
  const preview = page.locator(".preview");
  await expect(preview).toContainText(/With this rule saved: \d+ PRs would stop counting/);
  const stopped = Number(/(\d+) PRs would stop/.exec(await preview.innerText())?.[1]);
  expect(await preview.innerText()).toContain("chore: tidy");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator(".row").filter({ hasText: "no-chores" })).toBeVisible();

  const after = await merged90(page, "acme");
  expect(after).toBeLessThan(before);
  expect(before - after).toBeLessThanOrEqual(stopped);

  await setup(page, "acme", "Rules");
  await page.getByLabel("no-chores on").click();
  await expect(page.getByLabel("no-chores on")).not.toBeChecked();
  expect(await readFile(join(DIR, "orgs/acme/rules.yml"), "utf8")).toContain("enabled: false");
  expect(await merged90(page, "acme")).toBe(before);
});

test("TC-605 export downloads a bundle, and import previews before it applies", async ({
  page,
}) => {
  await setup(page, "acme", "Import & export");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("link", { name: "Download" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("acme.yml");
  const bundle = await readFile((await download.path()) ?? "", "utf8");
  expect(bundle).toContain("codeflow: 1");
  expect(bundle).toContain("Outside");

  await setup(page, "beta", "Import & export");
  await page.locator("input[type=file]").setInputFiles({
    name: "acme.yml",
    mimeType: "application/yaml",
    buffer: Buffer.from(bundle),
  });
  await page.getByRole("button", { name: "Preview" }).click();
  await expect(page.locator(".preview")).toContainText("Would change:");
  await expect(page.locator(".preview")).toContainText("teams: added");
  expect(await readFile(join(DIR, "orgs/beta/groups.yml"), "utf8")).not.toContain("Outside");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.locator(".preview")).toContainText("Applied:");
  expect(await readFile(join(DIR, "orgs/beta/groups.yml"), "utf8")).toContain("Outside");
});

test("TC-606 a save over a file changed meanwhile is refused, and says to reload", async ({
  page,
}) => {
  await setup(page, "acme", "Teams");
  const file = join(DIR, "orgs/acme/groups.yml");
  await writeFile(file, `${await readFile(file, "utf8")}# edited by hand meanwhile\n`);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Late");
  await page.getByLabel("Person or login").first().fill("zoe");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("alert")).toContainText("changed since you opened it");
  expect(await readFile(file, "utf8")).not.toContain("Late");
});

test("TC-608 org settings change the stale window and turn people views off", async ({ page }) => {
  await setup(page, "acme", "Settings");
  await page.getByLabel("Stale after (days)").fill("3650");
  await page.getByRole("combobox", { name: "People views" }).selectOption("off");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved to org.yml.")).toBeVisible();
  const yml = await readFile(join(DIR, "orgs/acme/org.yml"), "utf8");
  expect(yml).toMatch(/stale_after_days: 3650/);
  expect(yml).toMatch(/people_views: false/);

  await page.goto(`${URL}/orgs/acme/#tab=flow`);
  await ready(page);
  await expect(page.locator(".stale-strip")).toContainText(
    "No open PR has gone more than 3,650 days",
  );
  await page.getByRole("button", { name: "Select…" }).click();
  const picker = page.getByRole("dialog", { name: "Select what to look at" });
  await expect(picker.getByText("Teams", { exact: true })).toBeVisible();
  await expect(picker.getByText("People", { exact: true })).toHaveCount(0);
  await page.goto(`${URL}/orgs/acme/#tab=review&team=Platform`);
  expect(await ready(page)).not.toContain("devon");
});

test("TC-609 the header says how fresh the data is and when it syncs next", async ({ page }) => {
  await page.goto(`${URL}/orgs/acme/`);
  await ready(page);
  await expect(page.locator(".through")).toContainText(
    /Data through .* · (just now|\d+ (min|h|d) ago)/,
  );
  // This server runs with --no-schedule.
  await expect(page.locator(".through")).toContainText("no sync scheduled");
});

test("TC-607 an org not synced yet offers only its setup", async ({ page }) => {
  await page.goto(`${URL}/orgs/gamma/`);
  await expect(page.getByRole("heading", { name: "Nothing synced yet" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Tabs" })).toHaveText("Setup");
  await expect(page.getByText("npm run codeflow -- sync --org gamma")).toBeVisible();
});
