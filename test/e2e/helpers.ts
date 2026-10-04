import { expect, type Page } from "@playwright/test";

/** Never on a page: what a value missing somewhere in the pipeline would show as. */
export const BAD = /undefined|NaN|Infinity|\[object Object\]/;

/**
 * The page's text once it shows the view its URL asks for, with that view's data: the report sets
 * `data-view` and `data-ready` on <main> for exactly this. Never wait for a fixed time instead.
 */
export async function ready(page: Page): Promise<string> {
  await page.waitForFunction(() => {
    const main = document.querySelector("main");
    const view = (main?.dataset.view ?? "").replace(/^#/, "");
    return main?.dataset.ready === "true" && view === location.hash.replace(/^#/, "");
  });
  return page.locator("body").innerText();
}

/** The headline tile for one metric, by its label. */
export const tile = (page: Page, label: string) =>
  page
    .locator("a.tile")
    .filter({ has: page.locator(".tile-label", { hasText: new RegExp(`^${label}`) }) });

/** The number a headline tile shows, such as 42 for "PRs merged". */
export async function numberIn(page: Page, label: string): Promise<number> {
  await expect(tile(page, label)).toBeVisible();
  return Number((await tile(page, label).locator(".tile-value").innerText()).replace(/\D/g, ""));
}
