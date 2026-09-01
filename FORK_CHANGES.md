# Trendymen Fork 修改清单

本文档是 [`Trendymen/opencodex`](https://github.com/Trendymen/opencodex)
相对 [`lidge-jun/opencodex`](https://github.com/lidge-jun/opencodex)
最新稳定版的维护真源。

这里记录的是当前 Fork 已提交代码实际提供的能力，而不是旧 Spec、Plan、devlog、
可变安装包或已放弃实验中的设想。每次稳定版 rebase，以及任何新增、删除、替换或
实质改变 Fork 能力的普通提交，都必须更新本文档。文档内容统一使用简体中文；代码
符号、文件路径、命令、Provider/模型标识和版本号保持原样，避免技术含义漂移。

稳定版 rebase 时，先完成并提交实现，随后从精确的实现 SHA 更新本文档，在文档已
更新的状态下执行最终完整验证，最后单独提交本文档。该文档提交是派生版本 Tag 指向
的末尾提交。

## 状态定义

| 状态 | 含义 | rebase 时的要求 |
| --- | --- | --- |
| **Fork 独有——保留** | 官方稳定 Tag 尚未提供该能力。 | 保留行为与测试，并尽量缩小官方高频文件中的接线。 |
| **官方部分覆盖——保留差异** | 官方已有基础机制，但没有覆盖完整 Fork 行为。 | 重新核对边界，只保留官方未覆盖的差异。 |
| **官方完整覆盖——已移除** | 官方已有等价或更优实现，本地补丁已经删除。 | 保留历史记录，并附官方源码、测试或提交证据。 |
| **Fork 内部替换/移除** | 本地实现已被新实现替代、被证伪或主动删除。 | 冲突处理时不得恢复旧方向。 |
| **已知缺口** | 目标行为仍不完整，或缺少所需验收证据。 | 不得宣称完全闭环；必须单独修复或复验。 |

只有当前官方源码与测试能够证明行为等价或更优时，才算“官方覆盖”。名称相似、旧
文档描述或单次 HTTP 200 都不能作为删除 Fork 能力的依据。

## 当前审计基线

| 项目 | 当前值 |
| --- | --- |
| 审计日期 | 2026-09-01 |
| 本轮官方维护基线 | [`v2.39.0`](https://github.com/lidge-jun/opencodex/releases/tag/v2.39.0) |
| 官方 Tag commit | `af6113a0381d6fff2e4dce587652825c7eeb6423` |
| 当前上游最新稳定 Release | `v2.39.0`（`af6113a0381d6fff2e4dce587652825c7eeb6423`），即本轮 rebase 基线 |
| dev 候选实现 HEAD | `6835e7ea163144c52d520231ed6df2830a9dac5d`（rebase 完成并同步 v2.39 官方证据锚） |
| Fork 包版本 | `2.39.0-ben.1` |
| 本轮派生 Tag | `v2.39.0-ben.1`；本轮只执行 rebase，未授权创建 Tag 或 Release |
| 同步分支 | `sync/v2.39.0` 尚未建立；只在后续发布候选完整验证后建立 |
| 已提交修改面 | 165 个文件，新增 27,132 行，删除 291 行（相对 `v2.39.0`，不含后续证据锚与末尾文档提交） |
| 最终本地门禁 | rebase 后 typecheck 已通过；维护真源测试已更新为 v2.39 并 14 pass / 0 fail；本轮不发布，完整 prepush 尚未执行 |
| 外部发布状态 | 未发生：`main`、`origin/dev`、`upstream-release`、Tag 与 Release 均未修改 |
| dev 发布策略 | `dev` 是候选与 rebase 线；发布时以显式 lease 与 `main` 同步到同一 Release commit，发布后可再次自由领先 `main` |
| 官方基线标记 | `origin/upstream-release` 指向未经修改的官方 Tag commit |

本轮相对 `v2.39.0` 的实现短统计严格以最终捕获的 `IMPLEMENTATION_HEAD` 计算；末尾
`FORK_CHANGES.md` 文档提交不属于实现快照。候选来自已提交且来源明确的 `dev`：
`v2.38.0-ben.2` Release commit `1092cfb48` 在官方 `v2.39.0` 之上重放为临时候选
`ff3653f0a`。本轮只执行 rebase 与验证，不创建 Tag、push 或 GitHub Release。

官方 v2.39 改动与 Fork 候选重叠 19 条路径。内容冲突 2 条：`bin/ocx.mjs` 同时保留
官方 pending-teardown 检查与 Fork version policy import；`package.json` 同时保留官方
v2.39 package 表面、Fork `install:local`，并将候选版本收敛为 `2.39.0-ben.1`。
其余 17 条路径自动合并；range-diff 显示 Fork 主体提交等价重放，v2.38 ben.2 版本提交
仅按新官方基线调整版本。

历史 v2.38.0 及更早轮次账户保留在专用区块，仅用于追溯，不能作为本轮结论。

<!-- v239-rebase:start -->
official_old=v2.38.0
official_new=v2.39.0
candidate_branch=dev
candidate_before=1092cfb48b2e8f478c21e3fa9daf09bb002e7bef
candidate_after=6835e7ea163144c52d520231ed6df2830a9dac5d
overlap_path_count=19
auto_merge_path_count=17
overlap_paths=bin/ocx.mjs,gui/src/i18n/de.ts,gui/src/i18n/en.ts,gui/src/i18n/fr.ts,gui/src/i18n/ja.ts,gui/src/i18n/ko.ts,gui/src/i18n/ru.ts,gui/src/i18n/tr.ts,gui/src/i18n/zh-TW.ts,gui/src/i18n/zh.ts,gui/src/pages/Logs.tsx,package.json,src/adapters/openai-responses.ts,src/codex/catalog/provider-fetch.ts,src/server/responses/encrypted-payload.ts,src/update/index.ts,tests/openai-responses-passthrough.test.ts,tests/responses-state.test.ts,tests/update-stop-first.test.ts
content_conflict_count=2
content_conflicts=bin/ocx.mjs,package.json
decision_bin_ocx_mjs=official=hasPendingTeardownIn；fork=forkUpdateDecision；resolution=双方 import 与调用链均保留；tests=tests/release-version-line.test.ts,tests/update-stop-first.test.ts
decision_package_json=official=version 2.39.0 与 package 表面；fork=install:local 与 ben 版本策略；resolution=保留官方表面并收敛为 2.39.0-ben.1；tests=tests/fork-version-policy.test.ts,tests/release-version-line.test.ts
external_actions=none；本轮未授权 Tag、push、main/dev/sync promotion 或 GitHub Release
tests=tests/fork-maintenance-truth.test.ts,tests/fork-version-policy.test.ts,tests/release-version-line.test.ts
<!-- v239-rebase:end -->

<!-- v238-rebase:start -->
official_old=v2.37.0
official_new=v2.38.0
candidate_branch=dev
candidate_before=09fbd1453fa2c374d5d0e9cad9ae15cf86cf7e8f
candidate_after=fac328f9465b4ce17abddf7fec2df006c9a58aa0
overlap_path_count=17
auto_merge_path_count=16
overlap_paths=bin/ocx.mjs,gui/src/i18n/de.ts,gui/src/i18n/en.ts,gui/src/i18n/fr.ts,gui/src/i18n/ja.ts,gui/src/i18n/ko.ts,gui/src/i18n/ru.ts,gui/src/i18n/tr.ts,gui/src/i18n/zh-TW.ts,gui/src/i18n/zh.ts,package.json,src/codex/catalog/provider-fetch.ts,src/codex/catalog/sync.ts,src/config.ts,src/server/management/provider-routes.ts,src/update/index.ts,structure/04_transports-and-sidecars.md
content_conflict_count=1
content_conflicts=package.json
decision_package_json=official=version 2.38.0；fork=install:local script；resolution=双方保留并收敛为 2.38.0-ben.2；tests=tests/release-version-line.test.ts,tests/fork-version-policy.test.ts
dev_promotion=发布瞬间当前已验证 dev 与 main/sync/Fork Tag 收敛到 RELEASE_COMMIT；发布后 advanced dev 不得被自动重置回旧 RELEASE_COMMIT
tests=tests/fork-maintenance-truth.test.ts,tests/fork-version-policy.test.ts,tests/fork-ci-official-baseline.test.ts
<!-- v238-rebase:end -->

<!-- v237-rebase-conflicts:start -->
official_old=v2.36.0
official_new=v2.37.0
mechanism=rebase 范围排除：官方 v2.36.0..v2.37.0 之间 14 笔提交（含官方预发布的 9 笔 Fork 作者提交）upstream-reachable，rebase --onto 自动排除；Fork 侧 25 笔全部重放，无 Fork 提交被 drop
overlap_path_count=3
overlap_paths=gui/tests/sidecar-layout.test.ts,package.json,src/adapters/kiro.ts
content_conflict_count=2
content_conflicts=gui/src/styles-dashboard-workspace.css,package.json
decision_package_json=official=version 2.37.0；fork=install:local script；resolution=双方保留；tests=tests/release-version-line.test.ts
decision_css=官方 PR #3007（df8b3882f）已吸收 Fork 73eb88b7f 全部内容；冲突按官方侧解决，Fork 保留测试增量 fc0360d52；tests=gui/tests/sidecar-layout.test.ts
verification=git rev-list 计数（官方 14 笔、旧栈 33、新栈 25=33−9+1 文档+1 测试）+ merge-base --is-ancestor 逐笔祖先验证 + CSS blob 双侧等价（2b854f57c）
version_convergence=ben.3/ben.4/ben.5 候选收敛为 2.37.0-ben.1
tests=tests/fork-maintenance-truth.test.ts,tests/fork-version-policy.test.ts,tests/release-version-line.test.ts
<!-- v237-rebase-conflicts:end -->

## v2.37.0-ben.2 修订

官方基线不变（`v2.37.0` / `54e2274cff231631c0ea2ff12574ff03829d5fe6`），本轮为用户明确要求的增量修订。

- 实现提交 `b4fc9d7bc749874d5c1bd5a68832cc2e094579d2`：`feat(responses): 分段聚合第三方 reasoning summary 为多 part`。
  - part 0 保持既有“粗体标题+首句”单 delta 发射方式；
  - part 1+ 按 3 句或 500 Unicode code point（先到为准）聚合，每个 part 发出完整 added / delta / done / part-done 生命周期；
  - `response.reasoning_text.done` 时 flush 残余缓冲为最后一个 part，并按最后一个 part 的 `summary_index` 发送总 `summary_text.done`（text 为各 part 以换行连接）；
  - 终态 `response.output_item.done` / `response.completed` 将已发送 parts 复用为 `summary[]`，原始 reasoning `content[]` 全程保留（含 encrypted_content 项）；
  - code point 安全切分（surrogate pair 不跨 part 断开）。
- 新增测试 `tests/responses-reasoning-summary-part-split.test.ts`（3 用例：3 句聚合 / 500 code point 兜底 / 残余 flush 与终态复用）。
- 修改面：仅 `src/server/responses-reasoning-summary-rewrite.ts`（相对 ben.1 +240/−56）与上述新测试文件；无公共 API、路由或 provider 行为变化，passthrough 与 JSON 改写路径行为保持。
- ben.2 实现 HEAD 短统计（相对官方 `v2.37.0`）：135 个文件，新增 17,694 行，删除 193 行。
- 验证边界：聚焦 5 个 reasoning-summary 测试文件 31 pass；`bun run typecheck` 通过；`bun run test:changed` 14,319 tests / 0 fail；独立 reviewer COMBINED_REVIEW Approved（无 Critical/Important finding）。

## v2.37.0-ben.3 全量历史压缩与发布边界

本修订只重组已提交的 Fork 历史，不改变 ben.2 已有运行时、兼容层、测试或 CI 内容。不可变源 Tag `v2.37.0-ben.2` 的 peeled commit 为 `4108827bd655fc4d87701faf98fe2ae84c893c75`，其历史保持不可变，不移动、不删除、不重建。

压缩结构（相对官方 `v2.37.0` / `54e2274cff231631c0ea2ff12574ff03829d5fe6`，32 笔收敛为 5 笔）：

- C1 `feat: 汇总 Fork 运行时与兼容扩展`：全部 src、gui、docs-site、structure 与 .gitignore（72 文件）。
- C2 `test: 汇总 Fork 回归与兼容覆盖`：全部 Fork 测试与真源/台账锚点（48 文件）。
- C3 `chore: 汇总 Fork CI 发布与审计基础设施`：CI workflow、本地安装与官方基线准备脚本、代理本地规则、维护真源 FORK_CHANGES.md 与 superpowers 审计文档（15 文件）。
- C4 `chore: 推进 v2.37.0-ben.3 版本真源`：仅 package.json 版本行推进为 `2.37.0-ben.3`。
- C5 末尾文档提交（本轮 FORK_CHANGES.md 更新）。

树等价不变量：C3 树与 ben.2 末尾文档树（`4108827bd`）逐 blob 完全一致（`git diff` 为空）；C4 仅 package.json 版本行差异；C5 仅 FORK_CHANGES.md。

提交形态收敛记录：原栈中跨 ben.1/ben.2 的 rebase 过程提交（含 14 笔 v2.36 轮候选、版本真源与文档往返）全部折叠进上述五笔；无能力丢失，全部修改面（135 文件）在 C1-C3 中完整保留。计数口径：git rev-list --count v2.37.0..4108827bd = 32（31 笔 Fork 提交 + 1 笔旧末尾文档提交）。

新的 annotated `v2.37.0-ben.3` Tag、candidate 验证、双审、五成员 atomic promotion、最终 main CI 与 Release 流程沿用 `docs/fork-sync-automation.md` 完整 15 步流程执行。

<!-- v236-rebase-conflicts:start -->
official_old=v2.35.0
official_new=v2.36.0
overlap_path_count=25
overlap_paths=docs-site/src/content/docs/reference/configuration/providers.md,docs-site/src/content/docs/zh-cn/reference/configuration/providers.md,gui/src/i18n/de.ts,gui/src/i18n/en.ts,gui/src/i18n/fr.ts,gui/src/i18n/ja.ts,gui/src/i18n/ko.ts,gui/src/i18n/ru.ts,gui/src/i18n/tr.ts,gui/src/i18n/zh-TW.ts,gui/src/i18n/zh.ts,gui/src/pages/Logs.tsx,package.json,src/adapters/openai-responses.ts,src/config.ts,src/lib/upstream-retry.ts,src/providers/registry.ts,src/server/auth-cors.ts,src/server/chat-native.ts,src/server/management/provider-routes.ts,src/server/responses-undeclared-tool-guard.ts,src/server/responses/agent-task-recovery.ts,src/server/responses/core.ts,src/types/provider.ts,tests/openai-responses-passthrough.test.ts
content_conflict_count=5
content_conflicts=package.json,src/adapters/openai-responses.ts,src/config.ts,src/lib/upstream-retry.ts,src/server/responses/core.ts
decision_package_json=official=scripts/dependencies；fork=install:local与ben版本；resolution=保留官方脚本和依赖并保留Fork本地安装入口；tests=tests/release-version-line.test.ts,tests/fork-maintenance-truth.test.ts
decision_src_adapters_openai_responses_ts=official=prompt-cache空工具输出和Responses通用工具链；fork=精确GLM_Kimi兼容和原始字段保真；resolution=保留双方且Fork兼容置于官方通用规范化后的最终出站边界；tests=tests/fork-glm-kimi-compat.test.ts,tests/fork-zhipu-glm-schema-lowering.test.ts,tests/openai-responses-passthrough.test.ts
decision_src_config_ts=official=provider配置schema演进；fork=inferResponsesMessagePhaseModels；resolution=在官方schema上追加窄字段并贯通读取写入和DTO；tests=tests/fork-provider-message-phase-config.test.ts,tests/provider-model-discovery-contract.test.ts
decision_src_lib_upstream_retry_ts=official=共享transient_5xx总发送预算；fork=恢复与continuation共享预算；resolution=合并为单一预算且保留Fork恢复链的实际send计数；tests=tests/upstream-transient-retry.test.ts,tests/agent-task-recovery.test.ts
decision_src_server_responses_core_ts=official=Responses终端和重试生命周期；fork=nested_exec修复严格加密恢复turn_termination重绑和消息phase；resolution=官方生命周期保留Fork通过窄接线在同一资源生命周期内组合；tests=tests/fork-agent-task-recovery-kiro-turn-termination.test.ts,tests/nested-exec-repair.test.ts,tests/responses-message-phase-rewrite.test.ts
<!-- v236-rebase-conflicts:end -->

### v2.36.0-ben.2 审查修订

`v2.36.0-ben.1` 是不可变历史 Tag；本修订不移动、不删除或重建它。实现提交
`80d741d8422e030db72a5fe30eae52c8a7486cad` 推进包版本、锁入当前 v2.36 冲突台账，
并机械枚举全部 25 条 overlap 路径。当前审查确认 25 个 overlap 与 5 个内容冲突的合并结果仍保留官方
v2.36 行为和 Fork 所需差异；本节的机器块是后续同步时唯一可作为当前 v2.36 冲突结论
的账户。

Kimi 工具 schema catalog 的持久化行为已在代码审查中被标记为隐私/最小修改面问题；
用户明确要求本修订不改变该兼容路径，因此它作为用户接受的现有行为保留，不作为
v2.36.0-ben.2 的修复范围或新能力宣称。

`bun run prepush` 与 `workflow_dispatch` 的 `run_windows=true` Windows suite 是本修订
的后续验证门；在 Tag、promotion、final CI 和 Release 之前必须真实执行并记录结果。

<!-- v236-ben2-review:start -->
base_tag=v2.36.0
base_peeled=c7d8407d29bdd98b7ba743c85e654a41b3e4fca8
ben1_history=immutable
implementation_head=80d741d8422e030db72a5fe30eae52c8a7486cad
v236_conflict_ledger=completed
kimi_schema_persistence=user_accepted_out_of_scope
prepush=pending external gate
windows_dispatch=pending external gate
candidate_cross_platform_ci=pending external gate
atomic_promotion=pending external gate
final_main_cross_platform_ci=pending external gate
github_release=pending external gate
<!-- v236-ben2-review:end -->

### 历史 v2.35.0-ben.1 rebase 冲突账户（非本轮结论）

相对 immutable `v2.35.0-ben.1` 边界的历史 rebase 重叠为 16 paths：`package.json`
是唯一冲突，其余 15 条路径均自动合并。这个历史冲突账户不包含后续 ben.2 的 CI workflow
新增路径，也不代表 v2.36.0 的冲突结果。

<!-- ben2-overlap:start -->
Conflict (1):
- `package.json`

Auto-merge (15):
- `gui/src/i18n/de.ts`
- `gui/src/i18n/en.ts`
- `gui/src/i18n/fr.ts`
- `gui/src/i18n/ja.ts`
- `gui/src/i18n/ko.ts`
- `gui/src/i18n/ru.ts`
- `gui/src/i18n/tr.ts`
- `gui/src/i18n/zh-TW.ts`
- `gui/src/i18n/zh.ts`
- `src/adapters/base.ts`
- `src/adapters/openai-responses.ts`
- `src/server/responses/core.ts`
- `src/usage/log.ts`
- `tests/openai-responses-passthrough.test.ts`
- `tests/update-stop-first.test.ts`
<!-- ben2-overlap:end -->

<!-- ben2-s2r:start -->
首个 candidate：`d5558096bb229b5fbf5607a6468c2871b2b1213e` 已在精确 lease 下推送到
`origin/sync/v2.35.0`。绑定的 Cross-platform `workflow_dispatch` run `33234936660`
在 `Prepare verified Fork official base` 步骤失败：旧的 annotated-only policy 错把固定官方
`v2.35.0` lightweight ref 拒绝；其 type=`commit`，
raw=peeled=marker=`fc4de772b58c13f7b16b5029b1e981d612a5db06`。

第二个 candidate：`d252cb0e0ed67789c62d9aad5d2308aa5d04889b` 的
Cross-platform `workflow_dispatch` run `33236405510` 已证明 official-base preparation
在 Linux/macOS 全部通过；随后 `test 4/4` 与 macOS 在同一专用测试的四个 cleanup 用例失败。
这是 verifier-oracle 失败：测试错误假设 process-wide verifier-root namespace为空，生产 cleanup
没有失败；修复改为逐用例断言本次捕获的精确 verifier root 已删除。

第三个 candidate：`5548eb2a0d71d84bee03a4fa8424750bfdc78b85` 的
Cross-platform `workflow_dispatch` run `33236921544` 已按严格 18-job allowlist/cardinality
验证成功但不可复用于新的 descendant：它不能证明其后的官方 Tag 保留 contract、本文档或
新的 S2R candidate。

用户已纠正规则：Fork origin 对每个已 rebase 的官方版本保留同名官方 Tag；不再把 origin
缺少官方 Tag 当作安全条件。`v2.34.0` 必须保持官方 lightweight 身份，
raw=peeled=`80fff9a7f47332a4445df2b26ea175053fa55b0b`；`v2.35.0` 的固定官方 lightweight
身份为 raw=peeled=`fc4de772b58c13f7b16b5029b1e981d612a5db06`，在 atomic promotion 时补齐。
已存在 Tag 必须逐项 exact；任何 raw、peeled 或 type mismatch 都 fail closed，禁止 force、删除、
重建或移动。固定官方仓库仍是 provenance 来源，origin Tag 不是替代证据。

上述三个 run 分别保留为失败、失败和成功但 stale 的 predecessor evidence。当前
v2.35.0-ben.2 Tag：未发生；Atomic promotion：未发生；Final main Cross-platform CI：未发生；
GitHub Release：未发生。新的 S2R candidate 与其后的所有外部门禁仍 pending。
<!-- ben2-s2r:end -->

<!-- ben2-external-gates:start -->
| Gate | Tagged snapshot state |
| --- | --- |
| S2R candidate Cross-platform CI | `pending external gate` |
| Atomic promotion | `pending external gate` |
| Final main Cross-platform CI | `pending external gate` |
| GitHub Release | `pending external gate` |
<!-- ben2-external-gates:end -->

## v2.35.0-ben.3 全量历史压缩与发布边界

本修订只重组已提交的 Fork 历史，不改变 ben.2 已有运行时、兼容层、测试或 CI 内容。
不可变源 Tag `v2.35.0-ben.2` 的 peeled commit 为
`42282c405dc4c3dcb4f1e2877b89ac6ab49eeaba`，tree 为
`8499fcec058d61a42a4fa382118e4c7f92bbff58`，其相对官方 `v2.35.0` 的 39 个线性
Fork commits 被重建为恰好 5 个语义提交。

C1 汇总运行时、CLI、GUI 与文档站；C2 汇总 Fork 回归与兼容覆盖；C3 汇总 CI、发布与
审计基础设施。C3 的 112 个共享路径逐 blob 等于 ben.2 tree，另外仅增加本轮受跟踪的
`docs/superpowers/specs/2026-08-29-v2350-ben3-squash-design.md` 和
`docs/superpowers/plans/2026-08-29-v2350-ben3-squash.md` 两份设计文档，因此相对官方
共有 114 个路径。C4 只将包版本推进到 `2.35.0-ben.3`，并只更新维护真源测试中的版本
期望；本 C5 记录发布边界和可解析审计契约。

ben.2 Tag 和其历史保持不可变，不移动、不删除、不重建。新的 annotated
`v2.35.0-ben.3` Tag、candidate Cross-platform CI、五成员 atomic promotion、最终 main
Cross-platform CI 和 GitHub Release 都是后续外部流程，尚未发生；不得将本地重写或局部
测试误称为这些外部门禁已完成。

<!-- ben3-squash:start -->
source_tag=v2.35.0-ben.2
source_peeled=42282c405dc4c3dcb4f1e2877b89ac6ab49eeaba
source_tree=8499fcec058d61a42a4fa382118e4c7f92bbff58
source_commit_count=39
squashed_commit_count=5
c1=4d91209a587a7dbc970cd179a14ce7cf21ec1642
c2=7a35c99ec2529aac4fd011733b1617164248023b
c3=b67df10538bd77556c72d12c3ea6167175049a79
c3_shared_tree=8499fcec058d61a42a4fa382118e4c7f92bbff58
c3_shared_path_count=112
c3_new_document_paths=docs/superpowers/plans/2026-08-29-v2350-ben3-squash.md,docs/superpowers/specs/2026-08-29-v2350-ben3-squash-design.md
c3_total_delta_path_count=114
c4=fba9eadce2535cae6e76efee02695e9050262829
ben2_history=immutable
ben3_annotated_tag=pending external gate
candidate_cross_platform_ci=pending external gate
atomic_promotion=pending external gate
final_main_cross_platform_ci=pending external gate
github_release=pending external gate
<!-- ben3-squash:end -->

当前实现栈中与能力直接相关的提交：

- `d741f7bd6`：第三方 Responses 与 Provider 兼容层；
- `9703c79e4`：本地安装和维护门禁；
- `6ca2cbe81`：本地最小修改面规则；
- `c9446e0b5`：智谱 Codex 模型发现；
- `aea2ff119`：原生加密子任务恢复接力；
- `5789a619f`：`ben` Fork 修订版本策略；
- `49763c34c`：本地安装默认开启 macOS provider debug。
- `ffdb37774`：修复 install-local 平台用例并推进 `ben.2`。
- `727cb58ec`：智谱 GLM 复杂工具 schema lowering；`042af6dd9`：保留 provider 转换原始字段。
- `0124c2809`：v2.34.0-ben.7 fork 完整扩展栈（含第三方推理摘要生命周期/展示优化、
  双阶段诊断附件等全部能力，rebase 后的承载提交）；
- `65a66590f`：passthrough tee-lane 保持官方响应构造形状；
- `bf2daa5fc`：provider 诊断按日期/小时分目录并拆分 delta timeline 子日志。

`93ccabdaf` 是上一版维护文档提交，`06b2e67d1` 与各轮末尾文档提交均不属于运行时
能力。`ben.2` 修订新增 `ffdb37774`：install-local 平台用例的显式平台修复和版本推进。
`ben.3` 修订新增 `727cb58ec`（智谱 GLM 复杂工具 schema lowering）与 `042af6dd9`
（provider 转换原始字段保真）。`ben.4` 修订不含运行时能力变化：官方基线仍为
`v2.34.0`，实现栈压缩为单一 commit `b4e0f2a1f`（内容与原 14 个扩展提交逐字节
等价），并删除了 `tests/fork-version-policy.test.ts` 中硬编码当前包版本号的断言，
此后推进 ben 版本不再需要修改该测试文件。后续审计应记录被审计的实现 HEAD，而不是
让文档引用自己的 commit SHA。
`ben.4` 修订新增 `89f939ddb`：本地安装器在 npm pack 前临时注入
`bundleDependencies`（pack 后逐字节还原 package.json），全局替换改用
`--ignore-scripts`，安装期依赖从 tarball 内静态解出。
`ben.5` 修订为提交形态收敛：`ben.4` 之后的整个实现栈（含压缩提交、
版本推进、安装器依赖内置）再次压缩为单一 commit `791cce539`，内容与
`ben.4` 栈逐字节等价（仅 package.json 版本号推进为 ben.5），并同步更新
本文档基线。
`ben.6` 修订新增 `1bf175bf2`（严格匹配的 backend ciphertext 子任务在最终路由
确定后、派发给非官方转发 Provider 前也触发一次明文恢复，恢复失败保持
fail-closed）与 `ff0325abe`（debug 开启时按 allowlisted 事件结构把原生
Responses 入站摘要有界落盘到 `provider-debug.jsonl`），并推进包版本为
`2.34.0-ben.6`。
`ben.7` 修订将 `ben.6` 之后的三个提交（`20abbeefa` 修复 reasoning summary
分片生命周期；`96bbb0be5` 记录 Responses 双阶段诊断附件；
`68c943c19` 优化第三方推理摘要展示）压缩为单一 commit `7f8ced19d`
（树内容与原栈逐字节等价），并推进包版本为 `2.34.0-ben.7`。
`ben.8` / `ben.9`（v2.34.0 基线）为本地开发轮次：`5f51c177b`+`1c8c8feab`
推进并同步文档，`14fd7793d` 保持 passthrough tee-lane 官方响应构造形状，
`24af0874b` 将 provider 诊断按日期/小时分目录并拆分 delta timeline 子日志。
官方发布 `v2.35.0`（`fc4de772b`，219 文件 +18208/−498）后，整个 Fork 栈
rebase 到新基线并先收敛为包版本 `2.35.0-ben.1`。不可变 ben.1 边界的精确重叠
为 16 paths：仅 `package.json` 版本号冲突，另外 15 条路径（含 `core.ts`、
`openai-responses.ts`、`base.ts`、`usage/log.ts` 与 9 个 GUI i18n）自动合并。
ben.1 的远端 Cross-platform CI 失败后，本次 `ben.2` 保留官方 v2.35 的基线，同时
修复 recovery reparse 后的 turn termination scope，并用 origin-only 官方 ref/marker/main
验证替代宽松基线假设。首个 ben.2 candidate 的 prepare-step 失败已证明官方 `v2.35.0`
是 lightweight commit ref，而非 annotated Tag；修复后的本地 focused 测试和本地 CI
契约证据已提交。该已知失败与当时未发生的 Tag/promotion/final CI/Release 由本页 S1
快照保留；仅 replacement candidate 及后续外部门禁仍由机器表逐项保持 pending。


`ben.8` 修订为修改面收敛与历史压缩：将官方 v2.34.0 基线之后的全部历史提交压缩为单一 commit `b26cf4a20`（树内容与压缩前逐字节一致）。收敛内容：原仓库测试文件中的纯新增 fork 用例全部迁入新建 `tests/fork-*.test.ts`；还原 `server-auth` 三处 watchdog 预算、serial lane membership 及配套断言；还原 `core.ts` 与 `openai-responses.ts` 两处非必要注释 churn。收敛后原仓库测试修改从 20 个文件降至 8 个（剩余均为必要回归或宿主环境适配），共 +78/-28 行。


`ben.9` 修订新增两项修复与一项改进：`14fd7793d` 修复 passthrough tee-lane 响应构造形状（保留官方 invariants 测试断言）；`24af0874b` provider 诊断按日期/小时分目录并拆分 delta timeline 子日志。CI 修复验证中发现 ben.8 tag 指向与后续修复提交分离，按惯例推进 ben.9 使 tag 与发布点一致。
## 当前运行时差异

### 火山方舟 Agent Plan GLM/Kimi 与智谱 GLM Responses 兼容

- **状态：** Fork 独有——保留。
- **行为：** 仅对 `openai-responses` adapter 且非官方 OpenAI 目的地的第三方请求启用。
  智谱 GLM 在 base URL 精确为 `https://ark.cn-beijing.volces.com/api/plan/v3`（Ark）或
  `https://open.bigmodel.cn/api/v1`（BigModel）时启用；Kimi-K3 限 Ark endpoint。
  `ben.5` 起尾部 user turn 修复扩展到所有第三方 `openai-responses` 目的地
  （官方 OpenAI 目的地与 GPT 族硬排除）：目的地拒绝 assistant prefill 时追加尾部
  user turn，由 `isOpenAiOperatedResponsesDestination` 与
  `isOpenAiGptModelFamily`（容错非字符串 model id）双 gate 控制。Kimi-K3 的
  function schema 在深度/节点预算内降级 `$defs`、`$ref`、`oneOf`、`allOf` 和
  根级 `anyOf`；保留嵌套 `anyOf`、工具名称、描述、可见 properties 和 App 原始
  schema。智谱 Codex 仅在 `openai-responses`、base URL 精确为
  `https://open.bigmodel.cn/api/v1` 且模型为 `glm-5.3` 或 `glm-5.3-flash` 时复用
  同一 provider-facing schema compiler；GLM 不写 Kimi schema catalog，也不触发
  Kimi 专用 trace 或诊断字段。对 Volcengine Agent Plan 的历史 assistant message，会在
  trailing-user compatibility 之前移除空白、非字符串或全空 text content；保留 refusal、
  非文本 part 和其他有效字段，避免把空 assistant 重放给上游。
- **代码：** `src/fork/glm-kimi-compat.ts`（blob `64ce11986a7fc2391c7b8965256e55c16a2bfa72`）。
  最小接线位于 `src/adapters/openai-responses.ts` 和 `src/server/responses/core.ts`。
- **测试：** `tests/fork-glm-kimi-compat.test.ts`、
  `tests/fork-kimi-schema-compiler.test.ts`、
  `tests/fork-zhipu-glm-schema-lowering.test.ts`；
  `tests/fork-volcengine-empty-assistant-content.test.ts`（blob `95cfba92ac6e3ef6ee5fe27b62519f5a144b7862`）
  固定空 assistant 清理、字段保真与非目标输入不变。39 工具测试是与已观察数量一致的
  合成目录，不等同于真实 Codex App fixture；智谱测试另覆盖顶层工具和 Responses
  Lite `additional_tools`。
- **官方对比：** `v2.39.0:src/adapters/openai-responses.ts`（blob
  `0d918076171c14142a1bafdc6dde693a54a9d38f`，v2.39 已变更）仍通过
  `collectResponsesToolGroups`、`rewriteRoutedCustomToolsForUpstream` 等通用 Responses
  处理转发工具；其中没有 `applyGlmKimiOutboundCompatibility`、精确 Ark Plan endpoint
  gate 或 `$defs/$ref/oneOf/allOf` compiler。Fork 的
  `src/fork/glm-kimi-compat.ts`（blob `64ce11986a7fc2391c7b8965256e55c16a2bfa72`）
  保留精确 lowering/prefill 差异；`94ed4ca95612c2f640127fb61ac1330449258dd6`
  在同一窄模块加入 Volcengine 空 assistant 修复。当前证据是合成/静态回归，不替代真实
  Provider replay 与 Codex App terminal 验收。

### 原生 Responses message phase 推断

- **状态：** 官方部分覆盖——保留差异。
- **行为：** Provider 通过 `inferResponsesMessagePhaseModels` 显式选择；模型 ID
  含 GPT/OpenAI 或目标由 OpenAI 运营时硬排除。SSE 和非流式 JSON 使用一致语义；
  有界 barrier 区分后续还有工作时的 `commentary` 与最终 `final_answer`，并尊重
  上游已有 phase。
- **代码：** `src/fork/responses-message-phase.ts`，以及 config、management API、
  eager relay、SSE rewrite 和 Responses core 的窄接线。
- **测试：** `tests/responses-message-phase-config.test.ts`、
  `tests/responses-message-phase-passthrough.test.ts`、
  `tests/responses-message-phase-rewrite.test.ts`。
- **官方对比：** 官方 bridge 已对 adapter event 做 phase 推断，但原生 Responses
  passthrough 没有可配置的 phase inference；不能因名称相似删除 Fork 状态机。

### 第三方工具任务的用户可见进度契约

- **状态：** Fork 独有——保留。
- **行为：** 第三方模型的工具任务会收到同一份 provider-neutral 进度契约：首次工具调用前、
  重要里程碑后、长操作前、最多连续四个纯工具响应后，以及工作中收到新用户消息后，使用
  普通 assistant 文本向用户更新。写入契约前，会把已知 GPT 双 channel 总览、Intermediate
  commentary 段、compaction 更新措辞和 skill 通知措辞精确改写为普通 assistant 语义；
  最终第三方提示不再包含 `commentary`、`final_answer` 或 channel 等 Codex/GPT 专属术语，
  并尊重用户明确提出的静默或不同节奏要求。转换型 adapter 复用
  既有 non-OpenAI tool-catalog nudge；原生 Responses passthrough 只在非 OpenAI 运营目标、
  请求确实带工具且已有字符串 `instructions` 时幂等追加。routed compaction、缺失/非字符串
  instructions、ChatGPT forward 和公共 OpenAI Responses 都保持原始字节形状。任务完成时，
  契约要求模型用一条自包含的普通 assistant 响应清楚说明结果。
- **边界：** OCX 不合成 assistant 进度消息，也不把工具调用等同于真实仓库进展。已有
  message phase 推断只负责给模型实际生成的文本补 `commentary` / `final_answer`。provider
  debug 仅记录 instruction 字节数与契约存在布尔值，不落盘提示正文。
- **代码：** `src/fork/routed-progress-contract.ts`；最小接线位于
  `src/adapters/identity.ts`、`src/adapters/anthropic.ts`、
  `src/adapters/google.ts`、`src/adapters/openai-chat.ts`、
  `src/adapters/command-code.ts`、`src/adapters/kiro.ts`、
  `src/adapters/cursor/request-builder.ts`、`src/adapters/openai-responses.ts`、
  `src/codex/catalog/parsing.ts`、`src/codex/catalog/provider-fetch.ts`、
  `src/codex/catalog/aggregation.ts`、`src/codex/catalog/sync.ts` 和
  `src/fork/outbound-debug.ts`。
- **测试：** `tests/fork-routed-progress-contract.test.ts` 覆盖转换型 adapter、模板/无模板
  catalog、Responses wire 幂等、ChatGPT/public OpenAI 不变和脱敏 debug 证据。
- **官方对比：** 官方 `v2.35.0` 已有 non-OpenAI tool-catalog nudge 与 routed identity
  修复，但没有普通 assistant 进度契约、第三方 Responses wire 注入或对应 debug 证明。

### Nested code-mode 工具修复

- **状态：** 官方部分覆盖——保留差异。
- **行为：** 只有当前 turn 的结构化工具目录和 lowering 事实授权时，才把模型输出的
  顶层 `functions.exec` / `web__run` 转成唯一声明的 `exec` custom tool。
  Fragmented adapter event 和 passthrough SSE 原子缓冲；畸形、歧义、重复、超预算或
  冲突调用进入现有 undeclared-tool guard。Continuation cache 只在客户端收到有效
  terminal 后提交。
- **代码：** `src/responses/nested-exec-call-repair.ts`、
  `src/responses/nested-exec-adapter-events.ts`、
  `src/server/responses-nested-exec-call-repair.ts`、
  `src/chat/nested-exec-eligibility.ts`，以及 `src/server/responses/core.ts` 的窄接线。
- **测试：** `tests/nested-exec-eligibility.test.ts`、
  `tests/nested-exec-repair-context.test.ts`、`tests/nested-exec-repair.test.ts`。
- **官方对比：** 官方提交 `cb9bb9b7634640f18568207322d386a059f6c9ac` 已通过
  `src/responses/code-mode-helper-compat.ts` 和
  `src/server/responses-custom-tool-repair.ts` 把裸 `exec_command` / `apply_patch`
  接入统一 `exec`。Fork 只保留 `functions.exec` / `web__run`、更严格授权、原子事件
  barrier 和 cache terminal 协调。

### Ark quota 在 Codex Desktop 中的展示

- **状态：** Fork 独有——保留；本轮 weekly 兼容已修复。
- **行为：** 识别到永久 Ark usage quota 429 时，改为不可重试的 HTTP 400
  `invalid_request_error`，code 为 `volcengine_usage_quota_exhausted`；完整保留 Ark
  原文并删除 `Retry-After`，避免 Codex Desktop 的通用 retry-limit 或 ChatGPT
  订阅额度组件覆盖 Ark reset 时间。matcher 精确接受无窗口、数字 `N-hour` 与 `weekly`
  三类 usage quota/limit 文案，同时继续要求完整 reset 时间与 `+0800 CST`；`monthly`、
  `week`、`rolling-weekly`、malformed JSON、普通 overload 和 legacy
  `usage_limit_reached` 均不转换。
- **代码：** `src/fork/ark-quota-display.ts`（blob `a80fd68a576013788bce100179c5982e2adb63ba`），以及
  `src/server/responses/passthrough-error.ts` / `src/server/responses/core.ts` 的非 2xx
  边界。
- **测试：** `tests/fork-ark-weekly-quota.test.ts`（blob `52e4b0b0d49438ffa5c14a12cba1c4f5eb704d35`）
  覆盖三种正例、相邻词汇、reset/timezone、malformed body 与 Provider scope；既有
  `tests/fork-latest-compat.test.ts`、`tests/fork-ark-quota-error.test.ts` 保留相邻回归。
- **官方对比：** 官方有通用 passthrough error / Retry-After pipeline，但没有 Ark
  专用客户端展示；本轮基线已更新为 `v2.39.0`。真实 weekly downstream 展示尚未执行，
  focused test 不替代 live Provider/Codex App 证据。

### 自定义模型配置、工具模式与公开投影

- **状态：** Fork 独有——保留；本轮配置/API/CLI/隐私边界已闭环。
- **行为：** `customModels` load-time 逐行 salvage 且读不写盘；strict whole-config write
  拒绝 malformed row、invalid enum、stable-ID duplicate 与新增 routed/native identity
  collision。历史 distinct stable-ID collision 在 load/guarded unrelated save 中保留，
  歧义 routed selector fail closed，精确 stable-ID remove 仍可收缩 collision class。
  stable-ID 三方合并把缺失/`undefined` 当作合法空集合：baseline absent 时 live/disk 并发
  首次新增不同 ID 会同时保留；live 删除最后一行时，disk 并发新增的独立 ID 也不会被
  整数组覆盖。
  reasoning efforts 规范为 canonical ladder；invalid optional field 局部省略；unknown
  opaque keys 仅在内部配置保存/reload，所有管理 API、CLI、safe config/client export
  都通过 known-field projection 排除。
- **工具模式：** `/api/custom-models` POST omission 表示 inherit，PUT omission preserve、
  enum set、`null` clear；invalid/null-on-create 在任何 persist/converge 前返回 400。
  `/api/models` 与 CLI JSON/text 暴露 stored `codexToolMode`，不把 provider-effective 值
  冒充用户存储；offline/live CLI 支持 `--tool-mode code_mode_only|shell|inherit`。管理
  POST/PUT 对 provider、modelId、displayName、contextWindow、modalities、reasoning/default
  effort 与 tool mode 做 presence-aware 严格解析；malformed、空白、非整数或越界输入在
  mutation/persist/converge 前返回 400，只保留明确的 empty/null clear 语义。
- **代码：** `src/config/custom-models.ts`（blob `12a84dd14a674eda773a83a31f9923c740a0e213`）；
  `src/config.ts`（blob `78480720f3b54fa80390504b89230f62f697f513`）；
  `src/server/management/model-routes.ts`（blob `70cd881de52bcfe99cf56ce44509872445b92fd5`）。
  static roster 位于 `src/providers/known-model-ids.ts`，router、catalog 与 CLI 仅保留必要
  窄接线。
- **测试：** `tests/fork-custom-model-config-schema.test.ts`（blob `269586b983374d4bd88c678a074ec975a3152bd7`）；
  `tests/fork-custom-model-tool-mode-contract.test.ts`（blob `a69dc95ff93c61e4fa4be4be1ec701f87797dfb8`）。
- **官方对比：** 官方 `v2.39.0` 没有上述 Fork `customModels` schema、stored tool-mode
  round trip 与 opaque-field public projection；因此保留新增窄模块和最小接线。

### Routed custom tool output 字符串化

- **状态：** 官方部分覆盖——保留差异。
- **行为：** `custom_tool_call_output` 降级成 `function_call_output` 时，确保 output
  是字符串：字符串原样保留，text/refusal 按顺序换行拼接，其他结构回退为 JSON。
- **代码：** `src/fork/custom-tool-output.ts`、
  `src/responses/custom-tool-compat.ts`。
- **测试：** `tests/custom-tool-compat.test.ts`、`tests/fork-latest-compat.test.ts`。
- **官方对比：** 官方已改 item type，但可能把 Codex content-part 数组继续送入
  string-only function output wire contract。

### Provider diagnostics 与有界持久化

- **状态：** 官方部分覆盖——保留差异。
- **行为：** debug 开启时记录 Provider、模型、endpoint shape、工具/schema 数量、
  input 尾部 role、bytes 与兼容动作，不记录 request body、key 或工具参数。日志有界
  持久化到 `provider-debug.jsonl`；Kimi schema catalog 使用独立的文件、目录、数量、
  ownership 和权限预算。debug 同时开启时，原生 Responses 入站方向按白名单事件
  类型聚合脱敏摘要（event counts、文本字节、有界 timeline、安全 context 值、
  不透明 threadIdTag 与 httpStatus），经 terminal repair 的 raw tap 观测原始上游
  字节，一次性落盘到 `provider-debug.jsonl`；观测失败不影响 relay 本身。
- **双阶段诊断（`ben.7`）：** 分别记录 upstream-inbound（客户端改写前的原始
  上游流）与 downstream-after-rewrite（Codex 实际收到的流，OCX 可能补 phase）。
  经用户明确授权后，可捕获有界文本样本：每条字符串硬性 UTF-8 安全截断
  （默认 256B、上限 8KB），每轮至多 512 条，总量不超 live 诊断预算；样本存入
  引用型 provider-debug artifact 文件（redactSecretString 脱敏、目录/文件权限
  加固），`provider-debug.jsonl` 只携带结构摘要与相对引用。eager relay 通过
  `onClientChunk` hook 观测改写后真正下发到客户端的字节。
- **代码：** `src/fork/outbound-debug.ts`、`src/fork/debug-persistence.ts`、
  `src/fork/glm-kimi-compat.ts` 的诊断部分，以及 `src/fork/inbound-response-debug.ts`
  与 `src/server/responses-terminal-repair.ts` 的 raw tap 接线。
- **测试：** `tests/fork-debug-persistence.test.ts`、
  `tests/fork-kimi-schema-compiler.test.ts`、`tests/fork-inbound-response-debug.test.ts`。
- `ben.7` 增补 `tests/fork-relay-eager-client-observation.test.ts`。
- **官方对比：** 官方有 `debugProviderDiagnostic` 和内存 ring buffer，但没有 Fork 的
  durable log、outbound shape 摘要或入站结构化摘要落盘。

### 第三方 reasoning summary 与 GPT continuation 清理

- **状态：** 官方部分覆盖——保留差异。
- **行为：** DeepSeek terminal reasoning 在补 summary channel 的同时保留 opaque/
  encrypted state 与 raw content。同一历史随后转向原生 OpenAI GPT 时，删除由第三方
  raw `reasoning_text` 支撑的 opaque token，保留真正的 OpenAI blob。
  `ben.3` 补充字段保真边界：summary 转换只追加 `summary_text`，不再删除
  `reasoning.content`；message phase 改写保留 message 的全部原始字段，只新增 phase。
- **代码：** `src/server/responses-reasoning-summary-rewrite.ts` 和
  `src/adapters/openai-responses.ts` 中的 reasoning input sanitizer。
- `ben.7` 增强：content part 事件补 `reasoning_summary_part.added/done` 生命周期；
  有状态 block rewrite 等到第一句（或 100 codepoint 有界回退）才发出首条
  summary delta，投影为 TUI 可读的粗体标题 + 原始正文
  （`projectRawReasoningSummary`）。
- **测试：** `tests/deepseek-reasoning-replay.test.ts`、
  `tests/responses-reasoning-summary-passthrough.test.ts`、
  `tests/responses-reasoning-summary-rewrite.test.ts`、
  `tests/responses-original-field-preservation.test.ts`、
  `tests/responses-reasoning-summary-lifecycle.test.ts`、
  `tests/responses-reasoning-summary-display-projection.test.ts`。
- **官方对比：** 官方已有普通 reasoning text → summary 与若干 replay 清理；Fork
  差异仅是 opaque terminal 保留和跨 Provider raw-backed blob 删除。

### SSE block rewrite flush

- **状态：** Fork 独有——作为内部基础设施保留。
- **行为：** pull relay 正常 EOF，以及 eager relay 生成 synthetic failure tail 前，
  对实现了可选 `flush` 的 rewrite 继续经过后续 stage 输出 retained block。当前
  message phase barrier 实现 `flush`。普通 pull reader error 只 dispose；nested-exec
  barrier 当前只有 `dispose`，teardown 时 reject/release retained state，不承诺 flush。
- **代码：** `src/server/sse-payload-rewrite.ts`、`src/server/relay-eager.ts`。
- **测试：** `tests/sse-payload-rewrite.test.ts`、`tests/relay-eager.test.ts`。
- **官方对比：** 官方稳定 Tag 没有 block rewrite flush contract 或 compose propagation。

### Standalone web search 能力注入

- **状态：** Fork 独有——保留。
- **行为：** 生成的 Codex Provider table 写入
  `supports_standalone_web_search = true`；当
  `[features].standalone_web_search` 开启时，允许 Codex 客户端自己的
  `exec` / `web__run` 路径。
- **代码：** `src/codex/inject.ts`。
- **证据边界：** 当前实现的 `src/codex/inject.ts` blob 为
  `7cca45fa7f5e41328a5199a5adf5151406019220`，其中在
  `buildProviderTableBlock` 写入该 capability；该 Fork 差异承载于
  `0124c2809cb40c29603cff196e6d2182559bd48d`。尚缺绑定当前实现 SHA 的真实 Codex App
  验收，不能以孤立配置观察替代。
- **官方对比：** `v2.39.0:src/codex/inject.ts`（blob
  `72be57878470077e9b3c434726aea329e007d79c`）同一 `buildProviderTableBlock` 只接受
  `supportsWebsockets`/auth/hostname 参数，已核对不含
  `supports_standalone_web_search`；Fork injection path 是上述 `src/codex/inject.ts`，
  现有 `tests/codex-inject-integration.test.ts` 覆盖 provider-table 注入的相邻契约，
  但尚无此 capability 的专门测试。

### 智谱 BigModel Codex 模型发现

- **状态：** Fork 独有——保留。
- **行为：** 只在 Provider 为 `zhipu-bigmodel-codex`、adapter 为
  `openai-responses`、base URL 精确为 `https://open.bigmodel.cn/api/v1`（允许末尾
  `/`）时，把大陆官方 Codex `{ models: [{ slug }] }` 映射成内部 `id`。其他 Provider
  继续使用默认 `data[].id`。没有人为 64 条限制，仍受全局 2,000 条安全上限保护。
- **代码：** `src/providers/model-discovery.ts`、`src/providers/registry.ts`。
- **测试：** `tests/zhipu-bigmodel-codex-provider.test.ts`。定向/registry 测试、typecheck、
  完整套件与真实 discovery/Responses 回放均通过；提交为 `c9446e0b5`。
- **官方对比：** `v2.39.0:src/providers/model-discovery.ts`（blob
  `ada0bd2aecc196e003d0b1720c96d864e4793dbc`）只以默认 `data[]`/`id` envelope 取值，
  没有 `zhipu-bigmodel-codex`、`https://open.bigmodel.cn/api/v1` 或 `models[].slug` gate。
  Fork `src/providers/model-discovery.ts`（blob
  `85ea01d624b128d56400f4b699b95b32517de639`）以三元精确 gate 后采用
  `envelopeKey: "models"`、`modelIdKey: "slug"`；此差异由
  `c9446e0b5cddb90a0569d8e59913a91ae7eaa893` 引入，并由
  `tests/zhipu-bigmodel-codex-provider.test.ts`（blob
  `df3e37ba680fb11650aa86fdef14f5629f20629a`）覆盖 65 项目录与所有错配 control。

### 原生加密子任务恢复接力

- **状态：** 官方部分覆盖——保留差异；真实 ciphertext 验收仍有缺口。
- **行为：** 受同一个 `agentTaskRecovery.enabled` 开关控制。原生目标先按现有
  transient 5xx 策略直发；只有重试真实耗尽、且严格匹配 canonical backend-
  ciphertext `NEW_TASK` envelope 时，才恢复明文，并对同一已确定 Provider、模型、
  account、tier 和 options 重放一次。Slow 5xx、abort、直接成功、非 transient、非原生
  direct/combo 均不触发。严格匹配的 backend ciphertext 子任务即使不属于 routed
  unreadable 集合，也会在最终路由确定后、派发给非官方转发 Provider 前触发同一
  恢复路径；恢复失败时保持 fail-closed。恢复重放不再进入其他
  OAuth/429/account/opaque/combo 重试。
  `v2.39.0:src/server/responses/agent-task-recovery.ts`（blob
  `8b409e175bfb83345ac147ccbeb4b5bc4d462fcf`，相对 `v2.34.0` 新增官方 cache
  admission 重构）仍以
  `structurallyValidFernetTokens` 识别 Fernet envelope；官方没有扩展 strict backend
  ciphertext 识别。Fork 行为：strict non-Fernet envelope recognition、admission、routed trigger 与
  fail-closed forwarding 都由 `src/server/responses/encrypted-payload.ts`、
  `src/server/responses/agent-task-recovery.ts` 与 `src/server/responses/core.ts` 的 Fork
  wiring 承担；其 core 触发门控为（routed-unreadable ∪ strict-backend），对 canonical
  OpenAI 转发 Provider 保持 fail-closed 拒转。官方 `v2.35.0` 行为：turn termination
  在恢复后的 Kiro 终态仍由官方路径归属；Fork 只修复 reparse 后恢复该终止对象作用域的
  窄接线，不把官方终止语义归为 Fork 独有能力。
- **隐私边界：** 严格 envelope 只接受精确 header/author/recipient/task、两段 content
  与一个完整非 Fernet ciphertext。直接成功和恢复后的 body 都不得进入 continuation
  state，避免 ciphertext/plaintext 写入 `responses-state.json`。
- **代码：** `src/lib/upstream-retry.ts`、
  `src/server/responses/agent-task-recovery.ts`、
  `src/server/responses/encrypted-payload.ts`、`src/server/responses/core.ts`、
  `src/usage/log.ts`，以及 GUI/i18n/双语配置文档接线。
- **测试与审查：** 提交为 `aea2ff119`；`ben.6` 修订补充
  `tests/agent-task-recovery-routed-backend.test.ts`（提交 `1bf175bf2`）。
- **已知缺口：** 尚未使用当前真实 minted ChatGPT backend ciphertext 与 live recovery
  SSE 做隔离验收；当前自动化使用合成 ciphertext、mock fetch/SSE 与 fake JWT。

## 当前维护、安装与测试差异

### 本地源码包安装

- **状态：** Fork 独有——与运行时兼容层分开保留。
- **行为：** `bun run install:local` 构建 GUI，但 tracked root `package.json` 全程只读。
  完整 manifest bytes 在 `build:gui -> prepare:package` 前冻结，并从同一 snapshot 解析
  name/version；source build/patch、pack、offline validation、stop admission/verification、
  replacement admission、lifecycle completion 与 cleanup 都比较同一份字节快照。stop 前
  drift fail closed；服务已经确认停止但 replacement 尚未开始时，后置 guard failure 在
  `restart=true` 下先执行真实 `restart -> ready` 再返回原 manifest error，恢复失败保持
  `[manifestError, recoveryError]` 顺序，`restart=false` 则尊重用户选择不恢复。一旦
  replacement 已开始，restart/ready 同样无条件优先恢复服务，completion/cleanup 再报告
  source drift，避免诊断断言把旧/新服务留在停机状态。任何 prepared
  stage 后的 manifest mismatch、read error 或 lifecycle admission failure 都进入统一 cleanup
  ownership，primary/cleanup 双错误保持原始错误在前。
  owner-only 临时 stage 复制 package `files` 与经过 canonical containment 校验的完整
  runtime dependency closure，只在 staged manifest 写入排序后的 `bundleDependencies`。
  `npm pack --json --ignore-scripts` 产物必须是唯一 regular local tarball，并重新计算
  SHA-512 SRI、SHA-1 shasum 和 pack file rows；dot/escape/duplicate/sensitive 路径、
  非 allowlisted dependency、link/junction escape、cycle 与 special file 均 fail closed。
  disposable validation 使用 owned empty cache、`--offline --ignore-scripts --no-audit
  --no-fund --package-lock=false`，递归验证 main/bin/exports、runtime closure 和资源文件。
  若包声明 Bun，则对隔离解包出的当前平台精确 binary 先做 size gate，再执行
  `--version`（5 秒 timeout、exit 0、plausible semver），任何失败都发生在全局 replacement
  前。根级 required dependencies 与当前 source tree 中实际存在的 optional runtime
  dependencies 合并、去重、排序进入 `bundleDependencies`；present optional 必须在 archive
  和 offline installed tree 中可解析，missing optional 不制造占位或网络回退。最终 global
  install argv 复用同一 validated tarball/cache 与 offline/no-script 策略。
- **代码：** `scripts/install-local-vendor.ts`（blob `6eccd1c64fd823e9189d19f89169b4ffb8d15a93`）；
  `scripts/install-local.ts`（blob `e1f8f8d97db8cbeab97807c7733c5829cafb1276`）。
- **测试：** `tests/fork-install-local-staging.test.ts`（blob `2ab483349ae32e81b3dacc64a222dce3c18f69c5`）
  覆盖 staging、present/missing optional、offline closure、forged/empty/malformed pack JSON、
  integrity/shasum/file rows、tarball escape/symlink、installed identity/main/bin/exports/files、
  link/cycle/special-file containment、默认 large-junk Bun probe 与 cleanup/error ordering；
  `tests/fork-install-local-manifest-lifecycle.test.ts`（blob `aa9580f645df7bf27ed71062cb6eb2265d3c2274`）
  固定 pre-build snapshot、post-prepare read failure cleanup、lifecycle admission cleanup 及
  replace 成功/失败后 recovery-first 顺序；
  `tests/fork-install-local-guard-recovery.test.ts`（blob `05d24eb1b37ab7bf70c5a52d3adf261bba51c50e`）
  单独固定 stop verification guard failure 的 `stop -> verify -> restart -> ready` 顺序、
  replacement 零调用、recovery 双错误顺序与 stage cleanup exactly once；`tests/install-local-vendor.test.ts`、
  `tests/install-local.test.ts` 保留相邻生命周期回归。这些仍是 isolated/unit/static 证据；
  本轮未执行真实全局替换或 service stop/restart 恢复。
- **官方对比：** 官方 `v2.39.0` 与当前 upstream 开发分支没有同等本地源码安装器。

### GUI Logs/Debug 恢复标签与 sidecar 契约

- **状态：** 官方已有页面能力；Fork 只保留 recovery label 增量，sidecar 回归与官方对齐。
- **行为：** Logs/Debug tab、hash source of truth、lazy-mounted Debug 与 viewer 仍由官方
  `v2.39.0` 页面能力提供；Fork 在 Logs attempt detail 增加
  `agent-task-recovery`、`oauth-account-429`、`opaque-blob-rejection` 三种 recovery kind
  映射，并为全部 9 个 locale 提供对应翻译。`Debug.tsx` 本身与官方相同，不宣称为 Fork
  独有 runtime。sidecar 本轮只删除重复且与 vertical control-band 冲突的旧断言，生产
  CSS 未修改。
- **代码：** `gui/src/pages/Logs.tsx`（blob `c8f79494aff1df856466adc0d7718b6338e5473d`）；
  `gui/src/pages/Debug.tsx`（blob `05207fbb9097dc665c94fdef24d665782ac2f9ce`，与官方 v2.39.0 相同）。
- **9 locale：** `gui/src/i18n/de.ts`（blob `60502ed061b10ba6cc2b5303e3b01fbbf4b8a00b`）；
  `gui/src/i18n/en.ts`（blob `9f4ed1948c4f3862a458623f68bae9ef38eeaf65`）；
  `gui/src/i18n/fr.ts`（blob `77849e5fe9ca6ac2cc1b46806c9b07ca8c4b6b29`）；
  `gui/src/i18n/ja.ts`（blob `aa80841cca96080a93f68e545c52e724171663d3`）；
  `gui/src/i18n/ko.ts`（blob `49562e8a7b9c87070fdabd7c0bcb0be7dc1bcd26`）；
  `gui/src/i18n/ru.ts`（blob `cafcd2687f40b36c48bf660aff8234d0b06ad64b`）；
  `gui/src/i18n/tr.ts`（blob `1b3e23979f32f1fc7e2712c721214ee6025bd2da`）；
  `gui/src/i18n/zh-TW.ts`（blob `b463b9e38c524808b799cbabd9ab6a0581dd4477`）；
  `gui/src/i18n/zh.ts`（blob `4cbffe4401797b2e2ad21663efbc7da81e8dabed`）。
- **sidecar：** `gui/tests/sidecar-layout.test.ts`（blob `e140a627260bbf952708e7f710874a5f76cc5b2b`，与官方 v2.39.0 相同）；
  `gui/src/styles-dashboard-workspace.css` blob `2b854f57c1b66a9ad4cc0e53fef421f7cf14fc5f`
  也与官方相同。提交 `1476108b3` 是测试契约修正，不是新 CSS 能力。

### install-local 默认开启 macOS provider debug

- **状态：** Fork 独有——仅限本地安装脚本。
- **行为：** 本地包替换成功后，已有 macOS launchd 服务先 repair，再使用 `plutil`
  结构化写入 `EnvironmentVariables.OCX_DEBUG=1`，lint 后 unload/load。`--no-restart`
  只更新磁盘 plist；无服务的 Darwin 前台 `ocx start` 子进程继承 `OCX_DEBUG=1`；
  非 Darwin 保持原环境并跳过 launchd。
- **安全边界：** 同目录 UUID + `wx` 独占临时文件、0600、临时文件 patch/lint 成功后
  才 atomic rename。整数、布尔或空白字符串都会规范化，只有 string 且严格为 `1`
  才跳过。Patch、校验或 rename 失败时保留原 plist 并清理临时文件。Launchctl 使用
  现有失败判定，同时检查 exit 0 但 stderr 为 `Load failed` 的情况。
- **代码与测试：** 只修改 `scripts/install-local.ts`，新增
  `tests/install-local.test.ts`；专项 14 pass，连同既有安装测试共 31 pass；提交为
  `49763c34c`。
- **跨平台修正：** `ffdb37774` 把 restart 环境用例改为显式 `darwin`，与实现的显式
  platform 分支语义一致；Linux CI 对应失败已闭环，实现行为未改。
- **已知边界：** 独立执行 `ocx service repair/install` 或其他更新路径仍可能由未修改的
  `src/service.ts` 重写掉 `OCX_DEBUG=1`；本能力只保证 `install-local` 流程补回并 reload。

### `ben` Fork 修订版本策略

- **状态：** Fork 独有——保留。
- **包版本：** 官方稳定版 `X.Y.Z` 对应 Fork 包版本 `X.Y.Z-ben.N`。当前为
  `2.39.0-ben.1`（`v2.38.0-ben.*` 及更早 Tag 保留为历史不可变修订）。`N` 从 1 开始且必须是安全整数；
  `ben.0`、前导零、超安全整数或其他 suffix 不属于该策略。
- **更新语义：** 官方同基线稳定版与当前 Fork 等价，不允许显式 `ocx update` 用同基线
  官方包覆盖 Fork；registry target 无法解析时，`ben` build 在任何 cache/stop/install
  副作用前 fail closed。更高官方稳定版仍判定为更新。普通 stable/preview 行为不变。
- **Tag 语义：** Git Tag 使用 `vX.Y.Z-ben.N`。必须存在对应官方 `vX.Y.Z` Tag；Fork
  对每个已 rebase 官方基线在 origin 保留同名、与固定官方仓库 type/raw/peeled 完全一致的
  official Tag。缺失只能在 atomic promotion 中以已验证 raw ref 补齐；已存在的任一字段
  不一致即 fail closed，禁止 force、删除、重建或移动。严格 numbered `ben.N` 按精确官方
  基线独立维护：更新官方 stable 不自动禁止用户明确授权的旧基线维护 revision，但必须
  存在 exact base、不得低于完整本地/远端同基线最高有效 revision，已有同名 Fork Tag
  只有指向当前 commit 时才合法。普通 stable/preview 继续遵守完整 Tag 集全局单调门禁。
  畸形 Tag 不参与 revision 比较。
- **发布竞态边界：** 创建本地 Tag 前、atomic push 紧邻前、确定/不确定 push 后及
  GitHub Release 前，都按 phase-aware 规则枚举完整同基线 name/raw/peeled namespace；
  late higher revision、对象身份或集合非预期漂移均阻塞。Git 无法 lease 尚不存在的不同
  Tag 名称，最终复核到 push 仍是显式 TOCTOU 残余风险，依赖 single publisher；若 push
  后发现更高 revision，保留不可变 lower Tag、停止 Release 并报告。
- **代码：** `src/fork/version-policy.mjs`（blob `1c9351fea6dd28f5d70fb945c37e5ac46536a7b6`）、
  `src/fork/version-policy.d.mts`；
  `src/update/notify.ts`、`src/update/index.ts` 和 `bin/ocx.mjs` 只保留窄接线。
- **测试：** `tests/fork-version-policy.test.ts`（blob `40c1092241345b88c3c26756bca1d3d59586f501`）；
  `tests/release-version-line.test.ts` 只增加经用户批准的最小门禁调用。Node/Bun 策略、
  package-shaped npm launcher、same-base late `ben.3` 与 immutable current Tag 均覆盖；
  本轮实现提交为 `3337a56f7`。该测试不硬编码当前包版本号，版本推进只改
  `package.json`。
- **官方对比：** 官方 `v2.39.0` 没有该 Fork ben 版本与 Tag 策略。
- **前端边界：** 按用户要求不修改 `gui/src/App.tsx` 或 CSS。GUI 继续通过现有链路显示
  真实版本，视觉缩短仅来自实际包版本从 `2.34.1-trendymen.1` 改为 `ben` 系列。

### 默认测试 runner 与负载敏感隔离

- **状态：** 官方部分覆盖——只保留剩余差异。
- **Fork 剩余行为：** launcher/update 测试规避环境 runtime shim 与不支持的 PATH interception。`tests/server-auth.test.ts` 的 serial lane membership 与 watchdog 预算已按用户要求还原为官方行为。
- **最终门禁修复：** 首次完整 prepush 暴露 `tests/cli-status-json.test.ts` 把 dead owner
  PID 硬编码为 `4242`，而当前主机该 PID 正由 `playwright-mcp` 使用，导致两个 stale-process
  E2E 正确返回 false。`3ea61a1b0` 改为在 fixture 建立时验证一个不可存活的高 PID 后再
  写入记录，不改变 production status/doctor 行为；当前测试 blob 为
  `e376768d7af62c07a036a0eb557c23d4dc48b890`。
- **Responses 周期清理边界：** 高负载复跑曾为单个 fixture 把完整
  `ResponseStateTempRecoveryOptions` 暴露到 production sweeper；最终修复已撤回该扩张。
  `sweepAbandonedResponseStateTemps()` 继续保持严格无参并固定 `maxEntries`、`maxCleanups`、
  `deadlineMs`，测试通过预先探测的极大 dead PID 消除共享 runner PID 复用噪声，同时用
  hostile runtime argument 证明调用者不能覆盖周期预算。当前
  `src/responses/state.ts`（blob `35540a0ee7210d6cd1c6a2fd377a8a1837501e4e`）、
  `tests/responses-state.test.ts`（blob `5836f31c6883c98b2acc6361788c7599e5ceaa96`）。
- **代码：** `tests/shutdown-launcher.test.ts`、`tests/update-stop-first.test.ts`、
  `tests/cli-status-json.test.ts`。
- **官方对比：** `v2.39.0:tests/update-stop-first.test.ts`（blob
  `d20eafb5c7051744168d7ce649186c49da789d8e`，merge
  `fe063d16ef620a148ab425cfffe63a8936d00e52`）已包含 recovery PID cleanup、
  `UPDATE_SPAWN_TIMEOUT_MS`/`PROXY_READY_TIMEOUT_MS` 派生预算，以及 cleanup 后才
  `rmSync` 的防 orphan 顺序。该官方文件不含 `nodeExecutable`；该 token 只出现在当前
  Fork `tests/shutdown-launcher.test.ts`，其 current blob
  `d34dd18b9f8c16d66f269bb0352d787f24f00856` 明确以 `process.execPath` 绕开
  version-manager shim。Fork 在 `tests/update-stop-first.test.ts` 保留的唯一 host guard
  是 PATH-precedence：Fork PATH-precedence guard（`a1e35b13db14a1686ef0033685d7214184c37743`）
  先实测 Bun 是否保留 fake npm 的 supplied PATH，只有可表示 fixture 时才运行该恢复用例；
  该 guard 来自 Fork 承载提交 `0124c2809cb40c29603cff196e6d2182559bd48d`，不改变官方
  runner、cleanup 或 timeout 语义。

### 本地最小修改面规则

- **状态：** Fork 独有——保留。
- **文件：** `AGENTS.local.md`。
- **规则：** 新能力默认使用新的职责明确测试文件；修改既有测试需要用户明确批准。
  所有实现必须优先新增窄模块或使用扩展点，避免扩散到官方高频文件；审查必须单独检查
  相对官方的修改面。本文件不进入 npm package。

### Prepush 与 GitHub CI

- **状态：** 官方部分覆盖——保留 Fork 基线门禁。
- **证据：** `prepush` package script 与 `v2.39.0` 一致；Fork 只新增
  `.github/workflows/ci.yml` 的 origin-only 官方基线验证，精确验证 official ref 的
  lightweight/annotated 类型、raw/peeled commit、official main ancestry 与
  `origin/upstream-release` marker。官方 `v2.39.0` 的实测 ref type 为 `commit`，其
  raw/peeled/marker 均为 `af6113a0381d6fff2e4dce587652825c7eeb6423`；因此不得再把
  annotated-only 写成 provenance 要求。这不是对官方 CI 的替代，也不把 workflow 扩展为
  生产运行时能力。runner-local official ref proof 每轮重新验证；Fork origin 必须保留每个
  已 rebase 基线的同名 exact official Tag，但固定官方 URL 而非 origin 始终是 provenance
  来源。缺失 Tag 只能在 atomic promotion 补齐，existing mismatch 必须 fail closed。

## 已替换、已移除或已证伪方向

保留下表是为了避免未来冲突处理复活错误实现。

| 旧方向 | 状态 | 当前决策 |
| --- | --- | --- |
| 动态 `scripts/fork-test-runner.ts`、local-only worker group 和 quarantine list | 官方覆盖/已移除 | 官方稳定 runner 已负责有界隔离和 serial lane；`server-auth` membership 差异已还原。 |
| 按工具名过滤 Kimi 工具与 automation-specific schema lowering | Fork 内部替换/移除 | 已被精确 gate 的通用 function schema compiler 替代；不得恢复 allowlist 或过滤 39 工具目录。 |
| `src/server/responses-message-phase-rewrite.ts` | Fork 内部替换/移除 | 实现已迁移到 `src/fork/responses-message-phase.ts`，旧路径不是活跃能力。 |
| Kimi 自动触发 `normalizeResponsesToolResultAdjacency` | 已证伪/移除 | 并行 `call A, call B, output A, output B` 合法；Kimi 不得启用该 normalization。 |
| `usage_limit_reached` + promo header quota 展示 | 已证伪/移除 | 会触发全局 ChatGPT quota UI 并覆盖 Ark reset；保留 Provider 专用 client error。 |
| Fork MiniMax fixed-port 测试 workaround | 不必要/已移除 | 最终维护提交不含该补丁；没有同基线 fork 失败证据时不得重加。 |

## 当前已知缺口与验证边界

1. **Standalone web search：** 缺少绑定当前实现 SHA 的专门断言和不可变真实验收证据。
2. **原生加密恢复：** 缺少真实 minted backend ciphertext + live recovery SSE 验收。
3. **Provider debug：** 独立 `ocx service repair/install` 仍可能覆盖 install-local 写入的
   `OCX_DEBUG=1`。
4. **安装器：** owner-only staging、offline archive validation 与 Bun probe 的
   unit/static 通过不替代真实全局 package replacement 与服务模式恢复；Windows junction
   containment 仍需平台实跑。
5. **Windows：** package-shaped npm launcher 的 unresolved target 子进程测试在 Windows
   跳过，依赖 CI 覆盖。
6. **外部 Provider：** weekly quota、empty-assistant 与 custom model focused test 和 HTTP
   success 都不能替代真实 Provider/Codex App terminal 分层记录；
   相关能力变化后必须记录 Provider/模型、客户端终态与脱敏 outbound shape。
7. **同基线发布竞态：** 完整远端 ben namespace 的最终复核到 atomic push 之间无法对
   尚不存在的 differently named future Tag 建立 wildcard lease；依赖 single publisher，
   push 后必须在 GitHub Release 前复核，发现竞态时保留 immutable Tag 并停止 Release。
8. **上游版本边界：** 当前候选已 rebase 到官方 `v2.39.0`；本轮仅完成 rebase 与验证，
   未授权 Tag、push 或 Release，不宣称已发布 v2.39 Fork 修订。
9. **并行工作区：** 本清单只按 committed SHA 计算，绝不因工作区中恰好存在其他任务
   文件而把它们混入提交或能力清单。

## Fork 版本、Tag 与 GitHub Release 规则

1. 官方稳定 `vX.Y.Z` 第一次完成派生 rebase 时，包版本设为 `X.Y.Z-ben.1`，创建带
   `v` 的 Git Tag `vX.Y.Z-ben.1`。
2. 同一同步任务重复执行必须幂等；不得因 heartbeat 重跑自动生成 `ben.2`。
3. `ben.2`、`ben.3` 等只在用户明确要求同一官方基线再做一次 Fork 修订时创建；每次
   revision 都必须更新包版本、本文档、Tag 与 Release。
4. 发布瞬间，`main`、`dev`、`sync/vX.Y.Z` 和最新 `vX.Y.Z-ben.N` 的 peeled commit
   必须完全等于 `RELEASE_COMMIT`；`upstream-release` 始终等于未经修改的
   `OFFICIAL_COMMIT`。发布后若 `dev` 已有新开发提交，自动化不得把它重置回旧 Release。
5. 每个已经 rebase 的官方 `vX.Y.Z` Tag 都必须在 `Trendymen/opencodex` 保留同名 Tag，
   并与固定官方仓库的 type、raw OID 和 peeled commit 逐项完全一致。promotion 前只允许
   缺失或 exact，promotion 后必须 exact；不一致时 fail closed，禁止 force、删除、重建或移动。
6. Fork Tag 不可改写。远端 Tag 不存在时才创建；已存在时必须验证 Tag object/peeled
   commit 与本地一致，否则 fail closed，禁止 force tag。
7. 每个 Fork Tag 都必须在 `Trendymen/opencodex` 创建同名 GitHub Release。`ben.N`
   在本 Fork 中表示正式修订，不是 beta；Release 必须公开，即 `isDraft=false`、
   `isPrerelease=false`。
8. Release 标题必须与 Tag 完全一致；Release Notes 使用简体中文，至少包括官方基线、
   Fork 修改点、验证结果、已知缺口与 commit。已有 Release 也必须核对 `tagName`、`name`、
   `body`、`isDraft` 和 `isPrerelease`；元数据不合格时只幂等修正 Release，不移动 Tag、
   不递增 revision。GitHub 自动生成的 source archive 即可；默认不上传 npm 包或额外
   二进制资产。
9. 不发布 npm。官方仓库的 `scripts/release.ts` / release workflow 不是 Fork Tag 的
   执行入口。
10. Tag 已推送但 GitHub Release 尚未创建或元数据不合格时，任务仍视为未完成。后续重试
   只补建/修正/核对 Release，不递增 `ben.N`，也不移动已存在 Tag。

## 没有新官方版本时的幂等收敛

Heartbeat 在输出“无需同步”前，必须从已提交的 `FORK_CHANGES.md` 与 `package.json`
推导当前预期 Fork 版本和 Tag，并核对末尾文档提交、本地/远端引用、annotated Tag 与
GitHub Release。官方 `upstream-release` 已经是最新版本，并不代表本次 Fork 派生流程
已经完成。

1. 若实现、最终验证或末尾文档提交尚未完成，则保留当前 `ben.N`，只恢复剩余收尾步骤；
   不重新 rebase，也不递增 revision。工作树不干净、提交来源不明或证据不足时 fail
   closed，明确登记未完成状态。
2. 若 `RELEASE_COMMIT` 已经完成但 Fork Tag 缺失，则先验证 package/document 版本一致、
   其父提交是记录的 `IMPLEMENTATION_HEAD`、提交只含本文档，并核对本地/远端 `main`、
   `dev`、sync 和 `upstream-release` 的 expected SHA；随后创建当前版本的 annotated Tag，
   并使用同一套六成员 atomic push 与显式 branch lease 收敛引用。Tag refspec 不使用 force
   或 lease。不得启动新 rebase 或生成 `ben.(N+1)`。

在任何幂等收敛 push 前，必须完成 fixed-upstream type/raw/peeled/ancestry 验证；origin
official Tag absent-or-exact preflight 必须确认当前 `refs/tags/vX.Y.Z` 不是缺失就是与固定
官方 raw/peeled/type 完全一致，existing mismatch 阻塞。pre absent/exact，post exact：若预检
缺失，必须只把已验证的官方 raw ref 纳入本次原子 push 后补齐；若预检 exact，不得重建。

`git push --atomic origin` 必须使用下列唯一完整 refset：

<!-- official-atomic-refset:start -->
branch|main|leased-force|RELEASE_COMMIT:refs/heads/main
branch|dev|leased-force|RELEASE_COMMIT:refs/heads/dev
branch|sync|leased-fast-forward|RELEASE_COMMIT:refs/heads/sync/vX.Y.Z
branch|marker|leased-force|OFFICIAL_COMMIT:refs/heads/upstream-release
tag|official|no-force-no-lease|refs/tags/vX.Y.Z:refs/tags/vX.Y.Z
tag|fork|no-force-no-lease|refs/tags/vX.Y.Z-ben.N:refs/tags/vX.Y.Z-ben.N
<!-- official-atomic-refset:end -->

<!-- fork-release-lifecycle:start -->
rebase_branch=dev
sync_role=audit-release-ref
release_instant_dev=must-equal-RELEASE_COMMIT
post_release_advanced_dev=must-not-reset
sync_ancestry=EXPECTED_REMOTE_SYNC-absent-or-ancestor-of-RELEASE_COMMIT
final_convergence=local-remote-main-dev-sync-fork-tag-equal-RELEASE_COMMIT
<!-- fork-release-lifecycle:end -->

<!-- same-base-ben-preflight:start -->
scope=strict-local-and-remote-vX.Y.Z-ben.N
snapshot=name-raw-peeled
pre_local_tag=freeze-local-baseline-and-remote-baseline
pre_push=local-baseline-plus-exact-target-and-remote-baseline
post_push=remote-baseline-or-remote-baseline-plus-exact-target
higher_revision=fail-closed-at-every-checkpoint
other_drift=fail-closed
post_success=required-before-github-release
serialization=single-publisher-required
toctou=final-recheck-to-push-window-is-residual-risk
<!-- same-base-ben-preflight:end -->

同基线 maintenance revision 还必须执行完整 local/origin `vX.Y.Z-ben.N` name/raw/peeled
phase-aware preflight；pre-push 只允许本地精确目标 Tag 增量，post-push 只允许远端同一
精确对象增量。每阶段重算最高 revision，其他漂移 fail closed；确定成功也必须在 GitHub
Release 前复核。final recheck 到 push 的 future-name namespace 竞态作为残余风险保留。

四个 branch 使用各自 exact lease；`main`、`dev` 与 marker 按发布策略允许 force，
`sync/vX.Y.Z` 只允许普通 fast-forward；两个 Tag 均不使用 force 或 lease。确定失败时停止；
uncertain 只允许以相同完整 refset 重试，且必须重新读取 branch lease 与两个 Tag 的
raw/peeled/type。

远端 sync 存在时，atomic push 紧邻前必须通过
`git merge-base --is-ancestor "$EXPECTED_REMOTE_SYNC" "$RELEASE_COMMIT"` 并重新读取远端
sync 仍等于 expected OID。sync refspec 不带 `+`；exact lease 只拒绝并发漂移，ancestry
guard 才禁止 audit ref 非 fast-forward 重写。`main`、`dev`、marker 使用各自 ref-scoped
force lease，禁止对四个 branch 使用 blanket force/lease 代替逐 ref 策略。

3. 若 Tag 已存在但 Release 缺失或元数据不合格，则只创建或修正同名 Release；必须确认
   `isDraft=false`、`isPrerelease=false`、标题等于 Tag，且中文 Notes 含官方基线、Fork
   修改点、验证结果、已知缺口与 commit。
4. 只有上述状态全部满足，且没有更新的官方稳定 Release，才允许记录“无需同步”。

## 每次稳定版 rebase 的强制流程

1. 查询 GitHub Releases，只接受非 draft、非 prerelease 的官方稳定 Release；确认 Tag
   commit 可从 upstream `main` 到达。
2. 要求工作树、索引干净且没有进行中的 Git 操作。记录本地/远端 `main`、`dev`、
   `upstream-release`、`sync/vX.Y.Z` 和目标 Fork Tag 的现有 SHA。
3. 保护已有候选历史：远端 dev 与 sync 存在时必须 fetch 并记录 lease；候选固定为来源明确、
   已提交且干净的 `dev`。远端独有、分叉来源不明或 lease 无法固定时停止。
4. 在 `dev` 上执行等价于
   `git rebase --onto <new-tag-sha> <old-upstream-release-sha> dev`；rebase 阶段不得移动
   `main`，不得在 detached HEAD 上验证，也不得在 `sync/vX.Y.Z` 上 rebase。完成最终验证
   和末尾文档提交后，本地 sync 才可准备为同一 `RELEASE_COMMIT`。
5. 逐项对照本文档与新官方源码/测试：完整覆盖则删除本地补丁并保留历史记录；部分覆盖
   只移除被替代部分；未覆盖则保留能力与 focused test。语义不明或需要放弃能力时请求
   用户决策。
6. 决定 Fork revision：新官方基线默认 `ben.1`；同基线已有 Release 时，只有用户明确
   要求新修订才递增。同步设置 `package.json` 并运行 Fork version/tag gate。
7. 完成并提交全部 rebase、冲突与实现修复。实现仍变化时可先跑定向测试，但不替代最终
   完整验证。
8. 捕获 `IMPLEMENTATION_HEAD`，按该 SHA 更新本文档中的官方版本、实现 commit、shortstat、
   能力状态、覆盖证据、已移除实现、已知缺口、Fork 版本与目标 Tag。文档必须为中文。
9. 在本文档已更新的状态下执行最终验证：相关定向测试、typecheck、privacy scan；共享
   runtime、adapter、server、script 或 runner 改动必须运行一次 `bun run prepush`。
   若验证促成实现修改，提交后回到第 8 步并重新生成文档、重跑完整门禁。
10. 只暂存 `FORK_CHANGES.md`，核对 staged name list 与 staged diff check，再创建
    `RELEASE_COMMIT`。使用第 8 步提前捕获的 `IMPLEMENTATION_HEAD`，机械确认
    `RELEASE_COMMIT^` 与它完全一致，且提交只含本文档；运行
    `git diff --check HEAD^ HEAD`。任何后续实现改动都必须重做第 7–10 步。
11. 创建或核对 annotated Fork Tag `vX.Y.Z-ben.N`，使其 peeled commit 指向
    `RELEASE_COMMIT`。必须用 `git cat-file -t` 证明本地 ref 指向 Tag object，而不是 lightweight
    Tag；远端已存在时同时核对 raw Tag object OID 与 peeled commit。用一次 atomic push
    同步四个 branch、已验证的 official Tag 与完整本地 Fork Tag ref；`main`、`dev`、marker
    使用各自 ref-scoped force lease，sync 必须先通过 ancestry guard、使用普通 refspec 和
    exact lease 拒绝并发漂移。任一 branch lease 漂移、远端 Tag 已存在但不一致、
    atomic 不支持或推送失败都 fail closed，不拆成可能部分成功的多次 push。

在 stable rebase 发布前，必须完成 fixed-upstream type/raw/peeled/ancestry 验证；origin
official Tag absent-or-exact preflight 必须读取 `refs/tags/vX.Y.Z` 的 type、raw OID 与
peeled commit，existing mismatch 阻塞。pre absent/exact，post exact：缺失时仅可将固定官方
验证后的 raw ref 放入本次 atomic refset，已存在且 exact 时保持不变。

`git push --atomic origin` 必须使用下列唯一完整 refset：

<!-- official-atomic-refset:start -->
branch|main|leased-force|RELEASE_COMMIT:refs/heads/main
branch|dev|leased-force|RELEASE_COMMIT:refs/heads/dev
branch|sync|leased-fast-forward|RELEASE_COMMIT:refs/heads/sync/vX.Y.Z
branch|marker|leased-force|OFFICIAL_COMMIT:refs/heads/upstream-release
tag|official|no-force-no-lease|refs/tags/vX.Y.Z:refs/tags/vX.Y.Z
tag|fork|no-force-no-lease|refs/tags/vX.Y.Z-ben.N:refs/tags/vX.Y.Z-ben.N
<!-- official-atomic-refset:end -->

<!-- fork-release-lifecycle:start -->
rebase_branch=dev
sync_role=audit-release-ref
release_instant_dev=must-equal-RELEASE_COMMIT
post_release_advanced_dev=must-not-reset
sync_ancestry=EXPECTED_REMOTE_SYNC-absent-or-ancestor-of-RELEASE_COMMIT
final_convergence=local-remote-main-dev-sync-fork-tag-equal-RELEASE_COMMIT
<!-- fork-release-lifecycle:end -->

<!-- same-base-ben-preflight:start -->
scope=strict-local-and-remote-vX.Y.Z-ben.N
snapshot=name-raw-peeled
pre_local_tag=freeze-local-baseline-and-remote-baseline
pre_push=local-baseline-plus-exact-target-and-remote-baseline
post_push=remote-baseline-or-remote-baseline-plus-exact-target
higher_revision=fail-closed-at-every-checkpoint
other_drift=fail-closed
post_success=required-before-github-release
serialization=single-publisher-required
toctou=final-recheck-to-push-window-is-residual-risk
<!-- same-base-ben-preflight:end -->

同基线 maintenance revision 还必须执行完整 local/origin `vX.Y.Z-ben.N` name/raw/peeled
phase-aware preflight；pre-push 只允许本地精确目标 Tag 增量，post-push 只允许远端同一
精确对象增量。每阶段重算最高 revision，其他漂移 fail closed；确定成功也必须在 GitHub
Release 前复核。final recheck 到 push 的 future-name namespace 竞态作为残余风险保留。

四个 branch 使用各自 exact lease；`main`、`dev` 与 marker 按发布策略允许 force，
`sync/vX.Y.Z` 只允许普通 fast-forward；两个 Tag 均不使用 force 或 lease。确定失败即停止；
uncertain 只允许以相同完整 refset 重试，并且先重新证明所有 branch leases 和两个 Tag 的
type/raw/peeled。

远端 sync 存在时，atomic push 紧邻前必须通过
`git merge-base --is-ancestor "$EXPECTED_REMOTE_SYNC" "$RELEASE_COMMIT"` 并重新读取远端
sync 仍等于 expected OID。sync refspec 不带 `+`；exact lease 只拒绝并发漂移，ancestry
guard 才禁止 audit ref 非 fast-forward 重写。`main`、`dev`、marker 使用各自 ref-scoped
force lease，禁止 blanket force/lease。
12. 远端 atomic push 成功后、调用 GitHub Release API 前，使用之前捕获的本地旧 OID
    作为 compare-and-swap 条件，在一个 `git update-ref --stdin` transaction 中把本地
    `main` 对齐末尾文档 commit、把本地 `upstream-release` 对齐官方 Tag commit；不得
    切换或移动已验证的当前 sync branch。随后刷新/核对 remote-tracking refs。即使后续
    Release 创建失败，本地/远端 branch 状态也必须保持已收敛。
13. Git 引用与本地 branch 收敛后，创建或核对同名 GitHub Release。必须查询并验证 `tagName`、
    `name`、`body`、`isDraft=false`、`isPrerelease=false` 和 URL；元数据不合格时只做
    幂等 Release 修正。创建或修正失败时保留已经推送的不可变 Tag，任务标记未完成，
    下次重试只处理 Release。
14. 最终确认发布瞬间本地/远端 `main`、`dev`、`sync/vX.Y.Z` 和 Fork Tag peeled commit
    全部等于 `RELEASE_COMMIT`，`upstream-release` 等于 `OFFICIAL_COMMIT`，GitHub Release
    指向该 Fork Tag；发布后 advanced dev 不得被自动重置回该旧 `RELEASE_COMMIT`。

## 最小可复现审计命令

以下命令是基础清单；只有实际 remote 名称不同才允许调整。

```bash
gh api repos/lidge-jun/opencodex/releases/latest
git fetch --all --prune --tags
git rev-parse refs/tags/<official-tag>^{}
git merge-base --is-ancestor refs/tags/<official-tag>^{} upstream/main

# 在创建末尾文档提交之前捕获；后续不得从 HEAD^ 反推或覆盖该变量。
IMPLEMENTATION_HEAD=$(git rev-parse HEAD)
# 更新、验证并提交 FORK_CHANGES.md 后运行。
test "$(git rev-parse HEAD^)" = "$IMPLEMENTATION_HEAD"
test "$(git diff-tree --no-commit-id --name-only -r HEAD)" = "FORK_CHANGES.md"
git log --reverse --oneline <official-tag>..$IMPLEMENTATION_HEAD
git diff --name-status <official-tag>...$IMPLEMENTATION_HEAD
git diff --shortstat <official-tag>...$IMPLEMENTATION_HEAD
git diff --check <official-tag>...$IMPLEMENTATION_HEAD
git diff --check HEAD^ HEAD

# Fork Tag 与 Release。
test "$(git cat-file -t refs/tags/<fork-tag>)" = "tag"
git rev-parse refs/tags/<fork-tag>
git rev-parse refs/tags/<fork-tag>^{}
git ls-remote origin refs/tags/<fork-tag> refs/tags/<fork-tag>^{}
git rev-parse refs/heads/main
git rev-parse refs/heads/dev
git rev-parse refs/heads/sync/<official-version>
git ls-remote origin refs/heads/main refs/heads/dev refs/heads/sync/<official-version>
gh release view <fork-tag> --repo Trendymen/opencodex \
  --json tagName,name,body,isDraft,isPrerelease,url
```
