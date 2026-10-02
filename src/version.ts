import { readFileSync } from "node:fs";

// Read at runtime: package.json sits one level above both src/ and dist/.
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

export const VERSION: string = pkg.version;
