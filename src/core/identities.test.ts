import { describe, expect, it } from "vitest";
import { prFact } from "../testing/factories.ts";
import {
  type Host,
  identitiesOf,
  mergePeople,
  type PersonRaw,
  separate,
  suggestMerges,
} from "./identities.ts";

const pr = (repoId: string, author: string, ...others: [string, string | null][]) =>
  ({
    ...prFact({}),
    repoId,
    author,
    identities: [[author, null] as [string, string | null], ...others].map(([login, name]) => ({
      login,
      name,
    })),
  }) as ReturnType<typeof prFact>;

const hostOf = (repoId: string): Host => (repoId.startsWith("ado:") ? "ado" : "github");

describe("identities", () => {
  const facts = [
    pr("gh", "ana", ["devon", null]),
    pr("gh", "dlee"),
    pr("gh", "dependabot[bot]"),
    pr("ado:1", "ana@acme.com", ["devon.lee@acme.com", "Devon Lee"]),
    pr("ado:1", "devon.lee@acme.com", ["mika@acme.com", "Mika Sato"]),
    pr("ado:1", "Build\\1234"),
  ];

  it("lists every account by host, with its activity and person, leaving services out", () => {
    const people: Record<string, PersonRaw> = {
      mika: { name: "Mika Sato", ado: ["mika@acme.com"] },
    };
    const list = identitiesOf(facts, hostOf, people);
    expect(list.map((i) => `${i.host}:${i.login}`).sort()).toEqual([
      "ado:ana@acme.com",
      "ado:devon.lee@acme.com",
      "ado:mika@acme.com",
      "github:ana",
      "github:devon",
      "github:dlee",
    ]);
    const devon = list.find((i) => i.login === "devon.lee@acme.com");
    expect(devon).toMatchObject({ name: "Devon Lee", authored: 1, involved: 2, person: null });
    expect(list.find((i) => i.login === "mika@acme.com")?.person).toBe("mika");
  });

  it("suggests GitHub and Azure DevOps accounts that look like one person, strongest first [D42]", () => {
    const suggestions = suggestMerges(identitiesOf(facts, hostOf, {}));
    expect(suggestions[0]).toMatchObject({
      github: "ana",
      ado: "ana@acme.com",
      strength: "strong",
      ambiguous: false,
    });
    const devon = suggestions.filter((s) => s.ado === "devon.lee@acme.com");
    // "dlee" (initial and surname) and "devon" (first name) both fit: look before merging.
    expect(devon.map((s) => s.github).sort()).toEqual(["devon", "dlee"]);
    expect(devon.every((s) => s.strength === "likely" && s.ambiguous)).toBe(true);
  });

  it("doesn't suggest what is one person already, or two people", () => {
    const people: Record<string, PersonRaw> = {
      ana: { ado: ["ana@acme.com"] },
      dlee: {},
      devon: {},
    };
    const suggestions = suggestMerges(identitiesOf(facts, hostOf, people));
    expect(suggestions.find((s) => s.github === "ana")).toBeUndefined();
    expect(suggestions.filter((s) => s.ado === "devon.lee@acme.com")).toHaveLength(2);
  });
});

describe("mergePeople", () => {
  it("makes one person of a GitHub login and an Azure DevOps sign-in", () => {
    expect(
      mergePeople({}, { key: "ana", name: "Ana Ruiz", github: ["ana"], ado: ["ana@acme.com"] }),
    ).toEqual({
      ana: { name: "Ana Ruiz", ado: ["ana@acme.com"] },
    });
  });

  it("adds to an existing person, and takes the accounts from anyone else who had them", () => {
    const people: Record<string, PersonRaw> = {
      devon: { name: "Devon Lee", internal: true },
      dlee: { github: ["dlee", "dlee-old"] },
      shadow: { ado: ["devon.lee@acme.com"], github: [] },
    };
    const merged = mergePeople(people, {
      key: "devon",
      github: ["dlee"],
      ado: ["devon.lee@acme.com"],
    });
    expect(merged).toEqual({
      devon: {
        name: "Devon Lee",
        github: ["devon", "dlee"],
        ado: ["devon.lee@acme.com"],
        internal: true,
      },
      dlee: { github: ["dlee-old"] },
    });
  });

  it("gives an Azure DevOps-only person no GitHub login, so the key doesn't claim one", () => {
    const merged = mergePeople({}, { key: "mika", github: [], ado: ["mika@acme.com"] });
    expect(merged.mika).toEqual({ github: [], ado: ["mika@acme.com"] });
  });

  it("separates one account again", () => {
    const people = { ana: { name: "Ana", ado: ["ana@acme.com"] } };
    expect(separate(people, "ana@acme.com")).toEqual({ ana: { name: "Ana" } });
    expect(separate(people, "ana")).toEqual({
      ana: { name: "Ana", github: [], ado: ["ana@acme.com"] },
    });
  });
});
