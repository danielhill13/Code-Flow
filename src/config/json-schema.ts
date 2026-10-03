import { z } from "zod";
import { BundleSchema } from "./schema.ts";

/** The bundle format as JSON Schema: what a person or tool writes (the input side). */
export function bundleJsonSchema(): string {
  const schema = z.toJSONSchema(BundleSchema, { io: "input", unrepresentable: "any" });
  return `${JSON.stringify(
    {
      ...schema,
      $id: "https://github.com/danielhill13/Code-Flow/docs/schema/codeflow-bundle.schema.json",
      title: "codeflow bundle",
      description:
        "An org's people, groups and rules, as `codeflow export` writes and `codeflow import` reads.",
    },
    null,
    2,
  )}\n`;
}
