// AI markers (decision D57): the traces an AI coding tool leaves on a pull request. A PR is
// AI-assisted when it shows at least one. Each is a convention a tool follows by default, so the
// markers find what a tool left, not every use of one: a PR written with help and no trace reads
// as no markers, never as "not AI".
import picomatch from "picomatch";
import type { Actor, PrModel } from "./model.ts";

/**
 * Kinds of trace, in the order the report lists them:
 * - `thoughts`: it changes files in a thoughts/ folder, where agent workflows keep research and
 *   plans;
 * - `claudeDir`: it changes Claude Code's .claude/ folder (settings, commands, agents);
 * - `claudeMd`: it changes a CLAUDE.md, Claude Code's instructions for the repo;
 * - `agentFiles`: it changes another tool's instructions or settings (AGENTS.md, .cursor/,
 *   copilot-instructions.md and the like);
 * - `signature`: its description or a commit says a tool wrote it ("Generated with Claude Code",
 *   a Co-Authored-By trailer naming one);
 * - `agentAuthor`: a coding agent opened it (Copilot's, Devin, Jules, Codex);
 * - `agentBranch`: its branch is named the way an agent names one (claude/…, copilot/…);
 * - `custom`: one of the org's own markers (config `ai_markers`).
 */
export type AiMarker =
  | "thoughts"
  | "claudeDir"
  | "claudeMd"
  | "agentFiles"
  | "signature"
  | "agentAuthor"
  | "agentBranch"
  | "custom";

export const AI_MARKERS: readonly AiMarker[] = [
  "thoughts",
  "claudeDir",
  "claudeMd",
  "agentFiles",
  "signature",
  "agentAuthor",
  "agentBranch",
  "custom",
];

export const AI_MARKER_LABELS: Record<AiMarker, string> = {
  thoughts: "thoughts/ folder",
  claudeDir: ".claude/ folder",
  claudeMd: "CLAUDE.md",
  agentFiles: "Other agent files",
  signature: "Signature",
  agentAuthor: "Opened by an agent",
  agentBranch: "Agent branch",
  custom: "Your own marker",
};

/** As a list's cell shows them. */
export const AI_MARKER_SHORT: Record<AiMarker, string> = {
  thoughts: "thoughts/",
  claudeDir: ".claude/",
  claudeMd: "CLAUDE.md",
  agentFiles: "agent files",
  signature: "signature",
  agentAuthor: "agent",
  agentBranch: "branch",
  custom: "own",
};

export const AI_MARKER_HELP: Record<AiMarker, string> = {
  thoughts: "Changes files in a thoughts/ folder, where agent workflows keep research and plans.",
  claudeDir: "Changes Claude Code's .claude/ folder: its settings, commands or agents.",
  claudeMd: "Changes a CLAUDE.md, Claude Code's instructions for the repo.",
  agentFiles:
    "Changes another AI tool's instructions or settings: AGENTS.md, GEMINI.md, .cursor/, .github/copilot-instructions.md, .windsurfrules and the like.",
  signature:
    'Its description or a commit message says a tool wrote it: "Generated with Claude Code", a Co-Authored-By trailer naming an AI tool, a link to an agent\'s session.',
  agentAuthor: "Opened by a coding agent's account: Copilot's, Devin, Jules, Codex and the like.",
  agentBranch: "Its branch is named the way an agent names one: claude/…, copilot/…, codex/….",
  custom: "Matches one of the org's own markers (ai_markers in org.yml).",
};

/** The tool a trace names, where it names one. */
export type AiTool =
  | "Claude"
  | "Copilot"
  | "Cursor"
  | "Codex"
  | "Gemini"
  | "Devin"
  | "Aider"
  | "Windsurf"
  | "Amazon Q"
  | "Other";

/** One marker on a PR, with the first place it was seen. */
export type AiSign = {
  marker: AiMarker;
  /** The tool it names; null when it names none (a thoughts/ folder could be any tool's). */
  tool: AiTool | null;
  /** Where it was seen, shortened: a path, "commit 1a2b3c4: Co-Authored-By: Claude", a branch. */
  where: string;
};

/** The org's own markers, added to the built-in ones, and built-in ones it doesn't trust. */
export type AiMarkerConfig = {
  files: readonly string[];
  /** Regular expressions, ignoring case, tested on the title, description and commit messages. */
  text: readonly string[];
  branches: readonly string[];
  authors: readonly string[];
  /** Built-in markers not to read: a team that keeps human notes in thoughts/, say. */
  ignore: readonly AiMarker[];
};

export const NO_AI_CONFIG: AiMarkerConfig = {
  files: [],
  text: [],
  branches: [],
  authors: [],
  ignore: [],
};

type FileRule = { marker: AiMarker; tool: AiTool | null; match: (path: string) => boolean };

const glob = (patterns: string | string[]) => picomatch(patterns, { nocase: true, dot: true });

