import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bundleJsonSchema } from "./json-schema.ts";

describe("the published bundle schema", () => {
  it("is current: regenerate it with `node scripts/schema.ts` after changing the config schema", () => {
    const published = readFileSync(
      new URL("../../docs/schema/codeflow-bundle.schema.json", import.meta.url),
      "utf8",
    );
    expect(published).toBe(bundleJsonSchema());
  });
});
