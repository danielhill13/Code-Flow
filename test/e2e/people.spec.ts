// Merging a person's GitHub and Azure DevOps accounts in Setup › People, in a browser.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { ready } from "./helpers.ts";

const URL = process.env.E2E_URL ?? "";
const DIR = process.env.E2E_DIR ?? "";

test("TC-613 a suggested match is merged in a click, shown as one person, and can be separated", async ({
  page,
}) => {
  await page.goto(`${URL}/orgs/company/#tab=setup`);
  await ready(page);
  await page.getByRole("button", { name: "People", exact: true }).click();
  const suggestion = page.locator(".suggestion").filter({ hasText: "ana@acme.example" });
  await expect(suggestion).toContainText("Likely the same: the address's name is the login");
  await suggestion.getByRole("button", { name: "Merge" }).click();
  await expect(page.locator(".suggestion").filter({ hasText: "ana@acme.example" })).toHaveCount(0);
  const yml = await readFile(join(DIR, "orgs/company/people.yml"), "utf8");
  expect(yml).toMatch(/ana:[\s\S]*ado:[\s\S]*ana@acme\.example/);

  // Every account, merged ones included: ana's two accounts are one person now.
  await page.getByLabel("Only accounts not in a person").uncheck();
  const accounts = page.locator('section[aria-labelledby="accounts"]');
  const row = accounts.locator(".row").filter({ hasText: "ana@acme.example" });
  await expect(row).toContainText("Azure DevOps");
  await expect(row).toContainText("ana");

  // Two accounts chosen by hand, merged under a name.
  await page.getByLabel("Choose mika", { exact: true }).check();
  await page.getByLabel("Choose mika@acme.example").check();
  await page.getByLabel("Name", { exact: true }).first().fill("Mika Sato");
  await page.getByRole("button", { name: "Merge into one person" }).click();
  // The Person column, once the save is done.
  await expect(
    accounts.locator(".row").filter({ hasText: "mika@acme.example" }).locator("span").nth(4),
  ).toHaveText("mika");
  expect(await readFile(join(DIR, "orgs/company/people.yml"), "utf8")).toMatch(
    /mika:[\s\S]*name: Mika Sato[\s\S]*mika@acme\.example/,
  );

  await row.getByRole("button", { name: "Separate" }).click();
  await expect(page.locator(".suggestion").filter({ hasText: "ana@acme.example" })).toHaveCount(1);
  expect(await readFile(join(DIR, "orgs/company/people.yml"), "utf8")).not.toContain(
    "ana@acme.example",
  );
});
