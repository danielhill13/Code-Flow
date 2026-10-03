import { describe, expect, it } from "vitest";
import type { ReportData } from "../core/source.ts";
import { renderReport } from "./report.ts";

const template =
  '<html><body><script id="codeflow-data" type="application/json">null</script></body></html>';

const data = (title: string): ReportData => ({
  builtAt: "2026-10-03T00:00:00Z",
  asOf: "2026-10-02T23:00:00Z",
  coveredFrom: "2025-10-01",
  repos: ["acme/api"],
  facts: [{ title } as ReportData["facts"][number]],
});

describe("renderReport", () => {
  it("puts the data in the slot, readable with JSON.parse", () => {
    const html = renderReport(template, data("Add a thing"));
    const json = /type="application\/json">(.*)<\/script>/.exec(html)?.[1] ?? "";
    expect(JSON.parse(json)).toEqual(data("Add a thing"));
  });

  it("keeps a PR title from ending the script element early", () => {
    const title = "Fix </script><script>alert(1)</script> and $& in titles";
    const html = renderReport(template, data(title));
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    const json = /type="application\/json">(.*)<\/script>/.exec(html)?.[1] ?? "";
    expect(JSON.parse(json).facts[0].title).toBe(title);
  });
});
