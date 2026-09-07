# OpenCodex v2.40.0-ben.3 四提交压缩与 CI 前置发布设计

## 目标

把官方 `v2.40.0` 之后、当前 `v2.40.0-ben.2` Release commit 之前的 10 个线性 Fork commits
重新压缩为恰好 4 个语义 commits，并以同一官方基线发布不可变的 `v2.40.0-ben.3`。

本次同时把下列规则写入 `AGENTS.local.md`、`docs/fork-sync-automation.md`、
`FORK_CHANGES.md` 和维护真源机械测试，作为后续所有 Fork 历史压缩发布的永久约束：

1. 压缩开始时固定 `SQUASH_TARGET_COUNT`；本次为 `4`。
2. 候选 CI、双审、Tag、发布用 `git push --atomic` 和 GitHub Release 的精确 SHA 都必须保持该提交数。
3. 候选 CI 未通过时不得追加第五个 commit；只允许 amend 既有四提交历史后，以精确
   `--force-with-lease` 强推 `dev` 触发新的 CI。
4. GitHub Release 必须晚于精确候选 SHA 的成功 CI；旧 SHA 的 PASS 不得沿用。

## 当前固定输入

| 项目 | 值 |
| --- | --- |
| 官方基线 | `v2.40.0` / `35ff3a462e786bd5efc394dfb1a8a5cc946e454f` |
| 当前 Fork Release | `v2.40.0-ben.2` |
| 当前 Release commit | `569f0e7b7d3388758b05553fda9ba2a13208433f` |
| 当前 Release tree | `db3e2fffc1a120f479a924e0d32a031e2d67b5c1` |
| 当前提交数 | `10` |
| 当前修改面 | 171 paths，`+28,766/-605` |
| 目标版本 | `2.40.0-ben.3` |
| 目标 Tag | `v2.40.0-ben.3` |
| 目标提交数 | `4` |

任务启动时先固定不可变的 `INITIAL_SOURCE_HEAD` / `INITIAL_SOURCE_TREE`。设计、计划、ben.3
版本和永久规则/测试全部落地并提交后形成 `SOURCE_HEAD_S1`；任何 CI 或审查促成的实质修复
都追加新的 `SOURCE_HEAD_SK` / `EXPECTED_TREE_SK`，不得覆盖旧内容快照。上表的 ben.2 tree
只用于证明现有 Release 不可变，不得冒充任一 attempt 的最终期望 tree。

## 方案比较

### 方案 A：`dev` 候选 CI + 固定四提交 amend 循环（采用）

先在本地重建 C1–C4，把候选以精确 lease 强推到 `dev`。CI 失败时不增加 commit：无代码变化的
重试只 amend C4 的候选尝试标识；需要修复时把变化 amend/重建进所属的 C1–C3，再重建 C4。
每次都重新证明官方基线之后恰好 4 个 commits，然后强推 `dev` 触发新 CI。只有最终精确 SHA
的 CI 与双审都通过，才创建 Tag，并用一次 `git push --atomic` 同时更新全部发布引用。

优点是 `main` 在候选阶段仍只指向最后一个正式 Fork Release，Tag 不会绑定失败候选，且所有
失败尝试都能继续 amend。代价是 `dev` 会被多次有 lease 地强推，这是用户明确授权的候选线
行为。

### 方案 B：提前把候选推到 `main` 再等 CI（不采用）

它可以直接取得 main push CI，但候选尚未发布时会让 `main` 偏离“只指向最新正式 Release”的
职责，并扩大失败窗口。

### 方案 C：先建 Tag/promotion，再依赖 main CI（不采用）

Tag 创建后不可移动。一旦 main CI 暴露确定性问题，就无法对同一个 `ben.3` 继续 amend，违反
“通过前持续 amend”的要求。

## 候选 CI 触发可达性与安全边界

