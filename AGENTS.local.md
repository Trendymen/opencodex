# OpenCodex Relay 本地规则

本文件是当前工作区的用户级补充规则。与仓库 `AGENTS.md` 或全局规则冲突时，以本文件为准。

## 上游同步自动化规则

- 每小时上游稳定版同步自动化（含官方 Tag 保留、双审门禁、幂等收敛与完整发布流程）的规则真源见 docs/fork-sync-automation.md；该自动化相关任务必须先读取并遵循该文档。
- 分支职责以该文档为准：main 只指向最新已发布 Fork Release；dev 是自由开发线，同时是上游稳定版 rebase、候选验证、双审和 Release 发布的候选来源。同步不得把 dev 仅当作只读证据。
- rebase 冲突审查必须执行该文档规定的逐冲突证据账本、固定 SHA 独立机械重算、三层 diff、命名风险清单与默认双审；只给汇总计数、总括性解决说明或测试通过结论均不够。explorer 仅作可选取证，不因敏感路径、冲突数量或 hunk 数量自动成为发布门禁；只有 reviewer 或主线程指出未收敛的具体跨边界 path、symbol 或 edge 时，才补一个窄范围质量审查。
- 验证选择、结果复用与有界审查按该文档执行：实现期定向检查，最终实现一次官方 prepush；未受影响且已通过的检查不因补文档或审查附件重跑。全量 Fork diff 是能力核对材料，深审聚焦本轮冲突、交叠变化、修复及受影响链路。不自动恢复已删除的 push hook。
- 每个官方基线只使用一个 `sync/vX.Y.Z` Release 指针；同基线 `ben.N` 发布时，用一次 `git push --atomic` 同时更新 `main`、`dev`、`sync/vX.Y.Z`、`upstream-release`、Fork Tag 和官方 Tag，其中允许用该 sync ref 的精确 expected-OID lease 强制更新；禁止创建 `sync/vX.Y.Z-ben.N`。Fork Tag 仍不可变，sync 的可移动性不得放宽 Tag 规则。

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

- 压缩任务开始时固定 `SQUASH_TARGET_COUNT=N`（`N>=2`）；CI 或审查未通过时只 amend `C_N` 或把修复折回所属提交并重建后继，禁止追加 `C_(N+1)`。只有同一 `C_N` SHA 的 dev candidate CI、常规双审与 main CI 全部通过，才允许创建或补齐 GitHub Release。

## 测试文件与官方布局

- 测试遵循官方 `tests/<domain>/` 布局。新增文件放到对应 domain，并按官方要求同时更新 `scripts/test-layout/layout.json` 的 explicit 与 `tests/fixtures/test-layout-expected.json`；resolver 能临时归类不免除登记。
- 同一行为已有官方测试文件时，优先在原文件补充回归，不为“Fork 专项”重复建根目录测试。源码真值测试通过 `tests/helpers/repo-root.ts` 取仓库路径。
- rebase 时，当前官方源码与测试已经完整覆盖 Fork 行为的，可以移动、改写或删除旧 Fork 测试；必须在 `FORK_CHANGES.md` 记录覆盖证据，不能只为通过测试降低断言。

## 官方版本修改面最小化

- 每项代码修改都必须以相对官方版本的最小修改面为目标：优先使用既有扩展点或新增窄模块，避免扩散到高频核心文件、无关调用链或既有功能。
- 动手前应核对官方基线与当前 fork 的差异；审查时必须把“相对官方基线的修改面是否仍为最小”作为独立检查项。
- 审查报告必须列出本任务改变的文件及必要性。若存在更小或更低耦合的实现路径，或混入与需求无关的改动，结论应为 Needs Changes。

## changed 模式基准

- 在本 Fork 中运行 changed 模式测试时，永远显式使用 `bun scripts/test.ts --changed=origin/dev`：以 Fork 自己的集成线 `origin/dev` 为比较基准。
- 禁止依赖 `bun run test:changed` 作为任务级门禁：它固定 `--changed=dev`，而 `dev` 会优先解析为 `upstream/dev`（官方上游），导致重新选择整条 Fork 相对上游的长期差异，而不是当前任务的变更集。
