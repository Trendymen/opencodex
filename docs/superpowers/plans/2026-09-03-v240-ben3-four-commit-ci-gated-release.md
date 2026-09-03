# OpenCodex v2.40.0-ben.3 Four-Commit CI-Gated Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将官方 `v2.40.0` 之后的 Fork 历史压缩为恰好 4 个语义 commits，并确保最终精确 SHA 的 dev candidate CI、双审、workflow security review 和 main CI 全部通过后才发布 `v2.40.0-ben.3`。

**Architecture:** 先用 TDD 修改 Cross-platform CI，使 `dev` 上同-tree、message-only amend 强推也会运行完整 push 门禁；再把参数化 `N>=2` 压缩合同写入三份维护真源。所有批准变化形成内容快照 `S_K`，用四份无重叠 manifest 和临时 Git index重建 C1–C4；每次实际候选 push形成 append-only `A_J`，CI 失败时 amend既有四提交历史并用精确 lease重推，绝不追加 C5。最终 Tag/promotion/main CI/Release 都绑定同一 C4 SHA。

**Tech Stack:** Bun 1.4.0、TypeScript、Git plumbing（`read-tree` / `update-index` / `write-tree` / `commit-tree`）、GitHub Actions、GitHub CLI。

**Spec:** `docs/superpowers/specs/2026-09-03-v240-ben3-four-commit-ci-gated-release-design.md`

## Global Constraints

- 官方基线固定为 `v2.40.0` / `35ff3a462e786bd5efc394dfb1a8a5cc946e454f`。
- `v2.40.0-ben.2` raw Tag、peeled commit `569f0e7b7d3388758b05553fda9ba2a13208433f` 和公开 Release 永不移动、删除或重建。
- 本轮固定 `SQUASH_TARGET_COUNT=4`；任一候选、远端 `dev`、Tag peeled 和 Release commit 都必须证明官方基线之后恰好 4 个线性 non-merge commits。
- C4 只修改 `FORK_CHANGES.md`，父提交必须是 C3；所有 C4 后的实际 CI/review/ref/Release证据只进入任务证据与 GitHub Release Notes。
- main 在候选阶段保持最后一个正式 Release；只有 Tag 前全部门禁通过后才与 dev/sync一起 promotion。
- `sync/v2.40.0` 继续作为该官方基线唯一可移动 Release指针；禁止创建 `sync/v2.40.0-ben.3`。
- candidate push和atomic promotion所有 branch强推都使用逐 ref精确 `--force-with-lease`；禁止普通 `--force`。
- official/Fork Tag refspec不带 `+`、不 force、不使用 lease；Fork Tag必须是中文 annotated Tag。
- 修改 `.github/workflows/ci.yml` 后，第一次 candidate push前必须通过限定 workflow blob的独立 security `CODE_QUALITY` review。
- 最终常规 `SPEC_COMPLIANCE` 与 `CODE_QUALITY` review绑定最终 C4 SHA；任何 Critical/Important finding阻塞。
- GitHub Release必须晚于同一 C4 SHA的成功 dev candidate CI和成功 main CI；不发布 npm、不上传额外资产、不修改全局安装。
- 当前工作区直接执行；不创建 worktree。任何历史改写前先创建明确的本地恢复分支，且不推送恢复分支。

## 持久严格shell执行合同

本Plan的全部`bash`代码块不是独立`exec_command`：执行Task 0前，用一次非TTY的`exec_command`
启动`bash --noprofile --norc -s`（`tty: false`），把返回的session id登记在当前任务状态；随后所有
bash代码块都按顺序通过该session的`write_stdin`发送，直到最终终验完成。shell二进制与围栏语法
一致，非交互模式保证`errexit`不会被交互shell语义忽略。首个输入固定为：

```bash
set -euo pipefail
test -n "${BASH_VERSION:-}"
case "$BASH_VERSION" in 3.*|4.*|5.*) ;; *) exit 1 ;; esac
printf 'bash=%s\n' "$BASH_VERSION"
printf '__OCX_BEN3_READY__\n'
```

每个代码块仍自行重复`set -euo pipefail`；发送时在块末追加
`printf '__OCX_BLOCK_DONE__\n'`。块内任一意外失败都会在sentinel前终止整个持久shell；只有读到本次
sentinel才可进入下一step。控制器检测session退出后立即fail closed，不向新shell手工补变量。
`apply_patch`、reviewer派发和等待期间，持久shell必须已输出sentinel且不运行命令；长prepush/CI
watch也发送到同一session，并用`write_stdin`读取到sentinel或明确退出。禁止并行启动第二个发布shell。

如果持久session因未预期错误退出，当前固定目录、backup refs和S/A证据立即转为blocked：不得“从
Task 0重跑”、不得删除/覆盖证据、不得用新shell补变量。向用户报告最后一个已见sentinel、HEAD/ref
后验和失败命令，由用户决定是否另行制定有界恢复/放弃方案。candidate `dev`已写入
后只允许从已落盘S_K/A_J和candidate classifier证据恢复；Tag/atomic promotion后只允许从promotion
classifier与Release证据恢复。正常可预期的RED、prepush/CI失败均在各自步骤显式捕获，不应导致
session退出；无法唯一恢复phase/context时始终fail closed。

---

### Task 0: 在任何实现提交前冻结任务级初始状态

**Files:**
- Create (ignored): `.tmp/v240-ben3-squash/task-initial/*`
- Create (ignored): `.tmp/v240-ben3-squash/remote-gates.sh`
- Read only: local/origin refs、Tag namespace、Release metadata

**Interfaces:**
- Consumes: 用户批准后的当前 `dev` checkout。
- Produces: 不可重赋值的 `INITIAL_SOURCE_HEAD/TREE`、初始remote refs和ben.2对象快照。

- [ ] **Step 1: fail-closed检查工作区与Git操作状态**

```bash
set -euo pipefail
test "$(git branch --show-current)" = dev
test -z "$(git status --porcelain=v1)"
git diff --quiet
git diff --cached --quiet
for state in rebase-merge rebase-apply MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD BISECT_LOG; do
  test ! -e "$(git rev-parse --git-path "$state")"
done
```

任一命令失败立即停止；不stash、不reset、不覆盖。

- [ ] **Step 2: 创建专用证据目录并固定初始source**

```bash
set -euo pipefail
SQUASH_EVIDENCE_DIR=.tmp/v240-ben3-squash
INITIAL_DIR="$SQUASH_EVIDENCE_DIR/task-initial"
mkdir -p "$INITIAL_DIR"
test ! -e "$INITIAL_DIR/source-head"
test ! -e "$INITIAL_DIR/source-tree"
test ! -e "$INITIAL_DIR/target-count"
git rev-parse HEAD > "$INITIAL_DIR/source-head"
git rev-parse HEAD^{tree} > "$INITIAL_DIR/source-tree"
printf '4\n' > "$INITIAL_DIR/target-count"
```

该目录一旦写入不得覆盖；后续S/A证据使用独立子目录。

使用`apply_patch`创建`.tmp/v240-ben3-squash/remote-gates.sh`，以便所有远端不存在断言都区分
“确定为空/404”和“网络、认证、限流或5xx失败”：

```bash
set -euo pipefail
capture_remote() (
  set -euo pipefail
  output="$1"
  shift
  git ls-remote origin "$@" > "$output"
)

assert_remote_absent() (
  set -euo pipefail
  output="$1"
  shift
  capture_remote "$output" "$@" || return
  test ! -s "$output"
)

assert_release_absent() (
  set -euo pipefail
  tag="$1"
  evidence_prefix="$2"
  if gh api --include "repos/Trendymen/opencodex/releases/tags/$tag" \
      > "$evidence_prefix.response" 2> "$evidence_prefix.stderr"; then
    echo "release already exists: $tag" >&2
    return 1
  fi
  grep -Eq '^HTTP/[0-9.]+ 404([[:space:]]|$)' "$evidence_prefix.response"
)
```

任一helper返回非0立即停止；不得用`test -z "$(git ls-remote ...)"`或把任意`gh`非0等同404。

- [ ] **Step 3: 固定初始local/remote refs与Tag namespace**

```bash
set -euo pipefail
set -o pipefail
git fetch origin --prune --tags
git for-each-ref --format='%(objectname) %(refname)' \
  refs/heads/main refs/heads/dev refs/heads/sync/v2.40.0 refs/heads/upstream-release \
  | LC_ALL=C sort > "$INITIAL_DIR/local-refs"
git ls-remote origin \
  refs/heads/main refs/heads/dev refs/heads/sync/v2.40.0 refs/heads/upstream-release \
  refs/tags/v2.40.0 refs/tags/v2.40.0^{} \
  refs/tags/v2.40.0-ben.2 refs/tags/v2.40.0-ben.2^{} \
  'refs/heads/sync/v2.40.0-ben.*' | LC_ALL=C sort > "$INITIAL_DIR/remote-refs"
git for-each-ref --format='%(refname) %(objecttype) %(objectname) %(*objectname)' \
  'refs/tags/v2.40.0-ben.*' | LC_ALL=C sort > "$INITIAL_DIR/local-ben-tags"
git ls-remote origin 'refs/tags/v2.40.0-ben.*' | LC_ALL=C sort > "$INITIAL_DIR/remote-ben-tags"
gh release view v2.40.0-ben.2 --repo Trendymen/opencodex \
  --json tagName,name,isDraft,isPrerelease,url,targetCommitish > "$INITIAL_DIR/ben2-release.json"
source "$SQUASH_EVIDENCE_DIR/remote-gates.sh"
assert_remote_absent "$INITIAL_DIR/revision-sync-refs" 'refs/heads/sync/v2.40.0-ben.*' || exit $?
assert_release_absent v2.40.0-ben.3 "$INITIAL_DIR/ben3-release-absence" || exit $?
```

机械断言初始状态；不要只凭叙述接受：

```bash
set -euo pipefail
BEN2_COMMIT=569f0e7b7d3388758b05553fda9ba2a13208433f
OFFICIAL_COMMIT=35ff3a462e786bd5efc394dfb1a8a5cc946e454f
INITIAL_SOURCE_HEAD=$(sed -n '1p' "$INITIAL_DIR/source-head")
for ref in main sync/v2.40.0; do
  test "$(git rev-parse "refs/heads/$ref")" = "$BEN2_COMMIT"
  test "$(git rev-parse "refs/remotes/origin/$ref")" = "$BEN2_COMMIT"
done
test "$(git rev-parse refs/heads/dev)" = "$INITIAL_SOURCE_HEAD"
test "$(git rev-parse refs/remotes/origin/dev)" = "$BEN2_COMMIT"
git merge-base --is-ancestor "$BEN2_COMMIT" "$INITIAL_SOURCE_HEAD"
test "$(git rev-list --count "$BEN2_COMMIT..$INITIAL_SOURCE_HEAD")" = 2
test "$(git rev-parse refs/heads/upstream-release)" = "$OFFICIAL_COMMIT"
test "$(git rev-parse refs/remotes/origin/upstream-release)" = "$OFFICIAL_COMMIT"
test "$(git cat-file -t refs/tags/v2.40.0-ben.2)" = tag
test "$(git rev-parse refs/tags/v2.40.0-ben.2^{})" = "$BEN2_COMMIT"
test "$(git ls-remote origin 'refs/tags/v2.40.0-ben.2^{}' | awk '{print $1}')" = "$BEN2_COMMIT"
test "$(git ls-remote origin refs/tags/v2.40.0-ben.2 | awk '{print $1}')" = \
  "$(git rev-parse refs/tags/v2.40.0-ben.2)"
test "$(git rev-parse refs/tags/v2.40.0^{})" = "$OFFICIAL_COMMIT"
test "$(git ls-remote origin 'refs/tags/v2.40.0^{}' | awk '{print $1}')" = "$OFFICIAL_COMMIT" || \
  test "$(git ls-remote origin refs/tags/v2.40.0 | awk '{print $1}')" = "$OFFICIAL_COMMIT"
node --input-type=module - "$INITIAL_DIR/ben2-release.json" <<'NODE'
import { readFileSync } from "node:fs";
const r = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (r.tagName !== "v2.40.0-ben.2" || r.name !== "v2.40.0-ben.2" ||
    r.isDraft || r.isPrerelease) throw new Error("ben.2 release metadata drifted");
NODE
```

任何差异停止。

---

### Task 1: 让同-tree candidate push 触发完整 Cross-platform CI

**Files:**
- Modify: `.github/workflows/ci.yml:26-48,389-455,737-834`
- Modify: `tests/ci-workflows.test.ts:390-535`
- Modify: `tests/fork-ci-official-baseline.test.ts:727-728`

**Interfaces:**
- Consumes: 现有 `Cross-platform CI` push/pull-request trigger、`changes` outputs、aggregate `ci` job。
- Produces: branch-only push trigger；push事件必跑 GUI lint/build 与 npm-global；push aggregate只允许 `platform-windows` skipped。

- [ ] **Step 1: 写 workflow trigger 的失败测试**

在 `tests/ci-workflows.test.ts` 现有 push trigger测试中使用：

```ts
expect([...(ci.on?.push?.branches ?? [])].sort()).toEqual(["dev", "main", "preview"]);
expect(ci.on?.push?.paths).toBeUndefined();
expect((ci.on?.push as { "paths-ignore"?: string[] } | undefined)?.["paths-ignore"])
  .toBeUndefined();
expect([...(areaFilters.ci ?? [])].sort()).toEqual(ciPaths);
```

保留 `changes` job 的完整 `ciPaths` 断言；只删除 `push.paths == ciPaths` 的旧断言。

- [ ] **Step 2: 写 push 必跑 GUI/packaging 与 aggregate skip policy 的失败测试**

```ts
const pushOrGuiChanged = "github.event_name != 'pull_request' || needs.changes.outputs.gui == 'true'";
for (const stepName of ["GUI lint", "GUI build"]) {
  const step = gateSteps.find(candidate => candidate.name === stepName);
  expect(step?.if).toBe(pushOrGuiChanged);
}

const npmGlobal = ci.jobs?.["npm-global-smoke"] as { if?: string } | undefined;
expect(npmGlobal?.if).toBe(
  "github.event_name == 'push' || github.event_name == 'workflow_dispatch' || needs.changes.outputs.packaging == 'true'",
);

const aggregate = ci.jobs?.ci as {
  needs?: string[];
  steps?: Array<{ env?: Record<string, string>; run?: string }>;
};
const assertion = aggregate.steps?.find(step => step.run?.includes("needed job(s) did not pass"));
expect(assertion?.env?.EVENT_NAME).toBe("${{ github.event_name }}");
expect(assertion?.run).toContain('if [ "$EVENT_NAME" = "push" ]; then');
expect(assertion?.run).toContain('.key != "platform-windows"');
expect(assertion?.run).toContain('.value.result != "success"');
```

同时把`tests/fork-ci-official-baseline.test.ts`中`npm-global-smoke.if`的完整字符串断言更新为同一个
push/workflow_dispatch/packaging条件；只调整与本次workflow语义直接对应的一行，不放宽其它官方
基线来源、Tag或权限断言。

- [ ] **Step 3: 运行测试并确认 RED**

```bash
set -euo pipefail
RED_LOG="$SQUASH_EVIDENCE_DIR/task1-red.log"
if bun test tests/ci-workflows.test.ts tests/fork-ci-official-baseline.test.ts >"$RED_LOG" 2>&1; then
  echo "expected Task 1 RED but test passed" >&2
  exit 1
fi
rg 'push|GUI|npm-global|aggregate|platform-windows|fork-ci-official-baseline' "$RED_LOG"
```

Expected: FAIL，命中 `push.paths`、GUI条件、npm-global push skip和aggregate skip policy。

- [ ] **Step 4: 最小修改 `.github/workflows/ci.yml`**

Trigger：

```yaml
  push:
    branches: [main, preview, dev]
```

GUI steps：

```yaml
        if: github.event_name != 'pull_request' || needs.changes.outputs.gui == 'true'
```

`npm-global-smoke`：

```yaml
    if: github.event_name == 'push' || github.event_name == 'workflow_dispatch' || needs.changes.outputs.packaging == 'true'
```

Aggregate env和push skip guard：

```yaml
        env:
          RESULTS: ${{ toJSON(needs) }}
          EVENT_NAME: ${{ github.event_name }}
```

```bash
set -euo pipefail
if [ "$EVENT_NAME" = "push" ]; then
  unexpected_skips=$(echo "$RESULTS" | jq -r '
    to_entries
    | map(select(.value.result == "skipped" and .key != "platform-windows"))
    | .[] | "\(.key)=\(.value.result)"')
  if [ -n "$unexpected_skips" ]; then
    echo "::error::required push job(s) were skipped: $unexpected_skips"
    exit 1
  fi
fi
```

- [ ] **Step 5: 运行 GREEN 与 YAML/source检查**

```bash
set -euo pipefail
bun test tests/ci-workflows.test.ts
bun test tests/fork-ci-official-baseline.test.ts
git diff --check -- .github/workflows/ci.yml tests/ci-workflows.test.ts \
  tests/fork-ci-official-baseline.test.ts
```

Expected: 全部退出 0。

- [ ] **Step 6: 提交 workflow任务**

```bash
set -euo pipefail
git add .github/workflows/ci.yml tests/ci-workflows.test.ts \
  tests/fork-ci-official-baseline.test.ts
git diff --cached --name-only
git diff --cached --check
git commit -m "ci: 让压缩候选强推运行完整门禁"
```

---

### Task 2: 写入参数化压缩发布永久规则

**Files:**
- Modify: `AGENTS.local.md:6-12`
- Modify: `docs/fork-sync-automation.md:1-125,416-463`
- Modify: `FORK_CHANGES.md:1148-1466`
- Modify: `tests/fork-maintenance-truth.test.ts:185-305,495-590,920-1040`

**Interfaces:**
- Consumes: 现有机器块解析器、三个活跃 release contract、六成员 atomic refset和本地三 ref CAS。
- Produces: 三处完全相同的 `fork-squash-release-policy` 机器块与 Tag-exists/Release-missing CI恢复门禁。

- [ ] **Step 1: 在测试中定义精确通用合同**

```ts
const EXPECTED_SQUASH_POLICY_KEYS = [
  "target_count", "task_inputs", "content_snapshot", "push_attempt",
  "final_commit", "same_tree_retry", "material_fix", "candidate_push",
  "candidate_ci", "workflow_security_review", "regular_reviews",
  "pre_release_ci", "tagged_failure", "external_evidence",
] as const;

const EXPECTED_SQUASH_POLICY = {
  target_count: "task-fixed-N-ge-2",
  task_inputs: "OFFICIAL_COMMIT,INITIAL_SOURCE_HEAD,INITIAL_SOURCE_TREE,SQUASH_TARGET_COUNT",
  content_snapshot: "append-only-SK-source-tree-manifests-C1-through-CN-minus-1",
  push_attempt: "append-only-AJ-content-snapshot-CN-candidate-push-ci",
  final_commit: "CN-docs-only-FORK_CHANGES-parent-CN-minus-1",
  same_tree_retry: "amend-CN-attempt-marker-no-N-plus-1",
  material_fix: "fold-into-owner-and-rebuild-all-successors-new-SK-AJ",
  candidate_push: "dev-exact-oid-force-with-lease",
  candidate_ci: "exact-push-dev-head-sha-completed-success-aggregate-ci",
  workflow_security_review: "pre-candidate-push-content-snapshot-ci-yml-blob-pass",
  regular_reviews: "post-candidate-ci-final-CN-sha-pass",
  pre_release_ci: "exact-dev-candidate-and-main-ci-success-same-CN-sha",
  tagged_failure: "immutable-tag-consumed-revision-release-blocked",
  external_evidence: "task-and-release-notes-not-candidate-tree",
} as const;
```