现有 `.github/workflows/ci.yml` 的 `push` 带顶层 `paths` 过滤。纯 commit-message amend 的
before/after tree 相同，GitHub 不会创建新 run；仅把 `FORK_CHANGES.md` 加入 allowlist 也不能
解决同-tree amend。为保证每个新候选 SHA 都真实触发完整 Cross-platform CI，本轮删除
`push.paths`，保留 `push.branches: [main, preview, dev]`。

删除顶层过滤只能保证 run 被创建；同-tree push 的 `changes` 输出仍全部为 false，因此还必须
同步修改当前两个 changed-surface 例外：

- `gates` 中 `GUI lint` / `GUI build` 改为在任何 push 上执行，仅 pull request继续按
  `needs.changes.outputs.gui` 裁剪；
- `npm-global-smoke` 改为在任何 push 上执行，pull request继续按 packaging输出裁剪，
  `workflow_dispatch` 保持执行。

aggregate `ci` 对 push event 不再普遍接受 `skipped`。候选/main push要求
`changes`、`select-windows-runner`、四个 `test` shard、`storage-policy`、`api-usage`、`gates`、
`platform-macos`、三平台 `keyring-smoke`、三平台 `npm-global-smoke` 全部 success；只有现行
dispatch-only `platform-windows` 可以 skipped。Windows发布策略不是本轮目标，不把它改成 push
job。pull request仍可按原规则接受明确的 changed-surface skip。

机械测试必须锁定：

- `push` 仍只接受 `main`、`preview`、`dev`；
- `push` 下不存在 `paths` / `paths-ignore`；
- 上述 candidate/main push必需 job和GUI/packaging步骤不能被 changed-path输出跳过；
- aggregate `ci` 在 push 上只允许 `platform-windows=skipped`，其它必需 producer必须 success；
- workflow 仍为 `permissions: contents: read`，不新增 secret、写权限、自托管 runner信任扩张或
  mutable action ref。

修改 `.github/workflows/ci.yml` 属于安全边界变化。除常规 `SPEC_COMPLIANCE` 和
`CODE_QUALITY` 外，发布前必须有一名独立 `CODE_QUALITY` reviewer做限定 scope 的显式
security review，至少检查 trigger、permissions、runner选择、第三方 action固定 SHA、secret
可达性和“push run不会全部 skip”。该 reviewer未 PASS 时禁止候选 push、Tag和 Release。

## 四个提交边界

| 提交 | Subject | 责任边界 |
| --- | --- | --- |
| C1 | `feat: 汇总 Fork 运行时与用户能力` | `src/**`、`bin/**`、`docs-site/**`、`gui/**`（明确排除 `gui/tests/**`） |
| C2 | `chore: 汇总 Fork CI、脚本与维护基础设施` | `.github/`、`scripts/`、`structure/`、规则文档、设计/计划、维护基础设施；不含 `FORK_CHANGES.md` |
| C3 | `test: 汇总 Fork 回归并推进 v2.40.0-ben.3` | `tests/`、`gui/tests/`、`package.json` 的 ben.3 版本及四提交/CI 前置门禁 |
| C4 | `docs: 记录 v2.40.0-ben.3 四提交候选` | 只修改 `FORK_CHANGES.md`；父提交固定为 C3 |

每个内容快照 `S_K` 在 `.tmp/` 固定四份按 `LC_ALL=C` 排序的 manifest，并记录 SHA-256：

- `M1_SK`：`src/**`、`bin/**`、`docs-site/**`、`gui/**`，排除 `gui/tests/**`；
- `M2_SK`：`.github/**`、`scripts/**`、`structure/**`、`docs/**`、`.gitignore`、
  `AGENTS.local.md`、`MAINTAINERS.md`；
- `M3_SK`：`tests/**`、`gui/tests/**`、`package.json`；
- `M4_SK`：只能是 `FORK_CHANGES.md`。

