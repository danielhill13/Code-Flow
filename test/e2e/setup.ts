// Before the browser tests: a workspace synced from the fake GitHub, a static report built from
// it, and `codeflow serve` running on it. Tests find them through E2E_* environment variables.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { acmeRepos, OWNER, scenarioStart } from "../../src/testing/scenario.ts";
import { ROOT, serve, workspace } from "../scenarios/support.ts";

export default async function setup() {
  if (!existsSync(join(ROOT, "dist/report/index.html"))) {
    await promisify(execFile)("npm", ["run", "build:report"], { cwd: ROOT });
  }
  const since = new Date(scenarioStart() - 14 * 86_400_000).toISOString().slice(0, 10);
  const ws = await workspace(acmeRepos());
  const must = async (...args: string[]) => {
    const result = await ws.run(...args);
    if (result.code !== 0) throw new Error(`codeflow ${args.join(" ")} failed:\n${result.out}`);
  };
  await ws.addOrg("acme", "--repo", `${OWNER}/api`, "--repo", `${OWNER}/legacy`, "--since", since);
  await ws.addOrg("beta", "--repo", `${OWNER}/web`, "--since", since);
  await ws.addOrg("gamma", "--repo", `${OWNER}/attic`, "--since", since);
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
  await must("build", "--org", "acme");
  await ws.stop();
  // No schedule: the tests decide when data changes. TC-306 covers the scheduler.
  const server = await serve(ws, "--no-schedule");

  process.env.E2E_DIR = ws.dir;
  process.env.E2E_URL = server.url;
  process.env.E2E_REPORT = pathToFileURL(join(ws.dir, "codeflow-report-acme.html")).href;
  return () => server.stop();
}