新增 `strictSquashPolicy(source)`，复用 `strictKeyValueBlock`。

- [ ] **Step 2: 写四个机器块实例和幂等恢复的失败测试**

```ts
test("keeps every squash release at its task-fixed commit count until CI and Release", () => {
  const flows = [
    majorSection("没有新官方版本时的幂等收敛"),
    majorSection("每次稳定版 rebase 的强制流程"),
    automation,
    localRules,
  ];
  for (const flow of flows) {
    expect(strictSquashPolicy(flow)).toEqual(EXPECTED_SQUASH_POLICY);
  }
  expect(automation).toContain("同一 peeled SHA 的成功 candidate CI 和 main CI");
  expect(strictSquashPolicy(localRules)).toEqual(EXPECTED_SQUASH_POLICY);
});
```

Mutation负例依次把 `task-fixed-N-ge-2` 改为 `mutable-N`、`no-N-plus-1` 改为
`append-N-plus-1`、`same-CN-sha` 改为 `any-prior-ci-success`，都必须 throw。

- [ ] **Step 3: 运行 RED**

```bash
set -euo pipefail
RED_LOG="$SQUASH_EVIDENCE_DIR/task2-red.log"
if bun test tests/fork-maintenance-truth.test.ts >"$RED_LOG" 2>&1; then
  echo "expected Task 2 RED but test passed" >&2
  exit 1
fi
rg 'fork-squash-release-policy|candidate CI|main CI' "$RED_LOG"
```

Expected: 四个实例缺少机器块，幂等 Tag恢复未绑定两次精确 CI。

- [ ] **Step 4: 把通用机器块写入四个实例**

在`AGENTS.local.md`、`docs/fork-sync-automation.md`以及`FORK_CHANGES.md`两个活跃大节各写一份，
四个block必须逐键逐值完全一致：

```text
<!-- fork-squash-release-policy:start -->
target_count=task-fixed-N-ge-2
task_inputs=OFFICIAL_COMMIT,INITIAL_SOURCE_HEAD,INITIAL_SOURCE_TREE,SQUASH_TARGET_COUNT
content_snapshot=append-only-SK-source-tree-manifests-C1-through-CN-minus-1
push_attempt=append-only-AJ-content-snapshot-CN-candidate-push-ci
final_commit=CN-docs-only-FORK_CHANGES-parent-CN-minus-1
same_tree_retry=amend-CN-attempt-marker-no-N-plus-1
material_fix=fold-into-owner-and-rebuild-all-successors-new-SK-AJ
candidate_push=dev-exact-oid-force-with-lease
candidate_ci=exact-push-dev-head-sha-completed-success-aggregate-ci
workflow_security_review=pre-candidate-push-content-snapshot-ci-yml-blob-pass
regular_reviews=post-candidate-ci-final-CN-sha-pass
pre_release_ci=exact-dev-candidate-and-main-ci-success-same-CN-sha
tagged_failure=immutable-tag-consumed-revision-release-blocked
external_evidence=task-and-release-notes-not-candidate-tree
<!-- fork-squash-release-policy:end -->
```

- [ ] **Step 5: 修正幂等 Release恢复入口并更新本地入口**

Tag存在但Release缺失时，先取得同一peeled SHA的`push/dev` candidate CI和`push/main` CI，
两者都必须completed/success且aggregate `ci=success`。在`AGENTS.local.md`写明固定N、禁止N+1、
只准amend/重建并逐次lease重推、Release晚于同SHA两次CI。

同时修订“双审前禁止push”的范围：压缩任务只有`dev` candidate push是明确例外，且必须先通过
本地完整门禁和workflow security review；该例外不得移动`main`、`sync`、marker或任何Tag。
常规双审仍必须在Tag、六成员atomic promotion和Release之前绑定最终C_N SHA并PASS。

- [ ] **Step 6: 运行 GREEN并提交**

```bash
set -euo pipefail
bun test tests/fork-maintenance-truth.test.ts
git diff --check -- AGENTS.local.md docs/fork-sync-automation.md FORK_CHANGES.md tests/fork-maintenance-truth.test.ts
git add AGENTS.local.md docs/fork-sync-automation.md FORK_CHANGES.md tests/fork-maintenance-truth.test.ts
git diff --cached --check
git commit -m "docs: 固化压缩候选 CI 前置发布规则"
```

---

### Task 3: 推进 ben.3 版本并准备 provisional source

**Files:**
- Modify: `package.json:3`
- Modify: `FORK_CHANGES.md:30-230`
- Modify: `tests/fork-maintenance-truth.test.ts:660-920`

**Interfaces:**
- Consumes: Task 1 workflow、Task 2通用合同、当前ben.2 Release facts。
- Produces: `2.40.0-ben.3`、本轮审计块结构、四提交重建的 provisional source。

- [ ] **Step 1: 写 ben.3 版本与审计块失败断言**

要求 `package.json.version === "2.40.0-ben.3"`，并要求 `v240-ben3-squash` block包含：

```text
<!-- v240-ben3-squash:start -->
official_base=35ff3a462e786bd5efc394dfb1a8a5cc946e454f
source_release=569f0e7b7d3388758b05553fda9ba2a13208433f
source_commit_count=10
target_commit_count=4
content_snapshot=S1
manifest_1_sha256=pending-reconstruction
manifest_2_sha256=pending-reconstruction
manifest_3_sha256=pending-reconstruction
manifest_4_sha256=pending-reconstruction
c1=pending-reconstruction
c2=pending-reconstruction
c3=pending-reconstruction
expected_tree=external-task-evidence
release_commit=docs-only-current-head
candidate_ci=pending external gate
workflow_security_review=pending external gate
regular_reviews=pending external gate
tag=pending external gate
atomic_promotion=pending external gate
main_ci=pending external gate
github_release=pending external gate
<!-- v240-ben3-squash:end -->
```

Task 4得到manifest/C1–C3后必须替换所有`pending-reconstruction`；external gates继续pending。
Provisional测试在首次source阶段要求`content_snapshot=S1`，只允许四个manifest和C1–C3临时为
`pending-reconstruction`，不能宣称重建完成；Task 4 strict转换后不得继续把snapshot字面量写死为S1。

- [ ] **Step 2: 运行 RED**

```bash
set -euo pipefail
RED_LOG="$SQUASH_EVIDENCE_DIR/task3-red.log"
if bun test tests/fork-maintenance-truth.test.ts tests/fork-version-policy.test.ts \
    >"$RED_LOG" 2>&1; then
  echo "expected Task 3 RED but tests passed" >&2
  exit 1
fi
rg '2[.]40[.]0-ben[.]3|v240-ben3-squash' "$RED_LOG"
```

Expected: version仍为ben.2且本轮block缺失。

- [ ] **Step 3: 最小推进版本与候选文档**

把`package.json`改为`2.40.0-ben.3`。在`FORK_CHANGES.md`记录官方基线、ben.2不可变、10→4、
C4后证据不回写和所有external gate pending；加入provisional block。

- [ ] **Step 4: 运行 GREEN并提交**

```bash
set -euo pipefail
bun test tests/fork-maintenance-truth.test.ts tests/fork-version-policy.test.ts
bun run typecheck
git diff --check
git add package.json FORK_CHANGES.md tests/fork-maintenance-truth.test.ts
git diff --cached --name-only
git diff --cached --check
git commit -m "chore(release): 准备 v2.40.0-ben.3 四提交候选"
```

- [ ] **Step 5: 固定provisional source证据**

```bash
set -euo pipefail
SQUASH_EVIDENCE_DIR=.tmp/v240-ben3-squash
mkdir -p "$SQUASH_EVIDENCE_DIR"
test ! -e "$SQUASH_EVIDENCE_DIR/provisional-source-head"
test ! -e "$SQUASH_EVIDENCE_DIR/provisional-source-tree"
git rev-parse HEAD > "$SQUASH_EVIDENCE_DIR/provisional-source-head"
git rev-parse HEAD^{tree} > "$SQUASH_EVIDENCE_DIR/provisional-source-tree"
git rev-parse refs/tags/v2.40.0^{} > "$SQUASH_EVIDENCE_DIR/official-commit"
printf '4\n' > "$SQUASH_EVIDENCE_DIR/target-count"
```

Expected: 工作树干净；provisional source晚于Task 1–3、早于正式S1，包含Spec、Plan、workflow、
永久规则和ben.3版本。

---

### Task 4: 用四份 manifest 重建 C1–C4

**Files:**
- Create (ignored): `.tmp/v240-ben3-squash/ALL`、`M1`、`M2`、`M3`、`M4`、hash与index文件
- Modify: `FORK_CHANGES.md`
- Create local refs: `backup/dev-pre-v240-ben3-squash-20260903`、`backup/v240-ben3-source-S1`
- Rewrite: local `dev`

**Interfaces:**
- Consumes: provisional source、official commit、Task 1–3文件。
- Produces: S1证据、C1/C2/C3和尚未分配push attempt的`C4_PROVISIONAL`，官方基线后恰好4 commits。

- [ ] **Step 1: 冻结source与恢复分支**

```bash
set -euo pipefail
SQUASH_EVIDENCE_DIR=.tmp/v240-ben3-squash
test -d "$SQUASH_EVIDENCE_DIR"
PROVISIONAL_SOURCE_HEAD=$(sed -n '1p' "$SQUASH_EVIDENCE_DIR/provisional-source-head")
PROVISIONAL_SOURCE_TREE=$(sed -n '1p' "$SQUASH_EVIDENCE_DIR/provisional-source-tree")
test "$(git rev-parse HEAD)" = "$PROVISIONAL_SOURCE_HEAD"
test "$(git rev-parse HEAD^{tree})" = "$PROVISIONAL_SOURCE_TREE"
git show-ref --verify --quiet refs/heads/backup/dev-pre-v240-ben3-squash-20260903 && exit 1 || true
git branch backup/dev-pre-v240-ben3-squash-20260903 "$PROVISIONAL_SOURCE_HEAD"
```

已有同名ref时必须先核对来源，不能覆盖。

- [ ] **Step 2: 生成精确 manifest**

```bash
set -euo pipefail
OFFICIAL_COMMIT=35ff3a462e786bd5efc394dfb1a8a5cc946e454f
git diff --name-only --no-renames "$OFFICIAL_COMMIT" "$PROVISIONAL_SOURCE_HEAD" | LC_ALL=C sort -u > "$SQUASH_EVIDENCE_DIR/ALL"
awk '$0 ~ /^(src|bin|docs-site)\// || ($0 ~ /^gui\// && $0 !~ /^gui\/tests\//)' "$SQUASH_EVIDENCE_DIR/ALL" > "$SQUASH_EVIDENCE_DIR/M1"
awk '$0 ~ /^(\.github|scripts|structure|docs)\// || $0 ~ /^(\.gitignore|AGENTS\.local\.md|MAINTAINERS\.md)$/' "$SQUASH_EVIDENCE_DIR/ALL" > "$SQUASH_EVIDENCE_DIR/M2"
awk '$0 ~ /^tests\// || $0 ~ /^gui\/tests\// || $0 == "package.json"' "$SQUASH_EVIDENCE_DIR/ALL" > "$SQUASH_EVIDENCE_DIR/M3"
printf 'FORK_CHANGES.md\n' > "$SQUASH_EVIDENCE_DIR/M4"
```

每个manifest再执行`LC_ALL=C sort -u -o`。

- [ ] **Step 3: 证明union/disjoint并记录hash**

```bash
set -euo pipefail
LC_ALL=C sort -u "$SQUASH_EVIDENCE_DIR"/M1 "$SQUASH_EVIDENCE_DIR"/M2 "$SQUASH_EVIDENCE_DIR"/M3 "$SQUASH_EVIDENCE_DIR"/M4 > "$SQUASH_EVIDENCE_DIR/UNION"
cmp "$SQUASH_EVIDENCE_DIR/ALL" "$SQUASH_EVIDENCE_DIR/UNION"
for pair in 'M1 M2' 'M1 M3' 'M1 M4' 'M2 M3' 'M2 M4' 'M3 M4'; do
  set -- $pair
  test -z "$(LC_ALL=C comm -12 "$SQUASH_EVIDENCE_DIR/$1" "$SQUASH_EVIDENCE_DIR/$2")"
done
for manifest in M1 M2 M3 M4; do
  printf '%s  %s\n' "$(shasum -a 256 "$SQUASH_EVIDENCE_DIR/$manifest" | awk '{print $1}')" "$manifest"
done > "$SQUASH_EVIDENCE_DIR/manifest-sha256"
```

- [ ] **Step 4: 冻结可重复的commit元数据**

```bash
set -euo pipefail
META_DIR="$SQUASH_EVIDENCE_DIR/commit-metadata"
mkdir -p "$META_DIR"
test ! -e "$META_DIR/author-name"
git config --get user.name > "$META_DIR/author-name"
git config --get user.email > "$META_DIR/author-email"
date -u +%Y-%m-%dT%H:%M:%SZ > "$META_DIR/author-date"
cp "$META_DIR/author-name" "$META_DIR/committer-name"
cp "$META_DIR/author-email" "$META_DIR/committer-email"
cp "$META_DIR/author-date" "$META_DIR/committer-date"
```

下列函数必须与Step 5的`apply_manifest`一起持久化；不得只定义在一次性shell中：

```bash
set -euo pipefail
load_commit_metadata() {
  set -euo pipefail
  local meta_dir="$SQUASH_EVIDENCE_DIR/commit-metadata"
  export GIT_AUTHOR_NAME="$(sed -n '1p' "$meta_dir/author-name")"
  export GIT_AUTHOR_EMAIL="$(sed -n '1p' "$meta_dir/author-email")"
  export GIT_AUTHOR_DATE="$(sed -n '1p' "$meta_dir/author-date")"
  export GIT_COMMITTER_NAME="$(sed -n '1p' "$meta_dir/committer-name")"
  export GIT_COMMITTER_EMAIL="$(sed -n '1p' "$meta_dir/committer-email")"
  export GIT_COMMITTER_DATE="$(sed -n '1p' "$meta_dir/committer-date")"
  export TZ=UTC
  export LC_ALL=C
}
```

六个metadata文件必须非空且各只有一行。同一个S的每次重建复用它们，禁止依赖执行时刻。

- [ ] **Step 5: 持久化确定性对象构建函数**

使用`apply_patch`创建忽略文件`.tmp/v240-ben3-squash/rebuild-lib.sh`，先写入Step 4完整
`load_commit_metadata()`，再写入以下五个函数；该文件只包含这六个函数：

```bash
set -euo pipefail
apply_manifest() (
  set -euo pipefail
  parent_commit="$1"
  source_commit="$2"
  manifest="$3"
  index_file="$4"
  case "$index_file" in
    .tmp/v240-ben3-squash/index-*) ;;
    *) echo "refusing unexpected temporary index path: $index_file" >&2; return 2 ;;
  esac
  rm -f -- "$index_file"
  GIT_INDEX_FILE="$index_file" git read-tree "$parent_commit^{tree}"
  while IFS= read -r path; do
    meta=$(git ls-tree --format='%(objectmode) %(objectname)' "$source_commit" -- "$path")
    if [ -z "$meta" ]; then
      GIT_INDEX_FILE="$index_file" git update-index --force-remove -- "$path"
      continue
    fi
    mode=${meta%% *}
    oid=${meta#* }
    GIT_INDEX_FILE="$index_file" git update-index --add --cacheinfo "$mode" "$oid" "$path"
  done < "$manifest"
  GIT_INDEX_FILE="$index_file" git write-tree
)

build_manifests() (
  set -euo pipefail
  source_commit="$1"
  output_dir="$2"
  git diff --name-only --no-renames "$OFFICIAL_COMMIT" "$source_commit" | LC_ALL=C sort -u > "$output_dir/ALL"
  awk '$0 ~ /^(src|bin|docs-site)\// || ($0 ~ /^gui\// && $0 !~ /^gui\/tests\//)' "$output_dir/ALL" > "$output_dir/M1"
  awk '$0 ~ /^(\.github|scripts|structure|docs)\// || $0 ~ /^(\.gitignore|AGENTS\.local\.md|MAINTAINERS\.md)$/' "$output_dir/ALL" > "$output_dir/M2"
  awk '$0 ~ /^tests\// || $0 ~ /^gui\/tests\// || $0 == "package.json"' "$output_dir/ALL" > "$output_dir/M3"
  printf 'FORK_CHANGES.md\n' > "$output_dir/M4"
  for manifest in ALL M1 M2 M3 M4; do
    LC_ALL=C sort -u -o "$output_dir/$manifest" "$output_dir/$manifest"
  done
  LC_ALL=C sort -u "$output_dir"/M1 "$output_dir"/M2 "$output_dir"/M3 "$output_dir"/M4 > "$output_dir/UNION"
  cmp "$output_dir/ALL" "$output_dir/UNION"
  for pair in 'M1 M2' 'M1 M3' 'M1 M4' 'M2 M3' 'M2 M4' 'M3 M4'; do
    set -- $pair
    test -z "$(LC_ALL=C comm -12 "$output_dir/$1" "$output_dir/$2")"
  done
  for manifest in M1 M2 M3 M4; do
    printf '%s  %s\n' "$(shasum -a 256 "$output_dir/$manifest" | awk '{print $1}')" "$manifest"
  done > "$output_dir/manifest-sha256"
)

build_c1_c3() {
  set -euo pipefail
  source_commit="$1"
  manifest_dir="$2"
  load_commit_metadata
  tree1=$(apply_manifest "$OFFICIAL_COMMIT" "$source_commit" "$manifest_dir/M1" "$SQUASH_EVIDENCE_DIR/index-1")
  C1=$(printf '%s\n' 'feat: 汇总 Fork 运行时与用户能力' | git commit-tree "$tree1" -p "$OFFICIAL_COMMIT")
  tree2=$(apply_manifest "$C1" "$source_commit" "$manifest_dir/M2" "$SQUASH_EVIDENCE_DIR/index-2")
  C2=$(printf '%s\n' 'chore: 汇总 Fork CI、脚本与维护基础设施' | git commit-tree "$tree2" -p "$C1")
  tree3=$(apply_manifest "$C2" "$source_commit" "$manifest_dir/M3" "$SQUASH_EVIDENCE_DIR/index-3")
  C3=$(printf '%s\n' 'test: 汇总 Fork 回归并推进 v2.40.0-ben.3' | git commit-tree "$tree3" -p "$C2")
}

start_next_snapshot() {
  set -euo pipefail
  BASE_S="$1"
  OLD_LOCAL_DEV="$2"
  test "$(git branch --show-current)" = dev
  test "$(git rev-parse HEAD)" = "$OLD_LOCAL_DEV"
  test -z "$(git status --porcelain=v1)"
  CURRENT_SOURCE=$(sed -n '1p' "$SQUASH_EVIDENCE_DIR/$BASE_S/source-head")
  NEXT_S=$(node --input-type=module -e '
    import { readdirSync } from "node:fs";
    const nums = readdirSync(process.argv[1], { withFileTypes: true })
      .filter(x => x.isDirectory() && /^S[1-9][0-9]*$/.test(x.name))
      .map(x => Number(x.name.slice(1)));
    process.stdout.write(String((nums.length === 0 ? 0 : Math.max(...nums)) + 1));
  ' "$SQUASH_EVIDENCE_DIR")
  NEW_S="S$NEXT_S"
  NEW_SOURCE_REF="backup/v240-ben3-source-$NEW_S"
  if git show-ref --verify --quiet "refs/heads/$NEW_SOURCE_REF"; then
    return 1
  fi
  git switch -c "$NEW_SOURCE_REF" "$CURRENT_SOURCE"
}

finish_next_snapshot() {
  set -euo pipefail
  NEW_SOURCE=$(git rev-parse HEAD)
  NEW_EXPECTED_TREE=$(git rev-parse HEAD^{tree})
  NEW_S_DIR="$SQUASH_EVIDENCE_DIR/$NEW_S"
  mkdir "$NEW_S_DIR"
  cp "$SQUASH_EVIDENCE_DIR/ALL" "$SQUASH_EVIDENCE_DIR/M1" "$SQUASH_EVIDENCE_DIR/M2" \
    "$SQUASH_EVIDENCE_DIR/M3" "$SQUASH_EVIDENCE_DIR/M4" \
    "$SQUASH_EVIDENCE_DIR/manifest-sha256" "$NEW_S_DIR/"
  printf '%s\n' "$NEW_SOURCE" > "$NEW_S_DIR/source-head"
  printf '%s\n' "$NEW_EXPECTED_TREE" > "$NEW_S_DIR/expected-tree"
  printf '%s\n' "$C1" > "$NEW_S_DIR/c1"
  printf '%s\n' "$C2" > "$NEW_S_DIR/c2"
  printf '%s\n' "$C3" > "$NEW_S_DIR/c3"
  load_commit_metadata
  tree4=$(apply_manifest "$C3" "$NEW_SOURCE" "$NEW_S_DIR/M4" "$SQUASH_EVIDENCE_DIR/index-4")
  NEW_C4=$(printf '%s\n\n%s\n' 'docs: 记录 v2.40.0-ben.3 四提交候选' \
    '候选尝试: 尚未分配' | git commit-tree "$tree4" -p "$C3")
  source "$SQUASH_EVIDENCE_DIR/check-candidate.sh"
  check_candidate "$NEW_C4" "" "$NEW_SOURCE" "$NEW_EXPECTED_TREE" "$C1" "$C2" "$C3" "$NEW_S_DIR"
  test "$(git branch --show-current)" = "$NEW_SOURCE_REF"
  test "$(git rev-parse HEAD)" = "$NEW_SOURCE"
  test -z "$(git status --porcelain=v1)"
  git switch dev
  test "$(git rev-parse HEAD)" = "$OLD_LOCAL_DEV"
  git update-ref refs/heads/dev "$NEW_C4" "$OLD_LOCAL_DEV"
  git reset --hard "$NEW_C4"
  test "$(git branch --show-current)" = dev
  test "$(git rev-parse HEAD)" = "$NEW_C4"
  test "$(git rev-parse "$NEW_SOURCE_REF")" = "$NEW_SOURCE"
}
```

