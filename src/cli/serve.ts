import { readTemplate } from "../pipeline/report.ts";
import { Registry } from "../server/registry.ts";
import { Scheduler } from "../server/scheduler.ts";
import { createServer } from "../server/server.ts";
import { status } from "./format.ts";
import { Progress } from "./progress.ts";
import { syncOrg } from "./sync.ts";

export type ServeOptions = { config: string; port: string; host: string; schedule?: boolean };

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * The report as a web app on this machine, where every org's people, teams, groups and rules can
 * be edited. Runs until stopped. Each org is at /orgs/<name>/.
 */
export async function serve(options: ServeOptions): Promise<void> {
  const port = Number(options.port);
  const registry = new Registry(options.config);
  const names = await registry.names();
  const local = LOOPBACK.has(options.host);
  const scheduler =
    options.schedule === false
      ? undefined
      : new Scheduler(registry, {
          sync: (org, signal) => {
            const print = (line = "") => console.log(line ? `[${org.name}] ${line}` : "");
            return syncOrg(org, new Progress(), print, { signal });
          },
        });
  const server = createServer(registry, {
    template: readTemplate(),
    hosts: local ? ["localhost", "127.0.0.1", "[::1]"] : null,
    scheduler,
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, options.host, resolve);
  });
  const address = server.address();
  const actual = typeof address === "object" && address ? address.port : port;
  console.log(
    status(
      "ok",
      "Serving",
      `${names.length === 1 ? "1 org" : `${names.length} orgs`} at http://localhost:${actual}/`,
    ),
  );
  if (!local) {
    console.log(
      status(
        "warn",
        "",
        `listening on ${options.host}: anyone who can reach it can read and edit, as there is no sign-in yet`,
      ),
    );
  }
  if (scheduler) {
    const schedules = (await registry.workspace()).orgs.map(
      (org) =>
        `${org.name} ${org.config.sync_every === "off" ? "off" : `every ${org.config.sync_every}`}`,
    );
    console.log(status("ok", "Schedule", `syncs ${schedules.join(", ")}`));
    scheduler.start();
  }
  console.log("Press Ctrl-C to stop.");
  // First Ctrl-C: let a scheduled sync store its page in flight, then stop. Second: stop now.
  let stopping = false;
  process.on("SIGINT", () => {
    if (stopping) process.exit(130);
    stopping = true;
    console.log(status("warn", "Stopping", "after the page in flight (Ctrl-C again to quit now)"));
    server.close();
    server.closeAllConnections();
    void (scheduler?.stop() ?? Promise.resolve()).then(() => process.exit(0));
  });
}
