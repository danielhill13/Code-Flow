// Test data builders. Excluded from the published build.
import type { OwnerSource } from "../config/schema.ts";
import type { Repo } from "../providers/github/discover.ts";

export function repo(name: string, overrides: Partial<Repo> = {}): Repo {
  return {
    id: `id-${name}`,
    owner: "acme",
    name,
    fullName: `acme/${name}`,
    defaultBranch: "main",
    archived: false,
    fork: false,
    empty: false,
    private: false,
    prs: { open: 0, merged: 0, closed: 0 },
    lastPrActivity: null,
    ...overrides,
  };
}

export function ownerSource(overrides: Partial<OwnerSource> = {}): OwnerSource {
  return {
    kind: "owner",
    owner: "acme",
    include: ["*"],
    exclude: [],
    archived: false,
    forks: false,
    ...overrides,
  };
}