创建后执行`source "$SQUASH_EVIDENCE_DIR/rebuild-lib.sh"`并用`type load_commit_metadata
apply_manifest build_manifests build_c1_c3 start_next_snapshot finish_next_snapshot`证明六个函数均可用。
后续每个新shell都必须重新source该文件。`load_commit_metadata`、`build_c1_c3`、
`start_next_snapshot`和`finish_next_snapshot`会在当前shell启用`set -euo pipefail`，必须作为普通命令
调用，禁止放进`if`、`&&`、`||`或命令替换，以免shell抑制errexit；`apply_manifest`和
`build_manifests`使用局部严格subshell，调用方必须用赋值状态或`|| exit`检查返回值。

- [ ] **Step 6: 构建 provisional C1–C3**

```bash
set -euo pipefail
source "$SQUASH_EVIDENCE_DIR/rebuild-lib.sh"
load_commit_metadata
TREE1=$(apply_manifest "$OFFICIAL_COMMIT" "$PROVISIONAL_SOURCE_HEAD" "$SQUASH_EVIDENCE_DIR/M1" "$SQUASH_EVIDENCE_DIR/index-1")
C1=$(printf '%s\n' 'feat: 汇总 Fork 运行时与用户能力' | git commit-tree "$TREE1" -p "$OFFICIAL_COMMIT")
TREE2=$(apply_manifest "$C1" "$PROVISIONAL_SOURCE_HEAD" "$SQUASH_EVIDENCE_DIR/M2" "$SQUASH_EVIDENCE_DIR/index-2")
C2=$(printf '%s\n' 'chore: 汇总 Fork CI、脚本与维护基础设施' | git commit-tree "$TREE2" -p "$C1")
TREE3=$(apply_manifest "$C2" "$PROVISIONAL_SOURCE_HEAD" "$SQUASH_EVIDENCE_DIR/M3" "$SQUASH_EVIDENCE_DIR/index-3")
C3=$(printf '%s\n' 'test: 汇总 Fork 回归并推进 v2.40.0-ben.3' | git commit-tree "$TREE3" -p "$C2")
printf '%s\n' "$C1" > "$SQUASH_EVIDENCE_DIR/c1-provisional"
printf '%s\n' "$C2" > "$SQUASH_EVIDENCE_DIR/c2-provisional"
printf '%s\n' "$C3" > "$SQUASH_EVIDENCE_DIR/c3-provisional"
```

把完整 C1/C2/C3 SHA写入task evidence。

- [ ] **Step 7: 收紧最终审计测试并观察 provisional RED**

只修改`tests/fork-maintenance-truth.test.ts`：四个manifest值必须匹配`^[0-9a-f]{64}$`，
C1/C2/C3必须匹配`^[0-9a-f]{40}$`，不再接受`pending-reconstruction`；测试不能嵌入实际C3
SHA，避免C3自引用。把`content_snapshot`从provisional的精确`S1`断言拆出，strict/final测试只要求
`^S[1-9][0-9]*$`；当前candidate与实际S编号的精确相等由`verify-audit-block.mjs`接收
`expectedSnapshot`并在每个gate验证。先不修改`FORK_CHANGES.md`。

```bash
set -euo pipefail
RED_LOG="$SQUASH_EVIDENCE_DIR/task4-strict-red.log"
if bun test tests/fork-maintenance-truth.test.ts >"$RED_LOG" 2>&1; then
  echo "expected strict audit RED but test passed" >&2
  exit 1
fi
rg 'pending-reconstruction|manifest_[1-4]_sha256|c[1-3]' "$RED_LOG"
```

Expected: FAIL，精确指出manifest/C1–C3仍为`pending-reconstruction`。

- [ ] **Step 8: 写 provisional 对象并观察 GREEN**

替换 `v240-ben3-squash` block全部`pending-reconstruction`；保留
`expected_tree=external-task-evidence`、`release_commit=docs-only-current-head`和所有external
gate pending。运行focused测试和diff check后提交测试收紧与provisional账本。

```bash
set -euo pipefail
bun test tests/fork-maintenance-truth.test.ts tests/fork-version-policy.test.ts
git diff --check
git add FORK_CHANGES.md tests/fork-maintenance-truth.test.ts
git diff --cached --name-only
git diff --cached --check
git commit -m "docs: 固定 v2.40.0-ben.3 四提交重建输入"
```

这一轮测试逻辑收紧使测试文件归M3，因此必须在下一步重建C3及C4；manifest hash只依赖排序
路径清单，不因文件内容变化而改变。

- [ ] **Step 9: 重算 manifest并确定性重建最终 C1–C3**

先固定包含收紧测试与provisional账本的source，然后重新生成四份manifest、union与hash；不得复用
Step 2的旧文件内容：

```bash
set -euo pipefail
FINAL_INPUT_HEAD=$(git rev-parse HEAD)
git diff --name-only --no-renames "$OFFICIAL_COMMIT" "$FINAL_INPUT_HEAD" | LC_ALL=C sort -u > "$SQUASH_EVIDENCE_DIR/ALL"
awk '$0 ~ /^(src|bin|docs-site)\// || ($0 ~ /^gui\// && $0 !~ /^gui\/tests\//)' "$SQUASH_EVIDENCE_DIR/ALL" > "$SQUASH_EVIDENCE_DIR/M1"
awk '$0 ~ /^(\.github|scripts|structure|docs)\// || $0 ~ /^(\.gitignore|AGENTS\.local\.md|MAINTAINERS\.md)$/' "$SQUASH_EVIDENCE_DIR/ALL" > "$SQUASH_EVIDENCE_DIR/M2"
awk '$0 ~ /^tests\// || $0 ~ /^gui\/tests\// || $0 == "package.json"' "$SQUASH_EVIDENCE_DIR/ALL" > "$SQUASH_EVIDENCE_DIR/M3"
printf 'FORK_CHANGES.md\n' > "$SQUASH_EVIDENCE_DIR/M4"
for manifest in ALL M1 M2 M3 M4; do
  LC_ALL=C sort -u -o "$SQUASH_EVIDENCE_DIR/$manifest" "$SQUASH_EVIDENCE_DIR/$manifest"
done
LC_ALL=C sort -u "$SQUASH_EVIDENCE_DIR"/M1 "$SQUASH_EVIDENCE_DIR"/M2 \
  "$SQUASH_EVIDENCE_DIR"/M3 "$SQUASH_EVIDENCE_DIR"/M4 > "$SQUASH_EVIDENCE_DIR/UNION"
cmp "$SQUASH_EVIDENCE_DIR/ALL" "$SQUASH_EVIDENCE_DIR/UNION"
for pair in 'M1 M2' 'M1 M3' 'M1 M4' 'M2 M3' 'M2 M4' 'M3 M4'; do
  set -- $pair
  test -z "$(LC_ALL=C comm -12 "$SQUASH_EVIDENCE_DIR/$1" "$SQUASH_EVIDENCE_DIR/$2")"
done
for manifest in M1 M2 M3 M4; do
  printf '%s  %s\n' "$(shasum -a 256 "$SQUASH_EVIDENCE_DIR/$manifest" | awk '{print $1}')" "$manifest"
done > "$SQUASH_EVIDENCE_DIR/manifest-sha256"
```

复用Step 4冻结的metadata，从official开始重建三个对象并证明只有M3因测试收紧而变化：

```bash
set -euo pipefail
source "$SQUASH_EVIDENCE_DIR/rebuild-lib.sh"
PROVISIONAL_C1=$(sed -n '1p' "$SQUASH_EVIDENCE_DIR/c1-provisional")
PROVISIONAL_C2=$(sed -n '1p' "$SQUASH_EVIDENCE_DIR/c2-provisional")
PROVISIONAL_C3=$(sed -n '1p' "$SQUASH_EVIDENCE_DIR/c3-provisional")
load_commit_metadata
TREE1=$(apply_manifest "$OFFICIAL_COMMIT" "$FINAL_INPUT_HEAD" "$SQUASH_EVIDENCE_DIR/M1" "$SQUASH_EVIDENCE_DIR/index-1")
FINAL_C1=$(printf '%s\n' 'feat: 汇总 Fork 运行时与用户能力' | git commit-tree "$TREE1" -p "$OFFICIAL_COMMIT")
TREE2=$(apply_manifest "$FINAL_C1" "$FINAL_INPUT_HEAD" "$SQUASH_EVIDENCE_DIR/M2" "$SQUASH_EVIDENCE_DIR/index-2")
FINAL_C2=$(printf '%s\n' 'chore: 汇总 Fork CI、脚本与维护基础设施' | git commit-tree "$TREE2" -p "$FINAL_C1")
TREE3=$(apply_manifest "$FINAL_C2" "$FINAL_INPUT_HEAD" "$SQUASH_EVIDENCE_DIR/M3" "$SQUASH_EVIDENCE_DIR/index-3")
FINAL_C3=$(printf '%s\n' 'test: 汇总 Fork 回归并推进 v2.40.0-ben.3' | git commit-tree "$TREE3" -p "$FINAL_C2")
test "$FINAL_C1" = "$PROVISIONAL_C1"
test "$FINAL_C2" = "$PROVISIONAL_C2"
test "$FINAL_C3" != "$PROVISIONAL_C3"
printf '%s\n' "$FINAL_C1" > "$SQUASH_EVIDENCE_DIR/c1-final-input"
printf '%s\n' "$FINAL_C2" > "$SQUASH_EVIDENCE_DIR/c2-final-input"
printf '%s\n' "$FINAL_C3" > "$SQUASH_EVIDENCE_DIR/c3-final-input"
```

先输出将要写入的七个值，并确认每个key在唯一`v240-ben3-squash`块中恰好出现一次：

```bash
set -euo pipefail
sed -n '/<!-- v240-ben3-squash:start -->/,/<!-- v240-ben3-squash:end -->/p' FORK_CHANGES.md \
  > "$SQUASH_EVIDENCE_DIR/v240-block-before"
test "$(rg -c '^<!-- v240-ben3-squash:start -->$' FORK_CHANGES.md)" = 1
for key in manifest_1_sha256 manifest_2_sha256 manifest_3_sha256 manifest_4_sha256 c1 c2 c3; do
  test "$(rg -c "^${key}=" "$SQUASH_EVIDENCE_DIR/v240-block-before")" = 1
done
awk '{print $1, $2}' "$SQUASH_EVIDENCE_DIR/manifest-sha256"
for oid_file in c1-final-input c2-final-input c3-final-input; do
  printf '%s=' "$oid_file"
  sed -n '1p' "$SQUASH_EVIDENCE_DIR/$oid_file"
done
```

使用`apply_patch`只替换该块中的`manifest_1_sha256`至`manifest_4_sha256`和`c1`至`c3`七行，
值分别取上述输出；不修改external gate行。随后执行：

```bash
set -euo pipefail
bun test tests/fork-maintenance-truth.test.ts tests/fork-version-policy.test.ts
git diff --check -- FORK_CHANGES.md
git add FORK_CHANGES.md
test "$(git diff --cached --name-only)" = FORK_CHANGES.md
git diff --cached --check
git commit -m "docs: 固定 v2.40.0-ben.3 四提交对象"
```

- [ ] **Step 10: 正式分配 S1并证明C1–C3稳定**

```bash
set -euo pipefail
SOURCE_HEAD_S1=$(git rev-parse HEAD)
EXPECTED_TREE_S1=$(git rev-parse HEAD^{tree})
git show-ref --verify --quiet refs/heads/backup/v240-ben3-source-S1 && exit 1 || true
git branch backup/v240-ben3-source-S1 "$SOURCE_HEAD_S1"
```

以`SOURCE_HEAD_S1`重新生成manifest并重建对象；以下命令不可省略或改成只比总路径数：

```bash
set -euo pipefail
source "$SQUASH_EVIDENCE_DIR/rebuild-lib.sh"
git diff --name-only --no-renames "$OFFICIAL_COMMIT" "$SOURCE_HEAD_S1" | LC_ALL=C sort -u > "$SQUASH_EVIDENCE_DIR/ALL"
awk '$0 ~ /^(src|bin|docs-site)\// || ($0 ~ /^gui\// && $0 !~ /^gui\/tests\//)' "$SQUASH_EVIDENCE_DIR/ALL" > "$SQUASH_EVIDENCE_DIR/M1"
awk '$0 ~ /^(\.github|scripts|structure|docs)\// || $0 ~ /^(\.gitignore|AGENTS\.local\.md|MAINTAINERS\.md)$/' "$SQUASH_EVIDENCE_DIR/ALL" > "$SQUASH_EVIDENCE_DIR/M2"
awk '$0 ~ /^tests\// || $0 ~ /^gui\/tests\// || $0 == "package.json"' "$SQUASH_EVIDENCE_DIR/ALL" > "$SQUASH_EVIDENCE_DIR/M3"
printf 'FORK_CHANGES.md\n' > "$SQUASH_EVIDENCE_DIR/M4"
for manifest in ALL M1 M2 M3 M4; do
  LC_ALL=C sort -u -o "$SQUASH_EVIDENCE_DIR/$manifest" "$SQUASH_EVIDENCE_DIR/$manifest"
done
LC_ALL=C sort -u "$SQUASH_EVIDENCE_DIR"/M1 "$SQUASH_EVIDENCE_DIR"/M2 \
  "$SQUASH_EVIDENCE_DIR"/M3 "$SQUASH_EVIDENCE_DIR"/M4 > "$SQUASH_EVIDENCE_DIR/UNION"
cmp "$SQUASH_EVIDENCE_DIR/ALL" "$SQUASH_EVIDENCE_DIR/UNION"
for pair in 'M1 M2' 'M1 M3' 'M1 M4' 'M2 M3' 'M2 M4' 'M3 M4'; do
  set -- $pair
  test -z "$(LC_ALL=C comm -12 "$SQUASH_EVIDENCE_DIR/$1" "$SQUASH_EVIDENCE_DIR/$2")"
done
for manifest in M1 M2 M3 M4; do
  printf '%s  %s\n' "$(shasum -a 256 "$SQUASH_EVIDENCE_DIR/$manifest" | awk '{print $1}')" "$manifest"
done > "$SQUASH_EVIDENCE_DIR/manifest-sha256"
load_commit_metadata
TREE1=$(apply_manifest "$OFFICIAL_COMMIT" "$SOURCE_HEAD_S1" "$SQUASH_EVIDENCE_DIR/M1" "$SQUASH_EVIDENCE_DIR/index-1")
C1=$(printf '%s\n' 'feat: 汇总 Fork 运行时与用户能力' | git commit-tree "$TREE1" -p "$OFFICIAL_COMMIT")
TREE2=$(apply_manifest "$C1" "$SOURCE_HEAD_S1" "$SQUASH_EVIDENCE_DIR/M2" "$SQUASH_EVIDENCE_DIR/index-2")
C2=$(printf '%s\n' 'chore: 汇总 Fork CI、脚本与维护基础设施' | git commit-tree "$TREE2" -p "$C1")
TREE3=$(apply_manifest "$C2" "$SOURCE_HEAD_S1" "$SQUASH_EVIDENCE_DIR/M3" "$SQUASH_EVIDENCE_DIR/index-3")
C3=$(printf '%s\n' 'test: 汇总 Fork 回归并推进 v2.40.0-ben.3' | git commit-tree "$TREE3" -p "$C2")
test "$C1" = "$(sed -n '1p' "$SQUASH_EVIDENCE_DIR/c1-final-input")"
test "$C2" = "$(sed -n '1p' "$SQUASH_EVIDENCE_DIR/c2-final-input")"
test "$C3" = "$(sed -n '1p' "$SQUASH_EVIDENCE_DIR/c3-final-input")"
```