路径分类按上述精确前缀/根文件执行；出现未列出的顶层路径即 fail closed，不用“等”或人工猜测
归属。四份集合必须 pairwise disjoint，union 必须逐字节等于
`git diff --name-only --no-renames "$OFFICIAL_COMMIT" "$SOURCE_HEAD_SK" | LC_ALL=C sort -u`。

C1–C3 依次只应用 M1–M3；C4只应用 M4。定义
`EXPECTED_TREE_SK=SOURCE_HEAD_SK^{tree}`，每个引用该内容快照的 push attempt 都必须满足
`C4_AJ^{tree}=EXPECTED_TREE_SK`。C3 是未应用 M4 的 implementation tree；机械要求
`git diff --name-only C3_SK C4_AJ` 恰好
只有 `FORK_CHANGES.md`。因此 C4 必然有 docs-only 变化，同时最终候选仍逐字节等于该 attempt
的已批准 source tree。

## 固定提交数契约

任务级不可变输入：

- `OFFICIAL_COMMIT`
- `INITIAL_SOURCE_HEAD`
- `INITIAL_SOURCE_TREE`
- `SQUASH_TARGET_COUNT=4`

每次实质内容变化都追加一个内容快照 tuple `S_K`：

- `SOURCE_HEAD_SK`
- `EXPECTED_TREE_SK=SOURCE_HEAD_SK^{tree}`
- `M1_SK`、`M2_SK`、`M3_SK`、`M4_SK` 及各自 SHA-256
- `C1_SK`、`C2_SK`、`C3_SK`

每次实际 candidate push 都追加一个 push/CI attempt tuple `A_J`：

- `CONTENT_SNAPSHOT=S_K`
- `C4_AJ`
- `CANDIDATE_HEAD_AJ=C4_AJ`
- push before/after OID、CI run identity与结论

旧 `S_K` 与 `A_J` tuple 永久保留，不重赋值。同-tree message-only retry复用同一 `S_K`，但
必须追加新的 `A_J` 与新 C4 SHA。修改 C1 时依次重建 C1–C4并创建新 S/A；修改 C2 时重建
C2–C4；修改 C3 时重建 C3–C4。任何后继提交都不得继续挂在已废弃的前驱 SHA 上。

每个候选 push 前、CI 返回后、双审前、Tag 前、发布用 `git push --atomic` 前和 GitHub Release 前都必须
执行等价检查：

```bash
test "$(git rev-list --count "$OFFICIAL_COMMIT..$CANDIDATE_HEAD")" = "$SQUASH_TARGET_COUNT"
test -z "$(git rev-list --min-parents=2 "$OFFICIAL_COMMIT..$CANDIDATE_HEAD")"
git merge-base --is-ancestor "$OFFICIAL_COMMIT" "$CANDIDATE_HEAD"
test "$(git rev-parse "$C1_SK^")" = "$OFFICIAL_COMMIT"
test "$(git rev-parse "$C2_SK^")" = "$C1_SK"
test "$(git rev-parse "$C3_SK^")" = "$C2_SK"
test "$(git rev-parse "$C4_AJ^")" = "$C3_SK"
test "$CANDIDATE_HEAD" = "$C4_AJ"
test "$(git rev-parse "$CANDIDATE_HEAD^{tree}")" = "$EXPECTED_TREE_SK"
test "$(git diff-tree --no-commit-id --name-only -r "$CANDIDATE_HEAD")" = "FORK_CHANGES.md"
git diff --check "$OFFICIAL_COMMIT...$CANDIDATE_HEAD"
```

同一 gate 还必须执行 manifest 的 pairwise intersection 为空、四集合 union 等于 source diff，
并逐路径验证 C1–C4 实际 diff 与 M1–M4 完全一致。远端 `origin/dev` fetch 后必须满足
`origin/dev==CANDIDATE_HEAD`，再从该远端 OID重算为 4；不能只信本地计数或旧 CI 记录。任何
阶段出现第 5 个 commit、错误父链、merge commit、tree/manifest不等、C4 非 docs-only、remote
OID漂移或计数不等，均 fail closed。

