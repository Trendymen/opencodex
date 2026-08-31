import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const repoUrl = new URL("../", import.meta.url);
const packageText = readFileSync(new URL("package.json", repoUrl), "utf8");
const changes = readFileSync(new URL("FORK_CHANGES.md", repoUrl), "utf8");

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
const EXPECTED_ATOMIC_REFSET = [
  ["branch", "main", "leased", "candidate-commit:refs/heads/main"],
  ["branch", "sync", "leased", "candidate-commit:refs/heads/sync/vX.Y.Z"],
  ["branch", "marker", "leased", "official-peeled:refs/heads/upstream-release"],
  ["tag", "official", "no-force-no-lease", "refs/tags/vX.Y.Z:refs/tags/vX.Y.Z"],
  ["tag", "fork", "no-force-no-lease", "refs/tags/vX.Y.Z-ben.N:refs/tags/vX.Y.Z-ben.N"],
] as const;

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
  const rows = block.split("\n").filter(Boolean).map((line) => {
    const fields = line.split("|");
    if (fields.length !== 4 || fields.some(field => !field)) {
      throw new Error(`invalid atomic refset row: ${line}`);
    }
    return fields;
  });
  if (rows.length !== 5) throw new Error("atomic refset must contain exactly five rows");
  if (JSON.stringify(rows) !== JSON.stringify(EXPECTED_ATOMIC_REFSET)) {
    throw new Error("atomic refset differs from the exact five-member contract");
  }
  for (const [kind, name, policy, refspec] of rows) {
    if (kind === "branch" && policy !== "leased") throw new Error(`${name} branch is not leased`);
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

  test("requires the exact five-member official and Fork Tag atomic refset in each generic flow", () => {
    const flows = [
      majorSection("没有新官方版本时的幂等收敛"),
      majorSection("每次稳定版 rebase 的强制流程"),
    ];

    for (const flow of flows) {
      expect([...flow.matchAll(/<!-- official-atomic-refset:start -->/g)]).toHaveLength(1);
      expect([...flow.matchAll(/<!-- official-atomic-refset:end -->/g)]).toHaveLength(1);
      const block = machineBlock(flow, "official-atomic-refset");
      expect(parseAtomicRefset(block)).toEqual(EXPECTED_ATOMIC_REFSET);
    }
  });

  test("rejects atomic refsets with an extra row, missing lease, or forced Tag", () => {
    const valid = EXPECTED_ATOMIC_REFSET.map(row => row.join("|")).join("\n");
    expect(() => parseAtomicRefset(`${valid}\nbranch|extra|leased|extra:refs/heads/extra`)).toThrow();
    expect(() => parseAtomicRefset(valid.replace("branch|main|leased", "branch|main|unleased"))).toThrow();
    expect(() => parseAtomicRefset(valid.replace(
      "tag|official|no-force-no-lease|refs/tags/vX.Y.Z:refs/tags/vX.Y.Z",
      "tag|official|no-force-no-lease|+refs/tags/vX.Y.Z:refs/tags/vX.Y.Z",
    ))).toThrow();
  });

  test("grounds every active official comparison in v2.38.0 evidence", () => {
    const evidence = {
      "火山方舟 Agent Plan GLM/Kimi 与智谱 GLM Responses 兼容": [
        "`v2.38.0:src/adapters/openai-responses.ts`（blob `047c60a6a3fafefaa5d4ea0fea199565286d5054`，v2.38 未变更）",
        "`src/fork/glm-kimi-compat.ts`（blob `dd1fd17bd349`）",
        "`727cb58ec725076ecb9f4958910ebe854e423009`",
      ],
      "Standalone web search 能力注入": [
        "`v2.38.0:src/codex/inject.ts`（blob `72be57878470077e9b3c434726aea329e007d79c`）",
        "当前实现的 `src/codex/inject.ts` blob 为 `7cca45fa7f5e41328a5199a5adf5151406019220`",
        "`0124c2809cb40c29603cff196e6d2182559bd48d`",
      ],
      "智谱 BigModel Codex 模型发现": [
        "`v2.38.0:src/providers/model-discovery.ts`（blob `ada0bd2aecc196e003d0b1720c96d864e4793dbc`）",
        "`src/providers/model-discovery.ts`（blob `85ea01d624b128d56400f4b699b95b32517de639`）",
        "`c9446e0b5cddb90a0569d8e59913a91ae7eaa893`",
      ],
      "默认测试 runner 与负载敏感隔离": [
        "`v2.38.0:tests/update-stop-first.test.ts`（blob `0f7fd7ff55ec23cbdea4d157df61262bd9f8cd8e`，merge `fe063d16ef620a148ab425cfffe63a8936d00e52`）",
        "Fork PATH-precedence guard（`a1e35b13db14a1686ef0033685d7214184c37743`）",
        "`fe063d16ef620a148ab425cfffe63a8936d00e52`",
      ],
      "Prepush 与 GitHub CI": [],
    } as const;
    for (const [title, anchors] of Object.entries(evidence)) {
      const active = section(title);
      expect(active).toContain("v2.38.0");
      expect(active).not.toContain("v2.34.0");
      for (const anchor of anchors) expect(compactWhitespace(active)).toContain(anchor);
    }
  });

  test("separates Fork strict backend recovery from official v2.35 turn termination", () => {
    const recovery = section("原生加密子任务恢复接力");
    expect(compactWhitespace(recovery)).toContain(
      "`v2.38.0:src/server/responses/agent-task-recovery.ts`（blob `8b409e175bfb83345ac147ccbeb4b5bc4d462fcf`，相对 `v2.34.0` 新增官方 cache admission 重构）",
    );
    expect(recovery).not.toContain("官方恢复模块（`agent-task-recovery.ts`）扩展了 strict backend ciphertext 的 envelope 识别");
    expect(compactWhitespace(recovery)).toContain("Fork 行为：strict non-Fernet envelope recognition、admission、routed trigger 与 fail-closed forwarding");
    expect(recovery).toContain("官方 `v2.35.0` 行为：turn termination");
  });
});
