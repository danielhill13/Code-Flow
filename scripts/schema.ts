/**
 * Writes docs/schema/codeflow-bundle.schema.json from the bundle schema, so editors and other
 * tools can check a bundle before codeflow sees it. A test fails when it is out of date.
 *
 *   node scripts/schema.ts
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bundleJsonSchema } from "../src/config/json-schema.ts";

const out = fileURLToPath(new URL("../docs/schema/codeflow-bundle.schema.json", import.meta.url));
writeFileSync(out, bundleJsonSchema());
console.log(`Wrote ${out}`);
