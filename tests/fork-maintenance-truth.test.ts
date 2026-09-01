import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const repoUrl = new URL("../", import.meta.url);
const packageText = readFileSync(new URL("package.json", repoUrl), "utf8");
const changes = readFileSync(new URL("FORK_CHANGES.md", repoUrl), "utf8");
const automation = readFileSync(new URL("docs/fork-sync-automation.md", repoUrl), "utf8");
const repairPlan = readFileSync(
  new URL("docs/superpowers/plans/2026-09-01-v238-fork-important-repairs.md", repoUrl),
  "utf8",
);

function currentGitBlob(path: string): string {
  const bytes = readFileSync(new URL(path, repoUrl));
  const header = Buffer.from(`blob ${bytes.byteLength}\0`, "utf8");
  return createHash("sha1").update(header).update(bytes).digest("hex");
}

const EXPECTED_OVERLAPS = [
  "gui/src/i18n/de.ts",
  "gui/src/i18n/en.ts",
  "gui/src/i18n/fr.ts",
  "gui/src/i18n/ja.ts",
  "gui/src/i18n/ko.ts",
  "gui/src/i18n/ru.ts",
  "gui/src/i18n/tr.ts",
  "gui/src/i18n/zh-TW.ts",
  "gui/src/i18n/zh.ts",
  "package.json",
  "src/adapters/base.ts",
  "src/adapters/openai-responses.ts",
  "src/server/responses/core.ts",
  "src/usage/log.ts",
  "tests/openai-responses-passthrough.test.ts",
  "tests/update-stop-first.test.ts",
] as const;

const EXPECTED_AUTO_MERGES = EXPECTED_OVERLAPS.filter(path => path !== "package.json");
const EXPECTED_V238_OVERLAP_PATHS = [
  "bin/ocx.mjs",
  "gui/src/i18n/de.ts",
  "gui/src/i18n/en.ts",
  "gui/src/i18n/fr.ts",
  "gui/src/i18n/ja.ts",
  "gui/src/i18n/ko.ts",
  "gui/src/i18n/ru.ts",
  "gui/src/i18n/tr.ts",
  "gui/src/i18n/zh-TW.ts",
  "gui/src/i18n/zh.ts",
  "package.json",
  "src/codex/catalog/provider-fetch.ts",
  "src/codex/catalog/sync.ts",
  "src/config.ts",
  "src/server/management/provider-routes.ts",
  "src/update/index.ts",
  "structure/04_transports-and-sidecars.md",
] as const;
const EXPECTED_V238_CONFLICT_PATHS = ["package.json"] as const;
const EXPECTED_PACKAGE_DECISION = {
  official: "version 2.38.0",
  fork: "install:local script",
  resolution: "双方保留并收敛为 2.38.0-ben.2",
  tests: "tests/release-version-line.test.ts,tests/fork-version-policy.test.ts",
} as const;
const EXPECTED_DEV_PROMOTION = "发布瞬间当前已验证 dev 与 main/sync/Fork Tag 收敛到 RELEASE_COMMIT；发布后 advanced dev 不得被自动重置回旧 RELEASE_COMMIT";
const EXPECTED_V238_KEYS = [
  "official_old",
  "official_new",
  "candidate_branch",
  "candidate_before",
  "candidate_after",
  "overlap_path_count",
  "auto_merge_path_count",
  "overlap_paths",
  "content_conflict_count",
  "content_conflicts",
  "decision_package_json",
  "dev_promotion",
  "tests",
] as const;
const EXPECTED_V239_OVERLAP_PATHS = [
  "bin/ocx.mjs",
  "gui/src/i18n/de.ts",
  "gui/src/i18n/en.ts",
  "gui/src/i18n/fr.ts",
  "gui/src/i18n/ja.ts",
  "gui/src/i18n/ko.ts",
  "gui/src/i18n/ru.ts",
  "gui/src/i18n/tr.ts",
  "gui/src/i18n/zh-TW.ts",
  "gui/src/i18n/zh.ts",
  "gui/src/pages/Logs.tsx",
  "package.json",
  "src/adapters/openai-responses.ts",
  "src/codex/catalog/provider-fetch.ts",
  "src/server/responses/encrypted-payload.ts",
  "src/update/index.ts",
  "tests/openai-responses-passthrough.test.ts",
  "tests/responses-state.test.ts",
  "tests/update-stop-first.test.ts",
] as const;
const EXPECTED_V239_CONFLICT_PATHS = ["bin/ocx.mjs", "package.json"] as const;
const EXPECTED_V239_KEYS = [
  "official_old",
  "official_new",
  "candidate_branch",
  "candidate_before",
  "candidate_after",
  "overlap_path_count",
  "auto_merge_path_count",
  "overlap_paths",
  "content_conflict_count",
  "content_conflicts",
  "decision_bin_ocx_mjs",
  "decision_package_json",
  "external_actions",
  "tests",
] as const;
const EXPECTED_V239_BIN_DECISION = "official=hasPendingTeardownIn；fork=forkUpdateDecision；resolution=双方 import 与调用链均保留；tests=tests/fork-version-policy.test.ts,tests/update-stop-first.test.ts";
const EXPECTED_V239_PACKAGE_DECISION = "official=version 2.39.0 与 package 表面；fork=install:local 与 ben 版本策略；resolution=保留官方表面并收敛为 2.39.0-ben.1；tests=tests/fork-version-policy.test.ts";
const EXPECTED_V239_EXTERNAL_ACTIONS = "full_release；rebase 默认要求完成验证、双审、annotated Fork Tag、六成员 atomic push 与 GitHub Release；仅用户明确叫停时中止";
const EXPECTED_V239_TESTS = "tests/fork-maintenance-truth.test.ts,tests/fork-version-policy.test.ts";
const EXPECTED_RELEASE_LIFECYCLE = [
  "rebase_branch=dev",
  "rebase_request=full_steps_1_to_15_unless_user_explicitly_stops",
  "sync_role=audit-release-ref",
  "release_instant_dev=must-equal-RELEASE_COMMIT",
  "post_release_advanced_dev=must-not-reset",
  "sync_ancestry=EXPECTED_REMOTE_SYNC-absent-or-ancestor-of-RELEASE_COMMIT",
  "final_convergence=local-remote-main-dev-sync-fork-tag-equal-RELEASE_COMMIT",
].join("\n");
const EXPECTED_RELEASE_LIFECYCLE_KEYS = [
  "rebase_branch",
  "rebase_request",
  "sync_role",
  "release_instant_dev",
  "post_release_advanced_dev",
  "sync_ancestry",
  "final_convergence",
] as const;
const EXPECTED_RELEASE_LIFECYCLE_RECORD = {
  rebase_branch: "dev",
  rebase_request: "full_steps_1_to_15_unless_user_explicitly_stops",
  sync_role: "audit-release-ref",
  release_instant_dev: "must-equal-RELEASE_COMMIT",
  post_release_advanced_dev: "must-not-reset",
  sync_ancestry: "EXPECTED_REMOTE_SYNC-absent-or-ancestor-of-RELEASE_COMMIT",
  final_convergence: "local-remote-main-dev-sync-fork-tag-equal-RELEASE_COMMIT",
} as const;
const EXPECTED_ATOMIC_REFSET = [
  ["branch", "main", "leased-force", "RELEASE_COMMIT:refs/heads/main"],
  ["branch", "dev", "leased-force", "RELEASE_COMMIT:refs/heads/dev"],
  ["branch", "sync", "leased-fast-forward", "RELEASE_COMMIT:refs/heads/sync/vX.Y.Z"],
  ["branch", "marker", "leased-force", "OFFICIAL_COMMIT:refs/heads/upstream-release"],
  ["tag", "official", "no-force-no-lease", "refs/tags/vX.Y.Z:refs/tags/vX.Y.Z"],
  ["tag", "fork", "no-force-no-lease", "refs/tags/vX.Y.Z-ben.N:refs/tags/vX.Y.Z-ben.N"],
] as const;
const EXPECTED_SAME_BASE_TAG_PREFLIGHT_KEYS = [
  "scope",
  "snapshot",
  "pre_local_tag",
  "pre_push",
  "post_push",
  "higher_revision",
  "other_drift",
  "post_success",
  "serialization",
  "toctou",
] as const;
const EXPECTED_SAME_BASE_TAG_PREFLIGHT = {
  scope: "strict-local-and-remote-vX.Y.Z-ben.N",
  snapshot: "name-raw-peeled",
  pre_local_tag: "freeze-local-baseline-and-remote-baseline",
  pre_push: "local-baseline-plus-exact-target-and-remote-baseline",
  post_push: "remote-baseline-or-remote-baseline-plus-exact-target",
  higher_revision: "fail-closed-at-every-checkpoint",
  other_drift: "fail-closed",
  post_success: "required-before-github-release",
  serialization: "single-publisher-required",
  toctou: "final-recheck-to-push-window-is-residual-risk",
} as const;

