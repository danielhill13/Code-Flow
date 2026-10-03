import { readTemplate } from "../pipeline/report.ts";
import { Registry } from "../server/registry.ts";
import { createServer } from "../server/server.ts";
import { status } from "./format.ts";

export type ServeOptions = { config: string; port: string; host: string };

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
  const server = createServer(registry, {
    template: readTemplate(),
    hosts: local ? [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`] : null,
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
  console.log("Press Ctrl-C to stop.");
}