任一OID变化都停止并定位M1–M3内容变化。成功后创建`.tmp/v240-ben3-squash/S1`，写入source
head/tree、manifest/hash和C1–C3；旧provisional证据保持原文件，不覆盖。

```bash
set -euo pipefail
SNAPSHOT_DIR="$SQUASH_EVIDENCE_DIR/S1"
mkdir "$SNAPSHOT_DIR"
cp "$SQUASH_EVIDENCE_DIR/ALL" "$SQUASH_EVIDENCE_DIR/M1" "$SQUASH_EVIDENCE_DIR/M2" \
  "$SQUASH_EVIDENCE_DIR/M3" "$SQUASH_EVIDENCE_DIR/M4" "$SQUASH_EVIDENCE_DIR/manifest-sha256" \
  "$SNAPSHOT_DIR/"
printf '%s\n' "$SOURCE_HEAD_S1" > "$SNAPSHOT_DIR/source-head"
printf '%s\n' "$EXPECTED_TREE_S1" > "$SNAPSHOT_DIR/expected-tree"
printf '%s\n' "$C1" > "$SNAPSHOT_DIR/c1"
printf '%s\n' "$C2" > "$SNAPSHOT_DIR/c2"
printf '%s\n' "$C3" > "$SNAPSHOT_DIR/c3"
printf '%s\n' "$SOURCE_HEAD_S1" > "$SQUASH_EVIDENCE_DIR/source-head-S1"
printf '%s\n' "$EXPECTED_TREE_S1" > "$SQUASH_EVIDENCE_DIR/expected-tree-S1"
printf '%s\n' "$C1" > "$SQUASH_EVIDENCE_DIR/c1-S1"
printf '%s\n' "$C2" > "$SQUASH_EVIDENCE_DIR/c2-S1"
printf '%s\n' "$C3" > "$SQUASH_EVIDENCE_DIR/c3-S1"
```

- [ ] **Step 11: 构建尚未分配push attempt的 C4_PROVISIONAL**

```bash
set -euo pipefail
source "$SQUASH_EVIDENCE_DIR/rebuild-lib.sh"
load_commit_metadata
TREE4=$(apply_manifest "$C3" "$SOURCE_HEAD_S1" "$SQUASH_EVIDENCE_DIR/M4" "$SQUASH_EVIDENCE_DIR/index-4")
C4_PROVISIONAL=$(printf '%s\n\n%s\n' 'docs: 记录 v2.40.0-ben.3 四提交候选' '候选尝试: 尚未分配' | git commit-tree "$TREE4" -p "$C3")
test "$(git rev-parse "$C4_PROVISIONAL^{tree}")" = "$EXPECTED_TREE_S1"
printf '%s\n' "$C4_PROVISIONAL" > "$SQUASH_EVIDENCE_DIR/c4-provisional-S1"
printf '%s\n' "$C4_PROVISIONAL" > "$SQUASH_EVIDENCE_DIR/S1/c4-provisional"
```

- [ ] **Step 12: 完整机械检查并安全切换本地dev**

先使用`apply_patch`创建`.tmp/v240-ben3-squash/verify-audit-block.mjs`：

```js
import { readFileSync } from "node:fs";

const [docPath, hashPath, expectedSnapshot, c1, c2, c3] = process.argv.slice(2);
const text = readFileSync(docPath, "utf8");
const begin = "<!-- v240-ben3-squash:start -->";
const end = "<!-- v240-ben3-squash:end -->";
const starts = text.split(begin).length - 1;
const ends = text.split(end).length - 1;
if (starts !== 1 || ends !== 1) throw new Error("v240 audit block must occur once");
const block = text.slice(text.indexOf(begin) + begin.length, text.indexOf(end)).trim();
const values = new Map();
for (const line of block.split("\n").filter(Boolean)) {
  const split = line.indexOf("=");
  if (split < 1) throw new Error(`invalid audit row: ${line}`);
  const key = line.slice(0, split);
  if (values.has(key)) throw new Error(`duplicate audit key: ${key}`);
  values.set(key, line.slice(split + 1));
}
const hashes = new Map(readFileSync(hashPath, "utf8").trim().split("\n").map(line => {
  const [hash, name] = line.trim().split(/\s+/);
  return [name, hash];
}));
for (let index = 1; index <= 4; index += 1) {
  const actual = values.get(`manifest_${index}_sha256`);
  const expected = hashes.get(`M${index}`);
  if (!expected || actual !== expected) throw new Error(`manifest_${index}_sha256 mismatch`);
}
for (const [key, expected] of [["c1", c1], ["c2", c2], ["c3", c3]]) {
  if (values.get(key) !== expected) throw new Error(`${key} mismatch`);
}
if (values.get("target_commit_count") !== "4" ||
    values.get("official_base") !== "35ff3a462e786bd5efc394dfb1a8a5cc946e454f" ||
    values.get("source_release") !== "569f0e7b7d3388758b05553fda9ba2a13208433f" ||
    values.get("source_commit_count") !== "10" ||
    values.get("content_snapshot") !== expectedSnapshot ||
    values.get("expected_tree") !== "external-task-evidence" ||
    values.get("release_commit") !== "docs-only-current-head") {
  throw new Error("fixed v240 audit contract mismatch");
}
for (const key of ["candidate_ci", "workflow_security_review", "regular_reviews", "tag",
  "atomic_promotion", "main_ci", "github_release"]) {
  if (values.get(key) !== "pending external gate") throw new Error(`${key} must remain pending external gate`);
}
```

再使用`apply_patch`把下列严格模式与函数原样写入
`.tmp/v240-ben3-squash/check-candidate.sh`；source该文件会让caller立即进入严格模式，避免调用失败
后继续执行，也避免各阶段复制出不同检查子集：

```bash
set -euo pipefail

check_candidate() (
  set -euo pipefail
  candidate="$1"
  expected_remote="$2"
  source_head="$3"
  expected_tree="$4"
  c1="$5"
  c2="$6"
  c3="$7"
  manifest_dir="$8"
  snapshot_name=$(basename "$manifest_dir")
  test "${snapshot_name#S}" != "$snapshot_name"
  source "$SQUASH_EVIDENCE_DIR/rebuild-lib.sh"
  check_dir=$(mktemp -d "$SQUASH_EVIDENCE_DIR/check.XXXXXX")
  build_manifests "$source_head" "$check_dir"
  for manifest in ALL M1 M2 M3 M4 manifest-sha256; do
    test -s "$manifest_dir/$manifest"
    cmp "$manifest_dir/$manifest" "$check_dir/$manifest"
  done
  git merge-base --is-ancestor "$OFFICIAL_COMMIT" "$candidate"
  test "$(git rev-parse "$c1^")" = "$OFFICIAL_COMMIT"
  test "$(git rev-parse "$c2^")" = "$c1"
  test "$(git rev-parse "$c3^")" = "$c2"
  test "$(git rev-parse "$candidate^")" = "$c3"
  test "$(git rev-list --count "$OFFICIAL_COMMIT..$candidate")" = 4
  test -z "$(git rev-list --min-parents=2 "$OFFICIAL_COMMIT..$candidate")"
  test "$(git rev-parse "$candidate^{tree}")" = "$expected_tree"
  test "$(git diff-tree --no-commit-id --name-only -r "$candidate")" = FORK_CHANGES.md
  git diff --name-only --no-renames "$OFFICIAL_COMMIT" "$c1" | LC_ALL=C sort -u > "$check_dir/actual-M1"
  git diff --name-only --no-renames "$c1" "$c2" | LC_ALL=C sort -u > "$check_dir/actual-M2"
  git diff --name-only --no-renames "$c2" "$c3" | LC_ALL=C sort -u > "$check_dir/actual-M3"
  git diff --name-only --no-renames "$c3" "$candidate" | LC_ALL=C sort -u > "$check_dir/actual-M4"
  for manifest in M1 M2 M3 M4; do
    cmp "$manifest_dir/$manifest" "$check_dir/actual-$manifest"
  done
  git diff --name-only --no-renames "$OFFICIAL_COMMIT" "$candidate" | LC_ALL=C sort -u > "$check_dir/candidate-ALL"
  cmp "$manifest_dir/ALL" "$check_dir/candidate-ALL"
  git diff --exit-code "$source_head^{tree}" "$candidate^{tree}"
  git diff --check "$OFFICIAL_COMMIT...$candidate"
  git show "$candidate:FORK_CHANGES.md" > "$check_dir/FORK_CHANGES.md"
  node "$SQUASH_EVIDENCE_DIR/verify-audit-block.mjs" \
    "$check_dir/FORK_CHANGES.md" "$check_dir/manifest-sha256" "$snapshot_name" "$c1" "$c2" "$c3"
  if [ -n "$expected_remote" ]; then
    test "$(git rev-parse refs/remotes/origin/dev)" = "$expected_remote"
    test "$expected_remote" = "$candidate"
  fi
)
```

然后执行：

```bash
set -euo pipefail
source "$SQUASH_EVIDENCE_DIR/check-candidate.sh"
check_candidate "$C4_PROVISIONAL" "" "$SOURCE_HEAD_S1" "$EXPECTED_TREE_S1" "$C1" "$C2" "$C3" "$SQUASH_EVIDENCE_DIR/S1"
test "$(git rev-parse refs/heads/dev)" = "$SOURCE_HEAD_S1"
test "$(git rev-parse HEAD)" = "$SOURCE_HEAD_S1"
git diff --quiet
git diff --cached --quiet
test -z "$(git status --porcelain=v1)"
for state in rebase-merge rebase-apply MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD BISECT_LOG; do
  test ! -e "$(git rev-parse --git-path "$state")"
done
git update-ref refs/heads/dev "$C4_PROVISIONAL" "$SOURCE_HEAD_S1"
git reset --hard "$C4_PROVISIONAL"
test "$(git rev-parse HEAD)" = "$C4_PROVISIONAL"
git status --porcelain=v1
```

Expected: 最后一条输出为空；main/sync/Tag未移动。

---

### Task 5: 本地验证与 workflow security review

**Files:**
- Verify: 完整candidate tree
- Review: `.github/workflows/ci.yml`、`tests/ci-workflows.test.ts`

**Interfaces:**
- Consumes: C4_PROVISIONAL / S1 evidence。
- Produces: candidate push前本地PASS、绑定ci.yml blob的security PASS。

- [ ] **Step 1: 运行focused门禁**

```bash
set -euo pipefail
SQUASH_EVIDENCE_DIR=.tmp/v240-ben3-squash
OFFICIAL_COMMIT=$(sed -n '1p' "$SQUASH_EVIDENCE_DIR/official-commit")
VALIDATION_S="${NEW_S:-S1}"
VALIDATION_S_DIR="$SQUASH_EVIDENCE_DIR/$VALIDATION_S"
C1=$(sed -n '1p' "$VALIDATION_S_DIR/c1")
C2=$(sed -n '1p' "$VALIDATION_S_DIR/c2")
C3=$(sed -n '1p' "$VALIDATION_S_DIR/c3")
C4_PROVISIONAL=$(git rev-parse HEAD)
SOURCE_HEAD_S1=$(sed -n '1p' "$VALIDATION_S_DIR/source-head")
EXPECTED_TREE_S1=$(sed -n '1p' "$VALIDATION_S_DIR/expected-tree")
bun test tests/ci-workflows.test.ts tests/fork-ci-official-baseline.test.ts
bun test tests/fork-maintenance-truth.test.ts tests/fork-version-policy.test.ts
```

任何实现变化都创建新S并回到Task 4。

- [ ] **Step 2: 启动完整prepush**

通过已登记的持久shell session用`write_stdin`发送`bun run prepush`；不启动第二个shell或第二份
prepush。

```bash
set -euo pipefail
PREPUSH_LOG="$SQUASH_EVIDENCE_DIR/prepush-$VALIDATION_S.log"
if bun run prepush 2>&1 | tee "$PREPUSH_LOG"; then
  PREPUSH_STATUS=0
else
  PREPUSH_STATUS=$?
fi
printf '%s\n' "$PREPUSH_STATUS" > "$SQUASH_EVIDENCE_DIR/prepush-$VALIDATION_S-exit-status"
```

- [ ] **Step 3: 读取prepush终态**

用`write_stdin`每次最多等待30秒，直至同一session输出本次`__OCX_BLOCK_DONE__`或因strict失败明确
退出。必须记录完整exit code和pass/skip/fail counts，并执行：

```bash
set -euo pipefail
test -s "$PREPUSH_LOG"
if [ "$PREPUSH_STATUS" -eq 0 ]; then
  printf 'PASS\n' > "$SQUASH_EVIDENCE_DIR/prepush-$VALIDATION_S-verdict"
else
  printf 'FAIL\n' > "$SQUASH_EVIDENCE_DIR/prepush-$VALIDATION_S-verdict"
  printf 'material-fix-before-security-review\n' > "$SQUASH_EVIDENCE_DIR/prepush-$VALIDATION_S-next-action"
  MATERIAL_FIX_REASON=prepush-failure
fi
```

FAIL时不进入Step 4/5，不沿用旧结果；从`BASE_S=$VALIDATION_S`执行Step 6的新S修复入口，修复后重新运行完整
focused/prepush。只有当前最新S的prepush verdict为PASS才允许security review。

- [ ] **Step 4: 重跑四提交/tree检查并固定workflow blob**

重新加载S1全部变量并调用持久化`check_candidate`，然后固定workflow blob：

```bash
set -euo pipefail
test "$(sed -n '1p' "$SQUASH_EVIDENCE_DIR/prepush-$VALIDATION_S-verdict")" = PASS
source "$SQUASH_EVIDENCE_DIR/check-candidate.sh"
check_candidate "$C4_PROVISIONAL" "" "$SOURCE_HEAD_S1" "$EXPECTED_TREE_S1" "$C1" "$C2" "$C3" "$VALIDATION_S_DIR"
COMPUTED_WORKFLOW_BLOB=$(git rev-parse "$C4_PROVISIONAL:.github/workflows/ci.yml")
if [ -e "$SQUASH_EVIDENCE_DIR/ci-workflow-blob-$VALIDATION_S" ]; then
  test "$(sed -n '1p' "$SQUASH_EVIDENCE_DIR/ci-workflow-blob-$VALIDATION_S")" = \
    "$COMPUTED_WORKFLOW_BLOB"
else
  printf '%s\n' "$COMPUTED_WORKFLOW_BLOB" > "$SQUASH_EVIDENCE_DIR/ci-workflow-blob-$VALIDATION_S"
fi
if [ -e "$VALIDATION_S_DIR/ci-workflow-blob" ]; then
  test "$(sed -n '1p' "$VALIDATION_S_DIR/ci-workflow-blob")" = "$COMPUTED_WORKFLOW_BLOB"
else
  printf '%s\n' "$COMPUTED_WORKFLOW_BLOB" > "$VALIDATION_S_DIR/ci-workflow-blob"
fi
git status --porcelain=v1
```

- [ ] **Step 5: 派发限定workflow的security reviewer**

先按当前S的落盘状态选择唯一security路线：

```bash
set -euo pipefail
SECURITY_BLOB=$(sed -n '1p' "$VALIDATION_S_DIR/ci-workflow-blob")
if [ -e "$VALIDATION_S_DIR/security-verdict" ]; then
  test "$(sed -n '1p' "$VALIDATION_S_DIR/security-verdict")" = PASS
  SECURITY_REVIEW_EVIDENCE=$(sed -n '1p' "$VALIDATION_S_DIR/security-review-evidence")
  test -s "$SECURITY_REVIEW_EVIDENCE"
  test "$(shasum -a 256 "$SECURITY_REVIEW_EVIDENCE" | awk '{print $1}')" = \
    "$(sed -n '1p' "$VALIDATION_S_DIR/security-review-sha256")"
  SECURITY_ROUTE=REUSE_PASS
elif [ -e "$SQUASH_EVIDENCE_DIR/security-reviewer-thread" ]; then
  SECURITY_ROUTE=RE_REVIEW
else
  SECURITY_ROUTE=INITIAL
fi
```

`REUSE_PASS`不派 reviewer、不创建新R目录，直接进入Step 6的已绑定分支。其它路线分配append-only
round：

```bash
set -euo pipefail
if [ "$SECURITY_ROUTE" != REUSE_PASS ]; then
  SECURITY_REVIEW_ROOT="$SQUASH_EVIDENCE_DIR/security-reviews/$SECURITY_BLOB/$VALIDATION_S"
  mkdir -p "$SECURITY_REVIEW_ROOT"
  NEXT_SECURITY_ROUND=$(node --input-type=module -e '
    import { readdirSync } from "node:fs";
    const rows = readdirSync(process.argv[1], { withFileTypes: true })
      .filter(x => x.isDirectory() && /^R[1-9][0-9]*$/.test(x.name))
      .map(x => Number(x.name.slice(1)));
    process.stdout.write(String((rows.length ? Math.max(...rows) : 0) + 1));
  ' "$SECURITY_REVIEW_ROOT")
  SECURITY_REVIEW_ROUND="$SECURITY_REVIEW_ROOT/R$NEXT_SECURITY_ROUND"
  mkdir "$SECURITY_REVIEW_ROUND"
fi
```

路线`INITIAL`：派独立`reviewer`，`fork_turns: none`，`REVIEW_MODE: CODE_QUALITY`、
`REVIEW_PHASE: INITIAL`、稳定`REVIEW_SCOPE_ID: v240-ben3-ci-workflow-security`；成功创建后把精确reviewer
task id只写一次到`security-reviewer-thread`。路线`RE_REVIEW`：从该文件取得原task id，使用
follow-up复用原reviewer并发送`REVIEW_PHASE: RE_REVIEW`、完整PRIOR_FINDINGS、FIX_DIFF和
VERIFICATION_EVIDENCE。

两条审查路线的包都只含Spec、workflow旧/新blob与diff、CI tests和本地验证，并检查trigger、
permissions、runner、action SHA pin、secret可达性、GUI/packaging producer及aggregate skip policy。
使用`apply_patch`把prompt/响应分别保存为当前round的`request.md`/`response.md`。机械要求request只有
一个正确mode/scope/phase，response只有一个`## Code Quality: PASS|FAIL`；把解析结果写入只创建一次的
`verdict`并保存response SHA-256，不覆盖旧round。

- [ ] **Step 6: 绑定PASS或创建下一material-fix S**

若`SECURITY_ROUTE=REUSE_PASS`，前一步已经机械验证当前S的PASS/hash，直接结束security gate。否则
当前round为`Code Quality: PASS`且没有Critical/Important finding时，机械绑定当前
`VALIDATION_S`；request的phase必须等于实际`SECURITY_ROUTE`：

