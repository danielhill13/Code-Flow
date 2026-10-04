import { spawn } from "node:child_process";
import { readTemplate } from "../pipeline/report.ts";
import { Registry } from "../server/registry.ts";
import { Scheduler } from "../server/scheduler.ts";
import { createServer } from "../server/server.ts";
import { status } from "./format.ts";
import { Progress } from "./progress.ts";
import { syncOrg } from "./sync.ts";

export type ServeOptions = {
  config: string;
  port: string;
  host: string;
  schedule?: boolean;
  /** Open the page in the default browser once listening. */
  open?: boolean;
};

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
  // Always there, for "Sync now"; on the orgs' schedules only without --no-schedule.
  const scheduler = new Scheduler(registry, {
    sync: (org, signal, report) => {
      const print = (line = "") => {
        console.log(line ? `[${org.name}] ${line}` : "");
        if (line) report(plain(line));
      };
      // Progress lines go to the web app rather than rewriting the terminal's last line.
      const stream = {
        isTTY: true,
        columns: 200,
        write: (text: string) => {
          const line = plain(text);
          if (line) report(line, true);
          return true;
        },
      } as unknown as NodeJS.WriteStream;
      return syncOrg(org, new Progress(stream), print, { signal });
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
  const url = `http://localhost:${actual}/`;
  console.log(
    status(
      "ok",
      "Serving",
      names.length === 0
        ? `nothing yet: open ${url} to set up codeflow`
        : `${names.length === 1 ? "1 org" : `${names.length} orgs`} at ${url}`,
    ),
  );
  if (options.open) openBrowser(url);
  if (!local) {
    console.log(
      status(
        "warn",
        "",
        `listening on ${options.host}: anyone who can reach it can read and edit, as there is no sign-in yet`,
      ),
    );
  }
  if (options.schedule !== false) {
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

/** Terminal colour and cursor codes: ESC, [, numbers, a letter. */
const ESCAPES = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");

/** Text without terminal colours and line rewrites, for the web app. */
function plain(text: string): string {
  return text.replace(ESCAPES, "").replace(/\r/g, "").trim();
}

/** Opens a URL in the default browser; a missing browser only means the reader opens it. */
function openBrowser(url: string): void {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    spawn(command, args, { stdio: "ignore", detached: true })
      .on("error", () => {})
      .unref();
  } catch {
    // Nothing to do: the address is printed above.
  }
}