const EXPECTED_V236_CONFLICT_PATHS = [
  "package.json",
  "src/adapters/openai-responses.ts",
  "src/config.ts",
  "src/lib/upstream-retry.ts",
  "src/server/responses/core.ts",
] as const;

const EXPECTED_V236_OVERLAP_PATHS = [
  "docs-site/src/content/docs/reference/configuration/providers.md",
  "docs-site/src/content/docs/zh-cn/reference/configuration/providers.md",
  "gui/src/i18n/de.ts",
  "gui/src/i18n/en.ts",
  "gui/src/i18n/fr.ts",
  "gui/src/i18n/ja.ts",
  "gui/src/i18n/ko.ts",
  "gui/src/i18n/ru.ts",
  "gui/src/i18n/tr.ts",
  "gui/src/i18n/zh-TW.ts",
  "gui/src/i18n/zh.ts",
  "gui/src/pages/Logs.tsx",
  "package.json",
  "src/adapters/openai-responses.ts",
  "src/config.ts",
  "src/lib/upstream-retry.ts",
  "src/providers/registry.ts",
  "src/server/auth-cors.ts",
  "src/server/chat-native.ts",
  "src/server/management/provider-routes.ts",
  "src/server/responses-undeclared-tool-guard.ts",
  "src/server/responses/agent-task-recovery.ts",
  "src/server/responses/core.ts",
  "src/types/provider.ts",
  "tests/openai-responses-passthrough.test.ts",
] as const;

function machineBlock(source: string, name: string): string {
  const match = source.match(new RegExp(
    `<!-- ${name}:start -->\n([\\s\\S]*?)\n<!-- ${name}:end -->`,
  ));
  expect(match, `missing ${name} machine block`).not.toBeNull();
  return match![1]!;
}