```bash
set -euo pipefail
if [ "$SECURITY_ROUTE" != REUSE_PASS ]; then
  test "$(sed -n '1p' "$SECURITY_REVIEW_ROUND/verdict")" = PASS
  test -s "$SECURITY_REVIEW_ROUND/request.md"
  test -s "$SECURITY_REVIEW_ROUND/response.md"
  rg -x 'REVIEW_MODE: CODE_QUALITY' "$SECURITY_REVIEW_ROUND/request.md"
  rg -x 'REVIEW_SCOPE_ID: v240-ben3-ci-workflow-security' "$SECURITY_REVIEW_ROUND/request.md"
  if [ "$SECURITY_ROUTE" = INITIAL ]; then
    rg -x 'REVIEW_PHASE: INITIAL' "$SECURITY_REVIEW_ROUND/request.md"
  else
    rg -x 'REVIEW_PHASE: RE_REVIEW' "$SECURITY_REVIEW_ROUND/request.md"
  fi
  rg -x '## Code Quality: PASS' "$SECURITY_REVIEW_ROUND/response.md"
  test -z "$(rg '^### \[(Critical|Important)\]' "$SECURITY_REVIEW_ROUND/response.md" || true)"
  test ! -e "$VALIDATION_S_DIR/security-verdict"
  printf 'PASS\n' > "$VALIDATION_S_DIR/security-verdict"
  printf '%s\n' "$SECURITY_REVIEW_ROUND/response.md" > "$VALIDATION_S_DIR/security-review-evidence"
  shasum -a 256 "$SECURITY_REVIEW_ROUND/response.md" | awk '{print $1}' \
    > "$VALIDATION_S_DIR/security-review-sha256"
fi
```

若prepush FAIL或本轮security响应有Critical/Important finding，不依赖A tuple：显式设置
`BASE_S=$VALIDATION_S`并创建下一S。security finding时先设
`MATERIAL_FIX_REASON=security-finding`并把当前response路径保存到`PRIOR_SECURITY_FINDING`；prepush失败
沿用Step 3的`MATERIAL_FIX_REASON=prepush-failure`，此时不得假设reviewer thread存在。
workflow/规则改动进入M2，`tests/ci-workflows.test.ts`或
`tests/fork-ci-official-baseline.test.ts`进入M3，两者同时变化从C2开始：

```bash
set -euo pipefail
if [ "$(sed -n '1p' "$SQUASH_EVIDENCE_DIR/prepush-$VALIDATION_S-verdict")" = FAIL ]; then
  MATERIAL_FIX_REASON=prepush-failure
else
  test "$SECURITY_ROUTE" != REUSE_PASS
  test "$(sed -n '1p' "$SECURITY_REVIEW_ROUND/verdict")" = FAIL
  MATERIAL_FIX_REASON=security-finding
  PRIOR_SECURITY_FINDING="$SECURITY_REVIEW_ROUND/response.md"
  test -s "$PRIOR_SECURITY_FINDING"
fi
source "$SQUASH_EVIDENCE_DIR/rebuild-lib.sh"
BASE_S="$VALIDATION_S"
OLD_LOCAL_DEV=$(git rev-parse refs/heads/dev)
start_next_snapshot "$BASE_S" "$OLD_LOCAL_DEV"
```

使用`apply_patch`实施finding并运行focused测试，显式暂存实际文件、创建中文source修复commit；随后：

```bash
set -euo pipefail
NEW_SOURCE_INPUT=$(git rev-parse HEAD)
build_manifests "$NEW_SOURCE_INPUT" "$SQUASH_EVIDENCE_DIR"
build_c1_c3 "$NEW_SOURCE_INPUT" "$SQUASH_EVIDENCE_DIR"
printf '%s\n' "$C1" > "$SQUASH_EVIDENCE_DIR/c1-$NEW_S-input"
printf '%s\n' "$C2" > "$SQUASH_EVIDENCE_DIR/c2-$NEW_S-input"
printf '%s\n' "$C3" > "$SQUASH_EVIDENCE_DIR/c3-$NEW_S-input"
```

用`apply_patch`把`content_snapshot=$NEW_S`、新的四个manifest hash和C1–C3写入唯一
`v240-ben3-squash`块，运行维护真源测试，提交仅`FORK_CHANGES.md`的source末尾commit。然后证明
最终source没有改变C1–C3并完成S：

```bash
set -euo pipefail
NEW_SOURCE=$(git rev-parse HEAD)
build_manifests "$NEW_SOURCE" "$SQUASH_EVIDENCE_DIR"
build_c1_c3 "$NEW_SOURCE" "$SQUASH_EVIDENCE_DIR"
test "$C1" = "$(sed -n '1p' "$SQUASH_EVIDENCE_DIR/c1-$NEW_S-input")"
test "$C2" = "$(sed -n '1p' "$SQUASH_EVIDENCE_DIR/c2-$NEW_S-input")"
test "$C3" = "$(sed -n '1p' "$SQUASH_EVIDENCE_DIR/c3-$NEW_S-input")"
finish_next_snapshot
NEW_WORKFLOW_BLOB=$(git rev-parse "$NEW_C4:.github/workflows/ci.yml")
printf '%s\n' "$NEW_WORKFLOW_BLOB" > "$NEW_S_DIR/ci-workflow-blob"
```

只记录material-fix来源，不在本步骤派reviewer或写PASS：

```bash
set -euo pipefail
printf '%s\n' "$MATERIAL_FIX_REASON" > "$NEW_S_DIR/material-fix-reason"
if [ "$MATERIAL_FIX_REASON" = security-finding ]; then
  test -s "$PRIOR_SECURITY_FINDING"
  printf '%s\n' "$PRIOR_SECURITY_FINDING" > "$NEW_S_DIR/prior-security-finding"
fi
test ! -e "$NEW_S_DIR/security-verdict"
VALIDATION_S="$NEW_S"
VALIDATION_S_DIR="$NEW_S_DIR"
C4_PROVISIONAL="$NEW_C4"
```

随后无条件回到Task 5 Step 1，对`VALIDATION_S=$NEW_S`重新运行focused与完整prepush。prepush PASS
后，Step 5按落盘状态选择INITIAL、RE_REVIEW或REUSE_PASS；只有最终出现匹配workflow blob的
`security-verdict=PASS`与hash匹配的append-only evidence，才可分配A。

---

### Task 6: dev candidate push与 amend CI循环

**Files:**
- Mutate remote: `refs/heads/dev`
- Preserve: `main`、`sync/v2.40.0`、全部Tag与Release

**Interfaces:**
- Consumes: security-approved C4_AJ、origin/dev expected-old。
- Produces: 最新C4 SHA的成功push/dev Cross-platform CI与append-only A evidence。

- [ ] **Step 1: 为即将发生的push分配全局递增 A_J并amend C4**

```bash
set -euo pipefail
SQUASH_EVIDENCE_DIR=.tmp/v240-ben3-squash
NEXT_A=$(node --input-type=module -e '
  import { readdirSync } from "node:fs";
  const nums = readdirSync(process.argv[1], { withFileTypes: true })
    .filter(x => x.isDirectory() && /^A[1-9][0-9]*$/.test(x.name))
    .map(x => Number(x.name.slice(1)));
  process.stdout.write(String((nums.length === 0 ? 0 : Math.max(...nums)) + 1));
' "$SQUASH_EVIDENCE_DIR")
ATTEMPT_DIR="$SQUASH_EVIDENCE_DIR/A$NEXT_A"
mkdir "$ATTEMPT_DIR"
CURRENT_S=$(node --input-type=module -e '
  import { readdirSync } from "node:fs";
  const nums = readdirSync(process.argv[1], { withFileTypes: true })
    .filter(x => x.isDirectory() && /^S[1-9][0-9]*$/.test(x.name))
    .map(x => Number(x.name.slice(1)));
  if (nums.length === 0) throw new Error("no content snapshot exists");
  process.stdout.write(`S${Math.max(...nums)}`);
' "$SQUASH_EVIDENCE_DIR")
PRE_AMEND_C4=$(git rev-parse HEAD)
PRE_AMEND_TREE=$(git rev-parse HEAD^{tree})
PRE_AMEND_PARENT=$(git rev-parse HEAD^)
git commit --amend -m "docs: 记录 v2.40.0-ben.3 四提交候选" -m "候选尝试: A$NEXT_A"
CURRENT_C4=$(git rev-parse HEAD)
test "$(git rev-parse HEAD^{tree})" = "$PRE_AMEND_TREE"
test "$(git rev-parse HEAD^)" = "$PRE_AMEND_PARENT"
printf '%s\n' "$CURRENT_S" > "$ATTEMPT_DIR/content-snapshot"
printf '%s\n' "$CURRENT_C4" > "$ATTEMPT_DIR/c4"
```

每次实际push前都执行该步骤；即使上一次只因环境失败，旧A目录也不覆盖。

- [ ] **Step 2: 紧邻push按A历史冻结expected remote dev**

```bash
set -euo pipefail
OFFICIAL_COMMIT=$(sed -n '1p' "$SQUASH_EVIDENCE_DIR/official-commit")
CURRENT_S=$(sed -n '1p' "$ATTEMPT_DIR/content-snapshot")
SNAPSHOT_DIR="$SQUASH_EVIDENCE_DIR/$CURRENT_S"
SOURCE_HEAD_CURRENT=$(sed -n '1p' "$SNAPSHOT_DIR/source-head")
EXPECTED_TREE_CURRENT=$(sed -n '1p' "$SNAPSHOT_DIR/expected-tree")
C1_CURRENT=$(sed -n '1p' "$SNAPSHOT_DIR/c1")
C2_CURRENT=$(sed -n '1p' "$SNAPSHOT_DIR/c2")
C3_CURRENT=$(sed -n '1p' "$SNAPSHOT_DIR/c3")
git fetch origin --prune --tags
ACTUAL_REMOTE_DEV=$(git rev-parse refs/remotes/origin/dev)
LAST_PUSHED_A=$(node --input-type=module -e '
  import { existsSync, readFileSync, readdirSync } from "node:fs";
  const rows = readdirSync(process.argv[1], { withFileTypes: true })
    .filter(x => x.isDirectory() && /^A[1-9][0-9]*$/.test(x.name))
    .map(x => ({ name: x.name, n: Number(x.name.slice(1)) }))
    .filter(x => {
      const root = `${process.argv[1]}/${x.name}`;
      return existsSync(`${root}/pushed-remote-dev`) &&
        readFileSync(`${root}/candidate-push-verdict`, "utf8").trim() === "remote-is-current";
    })
    .sort((a, b) => b.n - a.n);
  process.stdout.write(rows[0]?.name ?? "");
' "$SQUASH_EVIDENCE_DIR")
if [ -z "$LAST_PUSHED_A" ]; then
  EXPECTED_REMOTE_DEV=$(awk '$2 == "refs/heads/dev" { print $1 }' "$SQUASH_EVIDENCE_DIR/task-initial/remote-refs")
else
  EXPECTED_REMOTE_DEV=$(sed -n '1p' "$SQUASH_EVIDENCE_DIR/$LAST_PUSHED_A/pushed-remote-dev")
fi
test "$ACTUAL_REMOTE_DEV" = "$EXPECTED_REMOTE_DEV"
printf '%s\n' "$EXPECTED_REMOTE_DEV" > "$ATTEMPT_DIR/expected-remote-dev"
test "$(git rev-parse "$CURRENT_C4:.github/workflows/ci.yml")" = "$(sed -n '1p' "$SNAPSHOT_DIR/ci-workflow-blob")"
test "$(sed -n '1p' "$SNAPSHOT_DIR/security-verdict")" = PASS
SECURITY_REVIEW_EVIDENCE=$(sed -n '1p' "$SNAPSHOT_DIR/security-review-evidence")
test -s "$SECURITY_REVIEW_EVIDENCE"
test "$(shasum -a 256 "$SECURITY_REVIEW_EVIDENCE" | awk '{print $1}')" = \
  "$(sed -n '1p' "$SNAPSHOT_DIR/security-review-sha256")"
source "$SQUASH_EVIDENCE_DIR/check-candidate.sh"
check_candidate "$CURRENT_C4" "" "$SOURCE_HEAD_CURRENT" "$EXPECTED_TREE_CURRENT" "$C1_CURRENT" "$C2_CURRENT" "$C3_CURRENT" "$SNAPSHOT_DIR"
```

首次expected-old来自Task 0；后续严格来自上一A tuple。任何漂移停止。

- [ ] **Step 3: 精确lease强推候选dev**

先用`apply_patch`创建`.tmp/v240-ben3-squash/classify-candidate-push.sh`：

```bash
set -euo pipefail

classify_candidate_push() (
  set -euo pipefail
  verdict="$ATTEMPT_DIR/candidate-push-verdict"
  printf 'checking\n' > "$verdict"
  if ! git ls-remote origin refs/heads/dev > "$ATTEMPT_DIR/remote-after.raw"; then
    printf 'remote-error\n' > "$verdict"
    return 30
  fi
  remote_after=$(awk '$2 == "refs/heads/dev" {print $1}' "$ATTEMPT_DIR/remote-after.raw")
  printf '%s\n' "$remote_after" > "$ATTEMPT_DIR/remote-after"
  if test "$remote_after" = "$CURRENT_C4"; then
    printf 'remote-is-current\n' > "$verdict"
    printf '%s\n' "$CURRENT_C4" > "$ATTEMPT_DIR/pushed-remote-dev"
    return 0
  fi
  if test "$remote_after" = "$EXPECTED_REMOTE_DEV"; then
    printf 'remote-unchanged\n' > "$verdict"
    return 10
  fi
  printf 'remote-drift\n' > "$verdict"
  return 20
)
```

捕获push退出状态后，用本次A专属remote后验分类；服务端已更新但客户端返回非0仍归为
`remote-is-current`并继续：

```bash
set -euo pipefail
if git push origin \
  --force-with-lease=refs/heads/dev:"$EXPECTED_REMOTE_DEV" \
  +"$CURRENT_C4":refs/heads/dev; then
  CANDIDATE_PUSH_STATUS=0
else
  CANDIDATE_PUSH_STATUS=$?
fi
printf '%s\n' "$CANDIDATE_PUSH_STATUS" > "$ATTEMPT_DIR/push-exit-status"
source "$SQUASH_EVIDENCE_DIR/classify-candidate-push.sh"
set +e
classify_candidate_push
CANDIDATE_CLASSIFY_STATUS=$?
set -euo pipefail
if [ "$CANDIDATE_CLASSIFY_STATUS" -eq 10 ]; then
  printf 'allocate-new-A\n' > "$ATTEMPT_DIR/next-action"
else
  test "$CANDIDATE_CLASSIFY_STATUS" = 0
  test "$(sed -n '1p' "$ATTEMPT_DIR/candidate-push-verdict")" = remote-is-current
  test "$(sed -n '1p' "$ATTEMPT_DIR/pushed-remote-dev")" = "$CURRENT_C4"
  git fetch origin --prune --no-tags
  check_candidate "$CURRENT_C4" "$CURRENT_C4" "$SOURCE_HEAD_CURRENT" "$EXPECTED_TREE_CURRENT" \
    "$C1_CURRENT" "$C2_CURRENT" "$C3_CURRENT" "$SNAPSHOT_DIR"
fi
```

分类20（其它OID）或30（无法读取）均fail closed。分类10证明远端未更新后，不复用旧A、不写
`pushed-remote-dev`，回到Step 1以message-only amend分配新A和新C4再推；pre-push hook每次仍运行
完整本地门禁。后续expected-old只从`candidate-push-verdict=remote-is-current`且
`pushed-remote-dev`匹配该A的最新tuple推导。

- [ ] **Step 4: 用GitHub API绑定唯一candidate run**

使用`apply_patch`创建`.tmp/v240-ben3-squash/discover-ci-run.mjs`，candidate与main共用：

```js
import { readFileSync } from "node:fs";

const [runsPath, branch, sha] = process.argv.slice(2);
const body = JSON.parse(readFileSync(runsPath, "utf8"));
const rows = body.workflow_runs.filter(run =>
  run.path === ".github/workflows/ci.yml" && run.name === "Cross-platform CI" &&
  run.event === "push" && run.head_branch === branch && run.head_sha === sha);
if (rows.length === 0) {
  process.stdout.write("WAIT");
} else if (rows.length === 1) {
  process.stdout.write(String(rows[0].id));
} else {
  throw new Error(`duplicate exact workflow runs: ${rows.map(run => run.id).join(",")}`);
}
```

在同一strict block中先等待0条变成1条，再固定run；API失败、重复run或10分钟timeout都停止：

```bash
set -euo pipefail
DISCOVERY_DIR="$ATTEMPT_DIR/run-discovery"
mkdir -p "$DISCOVERY_DIR"
RUN_ID=""
for DISCOVERY_INDEX in {1..40}; do
  RUNS_JSON="$DISCOVERY_DIR/runs-$DISCOVERY_INDEX.json"
  gh api "repos/Trendymen/opencodex/actions/workflows/ci.yml/runs?branch=dev&event=push&per_page=30" \
    > "$RUNS_JSON"
  DISCOVERY_RESULT=$(node "$SQUASH_EVIDENCE_DIR/discover-ci-run.mjs" \
    "$RUNS_JSON" dev "$CURRENT_C4")
  if [ "$DISCOVERY_RESULT" != WAIT ]; then
    RUN_ID="$DISCOVERY_RESULT"
    break
  fi
  sleep 15
done
test -n "$RUN_ID"
printf '%s\n' "$RUN_ID" > "$ATTEMPT_DIR/run-id"
```

该前台循环通过同一持久shell的`write_stdin`读取；不要启动第二个shell或并发watcher。

- [ ] **Step 5: 建立单一CI验证器并读取candidate终态**

使用`apply_patch`创建忽略文件`.tmp/v240-ben3-squash/verify-ci-run.mjs`，内容固定为：

```js
import { readFileSync } from "node:fs";

const [runPath, jobsPath, expectedBranch, expectedSha] = process.argv.slice(2);
if (!runPath || !jobsPath || !expectedBranch || !/^[0-9a-f]{40}$/.test(expectedSha ?? "")) {
  throw new Error("usage: verify-ci-run.mjs RUN_JSON JOBS_JSON BRANCH SHA");
}
const run = JSON.parse(readFileSync(runPath, "utf8"));
const jobs = JSON.parse(readFileSync(jobsPath, "utf8")).jobs;
if (run.path !== ".github/workflows/ci.yml" || run.name !== "Cross-platform CI" ||
    run.event !== "push" || run.head_branch !== expectedBranch || run.head_sha !== expectedSha ||
    run.status !== "completed" || run.conclusion !== "success") {
  throw new Error("workflow identity/result mismatch");
}
const required = [
  "changes", "select windows runner", "gates", "macos", "storage policy", "api usage", "ci",
  "test 1/4", "test 2/4", "test 3/4", "test 4/4",
  "keyring ubuntu", "keyring windows", "keyring macos",
  "npm-global ubuntu-latest", "npm-global windows-latest", "npm-global macos-latest",
];
for (const name of required) {
  const row = jobs.find(job => job.name === name);
  if (!row || row.status !== "completed" || row.conclusion !== "success") {
    throw new Error(`required job not successful: ${name}`);
  }
}
for (const job of jobs) {
  if (job.conclusion === "skipped" && job.name.startsWith("windows ")) continue;
  if (job.status !== "completed" || job.conclusion !== "success") {
    throw new Error(`unexpected job result: ${job.name}=${job.status}/${job.conclusion}`);
  }
}
```

创建后立即冻结验证器hash：

```bash
set -euo pipefail
shasum -a 256 "$SQUASH_EVIDENCE_DIR/verify-ci-run.mjs" | awk '{print $1}' \
  > "$SQUASH_EVIDENCE_DIR/verify-ci-run.sha256"
```