阶段证据必须满足以下同一 SHA 等式，不能只记录“通过”。这些是 C4 创建后的 append-only
任务证据，不要求写回 C4 tree：

| 阶段 | 必须记录并核对的身份 |
| --- | --- |
| candidate push | `origin/dev == C4_AJ == CANDIDATE_HEAD`；push 的 before OID 等于 lease expected-old |
| candidate CI | workflow 名称/ID、event=`push`、branch=`dev`、`headSha=C4_AJ`、run ID/URL、completed/success、aggregate `ci=success` |
| regular review | `SPEC_COMPLIANCE` 与常规 `CODE_QUALITY` package 的 `RELEASE_COMMIT_RN == C4_AJ`，最终 verdict绑定该 SHA |
| workflow security review | `CONTENT_SNAPSHOT=S_K`，记录精确 `.github/workflows/ci.yml` blob；最终 C4 tree 中该 blob必须相同，不要求绑定message-only C4 SHA |
| Tag | raw ref 类型=`tag`，peeled commit=`C4_AJ` |
| promotion | 本地/远端 `main`、`dev`、`sync/v2.40.0`、Fork Tag peeled 全等于 C4；marker和官方 Tag等于 official |
| main CI | workflow 名称/ID、event=`push`、branch=`main`、`headSha=C4_AJ`、completed/success、aggregate `ci=success` |
| Release | `tagName=name=v2.40.0-ben.3`、非 draft/prerelease，远端该 Tag peeled仍等于 C4 |

## amend 与候选 CI 循环

内容快照编号为 `S1`、`S2`……；每次实质变化递增 S。candidate push/CI 尝试编号为
`A1`、`A2`……；每次实际 push 都递增 A。同-tree CI 重试复用 S 并新增 A，不覆盖任何 tuple。

1. 首次构建 C1–C4 后，验证计数与 tree。workflow security reviewer先绑定该 `S_K` 中
   `.github/workflows/ci.yml` 的精确 blob并 PASS；之后才可以用 `origin/dev` 的精确旧 OID为
   lease 强推 C4。
2. 只接受该次 `push` event、`workflowName=Cross-platform CI`、`headBranch=dev`、
   `headSha=C4_AJ` 的 run；必须记录 run ID/URL、status、conclusion 和 aggregate `ci` job，且
   `status=completed`、`conclusion=success`、aggregate `ci=success`。
3. CI 失败但不需要改文件时，保持所引用的 S tuple、C1–C3、C4 tree 和 C4 parent 不变，仅
   amend C4 message 中的 `候选尝试: A` 加递增正整数，生成新 SHA并追加新的 A tuple；随后
   重新验证计数并以刚失败的远端 OID 为 lease 强推 `dev`。workflow blob未变时可复用绑定
   `S_K` blob的 security review，但最终常规双审必须绑定新的 C4 SHA。
4. CI 或审查要求实质修复时，创建下一 S tuple，把修复折入所属 commit，并依次重建其全部
   后继直到 C4，再创建新的 A tuple；不得追加 C5。新 S 具有新的 `SOURCE_HEAD_SK`、期望
   tree、manifest 和 C1–C3 SHA；若 workflow blob变化，security review也必须重做。旧 candidate
   CI与常规审查轮次全部废弃，必须从新的 candidate CI 开始。
5. 只有最新 C4 SHA 的 Cross-platform CI `status=completed`、`conclusion=success` 才能进入双审。
6. reviewer finding 导致任何提交/tree变化时，回到第 4 步。两个常规 reviewer PASS 后，
   再次确认它们的 candidate SHA 与当前 C4 完全相等，且 candidate CI仍绑定同一 SHA；另行
   确认最终 C4 tree中的 `.github/workflows/ci.yml` blob等于 security reviewer已 PASS 的
   `S_K` blob。只有 workflow blob变化才要求重做 security review，message-only C4 amend不要求。

