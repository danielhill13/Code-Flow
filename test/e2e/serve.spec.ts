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
  await expect(picker.locator("option")).toHaveText([
    "acme",
    "beta",
    "gamma",
    "company",
    "Add an org…",
  ]);
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
  // Found by searching, and ticked in the list.
  await page.getByLabel("Search people").fill("sa");
  await page.getByRole("checkbox", { name: /^sam\b/ }).check();
  await expect(page.getByRole("list", { name: "People chosen" })).toContainText("sam");
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
  await page.getByLabel("Search people").fill("ana");
  await page.getByLabel("Search people").press("Enter");
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
  await page.getByLabel("Search people").fill("zoe");
  await page.getByLabel("Search people").press("Enter");
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
  await expect(page.getByRole("button", { name: "Sync now" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Repos", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("TC-616 a local copy is chosen per repo in Setup, with what it gives and costs", async ({
  page,
}) => {
  await setup(page, "acme", "Repos");
  const card = page.locator("form").filter({ hasText: "Local copies (optional)" });
  await expect(card).toContainText("Exact PR sizes on Azure DevOps");
  await expect(card).toContainText("the repo's source code is stored on this machine");
  await card.getByLabel("Search keep a copy of").fill("api");
  await card.getByRole("checkbox", { name: /acme-co\/api/ }).check();
  await card.getByRole("button", { name: "Save" }).click();
  await expect(card.getByText("Saved to org.yml.")).toBeVisible();
  expect(await readFile(join(DIR, "orgs/acme/org.yml"), "utf8")).toMatch(
    /local_copies:[\s\S]*acme-co\/api/,
  );
  await expect(card).toContainText("made at the next sync");
});

test("TC-617 a long selection shortens in the header, and never runs over its neighbours", async ({
  page,
}) => {
  // The link as the report writes it: dimensions in order, no tab for the default one.
  const link = (org: string, selection: [string, string][]) =>
    `${URL}/orgs/${org}/#${new URLSearchParams(selection)}`;
  const selections = [
    // Several dimensions at once: two teams and two repos.
    link("acme", [
      ["team", "Platform"],
      ["team", "Product"],
      ["repo", "acme-co/api"],
      ["repo", "acme-co/legacy"],
    ]),
    // Long Azure DevOps repo names.
    link("company", [
      ["repo", "contoso/Platform/billing"],
      ["repo", "contoso/Platform/portal"],
      ["repo", "acme-co/api"],
    ]),
  ];
  for (const url of selections) {
    for (const [width, height] of [
      [1280, 800],
      [1100, 800],
      [900, 800],
      [390, 800],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.goto(url);
      await ready(page);
      await expect(page.locator(".crumb-facet > .crumb").first()).toHaveAttribute("title", /.+/);

      // No two parts of the header share any space, and nothing makes the page scroll sideways.
      const header = await page.evaluate(() => {
        const parts = [...(document.querySelector(".bar-row")?.children ?? [])]
          .map((el) => {
            const b = el.getBoundingClientRect();
            return {
              name: el.className || el.tagName,
              l: b.left,
              // Content that overflows its box still covers what's beside it: count its extent.
              r: Math.max(b.right, b.left + el.scrollWidth),
              t: b.top,
              b: b.bottom,
            };
          })
          .filter((p) => p.r - p.l > 1 && p.b - p.t > 1);
        const sideways =
          document.documentElement.scrollWidth - document.documentElement.clientWidth;
        return { parts, sideways };
      });
      expect(header.sideways, `${width}px scrolls sideways`).toBeLessThanOrEqual(0);
      for (const [i, a] of header.parts.entries()) {
        for (const b of header.parts.slice(i + 1)) {
          const across = Math.min(a.r, b.r) - Math.max(a.l, b.l);
          const down = Math.min(a.b, b.b) - Math.max(a.t, b.t);
          expect(
            across > 1 && down > 1,
            `${width}px: "${a.name}" overlaps "${b.name}" (${Math.round(across)} × ${Math.round(down)} px)`,
          ).toBe(false);
        }
      }
      // "Change…" is whole and can be used.
      await page.getByRole("button", { name: "Change…" }).click();
      const picker = page.getByRole("dialog", { name: "Select what to look at" });
      await expect(picker).toBeVisible();
      // Escape closes it; pressed again until it has, since the dialog is listening a moment
      // after it appears.
      await expect(async () => {
        await page.keyboard.press("Escape");
        await expect(picker).toHaveCount(0, { timeout: 500 });
      }).toPass();
    }
  }
});
