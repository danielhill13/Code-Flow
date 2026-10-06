import { describe, expect, it } from "vitest";
import { at, deriveRules, prFact } from "../testing/factories.ts";
import { linkDuplicates, ticketsOf } from "./duplicates.ts";
import type { PrFact } from "./facts.ts";

const PATTERN = /\b(?:ADO-)?(\d{5})\b/i;
const rules = { ticketPattern: PATTERN };

/** A merged PR into `base` on `day`, titled `title`, counted unless a test says otherwise. */
function pr(
  number: number,
  base: string,
  day: string,
  title: string,
  head = `topic/${number}`,
): PrFact {
  return prFact(
    {
      number,
      baseBranch: base,
      headBranch: head,
      title,
      mergedAt: at(`${day} 10:00`),
      closedAt: at(`${day} 10:00`),
    },
    deriveRules({
      isMeasuredBranch: (_repo, branch) => branch === "prod" || branch === "develop",
      ...rules,
    }),
  );
}

describe("ticket IDs [rule 17]", () => {
  it("are read from the branch, title and description, the capture group as the ID", () => {
    expect(ticketsOf({ headBranch: "defect/x", title: "Fix ADO-12340 login" }, PATTERN)).toEqual([
      "12340",
    ]);
    expect(ticketsOf({ headBranch: "fix-12340", title: "Fix login (12340)" }, PATTERN)).toEqual([
      "12340",
    ]);
    expect(
      ticketsOf({ headBranch: "x", title: "Tidy", body: "Fixes ado-55555 and 12340" }, PATTERN),
    ).toEqual(["12340", "55555"]);
    // Not five digits on its own: a version, a longer number.
    expect(ticketsOf({ headBranch: "x", title: "Bump to 123456, v1.2345" }, PATTERN)).toEqual([]);
    expect(ticketsOf({ headBranch: "ADO-1", title: "ADO-12340" }, null)).toEqual([]);
  });
});

describe("duplicates: one ticket landed on two branches [rule 17]", () => {
  it("counts a fix where it first landed, and not again on another branch", () => {
    const fix = pr(1, "prod", "03-04", "ADO-12340 Fix login", "defect/login");
    // The ID in both the branch name and the title, without its prefix: still one ticket.
    const again = pr(2, "develop", "03-06", "Bring 12340 login fix to develop", "port/12340-login");
    const story = pr(3, "develop", "03-07", "ADO-55555 New report");
    const facts = [fix, again, story];
    linkDuplicates(facts);
    expect(fix).toMatchObject({ counted: true, exclusion: null });
    expect(again).toMatchObject({ counted: false, exclusion: "duplicate", duplicateOf: 1 });
    expect(story).toMatchObject({ counted: true });
  });

  it("keeps every PR of one ticket into the same branch: a story in parts is separate work", () => {
    const parts = [
      pr(1, "develop", "03-04", "ADO-12340 part 1"),
      pr(2, "develop", "03-05", "ADO-12340 part 2"),
      pr(3, "develop", "03-06", "ADO-12340 part 3"),
    ];
    linkDuplicates(parts);
    expect(parts.every((p) => p.counted)).toBe(true);
  });

  it("leaves alone PRs already not counted, and PRs with no ticket", () => {
    const promoted = pr(1, "prod", "03-04", "ADO-12340 release");
    promoted.counted = false;
    promoted.exclusion = "promotion";
    const plain = pr(2, "develop", "03-05", "Tidy up");
    const later = pr(3, "develop", "03-06", "ADO-12340 the fix");
    linkDuplicates([promoted, plain, later]);
    expect(later.counted).toBe(true);
    expect(plain.counted).toBe(true);
  });
});
