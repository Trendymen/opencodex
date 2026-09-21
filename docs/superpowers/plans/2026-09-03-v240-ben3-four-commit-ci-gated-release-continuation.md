# 历史计划续页

承接[原计划](2026-09-03-v240-ben3-four-commit-ci-gated-release.md)。以下为原有 Task 6 及后续内容，不作为当前同步任务的执行入口。

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

### Task 8: 创建 ben.3 Tag并用一次 `git push --atomic` 同时更新 `main`、`dev`、sync、marker 与两个 Tag

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

- [ ] **Step 3: 用一次 `git push --atomic` 同时更新 `main`、`dev`、`sync/v2.40.0`、`upstream-release`、Fork Tag 和官方 Tag**

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

第一次 push 后调用同一函数。返回 0 表示远端 `main`、`dev`、`sync/v2.40.0`、`upstream-release`、官方 Tag 与 Fork Tag 均达到目标状态；返回 10 表示全部 branch 仍是 preflight old、
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