在既有持久shell中只运行一个前台`gh run watch`，用`write_stdin`读取至命令终止，然后保存终态并
调用该验证器：

```bash
set -euo pipefail
if gh run watch "$RUN_ID" --repo Trendymen/opencodex --exit-status --interval 15; then
  WATCH_STATUS=0
else
  WATCH_STATUS=$?
fi
printf '%s\n' "$WATCH_STATUS" > "$ATTEMPT_DIR/watch-exit-status"
gh api "repos/Trendymen/opencodex/actions/runs/$RUN_ID" > "$ATTEMPT_DIR/run-final.json"
gh api "repos/Trendymen/opencodex/actions/runs/$RUN_ID/jobs?per_page=100" > "$ATTEMPT_DIR/jobs-final.json"
if [ "$WATCH_STATUS" -eq 0 ]; then
  node "$SQUASH_EVIDENCE_DIR/verify-ci-run.mjs" \
    "$ATTEMPT_DIR/run-final.json" "$ATTEMPT_DIR/jobs-final.json" dev "$CURRENT_C4"
  printf 'completed success\n' > "$ATTEMPT_DIR/verdict"
else
  node --input-type=module - \
    "$ATTEMPT_DIR/run-final.json" "$ATTEMPT_DIR/jobs-final.json" "$CURRENT_C4" \
    > "$ATTEMPT_DIR/failure-summary.json" <<'NODE'
import { readFileSync } from "node:fs";
const [runPath, jobsPath, sha] = process.argv.slice(2);
const run = JSON.parse(readFileSync(runPath, "utf8"));
const jobs = JSON.parse(readFileSync(jobsPath, "utf8")).jobs;
if (run.path !== ".github/workflows/ci.yml" || run.name !== "Cross-platform CI" ||
    run.event !== "push" || run.head_branch !== "dev" || run.head_sha !== sha ||
    run.status !== "completed" || run.conclusion === "success") {
  throw new Error("candidate failure identity/result mismatch");
}
const failed = jobs.filter(job => job.conclusion !== "success" &&
  !(job.conclusion === "skipped" && job.name.startsWith("windows ")))
  .map(job => ({ id: job.id, name: job.name, status: job.status, conclusion: job.conclusion, url: job.html_url }));
process.stdout.write(JSON.stringify({ runId: run.id, conclusion: run.conclusion, url: run.html_url, failed }, null, 2));
NODE
  RUN_CONCLUSION=$(node --input-type=module -e '
    import { readFileSync } from "node:fs";
    process.stdout.write(JSON.parse(readFileSync(process.argv[1], "utf8")).conclusion);
  ' "$ATTEMPT_DIR/run-final.json")
  printf 'completed %s\n' "$RUN_CONCLUSION" > "$ATTEMPT_DIR/verdict"
fi
```

不回写C4。验证器文件内容也写入task evidence并记录SHA-256，candidate与main必须复用同一blob。
只有`verdict=completed success`可进入常规双审；failure-summary中明确证明无需改tree的环境失败进入
Step 6，明确指向测试/实现/规则缺陷的失败进入Step 7，cancelled、证据缺失或语义不明均fail closed并
请求判断。

- [ ] **Step 6: 环境性失败回到下一 A_J**

失败不需改文件时，保留当前A完整证据，回到Step 1分配下一A；message变化保证新C4 SHA，tree/
parent/count保持。禁止手写A2或覆盖旧目录，禁止新增C5。

- [ ] **Step 7: 确定性失败或review fix回到下一 S_K**

需要改文件时，先证明当前candidate checkout干净并分配不可复用的S编号：

```bash
set -euo pipefail
git diff --quiet
git diff --cached --quiet
test -z "$(git status --porcelain=v1)"
CURRENT_S=$(sed -n '1p' "$ATTEMPT_DIR/content-snapshot")
BASE_S="$CURRENT_S"
MATERIAL_FIX_REASON=candidate-or-review-finding
OLD_LOCAL_DEV=$(git rev-parse refs/heads/dev)
source "$SQUASH_EVIDENCE_DIR/rebuild-lib.sh"
start_next_snapshot "$BASE_S" "$OLD_LOCAL_DEV"
```

使用`apply_patch`完成finding要求的最小改动；workflow/规则归M2，测试归M3，runtime归M1。运行对应
focused测试后显式暂存实际文件并创建中文source修复commit。然后执行：

```bash
set -euo pipefail
NEW_SOURCE_INPUT=$(git rev-parse HEAD)
source "$SQUASH_EVIDENCE_DIR/rebuild-lib.sh"
build_manifests "$NEW_SOURCE_INPUT" "$SQUASH_EVIDENCE_DIR"
build_c1_c3 "$NEW_SOURCE_INPUT" "$SQUASH_EVIDENCE_DIR"
printf '%s\n' "$C1" > "$SQUASH_EVIDENCE_DIR/c1-$NEW_S-input"
printf '%s\n' "$C2" > "$SQUASH_EVIDENCE_DIR/c2-$NEW_S-input"
printf '%s\n' "$C3" > "$SQUASH_EVIDENCE_DIR/c3-$NEW_S-input"
```

使用`apply_patch`只更新`FORK_CHANGES.md`的`v240-ben3-squash`块内`content_snapshot=$NEW_S`、四个
manifest hash与C1–C3，external gate仍为pending；运行维护真源测试后提交只含
`FORK_CHANGES.md`的source末尾commit。
再以最终source执行以下稳定性检查，不允许只复用旧OID、旧hash或总计数：

```bash
set -euo pipefail
NEW_SOURCE=$(git rev-parse HEAD)
NEW_EXPECTED_TREE=$(git rev-parse HEAD^{tree})
build_manifests "$NEW_SOURCE" "$SQUASH_EVIDENCE_DIR"
build_c1_c3 "$NEW_SOURCE" "$SQUASH_EVIDENCE_DIR"
test "$C1" = "$(sed -n '1p' "$SQUASH_EVIDENCE_DIR/c1-$NEW_S-input")"
test "$C2" = "$(sed -n '1p' "$SQUASH_EVIDENCE_DIR/c2-$NEW_S-input")"
test "$C3" = "$(sed -n '1p' "$SQUASH_EVIDENCE_DIR/c3-$NEW_S-input")"
```

随后用共享helper创建新S目录和provisional C4，并把本地dev从旧candidate安全切换到新candidate：

```bash
set -euo pipefail
finish_next_snapshot
```

重新分配A时，expected remote dev必须等于最后一个已push A tuple的C4，而不是ben.2；旧
S/A/review-candidate证据一律保留。先按workflow blob决定security route，但无论哪条路线都必须回到
Task 5重跑focused/prepush：

```bash
set -euo pipefail
BASE_WORKFLOW_BLOB=$(sed -n '1p' "$SQUASH_EVIDENCE_DIR/$BASE_S/ci-workflow-blob")
NEW_WORKFLOW_BLOB=$(git rev-parse "$NEW_C4:.github/workflows/ci.yml")
printf '%s\n' "$NEW_WORKFLOW_BLOB" > "$NEW_S_DIR/ci-workflow-blob"
if [ "$NEW_WORKFLOW_BLOB" = "$BASE_WORKFLOW_BLOB" ]; then
  test "$(sed -n '1p' "$SQUASH_EVIDENCE_DIR/$BASE_S/security-verdict")" = PASS
  BASE_SECURITY_REVIEW=$(sed -n '1p' "$SQUASH_EVIDENCE_DIR/$BASE_S/security-review-evidence")
  test -s "$BASE_SECURITY_REVIEW"
  test "$(shasum -a 256 "$BASE_SECURITY_REVIEW" | awk '{print $1}')" = \
    "$(sed -n '1p' "$SQUASH_EVIDENCE_DIR/$BASE_S/security-review-sha256")"
  printf 'PASS\n' > "$NEW_S_DIR/security-verdict"
  printf '%s\n' "$BASE_SECURITY_REVIEW" > "$NEW_S_DIR/security-review-evidence"
  cp "$SQUASH_EVIDENCE_DIR/$BASE_S/security-review-sha256" "$NEW_S_DIR/security-review-sha256"
else
  test ! -e "$NEW_S_DIR/security-verdict"
  test ! -e "$NEW_S_DIR/security-review-evidence"
  test ! -e "$NEW_S_DIR/security-review-sha256"
  test -s "$SQUASH_EVIDENCE_DIR/security-reviewer-thread"
  printf 'RE_REVIEW\n' > "$NEW_S_DIR/security-route-hint"
fi
printf '%s\n' "$MATERIAL_FIX_REASON" > "$NEW_S_DIR/material-fix-reason"
VALIDATION_S="$NEW_S"
VALIDATION_S_DIR="$NEW_S_DIR"
C4_PROVISIONAL="$NEW_C4"
```

返回Task 5 Step 1。prepush PASS后，Step 5看到已复制的PASS时走`REUSE_PASS`且不创建R1；看到
`security-route-hint=RE_REVIEW`或已有`security-reviewer-thread`时复用原reviewer；只有任务从未派发过
security reviewer时走INITIAL。再次进入Task 6前必须重新验证当前S的PASS/hash/blob。

- [ ] **Step 8: 登记下一轮常规审查候选**

只有最新A的run/job验证success后，重新加载并执行完整八参数检查，再按SHA创建append-only审查候选
目录；此时不得写`final-c4`，因为常规双审finding仍可能使该候选失效：

```bash
set -euo pipefail
source "$SQUASH_EVIDENCE_DIR/check-candidate.sh"
check_candidate "$CURRENT_C4" "$CURRENT_C4" "$SOURCE_HEAD_CURRENT" "$EXPECTED_TREE_CURRENT" \
  "$C1_CURRENT" "$C2_CURRENT" "$C3_CURRENT" "$SNAPSHOT_DIR"
REVIEW_CANDIDATE_DIR="$SQUASH_EVIDENCE_DIR/review-candidates/$CURRENT_C4"
mkdir -p "$SQUASH_EVIDENCE_DIR/review-candidates"
mkdir "$REVIEW_CANDIDATE_DIR"
printf '%s\n' "$CURRENT_C4" > "$REVIEW_CANDIDATE_DIR/c4"
printf '%s\n' "$RUN_ID" > "$REVIEW_CANDIDATE_DIR/candidate-run"
printf 'A%s\n' "$NEXT_A" > "$REVIEW_CANDIDATE_DIR/attempt"
printf '%s\n' "$CURRENT_S" > "$REVIEW_CANDIDATE_DIR/snapshot"
```

不得回写C4。

---

### Task 7: 最终常规双审

**Files:**
- Review only: `v2.40.0..FINAL_C4` 完整Fork修改面

**Interfaces:**
- Consumes: 最新审查候选C4、candidate CI、security PASS、四提交/manifests/tree证据。
- Produces: FINAL_C4绑定的`SPEC_COMPLIANCE: PASS`与`CODE_QUALITY: PASS`。

- [ ] **Step 1: 生成有界review package**

从最新审查候选目录加载`REVIEW_C4`、A、S和run，生成以下只读文件：

```bash
set -euo pipefail
REVIEW_C4=$(git rev-parse HEAD)
REVIEW_CANDIDATE_DIR="$SQUASH_EVIDENCE_DIR/review-candidates/$REVIEW_C4"
test "$(sed -n '1p' "$REVIEW_CANDIDATE_DIR/c4")" = "$REVIEW_C4"
REVIEW_A=$(sed -n '1p' "$REVIEW_CANDIDATE_DIR/attempt")
REVIEW_S=$(sed -n '1p' "$REVIEW_CANDIDATE_DIR/snapshot")
REVIEW_S_DIR="$SQUASH_EVIDENCE_DIR/$REVIEW_S"
git diff --find-renames --binary "$OFFICIAL_COMMIT" "$REVIEW_C4" \
  > "$REVIEW_CANDIDATE_DIR/scoped.diff"
git log --format=fuller --no-merges "$OFFICIAL_COMMIT..$REVIEW_C4" \
  > "$REVIEW_CANDIDATE_DIR/commits.txt"
git diff --stat "$OFFICIAL_COMMIT" "$REVIEW_C4" > "$REVIEW_CANDIDATE_DIR/shortstat.txt"
cp "$REVIEW_S_DIR"/M1 "$REVIEW_S_DIR"/M2 "$REVIEW_S_DIR"/M3 "$REVIEW_S_DIR"/M4 \
  "$REVIEW_S_DIR/manifest-sha256" "$REVIEW_CANDIDATE_DIR/"
cp "$SQUASH_EVIDENCE_DIR/$REVIEW_A/run-final.json" \
  "$SQUASH_EVIDENCE_DIR/$REVIEW_A/jobs-final.json" "$REVIEW_CANDIDATE_DIR/"
```

审查包还必须逐项写出用户brief、Spec路径、official/ben.2/source SHA、所有相关S/A tuple路径、
10→4 tree等式、security verdict和本地验证证据；不得附主会话历史或无关Plan全文。

- [ ] **Step 2: 派发两个独立reviewer**

两个`reviewer`均`fork_turns: none`，共同
`REVIEW_SCOPE_ID: v240-ben3-four-commit-release`、`REVIEW_PHASE: INITIAL`；mode分别为
`SPEC_COMPLIANCE`和`CODE_QUALITY`。使用`apply_patch`把完整输出分别保存为
`$REVIEW_CANDIDATE_DIR/spec-review.md`和`quality-review.md`；对应mode为PASS且无未决
Critical/Important finding后，分别写入只含`PASS`一行的`spec-verdict`与`quality-verdict`。

- [ ] **Step 3: 修复finding并重启候选循环**

Critical/Important finding形成新S，折回所属commit并重建后继；重跑本地门禁、必要security
review、candidate push/CI，再用原reviewer `REVIEW_PHASE: RE_REVIEW` 携带完整
PRIOR_FINDINGS/FIX_DIFF/VERIFICATION_EVIDENCE。旧`review-candidates/<SHA>`目录保留，禁止追加commit。

- [ ] **Step 4: Tag前终验review、workflow blob与四提交等式**

证明两个常规PASS绑定FINAL_C4；FINAL_C4中的ci.yml blob等于security PASS blob；candidate CI
仍绑定FINAL_C4且remote dev未漂移，并再次执行完整八参数机械检查：

```bash
set -euo pipefail
SQUASH_EVIDENCE_DIR=.tmp/v240-ben3-squash
FINAL_C4="$REVIEW_C4"
OFFICIAL_COMMIT=$(sed -n '1p' "$SQUASH_EVIDENCE_DIR/official-commit")
FINAL_S="$REVIEW_S"
FINAL_S_DIR="$REVIEW_S_DIR"
SOURCE_HEAD_FINAL=$(sed -n '1p' "$FINAL_S_DIR/source-head")
EXPECTED_TREE_FINAL=$(sed -n '1p' "$FINAL_S_DIR/expected-tree")
C1_FINAL=$(sed -n '1p' "$FINAL_S_DIR/c1")
C2_FINAL=$(sed -n '1p' "$FINAL_S_DIR/c2")
C3_FINAL=$(sed -n '1p' "$FINAL_S_DIR/c3")
test "$(sed -n '1p' "$REVIEW_CANDIDATE_DIR/spec-verdict")" = PASS
test "$(sed -n '1p' "$REVIEW_CANDIDATE_DIR/quality-verdict")" = PASS
test -s "$REVIEW_CANDIDATE_DIR/spec-review.md"
test -s "$REVIEW_CANDIDATE_DIR/quality-review.md"
git fetch origin --prune --no-tags
test "$(git rev-parse refs/remotes/origin/dev)" = "$FINAL_C4"
test "$(git rev-parse "$FINAL_C4:.github/workflows/ci.yml")" = \
  "$(sed -n '1p' "$FINAL_S_DIR/ci-workflow-blob")"
source "$SQUASH_EVIDENCE_DIR/check-candidate.sh"
check_candidate "$FINAL_C4" "$FINAL_C4" "$SOURCE_HEAD_FINAL" "$EXPECTED_TREE_FINAL" \
  "$C1_FINAL" "$C2_FINAL" "$C3_FINAL" "$FINAL_S_DIR"
```

`FINAL_C4`必须等于两个PASS reviewer共同绑定的当前`REVIEW_C4`；全部检查通过后才以不可覆盖
方式冻结正式终态：

```bash
set -euo pipefail
for file in final-c4 final-candidate-run final-attempt final-snapshot; do
  test ! -e "$SQUASH_EVIDENCE_DIR/$file"
done
FINAL_C4="$REVIEW_C4"
printf '%s\n' "$FINAL_C4" > "$SQUASH_EVIDENCE_DIR/final-c4"
sed -n '1p' "$REVIEW_CANDIDATE_DIR/candidate-run" > "$SQUASH_EVIDENCE_DIR/final-candidate-run"
sed -n '1p' "$REVIEW_CANDIDATE_DIR/attempt" > "$SQUASH_EVIDENCE_DIR/final-attempt"
sed -n '1p' "$REVIEW_CANDIDATE_DIR/snapshot" > "$SQUASH_EVIDENCE_DIR/final-snapshot"
```

---

### Task 8: 创建ben.3 Tag并执行六成员atomic promotion

**Files:**
- Create: annotated `refs/tags/v2.40.0-ben.3`
- Mutate atomically: origin `main`、`dev`、`sync/v2.40.0`、`upstream-release`、official Tag、Fork Tag

**Interfaces:**
- Consumes: FINAL_C4、双审/security/candidate CI PASS。
- Produces: promotion refs与annotated ben.3 Tag。

- [ ] **Step 1: 冻结完整preflight**

重新读取local/remote main/dev/sync/marker、official Tag raw/peeled、完整`v2.40.0-ben.*`、
`sync/v2.40.0-ben.*`（必须为空）和ben.3 Release（必须不存在）。确认ben.2不变、count=4、所有
review/CI身份未漂移。

