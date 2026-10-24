// The static report, opened from disk as a person opens the file `codeflow build` wrote.
import { expect, type Page, test } from "@playwright/test";
import { BAD, numberIn, ready, tile } from "./helpers.ts";

const REPORT = process.env.E2E_REPORT ?? "";
const TABS = ["Overview", "Speed", "Review", "Flow", "Compare", "AI insights", "Pull requests"];

/** Opens a tab and waits until it is the one shown, with its data. */
async function openTab(page: Page, name: string): Promise<string> {
  const link = page.getByRole("link", { name, exact: true });
  await link.click();
  await expect(link).toHaveAttribute("aria-current", "page");
  return ready(page);
}

/** Presses a segmented control's button and waits for the view it asks for. */
async function press(page: Page, name: string): Promise<string> {
  const button = page.getByRole("button", { name, exact: true });
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  return ready(page);
}

/** Chooses a window from the window menu: "30 days", "Month" (to date), "Q3 2026", … */
async function pickWindow(page: Page, item: string): Promise<string> {
  await page.locator(".controls .window-button").click();
  const menu = page.getByRole("dialog", { name: "Choose a window" });
  await menu.getByRole("button", { name: item, exact: true }).click();
  await expect(menu).toHaveCount(0);
  return ready(page);
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => msg.type() === "error" && errors.push(msg.text()));
  page.on("request", (req) => {
    if (!req.url().startsWith("file:") && !req.url().startsWith("data:")) {
      errors.push(`network request to ${req.url()}`);
    }
  });
  test.info().annotations.push({ type: "errors", description: "" });
  (page as Page & { errors?: string[] }).errors = errors;
});

test.afterEach(async ({ page }) => {
  expect((page as Page & { errors?: string[] }).errors ?? []).toEqual([]);
});