function strictKeyValueBlock(
  source: string,
  name: string,
  expectedKeys: readonly string[],
): Record<string, string> {
  expect([...source.matchAll(new RegExp(`<!-- ${name}:start -->`, "g"))]).toHaveLength(1);
  expect([...source.matchAll(new RegExp(`<!-- ${name}:end -->`, "g"))]).toHaveLength(1);
  const lines = machineBlock(source, name).split("\n");
  if (lines.some(line => line.length === 0)) throw new Error(`${name} contains a blank row`);
  const entries: Array<[string, string]> = lines.map((line) => {
    const match = line.match(/^([a-z0-9_]+)=(.+)$/);
    if (!match) throw new Error(`invalid ${name} row: ${line}`);
    return [match[1]!, match[2]!];
  });
  const keys = entries.map(([key]) => key);
  if (new Set(keys).size !== keys.length) throw new Error(`${name} contains a duplicate key`);
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
    throw new Error(`${name} keys differ from the exact contract`);
  }
  return Object.fromEntries(entries);
}

function parsePackageDecision(value: string): Record<string, string> {
  const expectedKeys = Object.keys(EXPECTED_PACKAGE_DECISION);
  const entries: Array<[string, string]> = value.split("；").map((part) => {
    const match = part.match(/^([a-z_]+)=(.+)$/);
    if (!match) throw new Error(`invalid package decision part: ${part}`);
    return [match[1]!, match[2]!];
  });
  const keys = entries.map(([key]) => key);
  if (new Set(keys).size !== keys.length) throw new Error("package decision contains a duplicate key");
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
    throw new Error("package decision keys differ from the exact contract");
  }
  const parsed = Object.fromEntries(entries);
  if (JSON.stringify(parsed) !== JSON.stringify(EXPECTED_PACKAGE_DECISION)) {
    throw new Error("package decision values differ from the exact contract");
  }
  return parsed;
}

function strictReleaseLifecycle(source: string): string {
  const parsed = strictKeyValueBlock(source, "fork-release-lifecycle", EXPECTED_RELEASE_LIFECYCLE_KEYS);
  if (JSON.stringify(parsed) !== JSON.stringify(EXPECTED_RELEASE_LIFECYCLE_RECORD)) {
    throw new Error("release lifecycle values differ from the exact contract");
  }
  return machineBlock(source, "fork-release-lifecycle");
}

function strictSameBaseTagPreflight(source: string): Record<string, string> {
  const parsed = strictKeyValueBlock(
    source,
    "same-base-ben-preflight",
    EXPECTED_SAME_BASE_TAG_PREFLIGHT_KEYS,
  );
  if (JSON.stringify(parsed) !== JSON.stringify(EXPECTED_SAME_BASE_TAG_PREFLIGHT)) {
    throw new Error("same-base ben preflight values differ from the exact contract");
  }
  return parsed;
}

