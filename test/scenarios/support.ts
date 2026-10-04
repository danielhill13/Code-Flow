// Runs the real `codeflow` CLI, as a separate process, in a workspace of its own, against a fake
// GitHub (src/testing/github-server.ts). What a person typing the commands would see.
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseDocument } from "yaml";
import { type FakeRepo, GitHubServer } from "../../src/testing/github-server.ts";

export const ROOT = resolve(import.meta.dirname, "../..");
const CLI = join(ROOT, "src/cli/main.ts");
/** The variable the test orgs read their token from: never a real token's. */
export const TOKEN_ENV = "CODEFLOW_TEST_TOKEN";

export type Result = { code: number; stdout: string; stderr: string; out: string };

export type Workspace = {
  dir: string;
  /** The environment the CLI runs with: the fake's token, none of the user's. */
  env: Record<string, string | undefined>;
  github: GitHubServer;
  apiUrl: string;
  /** Runs `codeflow <args>` in the workspace. */
  run(...args: string[]): Promise<Result>;
  /** Runs it with a different environment, such as without a token. */
  runWith(env: Record<string, string | undefined>, ...args: string[]): Promise<Result>;
  /** Adds an org with `init`, then points it at the fake GitHub. */
  addOrg(name: string, ...initArgs: string[]): Promise<void>;
  read(path: string): Promise<string>;
  write(path: string, text: string): Promise<void>;
  stop(): Promise<void>;
};

/** A fresh, empty folder with a fake GitHub serving `repos`. */
export async function workspace(repos: readonly FakeRepo[]): Promise<Workspace> {
  const dir = await mkdtemp(join(tmpdir(), "codeflow-scenario-"));
  const github = new GitHubServer(repos);
  const apiUrl = await github.start();
  // Never a real credential: the user's own tokens and GitHub CLI login are kept out.
  const baseEnv: Record<string, string | undefined> = {
    ...process.env,
    GITHUB_TOKEN: undefined,
    GH_TOKEN: undefined,
    GH_CONFIG_DIR: join(dir, ".no-gh"),
    NO_COLOR: "1",
    FORCE_COLOR: undefined,
    [TOKEN_ENV]: github.token,
  };
  const runWith = (env: Record<string, string | undefined>, ...args: string[]) =>
    cli(dir, { ...baseEnv, ...env }, args);
  return {
    dir,
    env: baseEnv,
    github,
    apiUrl,
    run: (...args) => runWith({}, ...args),
    runWith,
    async addOrg(name, ...initArgs) {
      const result = await runWith({}, "init", "--org", name, ...initArgs);
      if (result.code !== 0) throw new Error(`init failed:\n${result.out}`);
      const file = join(dir, "orgs", name, "org.yml");
      const doc = parseDocument(await readFile(file, "utf8"));
      doc.set("github", { api_url: apiUrl, token_env: TOKEN_ENV });
      await writeFile(file, doc.toString());
    },
    read: (path) => readFile(join(dir, path), "utf8"),
    write: (path, text) => writeFile(join(dir, path), text),
    stop: () => github.stop(),
  };
}

function cli(cwd: string, env: Record<string, string | undefined>, args: string[]) {
  return new Promise<Result>((resolveResult) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { cwd, env: definedOnly(env), maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolveResult({ code, stdout, stderr, out: stdout + stderr });
      },
    );
  });
}

/** Starts `codeflow serve` in the workspace; resolves with its URL once it is listening. */
export async function serve(
  ws: Workspace,
  ...args: string[]
): Promise<{ url: string; stop: () => void }> {
  const child = spawn(process.execPath, [CLI, "serve", "--port", "0", ...args], {
    cwd: ws.dir,
    env: definedOnly(ws.env),
  });
  let output = "";
  const url = await new Promise<string>((resolveUrl, reject) => {
    const timer = setTimeout(() => reject(new Error(`serve never started:\n${output}`)), 20_000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const found = /http:\/\/[\w.:[\]-]+/.exec(output);
      if (found) {
        clearTimeout(timer);
        resolveUrl(found[0].replace(/\/$/, ""));
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => reject(new Error(`serve exited with ${code}:\n${output}`)));
  });
  return { url, stop: () => child.kill() };
}

function definedOnly(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}