test("TC-501 opens offline from the file, with its org, its data-through date and seven tabs [rule 12]", async ({
  page,
}) => {
  await page.goto(REPORT);
  const text = await ready(page);
  await expect(page.locator(".org-name")).toHaveText("acme");
  expect(text).toMatch(/Data through \w{3} \d+, \d{4}/);
  for (const tab of TABS)
    await expect(page.getByRole("link", { name: tab, exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Setup" })).toHaveCount(0);
});

test("TC-502 every tab, window and statistic shows numbers, never broken values", async ({
  page,
}) => {
  await page.goto(REPORT);
  await ready(page);
  for (const tab of TABS) {
    await openTab(page, tab);
    const windowed = tab !== "Compare" && tab !== "Pull requests";
    for (const window of windowed ? ["30 days", "90 days", "Month", "Quarter", "Year"] : [null]) {
      if (window) await pickWindow(page, window);
      for (const statistic of ["Median", "P75"]) {
        const text = await press(page, statistic);
        expect(text, `${tab} · ${window} · ${statistic}`).not.toMatch(BAD);
        expect(text).not.toContain("Loading");
      }
    }
  }
});

test("TC-503 a headline number opens the PRs behind it, and a PR opens how it was read [rule 8]", async ({
  page,
}) => {
  await page.goto(REPORT);
  await ready(page);
  const count = await numberIn(page, "PRs merged");
  expect(count).toBeGreaterThan(0);
  await tile(page, "PRs merged").click();
  await ready(page);
  await expect(page.locator("h1")).toHaveText("Which pull requests are behind this number?");
  await expect(page.getByText(/Overview › PRs merged/)).toBeVisible();
  const rows = page.locator("main a.row:not(.head)");
  await expect(rows).toHaveCount(count);

  await rows.first().click();
  const drawer = page.locator("aside.drawer");
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText("how codeflow read the pull request");
  expect(await drawer.innerText()).not.toMatch(BAD);
  await expect(drawer.getByRole("button", { name: "Close" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
});

test("TC-504 the whole view lives in the URL: reload or share it and it comes back [rule 11]", async ({
  page,
}) => {
  await page.goto(REPORT);
  await ready(page);
  await openTab(page, "Review");
  await pickWindow(page, "90 days");
  await press(page, "P75");
  const before = await press(page, "Internal");
  const url = page.url();
  expect(url).toMatch(/tab=review/);

  const other = await page.context().newPage();
  await other.goto(url);
  const after = await ready(other);
  await expect(other.getByRole("button", { name: "P75", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(after).toBe(before);
  await other.close();
});

test("TC-505 picking a team narrows every number to it, and back", async ({ page }) => {
  await page.goto(REPORT);
  await ready(page);
  const all = await numberIn(page, "PRs merged");
  await page.getByRole("button", { name: "Select…" }).click();
  const picker = page.getByRole("dialog", { name: "Select what to look at" });
  await picker.getByLabel("Platform").check();
  await picker.getByRole("button", { name: "Show" }).click();
  await ready(page);
  await expect(page.locator(".heading p")).toContainText("Platform");
  const platform = await numberIn(page, "PRs merged");
  expect(platform).toBeGreaterThan(0);
  expect(platform).toBeLessThan(all);
  await page.getByRole("link", { name: "All teams" }).click();
  await ready(page);
  expect(await numberIn(page, "PRs merged")).toBe(all);
});

test("TC-510 what is selected is listed first when the picker opens again", async ({ page }) => {
  await page.goto(REPORT);
  await ready(page);
  await page.getByRole("button", { name: "Select…" }).click();
  const picker = page.getByRole("dialog", { name: "Select what to look at" });
  const repos = picker.locator("fieldset").filter({ hasText: "Repos" });
  const names = await repos.locator("label").allTextContents();
  const last = names.at(-1)?.trim() ?? "";
  expect(names.length).toBeGreaterThan(1);
  await repos.getByLabel(last).check();
  // Ticking doesn't move a row away from the pointer.
  expect((await repos.locator("label").allTextContents()).at(-1)?.trim()).toBe(last);
  await picker.getByRole("button", { name: "Show" }).click();
  await ready(page);

  await page
    .getByRole("button", { name: /Select…|Change/ })
    .first()
    .click();
  const again = page.getByRole("dialog", { name: "Select what to look at" });
  const first = again.locator("fieldset").filter({ hasText: "Repos" }).locator("label").first();
  await expect(first).toHaveText(last);
  await expect(first.locator("input")).toBeChecked();
});

test("TC-511 a window can be a period to date, or one month, quarter or year, and stays in the link", async ({
  page,
}) => {
  await page.goto(REPORT);
  await ready(page);
  // One button names the window; its menu holds every choice.
  await expect(page.locator(".window-button")).toHaveText(/Last 30 days/);
  await pickWindow(page, "Month");
  await expect(page.locator(".window-button")).toHaveText(/Month to date/);
  await expect(page.locator(".heading p")).toContainText("month to date");

  await page.locator(".window-button").click();
  const menu = page.getByRole("dialog", { name: "Choose a window" });
  await expect(menu.getByRole("button", { name: "Month", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  // Escape closes it, changing nothing.
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);

  const quarter = (await page.evaluate(() => {
    const now = new Date();
    return `Q${Math.floor(now.getUTCMonth() / 3) + 1} ${now.getUTCFullYear()}`;
  })) as string;
  const text = await pickWindow(page, quarter);
  expect(text).not.toMatch(BAD);
  expect(page.url()).toMatch(/w=\d{4}-Q[1-4]/);
  await expect(page.locator(".window-button")).toHaveText(new RegExp(quarter));

  await page.reload();
  await ready(page);
  await expect(page.locator(".window-button")).toHaveText(new RegExp(quarter));
  const year = String(new Date().getUTCFullYear() - 1);
  await page.locator(".window-button").click();
  const years = page.getByRole("dialog", { name: "Choose a window" });
  if ((await years.getByRole("button", { name: year, exact: true }).count()) > 0) {
    await years.getByRole("button", { name: year, exact: true }).click();
    expect(await ready(page)).not.toMatch(BAD);
  }
});

/** How many PRs the list says it holds. */
async function listed(page: Page): Promise<number> {
  const text = await page
    .locator(".card .num", { hasText: /pull request/ })
    .first()
    .innerText();
  return Number(text.replace(/\D/g, ""));
}

test("TC-618 the PR list covers the periods chosen, two quarters at once", async ({ page }) => {
  await page.goto(REPORT);
  await ready(page);
  await openTab(page, "Pull requests");

  // With nothing chosen the list covers the report's window, and says so.
  await expect(page.locator(".window-button")).toHaveText(/Last 30 days/);
  await expect(page.locator("main")).toContainText("merged in Last 30 days");

  // The two most recent quarters the menu offers: key them as the link does ("2026-Q3").
  await page.locator(".window-button").click();
  const menu = page.getByRole("dialog", { name: "Choose periods" });
  const quarters = (await menu.locator(".window-column").nth(1).locator("button").allInnerTexts())
    .map((label) => /Q([1-4]) (\d{4})/.exec(label))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ label: `Q${m[1]} ${m[2]}`, key: `${m[2]}-Q${m[1]}` }));
  expect(quarters.length).toBeGreaterThan(1);
  const [a, b] = quarters.slice(0, 2);
  if (!a || !b) throw new Error("fewer than two quarters offered");
  await page.keyboard.press("Escape");

  // Each on its own, from the link.
  const countFor = async (key: string) => {
    await page.goto(`${REPORT}#tab=prs&set=merged&p=${key}&sort=-merged`);
    await ready(page);
    return listed(page);
  };
  const first = await countFor(a.key);
  const second = await countFor(b.key);
  expect(first + second).toBeGreaterThan(0);

  // Both at once, by the menu: it stays open for the second pick, and each PR counts once.
  await page.goto(`${REPORT}#tab=prs&set=merged&p=${a.key}&sort=-merged`);
  await ready(page);
  await page.locator(".window-button").click();
  await menu.getByRole("button", { name: b.label, exact: true }).click();
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("button", { name: `✓ ${b.label}`, exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await ready(page);
  expect(page.url()).toContain(`p=${a.key}`);
  expect(page.url()).toContain(`p=${b.key}`);
  await expect(page.locator(".window-button")).toContainText(`${a.label} + ${b.label}`);
  expect(await listed(page)).toBe(first + second);

  // One is always left: unticking the last period does nothing.
  await page.locator(".window-button").click();
  await menu.getByRole("button", { name: `✓ ${b.label}`, exact: true }).click();
  await menu.getByRole("button", { name: `✓ ${a.label}`, exact: true }).click();
  await expect(menu.getByRole("button", { name: `✓ ${a.label}`, exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  expect(await listed(page)).toBe(first);

  // Open PRs are as of now: the periods don't apply, and the page says so.
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await ready(page);
  await expect(page.locator(".controls-note")).toContainText("as of now");
});

test("TC-619 the PR list shows the columns chosen, files changed among them", async ({ page }) => {
  await page.goto(REPORT);
  await ready(page);
  await openTab(page, "Pull requests");
  const header = page.locator(".row.head").first();

  // Files changed is a column of the list, with a number for each PR.
  await expect(header).toContainText("Files");
  // ...and Code files beside it: product and test, apart from docs and notes.
  await expect(header).toContainText("Code files");
  const files = await page.locator("a.row.dense").first().locator("span").allInnerTexts();
  expect(files.some((text) => /^\d+$/.test(text.trim()))).toBe(true);

  // Choose columns: hide Files and Merge wait, show Time to approval; it stays in the link.
  await page.getByRole("button", { name: /^Columns/ }).click();
  const menu = page.getByRole("dialog", { name: "Choose columns" });
  await expect(menu.getByRole("checkbox", { name: "Title" })).toBeDisabled();
  await menu.getByRole("checkbox", { name: "Files changed" }).uncheck();
  await menu.getByRole("checkbox", { name: "Merge wait" }).uncheck();
  await menu.getByRole("checkbox", { name: "Time to approval" }).check();
  await page.keyboard.press("Escape");
  await ready(page);
  expect(page.url()).toContain("cols=");
  await expect(header).not.toContainText("Files");
  await expect(header).not.toContainText("Merge wait");
  await expect(header).toContainText("To approval");

  // A reload shows the same columns: they are in the link.
  await page.reload();
  await ready(page);
  await expect(page.locator(".row.head").first()).toContainText("To approval");

  // Reset returns what the list opens with.
  await page.getByRole("button", { name: /^Columns/ }).click();
  await page.getByRole("button", { name: "Reset to default" }).click();
  await page.keyboard.press("Escape");
  await ready(page);
  expect(page.url()).not.toContain("cols=");
  await expect(page.locator(".row.head").first()).toContainText("Files");
  await expect(page.locator(".row.head").first()).toContainText("Merge wait");
});

test("TC-506 the theme the viewer picks stays picked", async ({ page }) => {
  await page.goto(REPORT);
  await ready(page);
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await ready(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("TC-507 at phone width, no tab scrolls sideways", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(REPORT);
  await ready(page);
  for (const tab of TABS) {
    await openTab(page, tab);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, tab).toBeLessThanOrEqual(0);
  }
});

test("TC-508 stale PRs are shown on Flow apart from those open now, and listed on request", async ({
  page,
}) => {
  await page.goto(`${REPORT}#tab=flow`);
  await ready(page);
  const strip = page.locator(".stale-strip");
  await expect(strip).toContainText("1 PR open with no activity for more than 90 days");
  const openNow = await numberIn(page, "Open now");
  await page.getByRole("link", { name: "Open now" }).click();
  const open = await ready(page);
  expect(open).not.toContain("Add a Klingon locale");
  expect(await page.locator("main a.row:not(.head)").count()).toBe(openNow);

  await page.goto(`${REPORT}#tab=flow`);
  await ready(page);
  await strip.getByRole("link", { name: "List them" }).click();
  const stale = await ready(page);
  expect(stale).toContain("Add a Klingon locale");
  await expect(page.getByRole("button", { name: "Stale", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByText("Add a Klingon locale").click();
  await expect(page.locator("aside.drawer")).toContainText("Open · Stale");
});

test("TC-509 changes read as a neutral increase or decrease, in one unit", async ({ page }) => {
  await page.goto(`${REPORT}#w=90d`);
  await ready(page);
  for (const text of await page.locator("a.tile .tile-change").allInnerTexts()) {
    expect(text).not.toMatch(/[↑↓]/);
    expect(text).toMatch(/increase|decrease|same as before|no earlier data|^$|too few|old enough/);
  }
  const arrows = page.locator(".arrow");
  for (const arrow of await arrows.all()) {
    expect(["increase", "decrease"]).toContain(await arrow.getAttribute("aria-label"));
  }
});

test("TC-512 AI insights show the share, who uses AI, which markers, and each PR's markers [rule 20]", async ({
  page,
}) => {
  await page.goto(REPORT);
  await ready(page);
  await pickWindow(page, "90 days");
  const text = await openTab(page, "AI insights");
  expect(text).not.toMatch(BAD);
  expect(await numberIn(page, "AI-assisted share of PRs")).toBeGreaterThan(0);
  await expect(tile(page, "Contributors using AI")).toBeVisible();
  for (const card of [
    "AI-assisted PRs over time",
    "Impact: AI-assisted PRs and the rest",
    "Which markers were seen",
    "Tools named",
    "Adoption by repo, month by month",
  ]) {
    await expect(page.getByRole("heading", { name: card })).toBeVisible();
  }

  // A marker's row opens the PRs that show it, each with its markers.
  await page.getByRole("link", { name: /^Signature/ }).click();
  const list = await ready(page);
  expect(list).toContain("AI marker · Signature");
  await expect(page.locator(".ai-mark", { hasText: "signature" }).first()).toBeVisible();

  // And a PR shows where each marker was seen.
  await page.locator("a.row.dense").first().click();
  const drawer = page.getByRole("complementary");
  await expect(drawer).toContainText("AI markers");
  await expect(drawer).toContainText("Generated with [Claude Code]");
});

test("TC-513 essential mode keeps three tabs and the headline numbers, and stays chosen", async ({
  page,
}) => {
  await page.goto(REPORT);
  await ready(page);
  await press(page, "Essential");
  const tabs = page.getByRole("navigation", { name: "Tabs" }).getByRole("link");
  await expect(tabs).toHaveText(["Overview", "AI insights", "Pull requests"]);
  await expect(page.getByRole("group", { name: "Statistic" })).toHaveCount(0);
  await expect(page.getByText("Notes on the data")).toHaveCount(0);
  expect(page.url()).toContain("mode=essential");

  // Remembered: the report opens in it again, from a link that doesn't say.
  await page.goto(REPORT);
  await ready(page);
  await expect(tabs).toHaveText(["Overview", "AI insights", "Pull requests"]);

  const ai = await openTab(page, "AI insights");
  expect(ai).toContain("AI-assisted PRs and the rest");
  expect(ai).not.toContain("Which markers were seen");

  await press(page, "Advanced");
  await expect(tabs).toHaveCount(TABS.length);
  await expect(page.getByRole("group", { name: "Statistic" })).toBeVisible();
});
