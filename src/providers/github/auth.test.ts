import { describe, expect, it } from "vitest";
import { hostFromApiUrl, isLoopback, resolveToken, tokenKind } from "./auth.ts";

const noGh = async () => undefined;

describe("resolveToken", () => {
  it("prefers the configured variable, then GH_TOKEN, then the GitHub CLI", async () => {
    const base = { tokenEnv: "GITHUB_TOKEN", host: "github.com", readGhToken: async () => "gho_x" };

    expect(
      await resolveToken({ ...base, env: { GITHUB_TOKEN: "ghp_a", GH_TOKEN: "ghp_b" } }),
    ).toEqual({ value: "ghp_a", source: "$GITHUB_TOKEN", kind: "classic" });
    expect(await resolveToken({ ...base, env: { GH_TOKEN: "github_pat_b" } })).toEqual({
      value: "github_pat_b",
      source: "$GH_TOKEN",
      kind: "fine-grained",
    });
    expect(await resolveToken({ ...base, env: {} })).toEqual({
      value: "gho_x",
      source: "gh auth token",
      kind: "oauth",
    });
  });

  it("reads a custom variable and ignores blank ones", async () => {
    const token = await resolveToken({
      tokenEnv: "CODEFLOW_TOKEN",
      host: "github.com",
      env: { CODEFLOW_TOKEN: "  ", GH_TOKEN: "ghs_app " },
      readGhToken: noGh,
    });
    expect(token).toEqual({ value: "ghs_app", source: "$GH_TOKEN", kind: "app-installation" });
  });

  it("asks the GitHub CLI for the configured host", async () => {
    const hosts: string[] = [];
    await resolveToken({
      tokenEnv: "GITHUB_TOKEN",
      host: "ghe.acme.com",
      env: {},
      readGhToken: async (host) => {
        hosts.push(host);
        return "gho_x";
      },
    });
    expect(hosts).toEqual(["ghe.acme.com"]);
  });

  it("says how to get a token when there is none", async () => {
    await expect(
      resolveToken({ tokenEnv: "GITHUB_TOKEN", host: "github.com", env: {}, readGhToken: noGh }),
    ).rejects.toThrow(/Set GITHUB_TOKEN, or log in with the GitHub CLI/);
  });
});

describe("tokenKind", () => {
  it("reads GitHub's token prefixes", () => {
    expect(tokenKind("ghu_x")).toBe("app-user");
    expect(tokenKind("something-else")).toBe("unknown");
  });
});

describe("isLoopback", () => {
  it("knows an API on this machine from GitHub's", () => {
    expect(isLoopback("http://127.0.0.1:4000")).toBe(true);
    expect(isLoopback("http://localhost:4000/api/v3")).toBe(true);
    expect(isLoopback("https://api.github.com")).toBe(false);
    expect(isLoopback("https://ghe.acme.com/api/v3")).toBe(false);
  });
});

describe("hostFromApiUrl", () => {
  it("maps the public API to github.com and keeps Enterprise hosts", () => {
    expect(hostFromApiUrl("https://api.github.com")).toBe("github.com");
    expect(hostFromApiUrl("https://ghe.acme.com/api/v3")).toBe("ghe.acme.com");
  });
});