```bash
set -euo pipefail
SQUASH_EVIDENCE_DIR=.tmp/v240-ben3-squash
set -o pipefail
FINAL_C4=$(sed -n '1p' "$SQUASH_EVIDENCE_DIR/final-c4")
OFFICIAL_COMMIT=$(sed -n '1p' "$SQUASH_EVIDENCE_DIR/official-commit")
FINAL_S=$(sed -n '1p' "$SQUASH_EVIDENCE_DIR/final-snapshot")
FINAL_S_DIR="$SQUASH_EVIDENCE_DIR/$FINAL_S"
SOURCE_HEAD_FINAL=$(sed -n '1p' "$FINAL_S_DIR/source-head")
EXPECTED_TREE_FINAL=$(sed -n '1p' "$FINAL_S_DIR/expected-tree")
C1_FINAL=$(sed -n '1p' "$FINAL_S_DIR/c1")
C2_FINAL=$(sed -n '1p' "$FINAL_S_DIR/c2")
C3_FINAL=$(sed -n '1p' "$FINAL_S_DIR/c3")
test -z "$(git status --porcelain=v1)"
git fetch origin --prune --tags
EXPECTED_OLD_LOCAL_MAIN=$(git rev-parse refs/heads/main)
EXPECTED_LOCAL_DEV=$(git rev-parse refs/heads/dev)
EXPECTED_OLD_LOCAL_SYNC=$(git rev-parse refs/heads/sync/v2.40.0)
EXPECTED_OLD_LOCAL_MARKER=$(git rev-parse refs/heads/upstream-release)
EXPECTED_REMOTE_MAIN=$(git rev-parse refs/remotes/origin/main)
PROMOTION_EXPECTED_REMOTE_DEV=$(git rev-parse refs/remotes/origin/dev)
EXPECTED_REMOTE_SYNC=$(git rev-parse refs/remotes/origin/sync/v2.40.0)
EXPECTED_REMOTE_MARKER=$(git rev-parse refs/remotes/origin/upstream-release)
test "$PROMOTION_EXPECTED_REMOTE_DEV" = "$FINAL_C4"
test "$EXPECTED_LOCAL_DEV" = "$FINAL_C4"
test "$EXPECTED_OLD_LOCAL_MAIN" = "$EXPECTED_REMOTE_MAIN"
test "$EXPECTED_OLD_LOCAL_SYNC" = "$EXPECTED_REMOTE_SYNC"
test "$EXPECTED_OLD_LOCAL_MARKER" = "$OFFICIAL_COMMIT"
test "$EXPECTED_REMOTE_MARKER" = "$OFFICIAL_COMMIT"
OFFICIAL_TAG_RAW=$(git rev-parse refs/tags/v2.40.0)
OFFICIAL_TAG_PEELED=$(git rev-parse refs/tags/v2.40.0^{})
source "$SQUASH_EVIDENCE_DIR/remote-gates.sh"
capture_remote "$SQUASH_EVIDENCE_DIR/pre-tag-official-remote" \
  refs/tags/v2.40.0 'refs/tags/v2.40.0^{}' || exit $?
REMOTE_OFFICIAL_TAG_RAW=$(awk '$2 == "refs/tags/v2.40.0" {print $1}' \
  "$SQUASH_EVIDENCE_DIR/pre-tag-official-remote")
REMOTE_OFFICIAL_TAG_PEELED=$(awk '$2 == "refs/tags/v2.40.0^{}" {print $1}' \
  "$SQUASH_EVIDENCE_DIR/pre-tag-official-remote")
test "$OFFICIAL_TAG_PEELED" = "$OFFICIAL_COMMIT"
test "$REMOTE_OFFICIAL_TAG_RAW" = "$OFFICIAL_TAG_RAW"
test "${REMOTE_OFFICIAL_TAG_PEELED:-$REMOTE_OFFICIAL_TAG_RAW}" = "$OFFICIAL_COMMIT"
git for-each-ref --format='%(refname) %(objecttype) %(objectname) %(*objectname)' \
  'refs/tags/v2.40.0-ben.*' | LC_ALL=C sort > "$SQUASH_EVIDENCE_DIR/pre-tag-local-ben-tags"
awk '$1 != "refs/tags/v2.40.0-ben.3"' "$SQUASH_EVIDENCE_DIR/pre-tag-local-ben-tags" \
  > "$SQUASH_EVIDENCE_DIR/pre-tag-local-ben-tags-without-ben3"
capture_remote "$SQUASH_EVIDENCE_DIR/pre-tag-remote-ben-tags.raw" \
  'refs/tags/v2.40.0-ben.*' || exit $?
LC_ALL=C sort "$SQUASH_EVIDENCE_DIR/pre-tag-remote-ben-tags.raw" \
  > "$SQUASH_EVIDENCE_DIR/pre-tag-remote-ben-tags"
cmp "$SQUASH_EVIDENCE_DIR/task-initial/local-ben-tags" \
  "$SQUASH_EVIDENCE_DIR/pre-tag-local-ben-tags-without-ben3"
cmp "$SQUASH_EVIDENCE_DIR/task-initial/remote-ben-tags" "$SQUASH_EVIDENCE_DIR/pre-tag-remote-ben-tags"
assert_remote_absent "$SQUASH_EVIDENCE_DIR/pre-tag-revision-sync-refs" \
  'refs/heads/sync/v2.40.0-ben.*' || exit $?
if git show-ref --verify --quiet refs/tags/v2.40.0-ben.3; then
  test "$(git cat-file -t refs/tags/v2.40.0-ben.3)" = tag
  test "$(git rev-parse refs/tags/v2.40.0-ben.3^{})" = "$FINAL_C4"
  test -s "$SQUASH_EVIDENCE_DIR/fork-tag-raw"
  test "$(git rev-parse refs/tags/v2.40.0-ben.3)" = \
    "$(sed -n '1p' "$SQUASH_EVIDENCE_DIR/fork-tag-raw")"
else
  test ! -e "$SQUASH_EVIDENCE_DIR/fork-tag-raw"
fi
assert_remote_absent "$SQUASH_EVIDENCE_DIR/pre-tag-ben3-remote" \
  refs/tags/v2.40.0-ben.3 'refs/tags/v2.40.0-ben.3^{}' || exit $?
assert_release_absent v2.40.0-ben.3 "$SQUASH_EVIDENCE_DIR/pre-tag-ben3-release" || exit $?
source "$SQUASH_EVIDENCE_DIR/check-candidate.sh"
check_candidate "$FINAL_C4" "$FINAL_C4" "$SOURCE_HEAD_FINAL" "$EXPECTED_TREE_FINAL" "$C1_FINAL" "$C2_FINAL" "$C3_FINAL" "$FINAL_S_DIR"
```

把四个local expected OID、四个remote expected OID、official raw/peeled和FINAL_C4写入
不可覆盖的`promotion-preflight.env`：

```bash
set -euo pipefail
test ! -e "$SQUASH_EVIDENCE_DIR/promotion-preflight.env"
{
  printf 'FINAL_C4=%s\n' "$FINAL_C4"
  printf 'OFFICIAL_COMMIT=%s\n' "$OFFICIAL_COMMIT"
  printf 'EXPECTED_OLD_LOCAL_MAIN=%s\n' "$EXPECTED_OLD_LOCAL_MAIN"
  printf 'EXPECTED_LOCAL_DEV=%s\n' "$EXPECTED_LOCAL_DEV"
  printf 'EXPECTED_OLD_LOCAL_SYNC=%s\n' "$EXPECTED_OLD_LOCAL_SYNC"
  printf 'EXPECTED_OLD_LOCAL_MARKER=%s\n' "$EXPECTED_OLD_LOCAL_MARKER"
  printf 'EXPECTED_REMOTE_MAIN=%s\n' "$EXPECTED_REMOTE_MAIN"
  printf 'PROMOTION_EXPECTED_REMOTE_DEV=%s\n' "$PROMOTION_EXPECTED_REMOTE_DEV"
  printf 'EXPECTED_REMOTE_SYNC=%s\n' "$EXPECTED_REMOTE_SYNC"
  printf 'EXPECTED_REMOTE_MARKER=%s\n' "$EXPECTED_REMOTE_MARKER"
  printf 'OFFICIAL_TAG_RAW=%s\n' "$OFFICIAL_TAG_RAW"
  printf 'OFFICIAL_TAG_PEELED=%s\n' "$OFFICIAL_TAG_PEELED"
} > "$SQUASH_EVIDENCE_DIR/promotion-preflight.env"
```

所有值均为已验证hex OID，后续新shell先source该文件。它们均为existing-ref路径；未来通用流程若
遇到missing branch，只能使用`--force-with-lease=refs/heads/name:`表示expected absent，本轮不适用。

- [ ] **Step 2: 创建并验证中文annotated Tag**

```bash
set -euo pipefail
source "$SQUASH_EVIDENCE_DIR/promotion-preflight.env"
if git show-ref --verify --quiet refs/tags/v2.40.0-ben.3; then
  test "$(git cat-file -t refs/tags/v2.40.0-ben.3)" = tag
  test "$(git rev-parse refs/tags/v2.40.0-ben.3^{})" = "$FINAL_C4"
  test -s "$SQUASH_EVIDENCE_DIR/fork-tag-raw"
  test "$(git rev-parse refs/tags/v2.40.0-ben.3)" = \
    "$(sed -n '1p' "$SQUASH_EVIDENCE_DIR/fork-tag-raw")"
else
  test ! -e "$SQUASH_EVIDENCE_DIR/fork-tag-raw"
  git tag -a v2.40.0-ben.3 "$FINAL_C4" \
    -m "v2.40.0-ben.3：四提交压缩与 CI 前置发布" \
    -m "官方 v2.40.0；10 个 Fork commits 压缩为 4；candidate CI、双审与 workflow security review 已通过"
  git rev-parse refs/tags/v2.40.0-ben.3 > "$SQUASH_EVIDENCE_DIR/fork-tag-raw"
fi
test "$(git cat-file -t refs/tags/v2.40.0-ben.3)" = tag
test "$(git rev-parse refs/tags/v2.40.0-ben.3^{})" = "$FINAL_C4"
FORK_TAG_RAW=$(sed -n '1p' "$SQUASH_EVIDENCE_DIR/fork-tag-raw")
test "$(git rev-parse refs/tags/v2.40.0-ben.3)" = "$FORK_TAG_RAW"
```

- [ ] **Step 3: 执行唯一六成员atomic push**

先用`apply_patch`创建`.tmp/v240-ben3-squash/classify-promotion.sh`，把每次push后的远端读取和
三分类封装为同一个函数：

```bash
set -euo pipefail
classify_promotion() (
  set -euo pipefail
  label="$1"
  snapshot="$SQUASH_EVIDENCE_DIR/promotion-$label"
  verdict="$snapshot.verdict"
  printf 'checking\n' > "$verdict"
  raw_snapshot="$snapshot.raw"
  ben_snapshot="$snapshot.ben-tags"
  if ! git ls-remote origin \
      refs/heads/main refs/heads/dev refs/heads/sync/v2.40.0 refs/heads/upstream-release \
      refs/tags/v2.40.0 'refs/tags/v2.40.0^{}' \
      refs/tags/v2.40.0-ben.3 'refs/tags/v2.40.0-ben.3^{}' > "$raw_snapshot"; then
    printf 'remote-error\n' > "$verdict"
    return 30
  fi
  LC_ALL=C sort -u "$raw_snapshot" > "$snapshot"
  if ! git ls-remote origin 'refs/tags/v2.40.0-ben.*' > "$ben_snapshot.raw"; then
    printf 'remote-error\n' > "$verdict"
    return 30
  fi
  LC_ALL=C sort -u "$ben_snapshot.raw" > "$ben_snapshot"
  remote_oid() { awk -v ref="$1" '$2 == ref { print $1 }' "$snapshot"; }
  after_main=$(remote_oid refs/heads/main)
  after_dev=$(remote_oid refs/heads/dev)
  after_sync=$(remote_oid refs/heads/sync/v2.40.0)
  after_marker=$(remote_oid refs/heads/upstream-release)
  after_official_raw=$(remote_oid refs/tags/v2.40.0)
  after_official_peeled=$(remote_oid 'refs/tags/v2.40.0^{}')
  after_fork_raw=$(remote_oid refs/tags/v2.40.0-ben.3)
  after_fork_peeled=$(remote_oid 'refs/tags/v2.40.0-ben.3^{}')
  if test "$after_official_raw" != "$OFFICIAL_TAG_RAW" || \
     test "${after_official_peeled:-$after_official_raw}" != "$OFFICIAL_COMMIT"; then
    printf 'mixed-or-unknown\n' > "$verdict"
    return 20
  fi
  awk '$2 !~ /^refs\/tags\/v2[.]40[.]0-ben[.]3(\^\{\})?$/' "$ben_snapshot" \
    > "$ben_snapshot.without-ben3"
  if ! cmp "$SQUASH_EVIDENCE_DIR/task-initial/remote-ben-tags" "$ben_snapshot.without-ben3" \
      >/dev/null; then
    printf 'mixed-or-unknown\n' > "$verdict"
    return 20
  fi
  if test "$after_main" = "$FINAL_C4" && test "$after_dev" = "$FINAL_C4" && \
     test "$after_sync" = "$FINAL_C4" && test "$after_marker" = "$OFFICIAL_COMMIT" && \
     test "$after_fork_raw" = "$FORK_TAG_RAW" && test "$after_fork_peeled" = "$FINAL_C4"; then
    printf 'success\n' > "$verdict"
    return 0
  fi
  if test "$after_main" = "$EXPECTED_REMOTE_MAIN" && \
     test "$after_dev" = "$PROMOTION_EXPECTED_REMOTE_DEV" && \
     test "$after_sync" = "$EXPECTED_REMOTE_SYNC" && \
     test "$after_marker" = "$EXPECTED_REMOTE_MARKER" && test -z "$after_fork_raw"; then
    printf 'unchanged\n' > "$verdict"
    return 10
  fi
  printf 'mixed-or-unknown\n' > "$verdict"
  return 20
)
```

然后捕获push退出状态；即使非0也必须进入Step 4只读分类：

```bash
set -euo pipefail
source "$SQUASH_EVIDENCE_DIR/promotion-preflight.env"
FORK_TAG_RAW=$(sed -n '1p' "$SQUASH_EVIDENCE_DIR/fork-tag-raw")
if git push --atomic origin \
  --force-with-lease=refs/heads/main:"$EXPECTED_REMOTE_MAIN" \
  --force-with-lease=refs/heads/dev:"$PROMOTION_EXPECTED_REMOTE_DEV" \
  --force-with-lease=refs/heads/sync/v2.40.0:"$EXPECTED_REMOTE_SYNC" \
  --force-with-lease=refs/heads/upstream-release:"$EXPECTED_REMOTE_MARKER" \
  +"$FINAL_C4":refs/heads/main \
  +"$FINAL_C4":refs/heads/dev \
  +"$FINAL_C4":refs/heads/sync/v2.40.0 \
  +"$OFFICIAL_COMMIT":refs/heads/upstream-release \
  refs/tags/v2.40.0:refs/tags/v2.40.0 \
  refs/tags/v2.40.0-ben.3:refs/tags/v2.40.0-ben.3; then
  FIRST_PUSH_STATUS=0
else
  FIRST_PUSH_STATUS=$?
fi
printf '%s\n' "$FIRST_PUSH_STATUS" > "$SQUASH_EVIDENCE_DIR/first-push-status"
```

Tag refspec不加`+`；不拆分。

- [ ] **Step 4: 对确定失败或不确定结果做只读收敛判断**

第一次push后调用同一函数。返回0表示六目标完整成功；返回10表示全部branch仍是preflight old、
ben.3远端Tag明确不存在且其它Tag namespace未变；20/30分别表示mixed/unknown或远端读取失败：

```bash
set -euo pipefail
source "$SQUASH_EVIDENCE_DIR/promotion-preflight.env"
FORK_TAG_RAW=$(sed -n '1p' "$SQUASH_EVIDENCE_DIR/fork-tag-raw")
source "$SQUASH_EVIDENCE_DIR/classify-promotion.sh"
set +e
classify_promotion first
CLASSIFY_STATUS=$?
set -euo pipefail
if [ "$CLASSIFY_STATUS" -eq 0 ]; then
  test "$(sed -n '1p' "$SQUASH_EVIDENCE_DIR/promotion-first.verdict")" = success
else
  test "$CLASSIFY_STATUS" = 10 || exit "$CLASSIFY_STATUS"
  git fetch origin --prune --no-tags
  test "$(git rev-parse refs/remotes/origin/main)" = "$EXPECTED_REMOTE_MAIN"
  test "$(git rev-parse refs/remotes/origin/dev)" = "$PROMOTION_EXPECTED_REMOTE_DEV"
  test "$(git rev-parse refs/remotes/origin/sync/v2.40.0)" = "$EXPECTED_REMOTE_SYNC"
  test "$(git rev-parse refs/remotes/origin/upstream-release)" = "$EXPECTED_REMOTE_MARKER"
  if git push --atomic origin \
    --force-with-lease=refs/heads/main:"$EXPECTED_REMOTE_MAIN" \
    --force-with-lease=refs/heads/dev:"$PROMOTION_EXPECTED_REMOTE_DEV" \
    --force-with-lease=refs/heads/sync/v2.40.0:"$EXPECTED_REMOTE_SYNC" \
    --force-with-lease=refs/heads/upstream-release:"$EXPECTED_REMOTE_MARKER" \
    +"$FINAL_C4":refs/heads/main +"$FINAL_C4":refs/heads/dev \
    +"$FINAL_C4":refs/heads/sync/v2.40.0 +"$OFFICIAL_COMMIT":refs/heads/upstream-release \
    refs/tags/v2.40.0:refs/tags/v2.40.0 \
    refs/tags/v2.40.0-ben.3:refs/tags/v2.40.0-ben.3; then
    RETRY_PUSH_STATUS=0
  else
    RETRY_PUSH_STATUS=$?
  fi
  printf '%s\n' "$RETRY_PUSH_STATUS" > "$SQUASH_EVIDENCE_DIR/retry-push-status"
  classify_promotion retry
  test "$(sed -n '1p' "$SQUASH_EVIDENCE_DIR/promotion-retry.verdict")" = success
fi
```

`classify_promotion retry`只有返回0才继续；任何部分更新、Tag raw/peeled不一致、namespace新增/删除或
无法读取都fail closed并通知用户。不删除/重建local Tag，不拆分push。

- [ ] **Step 5: 本地三ref CAS**

```bash
set -euo pipefail
source "$SQUASH_EVIDENCE_DIR/promotion-preflight.env"
FORK_TAG_RAW=$(sed -n '1p' "$SQUASH_EVIDENCE_DIR/fork-tag-raw")
source "$SQUASH_EVIDENCE_DIR/classify-promotion.sh"
set -euo pipefail
classify_promotion pre-local-cas
test "$(sed -n '1p' "$SQUASH_EVIDENCE_DIR/promotion-pre-local-cas.verdict")" = success
git update-ref --stdin <<EOF
start
update refs/heads/main $FINAL_C4 $EXPECTED_OLD_LOCAL_MAIN
update refs/heads/sync/v2.40.0 $FINAL_C4 $EXPECTED_OLD_LOCAL_SYNC
update refs/heads/upstream-release $OFFICIAL_COMMIT $EXPECTED_OLD_LOCAL_MARKER
prepare
commit
EOF
```

随后fetch并核对local/remote main/dev/sync/Tag peeled=FINAL_C4，marker/official Tag=official。

---

### Task 9: main CI成功后创建GitHub Release并终验

**Files:**
- External: GitHub Actions、GitHub Release `v2.40.0-ben.3`
- Preserve: Git refs与Tag对象

**Interfaces:**
- Consumes: promoted FINAL_C4与成功dev candidate CI。
- Produces: 成功main CI、公开正式Release、完整最终后验。

- [ ] **Step 1: 绑定main Cross-platform CI**

