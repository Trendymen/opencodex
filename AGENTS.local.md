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

## 文档维护

### 文档位置与职责

| 路径 | 职责 |
| --- | --- |
| `AGENTS.local.md` | Fork 开发约束与文档维护规则；新增、移动或删除 Fork 文档时更新本表。 |
| `FORK_CHANGES.md` | 当前能力差异总览，包含官方基线、实现/回归入口和主要验证边界。 |
| `FORK_MAINTAINERS.md` | Fork 分支、版本和发布规则补充；完整同步流程链接到下方同步政策。 |
| `structure/fork-extensions.md` | 当前实现合同、源码边界和结构登记方式。 |
| `docs-site/src/content/docs/reference/fork-extensions.md` | 英文用户能力概览。 |
| `docs-site/src/content/docs/reference/configuration/fork-extensions.md` | 英文配置、默认值和操作说明。 |
| `docs-site/src/content/docs/zh-cn/reference/fork-extensions.md` | 对应能力概览的简体中文译文。 |
| `docs-site/src/content/docs/zh-cn/reference/configuration/fork-extensions.md` | 对应配置页的简体中文译文。 |
| `docs/fork-sync-automation.md` | 现行同步、候选验证与发布流程的规则真源；保留现有路径。 |

### 新增与形式

- 上游已有文档保持当前 `upstream-release` 基线原文，包含 `MAINTAINERS.md`、`docs-site/` 页面和 `structure/INDEX.md`。需要说明 Fork 差异时，在对应官方文件的同目录另起文件；不得给官方正文、译文或索引插入 Fork 段落。
- 优先更新上表中职责相符的现有文件。确需新增独立主题时，根目录使用 `FORK_<TOPIC>.md`，其余目录使用 `fork-<topic>.md`；登记路径和职责，并从现有 Fork 文档提供可点击入口。同一合同只维护一处正文，其他页面链接到它。
- 文档使用 Markdown，以短段落、表格和必要示例说明当前差异、适用条件及证据边界。总览的每项能力保留实现及现有回归入口，缺少回归时注明；详细配置、合同和流程放在各自负责的页面，避免重复整段说明。文档站页面沿用现有 Astro/Starlight frontmatter。
- Spec/Plan、审查包、冲突账本、执行记录和测试流水默认放 Git 忽略的 `.tmp/`；只有用户明确要求才进入仓库。版本发布记录放 Release Notes，当前能力不追加版本章节或候选 SHA 流水。历史材料从 Git 查阅。

### 更新与核对

- 能力新增、修复、上游化或撤回时，原地更新对应条目，并核对相关配置、合同、链接和回归入口；验证缺口继续明确标注。以“官方已覆盖”为由删除 Fork 差异条目或回归时，须有官方代码与测试的等价证据。
- 英文文档站 Fork 页面为正文来源；修改时同步对应简体中文页面，字段、默认值、条件和验证范围一致。其他官方语言页面继续采用上游版本。
- 同步新官方基线时，以新的 `upstream-release` 恢复官方文档原文，再核对仍有效的 Fork 差异；删除已失效的条目和孤立文件，更新本表及链接。
- `structure/` 新增或移动 Fork 文档时，按本目录规则更新 `structure/manifest.json` 并标记 `forkOnly: true`；完整接受结构门禁，生成的官方索引阅读顺序与源码映射排除这些条目。官方 contract registry 保持上游内容。
- 完成文档变更前，核对所有官方文档相对基线无修改/删除差异，并检查新文档的路径和链接；涉及 `structure/` 时按规则先暂存，再运行 `bun run structure:check`；涉及文档站时按目录规则运行构建。只改本文件的维护规则时，核对文档清单、职责和约束一致性，不重复运行未受影响的构建。

## changed 模式基准

- 在本 Fork 中运行 changed 模式测试时，永远显式使用 `bun scripts/test.ts --changed=origin/dev`：以 Fork 自己的集成线 `origin/dev` 为比较基准。
- 禁止依赖 `bun run test:changed` 作为任务级门禁：它固定 `--changed=dev`，而 `dev` 会优先解析为 `upstream/dev`（官方上游），导致重新选择整条 Fork 相对上游的长期差异，而不是当前任务的变更集。
