// Real git repos for tests of local copies (decision D46): built with the git CLI in a temporary
// folder, with fixed dates, so tests can check sizes and churn against what git itself says.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export class GitRepo {
  readonly dir: string;

  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), "codeflow-git-"));
    this.run("init", "--quiet", "--initial-branch=main");
    this.run("config", "user.email", "test@codeflow.invalid");
    this.run("config", "user.name", "Codeflow Test");
    this.run("config", "commit.gpgsign", "false");
  }

  /** Runs git in the repo, at a fixed time, and returns its output. */
  run(...args: string[]): string {
    return this.at("2026-03-01T10:00:00Z", ...args);
  }

  at(when: string, ...args: string[]): string {
    return execFileSync("git", args, {
      cwd: this.dir,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: when,
        GIT_COMMITTER_DATE: when,
        GIT_CONFIG_NOSYSTEM: "1",
        HOME: this.dir,
      },
      encoding: "utf8",
    }).trim();
  }

  /** Writes files, commits them at `when`, and returns the commit. */
  commit(when: string, message: string, files: Record<string, string>): string {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(this.dir, path)), { recursive: true });
      writeFileSync(join(this.dir, path), text);
    }
    this.at(when, "add", "-A");
    this.at(when, "commit", "--quiet", "-m", message);
    return this.at(when, "rev-parse", "HEAD");
  }

  /** `n` numbered lines, each marked with `tag`. */
  static lines(n: number, tag: string): string {
    return `${Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`).join("\n")}\n`;
  }
}