const FILE_RULES: readonly FileRule[] = [
  { marker: "thoughts", tool: null, match: glob(["thoughts/**", "**/thoughts/**"]) },
  { marker: "claudeDir", tool: "Claude", match: glob(["**/.claude/**", ".claude/**"]) },
  { marker: "claudeMd", tool: "Claude", match: glob(["**/CLAUDE.md", "**/CLAUDE.local.md"]) },
  {
    marker: "agentFiles",
    tool: "Copilot",
    match: glob([
      "**/.github/copilot-instructions.md",
      "**/.github/instructions/**",
      "**/.github/prompts/**",
      "**/.github/chatmodes/**",
    ]),
  },
  {
    marker: "agentFiles",
    tool: "Cursor",
    match: glob(["**/.cursorrules", "**/.cursor/**", "**/.cursorignore"]),
  },
  { marker: "agentFiles", tool: "Gemini", match: glob(["**/GEMINI.md", "**/.gemini/**"]) },
  { marker: "agentFiles", tool: "Windsurf", match: glob(["**/.windsurfrules", "**/.windsurf/**"]) },
  {
    marker: "agentFiles",
    tool: "Aider",
    match: glob(["**/.aider.conf.yml", "**/.aiderignore", "**/CONVENTIONS.md"]),
  },
  { marker: "agentFiles", tool: "Amazon Q", match: glob(["**/.amazonq/**"]) },
  { marker: "agentFiles", tool: "Codex", match: glob(["**/.codex/**"]) },
  {
    marker: "agentFiles",
    tool: "Other",
    match: glob([
      "**/AGENTS.md",
      "**/.clinerules",
      "**/.clinerules/**",
      "**/.roo/**",
      "**/.kiro/**",
      "**/.continue/**",
      "**/.junie/**",
      "**/.agents/**",
      "**/.mcp.json",
    ]),
  },
];

/** A tool's names in text: what a signature or a co-author trailer calls it. */
const TOOL_WORDS: readonly [AiTool, string][] = [
  ["Claude", "claude(?:[ -]code)?|anthropic"],
  ["Copilot", "(?:github )?copilot"],
  ["Cursor", "cursor(?:[ -]agent)?"],
  ["Codex", "(?:openai )?codex|chatgpt"],
  ["Gemini", "gemini(?:[ -]cli)?|jules"],
  ["Devin", "devin(?:-ai)?"],
  ["Aider", "aider"],
  ["Windsurf", "windsurf|codeium"],
  ["Amazon Q", "amazon q(?: developer)?"],
  ["Other", "openhands|cline|roo code|kiro|sweep|tabnine|cody|qodo|continue\\.dev|junie"],
];

const ANY_TOOL = TOOL_WORDS.map(([, words]) => words).join("|");

/** Phrases a tool signs with, each naming the tool in its first group. */
const SIGNATURES: readonly RegExp[] = [
  // "🤖 Generated with [Claude Code](…)", "Generated by Copilot", "written with Cursor"
  new RegExp(
    `\\b(?:generated|written|created|authored|coded|built|drafted)\\s+(?:with|by|using|via|in)\\s+\\[?(${ANY_TOOL})\\b`,
    "i",
  ),
  // "Co-Authored-By: Claude <noreply@anthropic.com>", "Co-authored-by: Copilot <…>"
  new RegExp(`^co-authored-by:\\s*(?:[^<\\n]*?\\b)?(${ANY_TOOL})\\b`, "im"),
  // Aider's commit prefix: "aider: fix the parser"
  /^(aider):/im,
];

/** Traces that name the tool by where they point: a session or task link, a known address. */
const LINKS: readonly [AiTool, RegExp][] = [
  ["Claude", /noreply@anthropic\.com|claude\.ai\/code/i],
  ["Codex", /chatgpt\.com\/codex/i],
  ["Cursor", /cursor\.com\/(?:background-agent|agents)|cursoragent@cursor\.com/i],
  ["Devin", /app\.devin\.ai\/sessions|link to devin run/i],
  ["Copilot", /copilot@users\.noreply\.github\.com|<!-- start copilot coding agent/i],
  ["Aider", /noreply@aider\.chat/i],
  ["Gemini", /jules\.google\.com/i],
  ["Other", /all-hands\.dev/i],
];

/** Accounts coding agents open PRs as, without "[bot]". */
const AGENT_AUTHORS: readonly [AiTool, RegExp][] = [
  ["Copilot", /^(?:copilot|copilot-swe-agent)$/i],
  ["Devin", /^devin-ai-integration$/i],
  ["Gemini", /^google-labs-jules$/i],
  ["Codex", /^(?:chatgpt-codex-connector|codex|openai-codex)$/i],
  ["Cursor", /^(?:cursor|cursoragent|cursor-agent)$/i],
  ["Claude", /^claude$/i],
  ["Amazon Q", /^amazon-q-developer$/i],
  ["Other", /^(?:openhands-agent|sweep-ai|factory-droid|sourcegraph-cody)$/i],
];

