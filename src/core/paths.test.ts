import { describe, expect, it } from "vitest";
import { pathClassifier } from "./paths.ts";

describe("pathClassifier", () => {
  const classify = pathClassifier();
  const bucket = (path: string) => classify("acme/api", path);

  it("puts ordinary source in product [rule 3]", () => {
    expect(bucket("src/server.ts")).toBe("product");
    expect(bucket("packages/app/src/index.js")).toBe("product");
    expect(bucket("package.json")).toBe("product");
    expect(bucket(".github/workflows/ci.yml")).toBe("product");
  });

  it("recognises lockfiles, at the root or nested", () => {
    for (const path of [
      "package-lock.json",
      "web/yarn.lock",
      "Cargo.lock",
      "go.sum",
      "bun.lockb",
    ]) {
      expect(bucket(path), path).toBe("lockfile");
    }
  });

  it("recognises vendored, generated, docs and test files", () => {
    expect(bucket("vendor/github.com/x/y.go")).toBe("vendored");
    expect(bucket("app/dist/bundle.js")).toBe("generated");
    expect(bucket("src/api.pb.go")).toBe("generated");
    expect(bucket("src/__snapshots__/view.test.ts.snap")).toBe("generated");
    expect(bucket("README.md")).toBe("docs");
    expect(bucket("docs/guide/setup.txt")).toBe("docs");
    expect(bucket("tests/request/basic.bru")).toBe("test");
    expect(bucket("src/parser.test.ts")).toBe("test");
    expect(bucket("pkg/parse_test.go")).toBe("test");
  });

  it("ignores case, since repos ship both Docs/ and docs/ [rule 3]", () => {
    expect(bucket("Docs/Intro.MD")).toBe("docs");
    expect(bucket("Tests/x.js")).toBe("test");
  });

  it("decides by rule order: a minified file in a test folder is generated", () => {
    expect(bucket("tests/fixtures/lib.min.js")).toBe("generated");
  });

  it("checks configured rules first, optionally for some repos only [rule 3]", () => {
    const custom = pathClassifier([
      { match: ["packages/*-tests/**"], bucket: "test" },
      { match: ["docs/**"], bucket: "product", repos: ["acme/website"] },
    ]);
    expect(custom("acme/api", "packages/bruno-tests/collection/a.bru")).toBe("test");
    expect(custom("acme/website", "docs/index.html")).toBe("product");
    expect(custom("acme/api", "docs/index.html")).toBe("docs");
  });
});
