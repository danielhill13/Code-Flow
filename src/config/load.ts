import { readFile } from "node:fs/promises";
import { parseDocument } from "yaml";
import type { z } from "zod";
import { CodeflowError } from "../errors.ts";
import { type Config, ConfigSchema } from "./schema.ts";

export const DEFAULT_CONFIG_FILE = "codeflow.yml";

export async function loadConfig(path = DEFAULT_CONFIG_FILE): Promise<Config> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new CodeflowError(
        `${path} not found. Create one with \`codeflow init --owner <org>\`, or point to it with --config.`,
      );
    }
    throw err;
  }
  return parseConfig(text, path);
}

export function parseConfig(text: string, path = DEFAULT_CONFIG_FILE): Config {
  const doc = parseDocument(text);
  const [yamlError] = doc.errors;
  if (yamlError) throw new CodeflowError(`${path}: ${yamlError.message}`);

  const result = ConfigSchema.safeParse(doc.toJS());
  if (!result.success) {
    throw new CodeflowError(`${path} is not valid:\n${formatIssues(result.error.issues)}`);
  }
  return result.data;
}

/** `sources[0].repo: must look like owner/name` — one line per problem. */
export function formatIssues(issues: readonly z.core.$ZodIssue[]): string {
  return issues
    .map((issue) => `  ${formatPath(issue.path) || "(top level)"}: ${issue.message}`)
    .join("\n");
}

function formatPath(path: readonly PropertyKey[]): string {
  return path
    .map((key, i) =>
      typeof key === "number" ? `[${key}]` : i === 0 ? String(key) : `.${String(key)}`,
    )
    .join("");
}
