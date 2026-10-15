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

  it("counts a thoughts tree as notes, whatever its files are called, and a repo's own rule can too [rule 3]", () => {
    for (const path of [
      "thoughts/plans/2026-10-01-migration.md",
      "thoughts/shared/research/notes.txt",
      "thoughts/data/results.json",
      "services/billing/thoughts/idea.yaml",
    ]) {
      expect(bucket(path), path).toBe("docs");
    }
    expect(bucket("src/thoughtsFormatter.ts")).toBe("product");
    // Another tree of notes, named by the repo's own rule, for that repo only.
    const own = pathClassifier([{ match: ["scratch/**"], bucket: "docs", repos: ["acme/api"] }]);
    expect(own("acme/api", "scratch/a.py")).toBe("docs");
    expect(own("acme/web", "scratch/a.py")).toBe("product");
  });

  it("counts pictures, fonts, media, archives, office files and binaries as assets, even inside tests [rule 3]", () => {
    for (const path of [
      "public/logo.png",
      "src/icons/arrow.SVG",
      "assets/fonts/inter.woff2",
      "docs/design/spec.pdf",
      "report.xlsx",
      "lib/native.dll",
      "bin/tool.exe",
      "release/app.zip",
      // A picture in a test folder is not test code: assets come before tests.
      "test/fixtures/screenshot.png",
      "cypress/snapshots/home.jpg",
    ]) {
      // Not code, whichever of docs or assets a folder like docs/ makes it.
      expect(["assets", "docs"], path).toContain(bucket(path));
    }
    expect(bucket("test/fixtures/screenshot.png")).toBe("assets");
    expect(bucket("src/icons/arrow.svg")).toBe("assets");
    // Text that happens to share a name part stays code.
    expect(bucket("src/pngEncoder.ts")).toBe("product");
    expect(bucket("src/zip.ts")).toBe("product");
    expect(bucket("test/zip.test.ts")).toBe("test");
  });

  it("counts what a build or tool leaves behind as generated, and the notes beside code as docs [rule 3]", () => {
    for (const path of [
      "svc/obj/Debug/net8.0/app.AssemblyInfo.cs",
      "svc/__pycache__/mod.cpython-312.pyc",
      "web/.next/server/app.js",
      "infra/.terraform/providers/x",
      "infra/terraform.tfstate",
    ]) {
      expect(bucket(path), path).toBe("generated");
    }
    expect(bucket("infra/.terraform.lock.hcl")).toBe("lockfile");
    for (const path of [
      "README",
      "services/api/README.txt",
      "NOTICE",
      "AUTHORS.md",
      "CONTRIBUTING",
      "design/flow.drawio",
      "design/seq.puml",
    ]) {
      expect(bucket(path), path).toBe("docs");
    }
    // Ordinary code named like these is still code, and CI and build config stay product.
    expect(bucket("src/readme.ts")).toBe("product");
    expect(bucket("src/components/Notice.tsx")).toBe("product");
    expect(bucket("src/authors.py")).toBe("product");
    expect(bucket("src/objectStore.ts")).toBe("product");
    expect(bucket("azure-pipelines.yml")).toBe("product");
    expect(bucket("bin/deploy.sh")).toBe("product");
    expect(bucket("build/scripts/release.py")).toBe("product");
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
