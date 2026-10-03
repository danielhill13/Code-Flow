import picomatch from "picomatch";

/**
 * What a changed file is, for measuring size. Only `product` lines count toward PR size and
 * lines merged; the other buckets are kept so they can be shown, never silently dropped.
 */
export const BUCKETS = ["product", "test", "docs", "generated", "vendored", "lockfile"] as const;
export type Bucket = (typeof BUCKETS)[number];

export type PathRule = {
  /** Glob patterns, matched against the file's path from the repo root, ignoring case. */
  match: readonly string[];
  bucket: Bucket;
  /** owner/name globs this rule applies to; every repo when absent. */
  repos?: readonly string[];
};

/**
 * Generic rules every repo starts with, checked in order; the first match wins and anything
 * unmatched is product code. Order matters: a minified file inside a test folder is generated.
 */
export const DEFAULT_PATH_RULES: readonly PathRule[] = [
  {
    bucket: "lockfile",
    match: [
      "**/package-lock.json",
      "**/npm-shrinkwrap.json",
      "**/yarn.lock",
      "**/pnpm-lock.yaml",
      "**/bun.lock",
      "**/bun.lockb",
      "**/*.lock",
      "**/go.sum",
      "**/packages.lock.json",
      "**/gradle.lockfile",
      "**/*.lockfile",
    ],
  },
  {
    bucket: "vendored",
    match: [
      "**/vendor/**",
      "**/vendored/**",
      "**/third_party/**",
      "**/third-party/**",
      "**/thirdparty/**",
      "**/node_modules/**",
      "**/bower_components/**",
      "**/Pods/**",
      "**/Carthage/**",
    ],
  },
  {
    bucket: "generated",
    match: [
      "**/dist/**",
      "**/generated/**",
      "**/__generated__/**",
      "**/*.generated.*",
      "**/*.gen.*",
      "**/*.min.js",
      "**/*.min.css",
      "**/*.map",
      "**/__snapshots__/**",
      "**/*.snap",
      "**/*.pb.go",
      "**/*_pb2.py",
      "**/*_pb2_grpc.py",
      "**/*.pb.ts",
      "**/*.g.dart",
      "**/*.freezed.dart",
      "**/*.designer.cs",
      "**/coverage/**",
    ],
  },
  {
    bucket: "docs",
    match: [
      "**/*.md",
      "**/*.mdx",
      "**/*.rst",
      "**/*.adoc",
      "**/docs/**",
      "**/doc/**",
      "**/documentation/**",
      "**/LICENSE",
      "**/LICENSE.*",
      "**/CHANGELOG",
      "**/CHANGELOG.*",
    ],
  },
  {
    bucket: "test",
    match: [
      "**/test/**",
      "**/tests/**",
      "**/__tests__/**",
      "**/spec/**",
      "**/specs/**",
      "**/e2e/**",
      "**/testdata/**",
      "**/fixtures/**",
      "**/__mocks__/**",
      "**/cypress/**",
      "**/playwright/**",
      "**/*.test.*",
      "**/*.spec.*",
      "**/*.e2e.*",
      "**/*_test.go",
      "**/*_test.py",
      "**/test_*.py",
      "**/*Test.java",
      "**/*Tests.java",
      "**/*Test.kt",
      "**/*Tests.cs",
      "**/*Test.cs",
    ],
  },
];

/**
 * A classifier: configured rules first, in order, then the defaults. The first rule whose
 * patterns match the path, and whose repos (if any) match the repo, decides the bucket.
 */
export function pathClassifier(
  configured: readonly PathRule[] = [],
): (repo: string, path: string) => Bucket {
  const options = { nocase: true, dot: true };
  const rules = [...configured, ...DEFAULT_PATH_RULES].map((rule) => ({
    bucket: rule.bucket,
    matches: picomatch([...rule.match], options),
    appliesTo: rule.repos ? picomatch([...rule.repos], options) : () => true,
  }));
  return (repo, path) => {
    for (const rule of rules) {
      if (rule.appliesTo(repo) && rule.matches(path)) return rule.bucket;
    }
    return "product";
  };
}