```bash
set -euo pipefail
SQUASH_EVIDENCE_DIR=.tmp/v240-ben3-squash
set -euo pipefail
FINAL_C4=$(sed -n '1p' "$SQUASH_EVIDENCE_DIR/final-c4")
MAIN_DISCOVERY_DIR="$SQUASH_EVIDENCE_DIR/main-run-discovery"
mkdir -p "$MAIN_DISCOVERY_DIR"
MAIN_RUN_ID=""
for DISCOVERY_INDEX in {1..40}; do
  MAIN_RUNS_JSON="$MAIN_DISCOVERY_DIR/runs-$DISCOVERY_INDEX.json"
  gh api "repos/Trendymen/opencodex/actions/workflows/ci.yml/runs?branch=main&event=push&per_page=30" \
    > "$MAIN_RUNS_JSON"
  DISCOVERY_RESULT=$(node "$SQUASH_EVIDENCE_DIR/discover-ci-run.mjs" \
    "$MAIN_RUNS_JSON" main "$FINAL_C4")
  if [ "$DISCOVERY_RESULT" != WAIT ]; then
    MAIN_RUN_ID="$DISCOVERY_RESULT"
    break
  fi
  sleep 15
done
test -n "$MAIN_RUN_ID"
printf '%s\n' "$MAIN_RUN_ID" > "$SQUASH_EVIDENCE_DIR/main-run-id"
```

run未出现时只使用上述同一前台循环，不并发轮询。

- [ ] **Step 2: 等待并验证main CI终态**

用`gh run watch "$MAIN_RUN_ID" --repo Trendymen/opencodex --exit-status --interval 15`启动单一长任务
命令并通过持久shell的`write_stdin`读取；watch非0只表示run未成功，不能在保存终态API证据前退出。
随后保存run/jobs JSON，并调用Task 6创建且hash未变化的唯一验证器：

```bash
set -euo pipefail
MAIN_RUN_JSON="$SQUASH_EVIDENCE_DIR/main-run-final.json"
MAIN_JOBS_JSON="$SQUASH_EVIDENCE_DIR/main-jobs-final.json"
if gh run watch "$MAIN_RUN_ID" --repo Trendymen/opencodex --exit-status --interval 15; then
  MAIN_WATCH_STATUS=0
else
  MAIN_WATCH_STATUS=$?
fi
printf '%s\n' "$MAIN_WATCH_STATUS" > "$SQUASH_EVIDENCE_DIR/main-watch-exit-status"
gh api "repos/Trendymen/opencodex/actions/runs/$MAIN_RUN_ID" > "$MAIN_RUN_JSON"
gh api "repos/Trendymen/opencodex/actions/runs/$MAIN_RUN_ID/jobs?per_page=100" > "$MAIN_JOBS_JSON"
test "$(shasum -a 256 "$SQUASH_EVIDENCE_DIR/verify-ci-run.mjs" | awk '{print $1}')" = \
  "$(sed -n '1p' "$SQUASH_EVIDENCE_DIR/verify-ci-run.sha256")"
if [ "$MAIN_WATCH_STATUS" -eq 0 ]; then
  node "$SQUASH_EVIDENCE_DIR/verify-ci-run.mjs" \
    "$MAIN_RUN_JSON" "$MAIN_JOBS_JSON" main "$FINAL_C4"
  printf 'completed success\n' > "$SQUASH_EVIDENCE_DIR/main-ci-verdict"
else
  node --input-type=module - "$MAIN_RUN_JSON" "$MAIN_JOBS_JSON" "$FINAL_C4" \
    > "$SQUASH_EVIDENCE_DIR/main-failure-summary.json" <<'NODE'
import { readFileSync } from "node:fs";
const [runPath, jobsPath, sha] = process.argv.slice(2);
const run = JSON.parse(readFileSync(runPath, "utf8"));
const jobs = JSON.parse(readFileSync(jobsPath, "utf8")).jobs;
if (run.path !== ".github/workflows/ci.yml" || run.name !== "Cross-platform CI" ||
    run.event !== "push" || run.head_branch !== "main" || run.head_sha !== sha ||
    run.status !== "completed" || run.conclusion === "success") throw new Error("main failure identity/result mismatch");
const failed = jobs.filter(job => job.conclusion !== "success" &&
  !(job.conclusion === "skipped" && job.name.startsWith("windows ")))
  .map(job => ({ id: job.id, name: job.name, conclusion: job.conclusion, url: job.html_url }));
process.stdout.write(JSON.stringify({ runId: run.id, conclusion: run.conclusion, url: run.html_url, failed }, null, 2));
NODE
fi
```

因此path/name/event/main/FINAL_C4、completed/success、aggregate`ci=success`和唯一允许skip的
`windows `job规则与candidate完全同源。

- [ ] **Step 3: 处理main CI失败**

环境性失败只允许在同一run/SHA上执行：

```bash
set -euo pipefail
test "$(gh api "repos/Trendymen/opencodex/actions/runs/$MAIN_RUN_ID" --jq .head_sha)" = "$FINAL_C4"
gh run rerun "$MAIN_RUN_ID" --repo Trendymen/opencodex --failed
```

然后重新执行Step 2并覆盖的是同一main run的终态API快照，不得产生新commit。确定性失败时保留Tag
和promoted refs，停止Release，登记ben.3已消耗并请求用户决定ben.4。不得amend/move ben.3 Tag；
heartbeat恢复时先通过workflow endpoint重新取得同一`FINAL_C4`的dev/main run，再调用
`verify-ci-run.mjs`分别验证，任何一个缺失或失败都不得补Release。

- [ ] **Step 4: Release前全等式检查**

验证local/remote main/dev/sync/Tag peeled=FINAL_C4；marker/official Tag=official；count=4；
candidate/main CI、regular reviews、security blob均匹配；同基线没有更高Tag/Release竞态。

```bash
set -euo pipefail
SQUASH_EVIDENCE_DIR=.tmp/v240-ben3-squash
FINAL_C4=$(sed -n '1p' "$SQUASH_EVIDENCE_DIR/final-c4")
OFFICIAL_COMMIT=$(sed -n '1p' "$SQUASH_EVIDENCE_DIR/official-commit")
FINAL_S=$(sed -n '1p' "$SQUASH_EVIDENCE_DIR/final-snapshot")
FINAL_S_DIR="$SQUASH_EVIDENCE_DIR/$FINAL_S"
SOURCE_HEAD_FINAL=$(sed -n '1p' "$FINAL_S_DIR/source-head")
EXPECTED_TREE_FINAL=$(sed -n '1p' "$FINAL_S_DIR/expected-tree")
C1_FINAL=$(sed -n '1p' "$FINAL_S_DIR/c1")
C2_FINAL=$(sed -n '1p' "$FINAL_S_DIR/c2")
C3_FINAL=$(sed -n '1p' "$FINAL_S_DIR/c3")
git fetch origin --prune --tags
test "$(git rev-parse refs/heads/main)" = "$FINAL_C4"
test "$(git rev-parse refs/heads/dev)" = "$FINAL_C4"
test "$(git rev-parse refs/heads/sync/v2.40.0)" = "$FINAL_C4"
test "$(git rev-parse refs/remotes/origin/main)" = "$FINAL_C4"
test "$(git rev-parse refs/remotes/origin/dev)" = "$FINAL_C4"
test "$(git rev-parse refs/remotes/origin/sync/v2.40.0)" = "$FINAL_C4"
test "$(git rev-parse refs/tags/v2.40.0-ben.3^{})" = "$FINAL_C4"
test "$(git rev-parse refs/heads/upstream-release)" = "$OFFICIAL_COMMIT"
test "$(git rev-parse refs/remotes/origin/upstream-release)" = "$OFFICIAL_COMMIT"
test "$(git rev-list --count "$OFFICIAL_COMMIT..$FINAL_C4")" = 4
OFFICIAL_TAG_RAW=$(git rev-parse refs/tags/v2.40.0)
FORK_TAG_RAW=$(sed -n '1p' "$SQUASH_EVIDENCE_DIR/fork-tag-raw")
source "$SQUASH_EVIDENCE_DIR/classify-promotion.sh"
set -euo pipefail
classify_promotion pre-release
test "$(sed -n '1p' "$SQUASH_EVIDENCE_DIR/promotion-pre-release.verdict")" = success
test "$(sed -n '1p' "$SQUASH_EVIDENCE_DIR/main-ci-verdict")" = "completed success"
FINAL_A=$(sed -n '1p' "$SQUASH_EVIDENCE_DIR/final-attempt")
test "$(sed -n '1p' "$SQUASH_EVIDENCE_DIR/$FINAL_A/verdict")" = "completed success"
FINAL_CANDIDATE_RUN=$(sed -n '1p' "$SQUASH_EVIDENCE_DIR/final-candidate-run")
node "$SQUASH_EVIDENCE_DIR/verify-ci-run.mjs" \
  "$SQUASH_EVIDENCE_DIR/$FINAL_A/run-final.json" \
  "$SQUASH_EVIDENCE_DIR/$FINAL_A/jobs-final.json" dev "$FINAL_C4"
node "$SQUASH_EVIDENCE_DIR/verify-ci-run.mjs" \
  "$SQUASH_EVIDENCE_DIR/main-run-final.json" \
  "$SQUASH_EVIDENCE_DIR/main-jobs-final.json" main "$FINAL_C4"
REVIEW_CANDIDATE_DIR="$SQUASH_EVIDENCE_DIR/review-candidates/$FINAL_C4"
test "$(sed -n '1p' "$REVIEW_CANDIDATE_DIR/spec-verdict")" = PASS
test "$(sed -n '1p' "$REVIEW_CANDIDATE_DIR/quality-verdict")" = PASS
test "$(sed -n '1p' "$FINAL_S_DIR/security-verdict")" = PASS
FINAL_SECURITY_REVIEW=$(sed -n '1p' "$FINAL_S_DIR/security-review-evidence")
test -s "$FINAL_SECURITY_REVIEW"
test "$(shasum -a 256 "$FINAL_SECURITY_REVIEW" | awk '{print $1}')" = \
  "$(sed -n '1p' "$FINAL_S_DIR/security-review-sha256")"
source "$SQUASH_EVIDENCE_DIR/remote-gates.sh"
assert_release_absent v2.40.0-ben.3 "$SQUASH_EVIDENCE_DIR/pre-release-ben3-absence" || exit $?
source "$SQUASH_EVIDENCE_DIR/check-candidate.sh"
check_candidate "$FINAL_C4" "$FINAL_C4" "$SOURCE_HEAD_FINAL" "$EXPECTED_TREE_FINAL" "$C1_FINAL" "$C2_FINAL" "$C3_FINAL" "$FINAL_S_DIR"
```

- [ ] **Step 5: 创建公开GitHub Release**

先用`apply_patch`在`$SQUASH_EVIDENCE_DIR/release-notes.md`写简体中文Notes，包含官方基线、
`target_commit_count=4`、四个完整manifest SHA-256、`EXPECTED_TREE_FINAL`、规则变化、candidate/main
CI URL、三份review、已知缺口、C1–C4与`FORK_TAG_RAW`/peeled C4；所有值从最终S/A证据逐字复制。

```bash
set -euo pipefail
SQUASH_EVIDENCE_DIR=.tmp/v240-ben3-squash
set -euo pipefail
source "$SQUASH_EVIDENCE_DIR/promotion-preflight.env"
gh release create v2.40.0-ben.3 \
  --repo Trendymen/opencodex \
  --verify-tag \
  --target "$FINAL_C4" \
  --title v2.40.0-ben.3 \
  --notes-file "$SQUASH_EVIDENCE_DIR/release-notes.md"
```

不附资产、不发npm。

- [ ] **Step 6: Release后验与workflow终态**

使用`apply_patch`创建`.tmp/v240-ben3-squash/verify-release.mjs`：

```js
import { readFileSync } from "node:fs";

const [releasePath, candidateRunPath, mainRunPath, manifestPath, expectedTree, forkTagRaw,
  c1, c2, c3, c4] = process.argv.slice(2);
const release = JSON.parse(readFileSync(releasePath, "utf8"));
const candidateRun = JSON.parse(readFileSync(candidateRunPath, "utf8"));
const mainRun = JSON.parse(readFileSync(mainRunPath, "utf8"));
if (release.tagName !== "v2.40.0-ben.3" || release.name !== "v2.40.0-ben.3" ||
    release.targetCommitish !== c4 || release.isDraft || release.isPrerelease || !release.url) {
  throw new Error("release metadata mismatch");
}
const hashes = readFileSync(manifestPath, "utf8").trim().split("\n").map(line => line.trim().split(/\s+/)[0]);
if (hashes.length !== 4 || hashes.some(hash => !/^[0-9a-f]{64}$/.test(hash))) {
  throw new Error("manifest hash evidence mismatch");
}
const required = [
  "官方基线", "v2.40.0", "候选 CI", "main CI", "SPEC_COMPLIANCE", "CODE_QUALITY",
  "workflow security", "已知缺口", "target_commit_count=4", candidateRun.html_url,
  mainRun.html_url, expectedTree, forkTagRaw, ...hashes, c1, c2, c3, c4,
];
for (const value of required) {
  if (!value || !release.body.includes(value)) throw new Error(`release body missing: ${value}`);
}
```

```bash
set -euo pipefail
SQUASH_EVIDENCE_DIR=.tmp/v240-ben3-squash
source "$SQUASH_EVIDENCE_DIR/promotion-preflight.env"
FINAL_S=$(sed -n '1p' "$SQUASH_EVIDENCE_DIR/final-snapshot")
FINAL_S_DIR="$SQUASH_EVIDENCE_DIR/$FINAL_S"
EXPECTED_TREE_FINAL=$(sed -n '1p' "$FINAL_S_DIR/expected-tree")
C1_FINAL=$(sed -n '1p' "$FINAL_S_DIR/c1")
C2_FINAL=$(sed -n '1p' "$FINAL_S_DIR/c2")
C3_FINAL=$(sed -n '1p' "$FINAL_S_DIR/c3")
FINAL_A=$(sed -n '1p' "$SQUASH_EVIDENCE_DIR/final-attempt")
FORK_TAG_RAW=$(sed -n '1p' "$SQUASH_EVIDENCE_DIR/fork-tag-raw")
gh release view v2.40.0-ben.3 --repo Trendymen/opencodex \
  --json tagName,name,body,isDraft,isPrerelease,url,targetCommitish \
  > "$SQUASH_EVIDENCE_DIR/release-final.json"
node "$SQUASH_EVIDENCE_DIR/verify-release.mjs" \
  "$SQUASH_EVIDENCE_DIR/release-final.json" \
  "$SQUASH_EVIDENCE_DIR/$FINAL_A/run-final.json" \
  "$SQUASH_EVIDENCE_DIR/main-run-final.json" \
  "$FINAL_S_DIR/manifest-sha256" "$EXPECTED_TREE_FINAL" "$FORK_TAG_RAW" \
  "$C1_FINAL" "$C2_FINAL" "$C3_FINAL" "$FINAL_C4"
node "$SQUASH_EVIDENCE_DIR/verify-ci-run.mjs" \
  "$SQUASH_EVIDENCE_DIR/$FINAL_A/run-final.json" \
  "$SQUASH_EVIDENCE_DIR/$FINAL_A/jobs-final.json" dev "$FINAL_C4"
node "$SQUASH_EVIDENCE_DIR/verify-ci-run.mjs" \
  "$SQUASH_EVIDENCE_DIR/main-run-final.json" \
  "$SQUASH_EVIDENCE_DIR/main-jobs-final.json" main "$FINAL_C4"
source "$SQUASH_EVIDENCE_DIR/classify-promotion.sh"
set -euo pipefail
classify_promotion post-release
test "$(sed -n '1p' "$SQUASH_EVIDENCE_DIR/promotion-post-release.verdict")" = success
```

本轮发布门禁只包含Spec规定的`Cross-platform CI`：精确dev candidate run和精确main run。不得把
其它workflow的成功误作替代，也不扩张为含糊的“全部workflow”。

- [ ] **Step 7: 最终对象核对**

执行完整终验；任一断言失败都不得报告完成：

```bash
set -euo pipefail
SQUASH_EVIDENCE_DIR=.tmp/v240-ben3-squash
set -euo pipefail
source "$SQUASH_EVIDENCE_DIR/promotion-preflight.env"
FINAL_S=$(sed -n '1p' "$SQUASH_EVIDENCE_DIR/final-snapshot")
FINAL_A=$(sed -n '1p' "$SQUASH_EVIDENCE_DIR/final-attempt")
FINAL_S_DIR="$SQUASH_EVIDENCE_DIR/$FINAL_S"
SOURCE_HEAD_FINAL=$(sed -n '1p' "$FINAL_S_DIR/source-head")
EXPECTED_TREE_FINAL=$(sed -n '1p' "$FINAL_S_DIR/expected-tree")
C1_FINAL=$(sed -n '1p' "$FINAL_S_DIR/c1")
C2_FINAL=$(sed -n '1p' "$FINAL_S_DIR/c2")
C3_FINAL=$(sed -n '1p' "$FINAL_S_DIR/c3")
FORK_TAG_RAW=$(sed -n '1p' "$SQUASH_EVIDENCE_DIR/fork-tag-raw")
test "$(git branch --show-current)" = dev
test -z "$(git status --porcelain=v1)"
git diff --quiet
git diff --cached --quiet
git fetch origin --prune --tags
for ref in main dev sync/v2.40.0; do
  test "$(git rev-parse "refs/heads/$ref")" = "$FINAL_C4"
  test "$(git rev-parse "refs/remotes/origin/$ref")" = "$FINAL_C4"
done
test "$(git rev-parse refs/heads/upstream-release)" = "$OFFICIAL_COMMIT"
test "$(git rev-parse refs/remotes/origin/upstream-release)" = "$OFFICIAL_COMMIT"
test "$(git cat-file -t refs/tags/v2.40.0-ben.3)" = tag
test "$(git rev-parse refs/tags/v2.40.0-ben.3)" = "$FORK_TAG_RAW"
test "$(git rev-parse refs/tags/v2.40.0-ben.3^{})" = "$FINAL_C4"
test "$(git rev-parse refs/tags/v2.40.0^{})" = "$OFFICIAL_COMMIT"
test "$(git rev-list --count "$OFFICIAL_COMMIT..$FINAL_C4")" = 4
source "$SQUASH_EVIDENCE_DIR/check-candidate.sh"
check_candidate "$FINAL_C4" "$FINAL_C4" "$SOURCE_HEAD_FINAL" "$EXPECTED_TREE_FINAL" \
  "$C1_FINAL" "$C2_FINAL" "$C3_FINAL" "$FINAL_S_DIR"
source "$SQUASH_EVIDENCE_DIR/classify-promotion.sh"
set -euo pipefail
classify_promotion final
test "$(sed -n '1p' "$SQUASH_EVIDENCE_DIR/promotion-final.verdict")" = success
gh release view v2.40.0-ben.3 --repo Trendymen/opencodex \
  --json tagName,name,body,isDraft,isPrerelease,url,targetCommitish \
  > "$SQUASH_EVIDENCE_DIR/release-terminal.json"
node "$SQUASH_EVIDENCE_DIR/verify-release.mjs" \
  "$SQUASH_EVIDENCE_DIR/release-terminal.json" \
  "$SQUASH_EVIDENCE_DIR/$FINAL_A/run-final.json" \
  "$SQUASH_EVIDENCE_DIR/main-run-final.json" \
  "$FINAL_S_DIR/manifest-sha256" "$EXPECTED_TREE_FINAL" "$FORK_TAG_RAW" \
  "$C1_FINAL" "$C2_FINAL" "$C3_FINAL" "$FINAL_C4"
```

恢复分支保留到全部终态确认；若删除，先核对精确ref只属于本任务，再用非递归明确branch delete。
