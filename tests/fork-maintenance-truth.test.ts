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
  test("records the exact ben.2 package and rebase-overlap truth", () => {
    const version = JSON.parse(packageText).version;
    expect(version).toBe("2.35.0-ben.2");
    expect(changes).toContain("| Fork 包版本 | `2.35.0-ben.2` |");
    expect(changes).toContain("| 本轮派生 Tag | `v2.35.0-ben.2`");
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

  test("grounds every active official comparison in v2.35.0 evidence", () => {
    const evidence = {
      "火山方舟 Agent Plan GLM/Kimi 与智谱 GLM Responses 兼容": [
        "`v2.35.0:src/adapters/openai-responses.ts`（blob `70e6e7a1d772e9728e31c8ff5532dc80c1ea87d0`）",
        "`src/fork/glm-kimi-compat.ts`（blob `6dcd6d130dc60fbe45ccedfdded01489055914b0`）",
        "`727cb58ec725076ecb9f4958910ebe854e423009`",
      ],
      "Standalone web search 能力注入": [
        "`v2.35.0:src/codex/inject.ts`（blob `72be57878470077e9b3c434726aea329e007d79c`）",
        "当前实现的 `src/codex/inject.ts` blob 为 `7cca45fa7f5e41328a5199a5adf5151406019220`",
        "`0124c2809cb40c29603cff196e6d2182559bd48d`",
      ],
      "智谱 BigModel Codex 模型发现": [
        "`v2.35.0:src/providers/model-discovery.ts`（blob `ada0bd2aecc196e003d0b1720c96d864e4793dbc`）",
        "`src/providers/model-discovery.ts`（blob `85ea01d624b128d56400f4b699b95b32517de639`）",
        "`c9446e0b5cddb90a0569d8e59913a91ae7eaa893`",
      ],
      "默认测试 runner 与负载敏感隔离": [
        "`v2.35.0:tests/update-stop-first.test.ts`（blob `0f7fd7ff55ec23cbdea4d157df61262bd9f8cd8e`，merge `fe063d16ef620a148ab425cfffe63a8936d00e52`）",
        "Fork PATH-precedence guard（`a1e35b13db14a1686ef0033685d7214184c37743`）",
        "`fe063d16ef620a148ab425cfffe63a8936d00e52`",
      ],
      "Prepush 与 GitHub CI": [],
    } as const;
    for (const [title, anchors] of Object.entries(evidence)) {
      const active = section(title);
      expect(active).toContain("v2.35.0");
      expect(active).not.toContain("v2.34.0");
      for (const anchor of anchors) expect(compactWhitespace(active)).toContain(anchor);
    }
  });

  test("separates Fork strict backend recovery from official v2.35 turn termination", () => {
    const recovery = section("原生加密子任务恢复接力");
    expect(compactWhitespace(recovery)).toContain(
      "`v2.35.0:src/server/responses/agent-task-recovery.ts` 的 blob `70003c116bfc2d6fb9a85dab355827fff2295acc` 与 `v2.34.0` 相同",
    );
    expect(recovery).not.toContain("官方恢复模块（`agent-task-recovery.ts`）扩展了 strict backend ciphertext 的 envelope 识别");
    expect(compactWhitespace(recovery)).toContain("Fork 行为：strict non-Fernet envelope recognition、admission、routed trigger 与 fail-closed forwarding");
    expect(recovery).toContain("官方 `v2.35.0` 行为：turn termination");
  });
});