/** Branch prefixes agents name their branches with. */
const AGENT_BRANCHES: readonly [AiTool, RegExp][] = [
  ["Claude", /^claude\//i],
  ["Copilot", /^copilot\//i],
  ["Codex", /^codex\//i],
  ["Cursor", /^cursor\//i],
  ["Devin", /^devin\//i],
  ["Gemini", /^jules\//i],
  ["Other", /^(?:openhands|sweep|aider)\//i],
];

const toolIn = (text: string): AiTool => {
  for (const [tool, words] of TOOL_WORDS) {
    if (new RegExp(`^(?:${words})$`, "i").test(text.trim())) return tool;
  }
  return "Other";
};

/** A line of text around a match, short enough to show. */
function excerpt(text: string, index: number): string {
  const start = text.lastIndexOf("\n", index) + 1;
  const end = text.indexOf("\n", index);
  const line = text.slice(start, end === -1 ? undefined : end).trim();
  return line.length > 80 ? `${line.slice(0, 77)}…` : line;
}

/** Compiles an org's markers once, for every PR of a derive. */
export function aiReader(config: AiMarkerConfig = NO_AI_CONFIG): (pr: PrModel) => AiSign[] {
  const ignored = new Set(config.ignore);
  const customFiles = config.files.length > 0 ? glob([...config.files]) : null;
  const customText = config.text.map((pattern) => new RegExp(pattern, "im"));
  const customBranches = config.branches.length > 0 ? glob([...config.branches]) : null;
  const customAuthors = config.authors.length > 0 ? glob([...config.authors]) : null;

  return (pr) => {
    const found = new Map<AiMarker, AiSign>();
    const add = (sign: AiSign) => {
      if (!ignored.has(sign.marker) && !found.has(sign.marker)) found.set(sign.marker, sign);
    };

    for (const file of pr.files) {
      for (const rule of FILE_RULES) {
        if (!found.has(rule.marker) && rule.match(file.path)) {
          add({ marker: rule.marker, tool: rule.tool, where: file.path });
        }
      }
      if (customFiles?.(file.path)) add({ marker: "custom", tool: null, where: file.path });
    }

    const texts: { where: string; text: string }[] = [
      { where: "description", text: pr.body },
      ...pr.commits.map((commit) => ({
        where: `commit ${commit.sha.slice(0, 7)}`,
        text: commit.message,
      })),
    ];
    for (const { where, text } of texts) {
      if (found.has("signature")) break;
      for (const pattern of SIGNATURES) {
        const match = pattern.exec(text);
        if (match) {
          add({
            marker: "signature",
            tool: toolIn(match[1] ?? ""),
            where: `${where}: ${excerpt(text, match.index)}`,
          });
          break;
        }
      }
      if (found.has("signature")) break;
      for (const [tool, pattern] of LINKS) {
        const match = pattern.exec(text);
        if (match) {
          add({ marker: "signature", tool, where: `${where}: ${excerpt(text, match.index)}` });
          break;
        }
      }
    }
    for (const { where, text } of [{ where: "title", text: pr.title }, ...texts]) {
      if (found.has("custom")) break;
      const index = customText.findIndex((pattern) => pattern.test(text));
      if (index >= 0) {
        const match = customText[index]?.exec(text);
        add({
          marker: "custom",
          tool: null,
          where: `${where}: ${excerpt(text, match?.index ?? 0)}`,
        });
      }
    }

    const login = loginOf(pr.author);
    for (const [tool, pattern] of AGENT_AUTHORS) {
      if (pattern.test(login)) {
        add({ marker: "agentAuthor", tool, where: pr.author?.login ?? login });
        break;
      }
    }
    if (customAuthors?.(login))
      add({ marker: "custom", tool: null, where: pr.author?.login ?? login });

    for (const [tool, pattern] of AGENT_BRANCHES) {
      if (pattern.test(pr.headBranch)) {
        add({ marker: "agentBranch", tool, where: pr.headBranch });
        break;
      }
    }
    if (customBranches?.(pr.headBranch))
      add({ marker: "custom", tool: null, where: pr.headBranch });

    return AI_MARKERS.flatMap((marker) => {
      const sign = found.get(marker);
      return sign ? [sign] : [];
    });
  };
}

/** "copilot-swe-agent[bot]" → "copilot-swe-agent"; lower case. */
function loginOf(actor: Actor | null): string {
  return (actor?.login ?? "").replace(/\[bot\]$/i, "").toLowerCase();
}

/** The tools a PR's markers name, once each, A–Z. */
export function toolsOf(signs: readonly AiSign[]): AiTool[] {
  return [...new Set(signs.flatMap((sign) => (sign.tool ? [sign.tool] : [])))].sort();
}
