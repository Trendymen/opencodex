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
      "Candidate Cross-platform CI": "pending external gate",
      "Atomic promotion": "pending external gate",
      "Final main Cross-platform CI": "pending external gate",
      "GitHub Release": "pending external gate",
    });
    expect(block).not.toMatch(/https?:\/\//);
    expect(block).not.toMatch(/\brun\s+#?\d+/i);
    expect(block).not.toMatch(/\b(?:success|passed|completed)\b/i);
  });

  test("updates every active official comparison to v2.35.0", () => {
    for (const title of [
      "火山方舟 Agent Plan GLM/Kimi 与智谱 GLM Responses 兼容",
      "Standalone web search 能力注入",
      "智谱 BigModel Codex 模型发现",
      "默认测试 runner 与负载敏感隔离",
      "Prepush 与 GitHub CI",
    ]) {
      const active = section(title);
      expect(active).toContain("v2.35.0");
      expect(active).not.toContain("v2.34.0");
    }
  });

  test("separates Fork strict backend recovery from official v2.35 turn termination", () => {
    const recovery = section("原生加密子任务恢复接力");
    expect(recovery).toContain("Fork 行为：严格 backend recovery");
    expect(recovery).toContain("官方 `v2.35.0` 行为：turn termination");
  });
});
