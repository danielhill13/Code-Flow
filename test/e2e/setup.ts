import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { acmeRepos, contosoRepos, OWNER, scenarioStart } from "../../src/testing/scenario.ts";
import {
  ADO_TOKEN_ENV,
  buildReportPage,
  ROOT,
  serve,
  TOKEN_ENV,
  workspace,
} from "../scenarios/support.ts";

export default async function setup() {
  if (!existsSync(join(ROOT, "dist/report/index.html"))) {
    await buildReportPage();
  }
  const since = new Date(scenarioStart() - 14 * 86_400_000).toISOString().slice(0, 10);
  const ws = await workspace(acmeRepos(), { ado: contosoRepos() });
  const must = async (...args: string[]) => {
    const result = await ws.run(...args);
    if (result.code !== 0) throw new Error(`codeflow ${args.join(" ")} failed:\n${result.out}`);
  };
  await ws.addOrg("acme", "--repo", `${OWNER}/api`, "--repo", `${OWNER}/legacy`, "--since", since);
  await ws.addOrg("beta", "--repo", `${OWNER}/web`, "--since", since);
  await ws.addOrg("gamma", "--repo", `${OWNER}/attic`, "--since", since);
  // One company on both hosts, for merging people's accounts across them.
  await ws.addOrg("company", "--owner", OWNER, "--ado", "contoso/Platform", "--since", since);
  await ws.write(
    "orgs/acme/groups.yml",
    [
      "teams:",
      "  # who builds the API",
      "  Platform:",
      "    people: [ana, devon]",
      "  Product:",
      "    people: [mika, rui]",
      "",
    ].join("\n"),
  );
  await must("sync", "--org", "acme");
  await must("sync", "--org", "beta");
  await must("sync", "--org", "company");
  await must("build", "--org", "acme");
  // No schedule: the tests decide when data changes. TC-306 covers the scheduler.
  const server = await serve(ws, "--no-schedule");

  process.env.E2E_DIR = ws.dir;
  process.env.E2E_URL = server.url;
  process.env.E2E_REPORT = pathToFileURL(join(ws.dir, "codeflow-report-acme.html")).href;
  // The fake GitHub stays up, for tests that set up an org from the web app.
  process.env.E2E_GITHUB = ws.apiUrl;
  process.env.E2E_TOKEN_ENV = TOKEN_ENV;
  process.env.E2E_TOKEN = ws.github.token;
  process.env.E2E_ADO = ws.adoUrl ?? "";
  process.env.E2E_ADO_TOKEN_ENV = ADO_TOKEN_ENV;
  process.env.E2E_ADO_TOKEN = ws.ado?.token ?? "";
  return async () => {
    server.stop();
    await ws.stop();
  };
}