`commit --amend` 不能只依赖时间戳碰运气生成新 OID；候选尝试编号必须变化。重试不得使用
`--allow-empty` 新增 commit，也不得使用普通 `--force`。

## Tag、原子推送与 GitHub Release

候选 CI 和双审都绑定最终 C4 SHA 后：

1. 创建新的中文 annotated `v2.40.0-ben.3`，raw ref 类型必须为 `tag`，peeled commit 必须为
   最终 C4；创建前再次执行父链、tree、manifest、count、candidate CI、两个常规 review SHA
   和 workflow security-review blob等式检查。`v2.40.0-ben.2` 保持不可变。
2. 执行一次 `git push --atomic`，同时更新 `main`、`dev`、`sync/v2.40.0`、`upstream-release`、
   Fork Tag 和官方 Tag：前三个 branch 与 Fork Tag 指向 C4，`upstream-release` 与官方 Tag
   指向官方基线。四个 branch 使用各自精确 ref-scoped lease；
   两个 Tag 不 force、不使用 lease。
3. 本地 `main`、`sync/v2.40.0`、`upstream-release` 使用一个带
   `start` / `prepare` / `commit` 的三 ref CAS transaction 收敛。
4. 原子推送后必须重新读取并证明远端 `main`、`dev`、`sync/v2.40.0` 和 Fork Tag peeled
   commit 全等于 C4，marker 与官方 Tag 全等于 `OFFICIAL_COMMIT`；本地三 ref 与对应远端一致。
5. main push 的 Cross-platform CI 仍是发布后验。只接受 `workflowName=Cross-platform CI`、
   `event=push`、`headBranch=main`、`headSha=C4`、`status=completed`、`conclusion=success` 且
   aggregate `ci=success` 的 run。GitHub Release 必须同时晚于同一 C4 的成功 dev candidate CI
   和成功 main CI。
6. main CI 的环境性失败可以只重跑同一 SHA；若暴露需要改代码的确定性失败，则保留不可变
   Tag、停止 GitHub Release，并请求用户决定新的同基线 revision，绝不移动 ben.3 Tag。
   `main`、`dev`、`sync/v2.40.0` 保持已 promotion 的 C4，ben.3 revision 视为已消耗。
7. `Tag 已存在但 Release 缺失` 的任何 heartbeat/恢复入口都必须重新查询该 Tag peeled SHA
   对应的成功 dev candidate CI 和成功 main CI；缺失、旧 SHA、失败、取消或未完成 run 一律
   阻塞 Release。确定性 main CI 失败只能由用户授权启动 `ben.4` 等新 revision，普通幂等收敛
   不得绕过。
8. GitHub Release 标题等于 Tag，中文 Notes 记录官方基线、4-commit tree/计数证据、最终候选
   CI、main CI、双审、已知缺口和完整 commit；非 draft、非 prerelease，仅 source archive。
   创建前后都重新读取 promotion refs 与 Tag，并验证 `tagName` 对应的远端 Tag peeled commit
   仍为同一 C4。

## 永久规则与机械门禁

在下列真源加入同一机器契约：

- `docs/fork-sync-automation.md`
- `FORK_CHANGES.md` 的两个活跃发布流程
- `AGENTS.local.md` 的上游同步入口

永久规则分为两层：

1. 通用压缩合同参数化为 `N=SQUASH_TARGET_COUNT`，且 `N>=2`。任务开始后 N 不变；最终
   `RELEASE_COMMIT=C_N` 且只修改 `FORK_CHANGES.md`；实质修复折回所属 commit 并重建全部
   后继；任何 attempt 都不得变成 N+1。
2. 本轮 `v240-ben3-squash` 仓库内审计块只记录 C4 创建前可确定且不会自引用的内容：`N=4`、
   内容快照标识、四份 manifest hash、C1–C3 SHA、`expected_tree=external-task-evidence`，以及
   `release_commit=docs-only-current-head`。candidate CI、regular/security review、Tag、
   promotion、main CI 和 GitHub Release 全部写成 `pending external gate`，不得预写未来成功。
   未来任务可以明确选择 2、3、5 或其他不小于 2 的整数，不继承本轮四提交拓扑。