function backtickedPaths(lines: string[]): string[] {
  return lines.map((line) => {
    const match = line.match(/^- `([^`]+)`$/);
    expect(match, `invalid path row: ${line}`).not.toBeNull();
    return match![1]!;
  });
}

function section(title: string): string {
  const start = changes.indexOf(`### ${title}\n`);
  expect(start, `missing section ${title}`).toBeGreaterThanOrEqual(0);
  const next = changes.slice(start + 1).search(/\n#{1,3} /);
  return next === -1 ? changes.slice(start) : changes.slice(start, start + 1 + next);
}

function majorSection(title: string): string {
  const start = changes.indexOf(`## ${title}\n`);
  expect(start, `missing section ${title}`).toBeGreaterThanOrEqual(0);
  const next = changes.slice(start + 1).search(/\n## /);
  return next === -1 ? changes.slice(start) : changes.slice(start, start + 1 + next);
}

function parseAtomicRefset(block: string): string[][] {
  const lines = block.split("\n");
  if (lines.some(line => line.length === 0)) throw new Error("atomic refset contains a blank row");
  const rows = lines.map((line) => {
    const fields = line.split("|");
    if (fields.length !== 4 || fields.some(field => !field)) {
      throw new Error(`invalid atomic refset row: ${line}`);
    }
    return fields;
  });
  if (rows.length !== 6) throw new Error("atomic refset must contain exactly six rows");
  if (JSON.stringify(rows) !== JSON.stringify(EXPECTED_ATOMIC_REFSET)) {
    throw new Error("atomic refset differs from the exact six-member contract");
  }
  for (const [kind, name, policy, refspec] of rows) {
    if (kind === "branch" && !policy.startsWith("leased-")) throw new Error(`${name} branch is not leased`);
    if (kind === "tag" && policy !== "no-force-no-lease") throw new Error(`${name} tag policy is invalid`);
    if (kind === "tag" && refspec.startsWith("+")) throw new Error(`${name} tag refspec is forced`);
  }
  return rows;
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ");
}

describe("Fork maintenance truth", () => {
  test("records the exact ben package version and preserved ben.2 rebase-overlap truth", () => {
    const version = JSON.parse(packageText).version;
    expect(version).toMatch(/^\d+\.\d+\.\d+-ben\.\d+$/);
    expect(changes).toContain(`| Fork 包版本 | \`${version}\` |`);
    expect(changes).toContain(`| 本轮派生 Tag | \`v${version}\``);
    expect(changes).toContain("16 paths");
    expect(changes).not.toContain("当前为\n  `2.34.0-ben.2`");

    const lines = machineBlock(changes, "ben2-overlap").split("\n");
    expect(lines[0]).toBe("Conflict (1):");
    const autoMerge = lines.indexOf("Auto-merge (15):");
    expect(autoMerge).toBe(3);
    expect(lines.slice(1, autoMerge)).toEqual(["- `package.json`", ""]);

    const conflicts = backtickedPaths(lines.slice(1, autoMerge).filter(Boolean));
    const merges = backtickedPaths(lines.slice(autoMerge + 1));
    const union = [...conflicts, ...merges].sort();

    expect(conflicts).toEqual(["package.json"]);
    expect(merges).toEqual(EXPECTED_AUTO_MERGES);
    expect(union).toEqual(EXPECTED_OVERLAPS);
    expect(conflicts).toHaveLength(1);
    expect(merges).toHaveLength(15);
    expect(union).toHaveLength(16);
  });

  test("records the current v2.36 rebase conflict decisions separately from the historical ben.1 overlap", () => {
    const current = machineBlock(changes, "v236-rebase-conflicts");
    const rows = Object.fromEntries(current.split("\n").map((line) => {
      const match = line.match(/^([a-z0-9_]+)=(.+)$/);
      expect(match, `invalid v236-rebase-conflicts row: ${line}`).not.toBeNull();
      return [match![1]!, match![2]!];
    }));

    expect(rows.official_old).toBe("v2.35.0");
    expect(rows.official_new).toBe("v2.36.0");
    expect(rows.overlap_path_count).toBe("25");
    expect(rows.content_conflict_count).toBe("5");
    const overlapPaths = rows.overlap_paths?.split(",");
    expect(overlapPaths).toEqual(EXPECTED_V236_OVERLAP_PATHS);
    expect(new Set(overlapPaths).size).toBe(25);
    expect(rows.content_conflicts?.split(",")).toEqual(EXPECTED_V236_CONFLICT_PATHS);
    for (const path of EXPECTED_V236_CONFLICT_PATHS) expect(overlapPaths).toContain(path);

    for (const path of EXPECTED_V236_CONFLICT_PATHS) {
      const key = `decision_${path.replaceAll("/", "_").replaceAll(".", "_").replaceAll("-", "_")}`;
      const decision = rows[key];
      expect(decision, `missing v2.36 decision for ${path}`).toBeDefined();
      expect(decision).toContain("official=");
      expect(decision).toContain("fork=");
      expect(decision).toContain("resolution=");
      expect(decision).toContain("tests=");
    }

    expect(changes.indexOf("<!-- ben2-overlap:start -->")).toBeGreaterThan(current.indexOf("official_old=v2.35.0"));
  });

  test("records the complete current v2.38 overlap and conflict account", () => {
    const rows = strictKeyValueBlock(changes, "v238-rebase", EXPECTED_V238_KEYS);

    expect(rows.official_old).toBe("v2.37.0");
    expect(rows.official_new).toBe("v2.38.0");
    expect(rows.candidate_branch).toBe("dev");
    expect(rows.candidate_before).toBe("09fbd1453fa2c374d5d0e9cad9ae15cf86cf7e8f");
    expect(rows.candidate_after).toBe("fac328f9465b4ce17abddf7fec2df006c9a58aa0");
    expect(rows.overlap_path_count).toBe("17");
    expect(rows.auto_merge_path_count).toBe("16");
    expect(rows.content_conflict_count).toBe("1");
    const overlapPaths = rows.overlap_paths?.split(",");
    expect(overlapPaths).toEqual(EXPECTED_V238_OVERLAP_PATHS);
    expect(new Set(overlapPaths).size).toBe(17);
    expect(rows.content_conflicts?.split(",")).toEqual(EXPECTED_V238_CONFLICT_PATHS);
    for (const path of EXPECTED_V238_CONFLICT_PATHS) expect(overlapPaths).toContain(path);
    expect(parsePackageDecision(rows.decision_package_json)).toEqual(EXPECTED_PACKAGE_DECISION);
    expect(rows.dev_promotion).toBe(EXPECTED_DEV_PROMOTION);
    expect(rows.tests).toBe("tests/fork-maintenance-truth.test.ts,tests/fork-version-policy.test.ts,tests/fork-ci-official-baseline.test.ts");
  });

  test("rejects ambiguous or incomplete current rebase machine blocks", () => {
    const valid = machineBlock(changes, "v238-rebase");
    const wrap = (block: string) => `<!-- v238-rebase:start -->\n${block}\n<!-- v238-rebase:end -->`;
    expect(() => strictKeyValueBlock(wrap(`${valid}\nofficial_old=v2.37.0`), "v238-rebase", EXPECTED_V238_KEYS)).toThrow();
    expect(() => strictKeyValueBlock(wrap(`${valid}\nunknown=value`), "v238-rebase", EXPECTED_V238_KEYS)).toThrow();
    expect(() => strictKeyValueBlock(wrap(valid.replace(/^tests=.+$/m, "")), "v238-rebase", EXPECTED_V238_KEYS)).toThrow();
    expect(() => strictKeyValueBlock(`${wrap(valid)}\n${wrap(valid)}`, "v238-rebase", EXPECTED_V238_KEYS)).toThrow();
    expect(() => strictKeyValueBlock(wrap(valid.replace("official_new=v2.38.0", "official_new=v2.38.0\n")), "v238-rebase", EXPECTED_V238_KEYS)).toThrow();
    const decision = `official=${EXPECTED_PACKAGE_DECISION.official}；fork=${EXPECTED_PACKAGE_DECISION.fork}；resolution=${EXPECTED_PACKAGE_DECISION.resolution}；tests=${EXPECTED_PACKAGE_DECISION.tests}`;
    expect(() => parsePackageDecision(`${decision}；official=wrong`)).toThrow();
    expect(() => parsePackageDecision(decision.replace("version 2.38.0", "wrong"))).toThrow();
    expect(() => {
      const altered = strictKeyValueBlock(
        wrap(valid.replace(EXPECTED_DEV_PROMOTION, "发布瞬间允许 advanced dev；发布后自动重置")),
        "v238-rebase",
        EXPECTED_V238_KEYS,
      );
      if (altered.dev_promotion !== EXPECTED_DEV_PROMOTION) throw new Error("invalid dev promotion contract");
    }).toThrow();
  });

  test("records the complete current v2.39 overlap and conflict account", () => {
    const rows = strictKeyValueBlock(changes, "v239-rebase", EXPECTED_V239_KEYS);
    expect(rows.official_old).toBe("v2.38.0");
    expect(rows.official_new).toBe("v2.39.0");
    expect(rows.candidate_branch).toBe("dev");
    expect(rows.candidate_before).toBe("1092cfb48b2e8f478c21e3fa9daf09bb002e7bef");
    expect(rows.candidate_after).toBe("6835e7ea163144c52d520231ed6df2830a9dac5d");
    expect(rows.overlap_path_count).toBe("19");
    expect(rows.auto_merge_path_count).toBe("17");
    expect(rows.content_conflict_count).toBe("2");
    const overlapPaths = rows.overlap_paths?.split(",");
    expect(overlapPaths).toEqual(EXPECTED_V239_OVERLAP_PATHS);
    expect(new Set(overlapPaths).size).toBe(19);
    expect(rows.content_conflicts?.split(",")).toEqual(EXPECTED_V239_CONFLICT_PATHS);
    for (const path of EXPECTED_V239_CONFLICT_PATHS) expect(overlapPaths).toContain(path);
    expect(rows.decision_bin_ocx_mjs).toBe(EXPECTED_V239_BIN_DECISION);
    expect(rows.decision_package_json).toBe(EXPECTED_V239_PACKAGE_DECISION);
    expect(rows.external_actions).toBe(EXPECTED_V239_EXTERNAL_ACTIONS);
    expect(rows.tests).toBe(EXPECTED_V239_TESTS);
  });

  test("rejects ambiguous or incomplete v2.39 rebase machine blocks", () => {
    const valid = machineBlock(changes, "v239-rebase");
    const wrap = (block: string) => `<!-- v239-rebase:start -->\n${block}\n<!-- v239-rebase:end -->`;
    const assertSemantics = (source: string) => {
      const rows = strictKeyValueBlock(source, "v239-rebase", EXPECTED_V239_KEYS);
      expect(rows.decision_bin_ocx_mjs).toBe(EXPECTED_V239_BIN_DECISION);
      expect(rows.decision_package_json).toBe(EXPECTED_V239_PACKAGE_DECISION);
      expect(rows.external_actions).toBe(EXPECTED_V239_EXTERNAL_ACTIONS);
      expect(rows.tests).toBe(EXPECTED_V239_TESTS);
    };
    expect(() => strictKeyValueBlock(wrap(`${valid}\nofficial_old=v2.38.0`), "v239-rebase", EXPECTED_V239_KEYS)).toThrow();
    expect(() => strictKeyValueBlock(wrap(`${valid}\nunknown=value`), "v239-rebase", EXPECTED_V239_KEYS)).toThrow();
    expect(() => strictKeyValueBlock(wrap(valid.replace(/^tests=.+$/m, "")), "v239-rebase", EXPECTED_V239_KEYS)).toThrow();
    expect(() => strictKeyValueBlock(`${wrap(valid)}\n${wrap(valid)}`, "v239-rebase", EXPECTED_V239_KEYS)).toThrow();
    expect(() => assertSemantics(wrap(valid.replace(EXPECTED_V239_BIN_DECISION, EXPECTED_V239_BIN_DECISION.replace("双方 import 与调用链均保留", "只保留官方"))))).toThrow();
    expect(() => assertSemantics(wrap(valid.replace(EXPECTED_V239_EXTERNAL_ACTIONS, "none；未授权 Tag，但 push 已发生")))).toThrow();
    expect(() => assertSemantics(wrap(valid.replace(EXPECTED_V239_TESTS, "tests/fork-maintenance-truth.test.ts")))).toThrow();
  });

  test("records the ben.3 39-to-5 squash boundary and pending external gates", () => {
    const block = machineBlock(changes, "ben3-squash");
    const rows = Object.fromEntries(block.split("\n").map((line) => {
      const match = line.match(/^([a-z0-9_]+)=(.+)$/);
      expect(match, `invalid ben3-squash row: ${line}`).not.toBeNull();
      return [match![1]!, match![2]!];
    }));

    expect(rows).toEqual({
      source_tag: "v2.35.0-ben.2",
      source_peeled: "42282c405dc4c3dcb4f1e2877b89ac6ab49eeaba",
      source_tree: "8499fcec058d61a42a4fa382118e4c7f92bbff58",
      source_commit_count: "39",
      squashed_commit_count: "5",
      c1: "4d91209a587a7dbc970cd179a14ce7cf21ec1642",
      c2: "7a35c99ec2529aac4fd011733b1617164248023b",
      c3: "b67df10538bd77556c72d12c3ea6167175049a79",
      c3_shared_tree: "8499fcec058d61a42a4fa382118e4c7f92bbff58",
      c3_shared_path_count: "112",
      c3_new_document_paths: "docs/superpowers/plans/2026-08-29-v2350-ben3-squash.md,docs/superpowers/specs/2026-08-29-v2350-ben3-squash-design.md",
      c3_total_delta_path_count: "114",
      c4: "fba9eadce2535cae6e76efee02695e9050262829",
      ben2_history: "immutable",
      ben3_annotated_tag: "pending external gate",
      candidate_cross_platform_ci: "pending external gate",
      atomic_promotion: "pending external gate",
      final_main_cross_platform_ci: "pending external gate",
      github_release: "pending external gate",
    });

    const squash = majorSection("v2.35.0-ben.3 全量历史压缩与发布边界");
    expect(squash).toContain("39 个线性");
    expect(squash).toContain("恰好 5 个语义提交");
    expect(squash).toContain("112 个共享路径逐 blob 等于 ben.2 tree");
    expect(squash).toContain("共有 114 个路径");
    expect(squash).toContain("保持不可变，不移动、不删除、不重建");
    expect(squash).toContain("尚未发生");
  });

  test("leaves external tagged-snapshot gates explicitly pending", () => {
    const block = machineBlock(changes, "ben2-external-gates");
    const lines = block.split("\n");
    expect(lines.slice(0, 2)).toEqual([
      "| Gate | Tagged snapshot state |",
      "| --- | --- |",
    ]);

    const rows = Object.fromEntries(lines.slice(2).map((line) => {
      const match = line.match(/^\| (.+) \| `(.+)` \|$/);
      expect(match, `invalid external-gate row: ${line}`).not.toBeNull();
      return [match![1]!, match![2]!];
    }));
    expect(rows).toEqual({
      "S2R candidate Cross-platform CI": "pending external gate",
      "Atomic promotion": "pending external gate",
      "Final main Cross-platform CI": "pending external gate",
      "GitHub Release": "pending external gate",
    });
    expect(block).not.toMatch(/https?:\/\//);
    expect(block).not.toMatch(/\brun\s+#?\d+/i);
    expect(block).not.toMatch(/\b(?:success|passed|completed)\b/i);
  });

  test("records the complete S2R candidate chain and preserved official Tags", () => {
    const block = machineBlock(changes, "ben2-s2r");
    const normalized = compactWhitespace(block);

    expect(normalized).toContain("`d5558096bb229b5fbf5607a6468c2871b2b1213e`");
    expect(normalized).toContain("`33234936660`");
    expect(normalized).toContain("`Prepare verified Fork official base`");
    expect(normalized).toContain("annotated-only");
    expect(normalized).toContain("type=`commit`");
    expect(normalized).toContain(
      "raw=peeled=marker=`fc4de772b58c13f7b16b5029b1e981d612a5db06`",
    );
    expect(normalized).toContain("`d252cb0e0ed67789c62d9aad5d2308aa5d04889b`");
    expect(normalized).toContain("`33236405510`");
    expect(normalized).toContain("official-base preparation 在 Linux/macOS 全部通过");
    expect(normalized).toContain("verifier-oracle");
    expect(normalized).toContain("process-wide verifier-root namespace为空");
    expect(normalized).toContain("`5548eb2a0d71d84bee03a4fa8424750bfdc78b85`");
    expect(normalized).toContain("`33236921544`");
    expect(normalized).toContain("成功但不可复用于新的 descendant");
    expect(normalized).toContain("Fork origin 对每个已 rebase 的官方版本保留同名官方 Tag");
    expect(normalized).toContain("`v2.34.0`");
    expect(normalized).toContain("raw=peeled=`80fff9a7f47332a4445df2b26ea175053fa55b0b`");
    expect(normalized).toContain("`v2.35.0`");
    expect(normalized).toContain("raw=peeled=`fc4de772b58c13f7b16b5029b1e981d612a5db06`");
    expect(normalized).toContain("promotion 时补齐");

    for (const gate of [
      "v2.35.0-ben.2 Tag",
      "Atomic promotion",
      "Final main Cross-platform CI",
      "GitHub Release",
    ]) {
      expect(normalized).toContain(`${gate}：未发生`);
    }

    const gates = machineBlock(changes, "ben2-external-gates");
    expect(gates).toContain("| S2R candidate Cross-platform CI | `pending external gate` |");
    expect(gates).toContain("| Atomic promotion | `pending external gate` |");
    expect(gates).toContain("| Final main Cross-platform CI | `pending external gate` |");
    expect(gates).toContain("| GitHub Release | `pending external gate` |");
  });

  test("requires the exact six-member atomic refset in every release contract", () => {
    const flows = [
      majorSection("没有新官方版本时的幂等收敛"),
      majorSection("每次稳定版 rebase 的强制流程"),
      automation,
    ];

    for (const flow of flows) {
      expect([...flow.matchAll(/<!-- official-atomic-refset:start -->/g)]).toHaveLength(1);
      expect([...flow.matchAll(/<!-- official-atomic-refset:end -->/g)]).toHaveLength(1);
      const block = machineBlock(flow, "official-atomic-refset");
      expect(parseAtomicRefset(block)).toEqual(EXPECTED_ATOMIC_REFSET);
      expect(strictReleaseLifecycle(flow)).toBe(EXPECTED_RELEASE_LIFECYCLE);
    }
  });

  test("freezes the complete same-base Fork Tag namespace before maintenance publication", () => {
    const flows = [
      majorSection("没有新官方版本时的幂等收敛"),
      majorSection("每次稳定版 rebase 的强制流程"),
      automation,
      repairPlan,
    ];
    for (const flow of flows) {
      expect(strictSameBaseTagPreflight(flow)).toEqual(EXPECTED_SAME_BASE_TAG_PREFLIGHT);
    }

    const valid = machineBlock(automation, "same-base-ben-preflight");
    const duplicate = `${automation}\n<!-- same-base-ben-preflight:start -->\n${valid}\n<!-- same-base-ben-preflight:end -->`;
    expect(() => strictSameBaseTagPreflight(duplicate)).toThrow();
    expect(() => strictSameBaseTagPreflight(automation.replace(
      "local-baseline-plus-exact-target-and-remote-baseline",
      "local-baseline-plus-any-target-and-remote-baseline",
    ))).toThrow();
  });

  test("rejects duplicate or contradictory release lifecycle blocks", () => {
    const valid = machineBlock(automation, "fork-release-lifecycle");
    const duplicate = `${automation}\n<!-- fork-release-lifecycle:start -->\n${valid.replace("must-not-reset", "may-reset")}\n<!-- fork-release-lifecycle:end -->`;
    expect(() => strictReleaseLifecycle(duplicate)).toThrow();
  });

  test("rejects atomic refsets with an extra row, missing lease, or forced Tag", () => {
    const valid = EXPECTED_ATOMIC_REFSET.map(row => row.join("|")).join("\n");
    expect(() => parseAtomicRefset(`${valid}\nbranch|extra|leased|extra:refs/heads/extra`)).toThrow();
    expect(() => parseAtomicRefset(valid.replace("branch|main|leased", "branch|main|unleased"))).toThrow();
    expect(() => parseAtomicRefset(valid.replace(
      "tag|official|no-force-no-lease|refs/tags/vX.Y.Z:refs/tags/vX.Y.Z",
      "tag|official|no-force-no-lease|+refs/tags/vX.Y.Z:refs/tags/vX.Y.Z",
    ))).toThrow();
    expect(() => parseAtomicRefset(valid.replace("\nbranch|dev", "\n\nbranch|dev"))).toThrow();
  });

  test("keeps dev as the rebase line and sync as the audit ref", () => {
    expect(automation).toContain("git rebase --onto <new-tag-sha> <old-upstream-release-sha> dev");
    expect(automation).not.toContain("git rebase --onto <new-tag-sha> <old-upstream-release-sha> sync/vX.Y.Z");
    expect(automation).toContain("RELEASE_COMMIT");
    expect(automation).toContain("OFFICIAL_COMMIT");
    expect(automation).toContain('git merge-base --is-ancestor "$EXPECTED_REMOTE_SYNC" "$RELEASE_COMMIT"');
    expect(automation).toContain("本地/远端 `main`、`dev`、`sync/vX.Y.Z`");
    expect(automation).toContain("post_release_advanced_dev=must-not-reset");
  });

  test("grounds every active official comparison in v2.39.0 evidence", () => {
    const evidence = {
      "火山方舟 Agent Plan GLM/Kimi 与智谱 GLM Responses 兼容": [
        "`v2.39.0:src/adapters/openai-responses.ts`（blob `0d918076171c14142a1bafdc6dde693a54a9d38f`，v2.39 已变更）",
        "`src/fork/glm-kimi-compat.ts`（blob `64ce11986a7fc2391c7b8965256e55c16a2bfa72`）",
        "`tests/fork-volcengine-empty-assistant-content.test.ts`（blob `95cfba92ac6e3ef6ee5fe27b62519f5a144b7862`）",
      ],
      "Ark quota 在 Codex Desktop 中的展示": [
        "`src/fork/ark-quota-display.ts`（blob `a80fd68a576013788bce100179c5982e2adb63ba`）",
        "`tests/fork-ark-weekly-quota.test.ts`（blob `52e4b0b0d49438ffa5c14a12cba1c4f5eb704d35`）",
      ],
      "自定义模型配置、工具模式与公开投影": [
        "`src/config/custom-models.ts`（blob `12a84dd14a674eda773a83a31f9923c740a0e213`）",
        "`src/config.ts`（blob `78480720f3b54fa80390504b89230f62f697f513`）",
        "`src/server/management/model-routes.ts`（blob `70cd881de52bcfe99cf56ce44509872445b92fd5`）",
        "`tests/fork-custom-model-config-schema.test.ts`（blob `269586b983374d4bd88c678a074ec975a3152bd7`）",
        "`tests/fork-custom-model-tool-mode-contract.test.ts`（blob `a69dc95ff93c61e4fa4be4be1ec701f87797dfb8`）",
      ],
      "本地源码包安装": [
        "`scripts/install-local-vendor.ts`（blob `6eccd1c64fd823e9189d19f89169b4ffb8d15a93`）",
        "`scripts/install-local.ts`（blob `e1f8f8d97db8cbeab97807c7733c5829cafb1276`）",
        "`tests/fork-install-local-staging.test.ts`（blob `2ab483349ae32e81b3dacc64a222dce3c18f69c5`）",
        "`tests/fork-install-local-manifest-lifecycle.test.ts`（blob `aa9580f645df7bf27ed71062cb6eb2265d3c2274`）",
        "`tests/fork-install-local-guard-recovery.test.ts`（blob `05d24eb1b37ab7bf70c5a52d3adf261bba51c50e`）",
      ],
      "GUI Logs/Debug 恢复标签与 sidecar 契约": [
        "`gui/src/pages/Logs.tsx`（blob `3cd4c4684b86a0506e154388aa5d82686b1db674`）",
        "`gui/src/pages/Debug.tsx`（blob `05207fbb9097dc665c94fdef24d665782ac2f9ce`，与官方 v2.39.0 相同）",
        "`gui/src/i18n/de.ts`（blob `f106b6cefbc25608ddb06c6a6ddb93ce47b6a51b`）",
        "`gui/src/i18n/en.ts`（blob `6d16305d9e9bb009e12bd7ec6338a3de8f084850`）",
        "`gui/src/i18n/fr.ts`（blob `964e57e8cff18422c280411a8b05fe16e452ffb7`）",
        "`gui/src/i18n/ja.ts`（blob `2d0b91b729254c9ff354b8dc18a91234f9a73d54`）",
        "`gui/src/i18n/ko.ts`（blob `c7e3e90b9acdd0537f1c0d60b87bae09ce47f040`）",
        "`gui/src/i18n/ru.ts`（blob `59a18905097d085ba7cc1712b2cf12a152bf6403`）",
        "`gui/src/i18n/tr.ts`（blob `8a02bb70d8d13dc02d0746fdb8e1dd9df86a3ec4`）",
        "`gui/src/i18n/zh-TW.ts`（blob `f0c61d157d573cff890a929103bb7e1ed631b4ac`）",
        "`gui/src/i18n/zh.ts`（blob `84f1bf3ea9f3b9cfb5802ad142362612859afa7f`）",
        "`gui/tests/sidecar-layout.test.ts`（blob `e140a627260bbf952708e7f710874a5f76cc5b2b`，与官方 v2.39.0 相同）",
      ],
      "`ben` Fork 修订版本策略": [
        "`src/fork/version-policy.mjs`（blob `1c9351fea6dd28f5d70fb945c37e5ac46536a7b6`）",
        "`tests/fork-version-policy.test.ts`（blob `40c1092241345b88c3c26756bca1d3d59586f501`）",
      ],
      "Standalone web search 能力注入": [
        "`v2.39.0:src/codex/inject.ts`（blob `72be57878470077e9b3c434726aea329e007d79c`）",
        "当前实现的 `src/codex/inject.ts` blob 为 `7cca45fa7f5e41328a5199a5adf5151406019220`",
        "`0124c2809cb40c29603cff196e6d2182559bd48d`",
      ],
      "智谱 BigModel Codex 模型发现": [
        "`v2.39.0:src/providers/model-discovery.ts`（blob `ada0bd2aecc196e003d0b1720c96d864e4793dbc`）",
        "`src/providers/model-discovery.ts`（blob `85ea01d624b128d56400f4b699b95b32517de639`）",
        "`c9446e0b5cddb90a0569d8e59913a91ae7eaa893`",
      ],
      "默认测试 runner 与负载敏感隔离": [
        "`v2.39.0:tests/update-stop-first.test.ts`（blob `d20eafb5c7051744168d7ce649186c49da789d8e`，merge `fe063d16ef620a148ab425cfffe63a8936d00e52`）",
        "Fork PATH-precedence guard（`a1e35b13db14a1686ef0033685d7214184c37743`）",
        "`src/responses/state.ts`（blob `b95a1fa2c6d36b9b43269af60d51f5a64e6754ec`）",
        "`tests/responses-state.test.ts`（blob `335bff1d733ee12897153fd1b2ab14eac2b420a3`）",
        "`fe063d16ef620a148ab425cfffe63a8936d00e52`",
      ],
      "Prepush 与 GitHub CI": [],
    } as const;
    for (const [title, anchors] of Object.entries(evidence)) {
      const active = section(title);
      expect(active).toContain("v2.39.0");
      expect(active).not.toContain("v2.34.0");
      for (const anchor of anchors) expect(compactWhitespace(active)).toContain(anchor);
    }
  });

  test("binds active mutable-file anchors to the current Git blob identity", () => {
    const paths = [
      "gui/src/pages/Logs.tsx",
      "gui/src/i18n/de.ts",
      "gui/src/i18n/en.ts",
      "gui/src/i18n/fr.ts",
      "gui/src/i18n/ja.ts",
      "gui/src/i18n/ko.ts",
      "gui/src/i18n/ru.ts",
      "gui/src/i18n/tr.ts",
      "gui/src/i18n/zh-TW.ts",
      "gui/src/i18n/zh.ts",
      "src/responses/state.ts",
      "tests/responses-state.test.ts",
      "tests/shutdown-launcher.test.ts",
    ] as const;
    for (const path of paths) {
      expect(changes).toContain(`\`${path}\`（blob \`${currentGitBlob(path)}\``);
    }
  });

  test("separates Fork strict backend recovery from official v2.35 turn termination", () => {
    const recovery = section("原生加密子任务恢复接力");
    expect(compactWhitespace(recovery)).toContain(
      "`v2.39.0:src/server/responses/agent-task-recovery.ts`（blob `8b409e175bfb83345ac147ccbeb4b5bc4d462fcf`，相对 `v2.34.0` 新增官方 cache admission 重构）",
    );
    expect(recovery).not.toContain("官方恢复模块（`agent-task-recovery.ts`）扩展了 strict backend ciphertext 的 envelope 识别");
    expect(compactWhitespace(recovery)).toContain("Fork 行为：strict non-Fernet envelope recognition、admission、routed trigger 与 fail-closed forwarding");
    expect(recovery).toContain("官方 `v2.35.0` 行为：turn termination");
  });
});
