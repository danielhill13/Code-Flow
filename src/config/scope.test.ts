import { describe, expect, it } from "vitest";
import { parseConfig } from "./load.ts";
import { measuredBy } from "./scope.ts";

const sourcesOf = (yaml: string) => parseConfig(`${yaml}\nsince: 2026-01-01\n`).sources;

describe("which stored repos the sources still select", () => {
  const sources = sourcesOf(`sources:
  - owner: acme
    include: [api-*, web]
    exclude: [api-old]
  - repo: other/tool
  - ado: contoso
    project: Platform
    include: [billing]`);
  const gh = (fullName: string) => ({ provider: "github", fullName });
  const ado = (fullName: string) => ({ provider: "ado", fullName });

  it("follows an owner's include and exclude patterns, ignoring case", () => {
    expect(measuredBy(sources, gh("acme/api-core"))).toBe(true);
    expect(measuredBy(sources, gh("ACME/Web"))).toBe(true);
    expect(measuredBy(sources, gh("acme/api-old"))).toBe(false);
    expect(measuredBy(sources, gh("acme/docs"))).toBe(false);
  });

  it("matches a single repo exactly", () => {
    expect(measuredBy(sources, gh("other/tool"))).toBe(true);
    expect(measuredBy(sources, gh("other/tool-2"))).toBe(false);
  });

  it("keeps Azure DevOps repos to their organization, project and names", () => {
    expect(measuredBy(sources, ado("contoso/Platform/billing"))).toBe(true);
    expect(measuredBy(sources, ado("contoso/Platform/portal"))).toBe(false);
    expect(measuredBy(sources, ado("contoso/Other/billing"))).toBe(false);
    // A GitHub source never selects an Azure DevOps repo, nor the other way round.
    expect(measuredBy(sources, gh("contoso/billing"))).toBe(false);
  });
});