`tests/fork-maintenance-truth.test.ts` 必须同时锁定通用合同和本轮审计块：

- `SQUASH_TARGET_COUNT=N` 在任务开始后固定且所有阶段复核，最终第 N 个提交 docs-only；
- candidate CI 必须早于 Tag 和 GitHub Release；
- CI 失败只能 amend/rebuild 现有 N 提交历史，不得追加第 N+1 个 commit；
- 无文件变化重试必须改变候选尝试编号；
- 实质修复必须折回所属提交并重建全部后继；
- 最终 C_N 永远只含 `FORK_CHANGES.md`，父提交永远是 C_(N-1)；
- `dev` 强推必须使用逐次 expected-OID lease；
- Release API 必须绑定最终 CI 已通过的同一 SHA；
- Tag 已存在但 Release 缺失时，仍必须取得同一 SHA 的成功 candidate/main CI；
- 任何旧 SHA PASS、commit-count 漂移、空成功 workflow 或 Tag 后 amend 都被拒绝；
- 本轮审计块额外固定 `N=4`、C1–C3、四 manifest完整分区、
  `expected_tree=external-task-evidence`、
  `release_commit=docs-only-current-head` 和全部外部门禁的 pending语义；
- `.github/workflows/ci.yml` 的 branch-only push 触发与完整 push jobs 可达性。

现有 pre-push hook 会运行 `bun run prepush`，因此会执行这份维护真源测试。hook 只能阻止静态
契约回退；实际 SHA、commit 数、remote lease 和 CI run identity 仍必须由发布任务在每个阶段
重新读取，hook 不得伪造 CI 或 review 证据。

C4 创建后的 `EXPECTED_TREE_SK` 实际 SHA、`C4_AJ`、candidate/main CI run、review verdict、
Tag raw/peeled、promotion refs 和 GitHub Release元数据只写入 append-only任务证据与最终
GitHub Release Notes，不回写候选 Git tree。这样既避免 C4 SHA/tree 自引用，也避免为了记录
发布结果追加 C5或移动 Tag。仓库测试只锁定结构、预先可知的 C1–C3 SHA、manifest和“外部
tree/门禁尚未发生”的诚实状态；最终闭环由实时 Git/API 后验与 Release Notes承载。

## 验证与审查

实现采用 TDD：先让维护真源测试因缺少四提交/CI 前置机器契约而失败，再补规则。最终候选至少
运行：

- `bun test tests/fork-maintenance-truth.test.ts tests/fork-version-policy.test.ts`
- `bun run prepush`
- workflow trigger 静态测试：dev message-only amend push 可启动完整 Cross-platform CI，且
  permissions/runner/action pinning 不变
- ancestry、完整父链、tree identity、manifest union/disjoint、四提交计数、无 merge commit、
  C4 parent/docs-only、远端 OID 和 diff check
- `SPEC_COMPLIANCE` 与 `CODE_QUALITY` 双审，加一名限定 workflow scope 的独立 security
  `CODE_QUALITY` reviewer；任一 Critical/Important finding 阻塞
- 精确 candidate dev CI 与最终 main CI

## 非目标与残余风险

- 不修改现有 runtime 行为，除非 CI 或 reviewer 证明必须修复；任何实质修复都重启完整门禁。
- 不移动、删除或重建 `v2.40.0-ben.2` 及更早 Tag/Release。
- 不发布 npm，不上传额外资产，不修改全局安装。
- Git 无法为未来未知 Tag 名称建立通配 lease；同基线 Tag namespace 仍需紧邻关键动作重读。
- Tag 创建后的确定性 main-only failure 不能通过 amend ben.3 修复；必须 fail closed，不能牺牲
  Tag 不可变性来满足重试便利。
