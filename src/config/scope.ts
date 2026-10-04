// Which stored repos an org's sources still select, from names alone (decision D43). A repo
// synced under an earlier, wider source (a whole organization, say) stays in the store until it
// is pruned; this says which those are, without asking GitHub or Azure DevOps.
import picomatch from "picomatch";
import type { Source } from "./schema.ts";

const lower = (s: string) => s.toLowerCase();

/** Whether any source names this repo: by owner and name patterns, or as a single repo. */
export function measuredBy(
  sources: readonly Source[],
  repo: { provider: string; fullName: string },
): boolean {
  const parts = repo.fullName.split("/");
  const name = parts.at(-1) ?? "";
  const options = { nocase: true, dot: true };
  return sources.some((source) => {
    if (source.kind === "repo") {
      return (
        repo.provider !== "ado" && lower(repo.fullName) === lower(`${source.owner}/${source.name}`)
      );
    }
    if (source.kind === "owner") {
      if (repo.provider === "ado" || parts.length !== 2) return false;
      if (lower(parts[0] ?? "") !== lower(source.owner)) return false;
    } else {
      if (repo.provider !== "ado" || parts.length !== 3) return false;
      if (lower(parts[0] ?? "") !== lower(source.organization)) return false;
      if (source.project !== null && lower(parts[1] ?? "") !== lower(source.project)) return false;
    }
    const excluded = source.exclude.length > 0 && picomatch(source.exclude, options)(name);
    return !excluded && picomatch(source.include, options)(name);
  });
}
