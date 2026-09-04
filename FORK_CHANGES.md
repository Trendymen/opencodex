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
| 审计日期 | 2026-09-04 |
| 本轮官方维护基线 | [`v2.42.0`](https://github.com/lidge-jun/opencodex/releases/tag/v2.42.0) |
| 官方 Tag commit | `48f8186647d9ffb108d226dcfa91a64225aae2a7` |
| 当前上游最新稳定 Release | `v2.42.0`（`48f8186647d9ffb108d226dcfa91a64225aae2a7`），非 draft、非 prerelease，且等于当前 `upstream/main` |
| 当前 `IMPLEMENTATION_HEAD` | `b15af48ad49d4ca82861a2a1ff61dda1c639429c`；包含完整 v2.40→v2.42 rebase、冲突 union、`2.42.0-ben.1` 版本、维护真源测试升级、按用户决定移除 `provider_debug` 预算豁免，以及 R1 审查发现的 Provider POST 数据保全与 nested-exec 授权修复 |
| Fork 包版本 | `2.42.0-ben.1` |
| 本轮派生 Tag | `v2.42.0-ben.1`（目标）；最终验证和双审通过前不创建，既有 `v2.40.0-ben.1`、`v2.40.0-ben.2`、`v2.40.0-ben.3` 保持不可变 |
| 同步分支 | 本轮固定 `RELEASE_SYNC_REF=refs/heads/sync/v2.42.0`，本地与 origin 均尚不存在；发布时只能以 expected-absent lease 在六成员 atomic push 中创建，禁止 `sync/v2.42.0-ben.*` |
| 实现修改面 | 固定 `IMPLEMENTATION_HEAD=b15af48ad49d4ca82861a2a1ff61dda1c639429c`：相对官方 `v2.42.0` 为 202 个文件、`+36,158/-747`；相对 `POST_REBASE_HEAD` 为 10 个文件、`+619/-119` |
| rebase 固定输入 | `OLD_OFFICIAL=35ff3a462e786bd5efc394dfb1a8a5cc946e454f`；`NEW_OFFICIAL=48f8186647d9ffb108d226dcfa91a64225aae2a7`；`PRE_REBASE_DEV=1aae7085e32e86e7043d0280b0097119a1e1e726`；`POST_REBASE_HEAD=6032e2cc5e131febda1a8d5c328e3323095ac7d3` |
| rebase 机械对账 | 官方变更 476 路径；旧 Fork net/touched 均为 204；overlap 38；实际内容冲突 8 路径、10 个唯一 hunk；30 个 overlap 自动合并；主/影 replay 的 stop、stage、hunk、action、commit 与最终 tree 完全一致 |
| 当前验证 | R1 前宽范围 focused 为 30 files、1,098 pass / 0 fail；R1 `CODE_QUALITY` 的两个 Important 已按 TDD 修复，Provider RED 2 pass / 1 fail→GREEN 3 pass / 0 fail，相邻管理路由 106 pass；nested-exec RED 3 fail→GREEN 8 pass。R2 精确门禁为 34 files、1,214 pass / 0 fail，typecheck、privacy scan、固定范围 diff check 与 clean status 全部 exit 0。两次默认 4x `bun run prepush` 仍是失败（A1：18,030 pass / 3 fail；A2：18,023 pass / 10 fail），用户明确要求本轮不再等待全量/远端 CI；R2 复审尚未完成，不把任何失败轮次记为 PASS |
| 外部发布状态 | [`v2.40.0-ben.3`](https://github.com/Trendymen/opencodex/releases/tag/v2.40.0-ben.3) 已闭环且不可变；`v2.42.0-ben.1` 的 Tag、六成员 atomic push、main CI 与 GitHub Release 均未发生 |
| dev 发布策略 | `dev` 是候选与 rebase 线；发布时以显式 lease 与 `main` 同步到同一 Release commit，发布后可再次自由领先 `main` |
| 官方基线标记 | 发布前本地与 `origin/upstream-release` 仍为旧官方 `v2.40.0`；本轮发布事务才允许更新到 `v2.42.0` |
| origin 官方历史 Tag | `v2.33.0` 至 `v2.41.0` 已存在且与 upstream 对应官方 Tag 一致；`v2.42.0` 将作为目标官方 Tag 进入本轮 atomic refset |

### v2.42.0-ben.1 上游同步与发布候选

本轮把已提交且来源明确的 `dev=1aae7085e32e86e7043d0280b0097119a1e1e726`
从官方 `v2.40.0` 完整 rebase 到正式稳定版 `v2.42.0`。官方两版主要新增 Cursor
effort table/rows 与 `max_output_tokens`、Meta/Muse Provider 和被动配额、完整 usage ledger
聚合、原子 Provider editor、OpenAI device auth、Realtime WebSocket 注入、Responses unknown
usage 字段保真、Gemini 3.8 与 gpt-6-astra，以及 retry/combo/cooldown 修复。Fork 继续保留
GLM/Kimi Responses 兼容、第三方 routed progress、nested-exec 严格授权、可配置 message phase、
入站/下游诊断、Ark quota 客户端展示、standalone web search、`install:local` 和发布治理。

官方 `v2.42.0` 已把 `provider_debug` 注册到 app-owned memory budget；旧 Fork 为它保留的
预算豁免只会让内存上限漏算，持久化诊断能力并不依赖该豁免。用户确认“没用就干掉”后，
本轮删除对应 Fork 测试并采用官方统一预算语义，同时保留 debug ring、durable artifact 与
GUI/CLI 读取能力。这是明确的 Fork 行为移除，不把测试删除伪装成官方自动覆盖。

R1 `CODE_QUALITY` 发现两个 rebase 前已存在的旧 Fork 缺口：普通 dashboard Provider
`POST` 会因 payload 未携带 `inferResponsesMessagePhaseModels` 而静默删除已有配置；
nested-exec 又会把任意名为 `exec` 的普通函数误认作统一执行器。本轮以 TDD 修复：Provider
覆盖在请求未拥有该字段时保留已有规范化数组，显式删除仍只走 `PATCH null`；nested-exec
只接受当前 turn 中保留 `functions` namespace 内唯一 `custom:exec` 的来源证明。Chat/Claude
转换后的普通 `function:exec`、顶层 `custom:exec`、其他 namespace 与歧义声明均不授权修复，
未声明调用继续由既有 guard fail closed。

<!-- v242-rebase:start -->
official_old=v2.40.0
official_new=v2.42.0
old_official_commit=35ff3a462e786bd5efc394dfb1a8a5cc946e454f
new_official_commit=48f8186647d9ffb108d226dcfa91a64225aae2a7
pre_rebase_dev=1aae7085e32e86e7043d0280b0097119a1e1e726
post_rebase_head=6032e2cc5e131febda1a8d5c328e3323095ac7d3
candidate_branch=dev
package_version=2.42.0-ben.1
fork_tag=v2.42.0-ben.1
release_sync_ref=refs/heads/sync/v2.42.0
official_changed_path_count=476
old_fork_net_path_count=204
old_fork_touched_path_count=204
net_overlap_path_count=38
overlap_path_count=38
content_conflict_count=8
content_hunk_count=10
non_overlap_conflict_count=0
auto_merge_path_count=30
overlap_paths=docs-site/src/content/docs/guides/codex-integration.md,docs-site/src/content/docs/guides/providers.md,docs-site/src/content/docs/reference/management-api.md,docs-site/src/content/docs/reference/proxy-formats.md,gui/src/i18n/de.ts,gui/src/i18n/en.ts,gui/src/i18n/fr.ts,gui/src/i18n/ja.ts,gui/src/i18n/ko.ts,gui/src/i18n/ru.ts,gui/src/i18n/tr.ts,gui/src/i18n/zh-TW.ts,gui/src/i18n/zh.ts,gui/src/pages/Logs.tsx,package.json,src/adapters/google.ts,src/adapters/identity.ts,src/adapters/openai-responses.ts,src/cli/registry.ts,src/codex/catalog/aggregation.ts,src/codex/catalog/parsing.ts,src/codex/catalog/provider-fetch.ts,src/codex/inject.ts,src/config.ts,src/lib/app-owned-memory-stores.ts,src/providers/registry.ts,src/server/auth-cors.ts,src/server/chat-native.ts,src/server/management/logs-usage-routes.ts,src/server/management/provider-routes.ts,src/server/responses/core.ts,src/usage/log.ts,tests/ci-workflows.test.ts,tests/codex-catalog.test.ts,tests/memory-watchdog.test.ts,tests/openai-responses-passthrough.test.ts,tests/responses-state.test.ts,tests/shutdown-launcher.test.ts
content_conflicts=package.json,src/codex/catalog/provider-fetch.ts,src/lib/app-owned-memory-stores.ts,src/server/auth-cors.ts,src/server/responses/core.ts,tests/ci-workflows.test.ts,tests/codex-catalog.test.ts,tests/shutdown-launcher.test.ts
content_hunk_ids=1506feca25c3046db7a409b0beffdea5d17efc88d02e184ea888926652afa738,2705a63636d9955c82f3bbb2a91568d7e0268cfcd0b85c3aedbae0cb7a1340bc,3765a3564c4bcef605964189ec05920a6850551319d75a527fb359d590904d95,65dbc31f100a0ec7f984efc7740a4f5aa173272a92041c033c0713e76233a3f7,681be6196942eae40ac4bc663495483fe8fb4141a2e40b0c86b2e8fd69f2968e,6f7418b738e24c83ed85e5b0e03f327a73d257a4506f4ae21107d2b49b40060c,7b6b4dfb987fba42c1e653c71c6adf28fa5fdd9bbe878824f0a3e462f30eb33e,d54645903050f445d616521aae7d50497bd94717ed0370dfe26cd834b78092f4,dbd348a5a005af2d4e4275a4149675873124d94db3e010cc11a42e42c3edbdaa,f1efdeafd214de44b9ac73524a34b0f9b1f0df409446dcf4c38661a2891ca38f
replay_manifest_sha256=20380ff5b865d9da8c676482acb5258b9d8ebeda281d390d6a1e1f5cbe774b59
shadow_replay=pass-exact-commit-tree-stops-paths-stages-hunks-actions
implementation_head=b15af48ad49d4ca82861a2a1ff61dda1c639429c
release_commit=docs-only-current-head
verification=pass-R2-focused-1214;typecheck-pass;privacy-pass;fixed-range-diff-check-pass;clean-status-pass;prepush-A1-fail-3;prepush-A2-fail-10;user-waived-further-full-and-remote-ci
reviews=pending
tag_state=pending
atomic_push=pending
github_release=pending
<!-- v242-rebase:end -->

#### 逐冲突账本

<!-- v242-conflict-package_json:start -->
path=package.json
symbols=version,scripts.install:local,overrides.fast-uri,overrides.ip-address,overrides.qs
official_change=版本升级为2.42.0并更新安全与解析依赖override
fork_change=旧Fork写入2.40.0-ben.3并增加install:local命令
resolution=保留官方override与Fork install:local，rebase后统一收敛为2.42.0-ben.1
official_coverage=官方不提供install:local或ben版本策略，依赖override由官方完整接管
downstream_consumers=npm包元数据、bin/ocx.mjs updater、scripts/install-local.ts、版本与CI门禁
failure_paths=非法JSON会阻断Volta与Bun；错误版本会破坏更新单调性和Tag绑定
state_edges=官方稳定版、ben.1、旧ben.3与缺失install:local必须严格区分
ordering_edges=版本修复只在rebase完成后提交，Tag与push只能在最终验证和双审之后
risk_domains=dependency-install,release,config
conflict_snapshots=step=3;REBASE_HEAD=7ec37d5751f6e3db8baf7a2f477b13df9085540b;hunk_ids=65dbc31f100a0ec7f984efc7740a4f5aa173272a92041c033c0713e76233a3f7
focused_tests=tests/fork-version-policy.test.ts,tests/fork-update-monotonicity.test.ts,tests/fork-update-downgrade.test.ts,tests/fork-maintenance-truth.test.ts
residual_risk=pending:最终完整prepush与发布namespace复核尚未执行
<!-- v242-conflict-package_json:end -->

<!-- v242-conflict-src_codex_catalog_provider_fetch_ts:start -->
path=src/codex/catalog/provider-fetch.ts
symbols=recordLiveCursorClaudeModels,routedMaxOutputTokens,metadataModelIdCaseFold,routedProgressContractEligible,isOpenAiOperatedResponsesDestination
official_change=增加Cursor live Claude roster、maxOutputTokens、virtualModels与大小写无关metadata传播
fork_change=按真实Responses目的地投影第三方routed progress资格并在custom替换时保留该字段
resolution=最小union保留官方目录能力链和Fork端点资格判定
official_coverage=官方未提供routedProgressContractEligible；Cursor与output上限逻辑由官方完整保留
downstream_consumers=src/codex/catalog/sync.ts、src/codex/catalog/aggregation.ts、Codex模型选择器与请求改写
failure_paths=discovery失败走stale/configured fallback；错误资格会向官方端点注入Fork progress或漏注第三方
state_edges=live空集、stale cache、custom replacement、canonical OpenAI默认auth与未知output ceiling
ordering_edges=gather flight固定registry/config authority；只在成功live discovery后发布Cursor roster
risk_domains=runtime,shared-entrypoint
conflict_snapshots=step=1;REBASE_HEAD=26005e4cf1d099594990c4552200d2f61f22b2fb;hunk_ids=2705a63636d9955c82f3bbb2a91568d7e0268cfcd0b85c3aedbae0cb7a1340bc,7b6b4dfb987fba42c1e653c71c6adf28fa5fdd9bbe878824f0a3e462f30eb33e
focused_tests=tests/codex-catalog.test.ts,tests/cursor-catalog.test.ts,tests/cursor-umbrella-rows.test.ts,tests/fork-routed-progress-contract.test.ts
residual_risk=none:目录与Cursor高风险focused测试通过且消费者链已静态核对
<!-- v242-conflict-src_codex_catalog_provider_fetch_ts:end -->

<!-- v242-conflict-src_lib_app_owned_memory_stores_ts:start -->
path=src/lib/app-owned-memory-stores.ts
symbols=usageSnapshotRetainedStoreSnapshot,evictOldestUsageSnapshot,providerDebugSnapshot,provider_debug
official_change=把完整usage ledger aggregate的evictable与pinned字节并入统一usage_snapshot预算
fork_change=旧Fork曾移除provider_debug注册，使其不受全局app-owned budget驱逐
resolution=保留官方usage aggregate和provider_debug统一预算；按用户决定删除Fork豁免及对应测试
official_coverage=官方v2.42完整提供usage aggregate与provider_debug注册；Fork豁免被明确放弃而非宣称等价覆盖
downstream_consumers=system memory API、memory watchdog、debug ring、usage aggregate cache
failure_paths=预算超限按logs优先淘汰；aggregate pinned字节不可错误计入evictable；snapshot异常保持有界
state_edges=legacy为空、aggregate为空或全pinned、provider_debug为空、零预算与exact-boundary
ordering_edges=append后同步enforce；同类store按oldestAt与注册顺序稳定淘汰
risk_domains=runtime,persistence
conflict_snapshots=step=1;REBASE_HEAD=26005e4cf1d099594990c4552200d2f61f22b2fb;hunk_ids=6f7418b738e24c83ed85e5b0e03f327a73d257a4506f4ae21107d2b49b40060c
focused_tests=tests/app-owned-memory.test.ts,tests/usage-aggregate-cache.test.ts,tests/memory-watchdog.test.ts,tests/fork-inbound-response-debug.test.ts
residual_risk=none:用户已决定移除豁免，受影响67个focused测试全部通过
<!-- v242-conflict-src_lib_app_owned_memory_stores_ts:end -->

<!-- v242-conflict-src_server_auth_cors_ts:start -->
path=src/server/auth-cors.ts
symbols=providerManagementConfigError,PROVIDER_CONFIG_FIELD_POLICY,providerEditorProviderDTO,parseProviderEditorConfigDTO,safeConfigDTO,inferResponsesMessagePhaseModels
official_change=新增exhaustive provider editor字段策略、原子批量DTO与未知或敏感字段fail-closed
fork_change=增加可编辑的inferResponsesMessagePhaseModels并保留凭据与运行时字段的安全投影边界
resolution=将inferResponsesMessagePhaseModels分类为editor并复用官方editor DTO；R1审查后补齐普通Provider POST遗漏字段时的数据保全，PATCH null仍为唯一显式删除路径
official_coverage=官方editor框架完整保留；官方不知道Fork字段与message-phase消费者，因此只部分覆盖
downstream_consumers=provider PUT/PATCH/GET、safe config API、src/fork/responses-message-phase.ts、Responses SSE/JSON重写
failure_paths=未知、redacted、runtime或stale baseline写入均拒绝；DNS/SSRF在provider route锁内复验
state_edges=字段缺失、空数组、空白模型ID、false或null clear、凭据只保留存在性布尔值
ordering_edges=baseline比较、持久化锁、保存后runtime reload与message-phase请求时读取
risk_domains=auth,secret,config,persistence
conflict_snapshots=step=1;REBASE_HEAD=26005e4cf1d099594990c4552200d2f61f22b2fb;hunk_ids=3765a3564c4bcef605964189ec05920a6850551319d75a527fb359d590904d95
focused_tests=tests/provider-config-batch-management.test.ts,tests/management-provider-validation.test.ts,tests/fork-provider-message-phase-config.test.ts
residual_risk=pending:R2复审需确认POST遗漏保留不改变显式写入和PATCH清除语义
<!-- v242-conflict-src_server_auth_cors_ts:end -->

<!-- v242-conflict-src_server_responses_core_ts:start -->
path=src/server/responses/core.ts
symbols=passiveQuotaWriterGeneration,noteInspectedPayload,recordPassiveAccountQuota,inboundDebugUsesRawTerminalRepairTap,nestedExecInspection,rememberPassthroughResponseChecked
official_change=在每个Muse入站事件上按服务账户与credential代际记录被动配额
fork_change=同一入口承担入站/下游debug、terminal raw tap去重、nested-exec判定与continuation cache门控
resolution=顺序固定为quota记录、debug观察、nested-exec与undeclared-tool判定、cache eligibility，保留双方终态dispose
official_coverage=官方只覆盖Muse passive quota；Fork诊断、严格nested-exec与message-phase链仍未覆盖
downstream_consumers=quota API、provider debug artifacts、terminal repair、Responses relay/eager、continuation state
failure_paths=failed或incomplete终态、abort、client gone、relay tail失败、undeclared tool拒绝与quota writer代际失配
state_edges=无OAuth账户、无quota payload、raw tap缺失、nested decision defer或reject、store false与空output
ordering_edges=SSE逐帧、terminal前close、raw tap去重、failover后事件时账户读取、dispose与flush
risk_domains=runtime,shared-entrypoint,persistence
conflict_snapshots=step=1;REBASE_HEAD=26005e4cf1d099594990c4552200d2f61f22b2fb;hunk_ids=1506feca25c3046db7a409b0beffdea5d17efc88d02e184ea888926652afa738
focused_tests=tests/muse-passive-quota-observation.test.ts,tests/muse-passive-quota-cache.test.ts,tests/responses-terminal-repair.test.ts,tests/responses-state.test.ts,tests/fork-inbound-response-debug.test.ts
residual_risk=pending:完整prepush与后续CODE_QUALITY流时序审查尚未完成
<!-- v242-conflict-src_server_responses_core_ts:end -->

<!-- v242-conflict-tests_ci_workflows_test_ts:start -->
path=tests/ci-workflows.test.ts
symbols=gui exhaustive-deps describe,dev-version-bump checkout,fetch-depth,bump-dev-version.ts
official_change=在同一describe尾部增加工作流和GUI lint/doctor硬化断言
fork_change=验证ben发布不把dev CI耦合到已发布版本线并要求完整merge-base历史
resolution=保留全部官方断言并把Fork测试放回同一describe，未放宽任何结构检查
official_coverage=官方未覆盖Fork ben版本线策略；其他CI安全断言由官方与Fork共同保留
downstream_consumers=.github/workflows/dev-version-bump.yml、GitHub Actions checkout与版本PR任务
failure_paths=浅克隆缺merge-base、旧release-version-line门禁复活、workflow解析或权限配置错误
state_edges=已有候选分支、无版本变化、Fork ben版本、官方stable与preview事件
ordering_edges=checkout必须先固定dev并fetch完整历史，再运行bump helper
risk_domains=release,dependency-install
conflict_snapshots=step=3;REBASE_HEAD=7ec37d5751f6e3db8baf7a2f477b13df9085540b;hunk_ids=f1efdeafd214de44b9ac73524a34b0f9b1f0df409446dcf4c38661a2891ca38f
focused_tests=tests/ci-workflows.test.ts
residual_risk=pending:GitHub实际事件调度与权限只可由远端CI最终证明
<!-- v242-conflict-tests_ci_workflows_test_ts:end -->

<!-- v242-conflict-tests_codex_catalog_test_ts:start -->
path=tests/codex-catalog.test.ts
symbols=provider discovered model display names,maxOutputTokens,routedProgressContractEligible
official_change=精确对象断言新增500000 maxOutputTokens与service-tier结果
fork_change=同一断言要求第三方xAI行保留routedProgressContractEligible=true
resolution=严格对象断言同时保留官方output ceiling与Fork route hint，不改为局部匹配
official_coverage=官方不提供Fork route hint；官方output ceiling覆盖完整保留
downstream_consumers=applyProviderConfigHints、catalogModelSlug、Codex picker与routed request rewrite
failure_paths=丢字段会造成picker能力误报、输出上限失真或第三方progress缺失
state_edges=精确ID、大小写差异、无displayName、live或stale row与custom replacement
ordering_edges=config hint在discovery后应用，custom replacement再做受限gap-fill
risk_domains=runtime
conflict_snapshots=step=3;REBASE_HEAD=7ec37d5751f6e3db8baf7a2f477b13df9085540b;hunk_ids=d54645903050f445d616521aae7d50497bd94717ed0370dfe26cd834b78092f4,dbd348a5a005af2d4e4275a4149675873124d94db3e010cc11a42e42c3edbdaa
focused_tests=tests/codex-catalog.test.ts
residual_risk=none:266个catalog focused测试通过且断言仍为完整对象相等
<!-- v242-conflict-tests_codex_catalog_test_ts:end -->

<!-- v242-conflict-tests_shutdown_launcher_test_ts:start -->
path=tests/shutdown-launcher.test.ts
symbols=nodeExecutable,process.execPath,STARTUP_BUDGET_MS,stdio,launcher output,port ownership
official_change=扩大CI启动预算并捕获stdout/stderr与退出状态，避免慢启动被误判为orphan
fork_change=绕过Volta/asdf node shim直接启动真实process.execPath，并固定fixture端口配置
resolution=同时保留真实Node直启、端口隔离、官方启动预算和失败诊断，原no-orphan断言不变
official_coverage=官方诊断不解决shim PID orphan；Fork直启仍需保留
downstream_consumers=bin/ocx.mjs launcher、Bun proxy、Codex配置注入与signal forwarding
failure_paths=启动超时、launcher提前退出、signal未转发、端口未释放、pid/runtime文件或配置未恢复
state_edges=CI或本地预算、SIGINT或SIGTERM或SIGHUP、无默认端口服务与版本管理器shim
ordering_edges=health ready后发signal，先等launcher退出再验证端口与配置恢复
risk_domains=runtime,dependency-install
conflict_snapshots=step=3;REBASE_HEAD=7ec37d5751f6e3db8baf7a2f477b13df9085540b;hunk_ids=681be6196942eae40ac4bc663495483fe8fb4141a2e40b0c86b2e8fd69f2968e
focused_tests=tests/shutdown-launcher.test.ts
residual_risk=pending:Windows按既有条件跳过，三平台最终结论依赖完整CI
<!-- v242-conflict-tests_shutdown_launcher_test_ts:end -->

### v2.40.0-ben.1 至 ben.3 历史发布说明

本轮相对 `v2.40.0` 的实现短统计严格以固定 `IMPLEMENTATION_HEAD` 计算；末尾
`FORK_CHANGES.md` 文档提交不属于实现快照。候选来自已提交且来源明确的
`dev=b5d4694b1de65c9c2faf9adc063ed8b5719fb9a9`，按
`git rebase --onto 35ff3a462 af6113a03 dev` 完整重放，rebase 完成点为
`91ae57de114dae18842e44067563db4493525b30`，随后新增 v2.40 维护真源机械门禁提交
`0f9fc0daa584592eeab78f507ed68882aeb2192d`，以
`3611064cc2949101472883334e181ea0349dbe9b` 更新 rebase 后变化的活跃 blob 锚点，最终以
`21fa726f2f2eb54130825fb8ecd2087fa59c4390` 记录用户明确授权的 catalog 组合字段断言；
初轮双审后以 `df73ecba72a50739e4060133928d5cb16d15bf4f` 修复 combo 最终投影、one-shot
body ceiling、稀疏显式 phase 顺序与 v2.40 重叠账本。

官方 v2.40 改动与 Fork 候选重叠 44 条路径，12 条路径发生内容冲突。解决原则不是覆盖一侧：
保留官方 remote hub、Cursor Fast、retainModels/model display、keychain、authless Desktop、
outbound body ceiling、self-named namespace scrub 与 dead-PID helper，同时保留 Fork
message-phase、nested exec、routed progress、standalone web search、one-shot recovery、
customModels 和发布治理。包版本固定为 `2.40.0-ben.1`。官方 v2.40 已覆盖 auth fixture 的
clock/quota/network 基础修复；Fork 继续保留 listener-before-send 与精确 namespace 回归，
不能把名称相似误判为全部覆盖。

初轮双审发现并修复以下 Important：重叠账本补入 `tests/cli-status-json.test.ts` 并收敛为
44 overlap / 32 auto-merge / 12 conflict；修正活跃 blob 锚点提交 SHA；combo 最终 catalog
投影禁止把未显式合格的组合回退为第三方；one-shot recovery 明文重建超限时只释放候选请求、
不取消原始 native failure；稀疏 SSE 的显式 phase 消息到达前先按顺序释放 pending 消息。
三项行为修复均完成 RED→GREEN，且以新实现 SHA 重新跑过完整发布门禁。

### v2.40.0-ben.1 发布后 rebase 审查规则强化

`dev` 提交 `3f5d1dd264d2b1f2f954d0a5069fa9d6ec932034` 只修改
`AGENTS.local.md`、`docs/fork-sync-automation.md` 与
`tests/fork-maintenance-truth.test.ts`，不改变 package 版本、runtime 行为、`main`、
`sync/v2.40.0`、既有 Tag 或 GitHub Release。它把后续官方稳定版 rebase 的审查证据从汇总式
账本提升为可追溯契约：

- 每个真实内容冲突必须记录符号、官方/Fork 语义、最终消费者、失败/状态/时序边界、
  `risk_domains`、冲突 snapshot、focused tests 与残余风险。
- `SPEC_COMPLIANCE` 独立重算官方变更、Fork 端点净差异、逐 commit touched paths 和 overlap；
  主 rebase 的逐 stop mode/blob/hunk 证据必须与 pre-rebase shared clone 的 shadow replay 在
  action、commit/dropped mapping、每步 tree 与最终 tree 上完全一致。
- 预审失败只产生 `AK` candidate attempt；只有验证通过且 implementation/docs-only commit
  完整 SHA 对同时存在时才分配 append-only `RN`。首次派发为 `INITIAL`，已有 verdict 后的新
  完整轮才是 `RE_REVIEW`，避免半轮、覆盖旧 SHA 或复用旧验证。
- `CODE_QUALITY` 强制检查最终消费者二次默认化、nullish 状态、失败/资源路径、流顺序、
  初建/重建、配置往返、官方与 Fork 能力可达性及相对官方最小修改面；审查包必须同时提供
  `FULL_FORK_DIFF`、`REBASE_RESOLUTION_DIFF`、`POST_REBASE_FIX_DIFF`。
- 敏感路径/全部 diff hunk/ledger symbol、固定 shared entrypoint、5 个 conflict paths 或 10 个
  唯一 hunk 会触发只读 explorer；只有具体 cross-boundary consumer edge 或未决跨边界风险才
  增加限定 scope 的第三 `CODE_QUALITY` reviewer，不做泛化重复审查。
- 现有 `pre-push` hook 继续通过完整 `prepush` 覆盖维护契约测试，但明确不能证明 reviewer
  approval、机械重算或复审，禁止自动生成 approval、清 finding、移动 ref 或用
  `--no-verify` 绕过门禁。

本次规则实现按 TDD 完成：新测试先因缺少 review-package 机器块得到 19 pass / 1 fail；最终
`bun test tests/fork-maintenance-truth.test.ts` 为 20 pass / 0 fail / 590 expect calls，
`bun run typecheck` 与 `git diff --check` 通过。独立复审最终为
`SPEC_COMPLIANCE: PASS`、`CODE_QUALITY: PASS`，无未决 Critical、Important 或 Minor；真实
shadow replay 行为仍须在下一次适用的官方 rebase 中按新协议生成证据，不能由本次静态契约
测试替代。

### v2.40.0 基线上的 dev 全量历史压缩

本轮只重写自由开发线 `dev`，不创建新 Fork revision。压缩前本地与远端 `dev` 均为
`d6ee37bea6e5d5c966564bfe1e1ba48ef64d28b2`，从官方
`v2.40.0=35ff3a462e786bd5efc394dfb1a8a5cc946e454f` 到该提交共有 66 个 commits、171 条
最终变更路径，tree 为 `5024beedc022c974df7d7614cff0cdd194841f84`。本地恢复分支
`backup/dev-pre-v240-squash-20260903` 保留压缩前提交，不推送 origin。

压缩后的语义边界如下：

1. `d8325bc9dfe1ca4985e281a71e8d785ff9422750`：
   `feat: 汇总 Fork 运行时与用户能力`，相对官方基线包含 84 条 `src/`、`bin/`、GUI、
   docs-site、package 与用户能力路径；`scripts/install-local.ts` 和
   `scripts/install-local-vendor.ts` 与注册它们的 `install:local` 命令同 commit 落下。
2. `b2a56ec454ec464705acc75859756ad37a61b188`：
   `chore: 汇总 Fork CI、脚本与维护基础设施`，增加剩余 22 条 workflow、script、structure、
   规则与维护文档路径，并在测试提交前提供其静态读取/导入目标。
3. `74c26e5e7053b20ba5501112332d8ff7c90636a7`：
   `test: 汇总 Fork 回归与兼容覆盖`，最后增加 65 条 `tests/` / `gui/tests/` 路径；该提交 tree
   精确等于压缩前 `dev` tree。
4. 当前末尾提交：`docs: 记录 v2.40.0 Fork 全量历史压缩`，只修改
   `FORK_CHANGES.md`，记录压缩边界、验证、审查与推送状态；不把该文档增量误记为压缩前 tree。

三组路径清单是官方基线到压缩前 `dev` 的 171 条变更的无重复完整分区；每个 C1–C3 commit
的实际 diff path list 已与对应清单逐字节比较。C3 tree 与压缩前 tree 相同，证明压缩没有改变
压缩前已提交的 runtime、测试、GUI、脚本、配置或维护规则。C4 之外的文件不得再变化。

<!-- v240-dev-squash:start -->
official_base=35ff3a462e786bd5efc394dfb1a8a5cc946e454f
source_dev=d6ee37bea6e5d5c966564bfe1e1ba48ef64d28b2
source_commit_count=66
source_path_count=171
source_tree=5024beedc022c974df7d7614cff0cdd194841f84
c1=d8325bc9dfe1ca4985e281a71e8d785ff9422750
c1_path_count=84
c2=b2a56ec454ec464705acc75859756ad37a61b188
c2_path_count=22
c3=74c26e5e7053b20ba5501112332d8ff7c90636a7
c3_path_count=65
c3_tree=5024beedc022c974df7d7614cff0cdd194841f84
tree_identity=source-dev-tree-equals-c3-tree
c4=docs-only-current-head
target_commit_count=4
remote_update=dev-only-force-with-lease-source-dev
release_refs=main-sync-tags-release-immutable
<!-- v240-dev-squash:end -->

`main`、`sync/v2.40.0`、`upstream-release`、官方 `v2.40.0`、Fork
`v2.40.0-ben.1` annotated Tag 和 GitHub Release 全部保持不可变。本轮不把包版本推进为
`2.40.0-ben.2`，也不把压缩后的自由开发提交宣称为已包含在现有 `v2.40.0-ben.1` Release 中。
远端只允许以压缩前 `origin/dev` 的精确 OID 为 lease 更新 `refs/heads/dev`；lease 漂移即停止。

### v2.40.0-ben.2 同基线维护发布候选

用户在完成 `v2.40.0..dev` 的 66→4 全量压缩后明确要求发布 `v2.40.0-ben.2`，因此本节取代
上一节“本轮不把包版本推进为 `2.40.0-ben.2`”的旧任务边界。官方基线仍为
`v2.40.0=35ff3a462e786bd5efc394dfb1a8a5cc946e454f`，本轮不执行新的上游 rebase，也不声称包含
`v2.40.0` 之后的 upstream 开发分支能力。

- **候选来源：** 已提交且本地/远端一致的压缩后
  `dev=666cf1291d97a1f4756384ee162444d27788d576`；其相对官方基线恰好 4 个语义 commits。
- **版本与 Tag：** package 目标为 `2.40.0-ben.2`，Fork Tag 目标为新的
  `v2.40.0-ben.2` annotated Tag。`v2.40.0-ben.1` raw/peeled 对象和 GitHub Release 保持不可变。
- **审计 ref：** 本轮 `RELEASE_SYNC_REF=refs/heads/sync/v2.40.0`，不创建任何
  revision-specific sync ref。发布前固定本地/远端旧 OID
  `f219dc999012c56ecf3b74e1fe66f4f89311d25b`，atomic push 使用该 ref 的精确
  expected-OID lease 与 `+RELEASE_COMMIT:refs/heads/sync/v2.40.0` 强制更新；不要求
  fast-forward 或 ancestry，但 lease 漂移仍 fail closed。
- **修改范围：** 固定 `IMPLEMENTATION_HEAD=6f46b90155d65b543f8c16e9b16030c19ff0a1c4`。
  本轮不新增 runtime、Provider、adapter、GUI 或公共 API 行为；相对压缩后候选只修改
  `AGENTS.local.md`、`FORK_CHANGES.md`、`docs/fork-sync-automation.md`、`package.json` 和
  `tests/fork-maintenance-truth.test.ts`，合计 `+299/-86`。相对官方基线仍为 171 个文件、
  `+28,761/-605`。
- **TDD 证据：** 单一可移动 sync 指针契约先在旧 revision-specific 正文上得到
  18 pass / 3 fail，失败精确命中同时更新 `main`、`dev`、sync、marker、Fork Tag 与官方 Tag 的原子 refset、`sync-audit-ref-policy` 与旧 ancestry 门禁；
  实现后 `bun test tests/fork-maintenance-truth.test.ts` 为 21 pass / 0 fail /
  630 expect calls，`git diff --check` 通过。
- **双审状态：** R1 两位 reviewer 的 FAIL 针对已被用户撤销的 revision-specific sync 方案；
  新方案不以修补该方案继续，而是按用户最终规则恢复单一 sync 指针强推。R2 仍须复用原
  reviewer，携带完整 PRIOR_FINDINGS、用户规则取代说明、新 diff 与新验证证据重新判定。R2
  `SPEC_COMPLIANCE` 又发现一个 Important：automation 已有三 ref 本地 CAS，但
  `FORK_CHANGES.md` 幂等入口、最小审计和跨文档机械门禁不完整；R3 已补齐。
- **R3 TDD：** 新跨文档 CAS 契约在 R2 上得到 19 pass / 2 fail / 591 expect calls，失败精确
  命中两个活跃流程缺少 `local-ref-cas-transaction`；补齐幂等恢复、两个机器块和最小审计后，
  `bun test tests/fork-maintenance-truth.test.ts` 为 21 pass / 0 fail / 658 expect calls，
  `git diff --check` 通过。
- **最终验证：** 绑定 `IMPLEMENTATION_HEAD=6f46b90155d65b543f8c16e9b16030c19ff0a1c4` 的
  focused gate 为 27 pass / 0 fail / 696 expect calls；完整 `bun run prepush` 退出 0：parallel
  17,667 pass / 14 skip / 0 fail / 244,389 expect calls，全部 serial lanes、typecheck 与
  privacy scan 通过；GUI 无改动，lint/doctor 按规则跳过。未沿用 R2 PASS。
- **发布状态：** 当前已固定 R3 实现 SHA并通过完整验证；本提交作为只修改
  `FORK_CHANGES.md` 的 R3 docs-only `RELEASE_COMMIT` 候选，尚待复用原 reviewer 复审。未创建本地
  `v2.40.0-ben.2` Tag，未执行 atomic push，未创建或修改 GitHub Release。后续状态只按实际
  双审和外部 API 结果更新。

<!-- v240-ben2-candidate:start -->
official_base=35ff3a462e786bd5efc394dfb1a8a5cc946e454f
candidate_dev=666cf1291d97a1f4756384ee162444d27788d576
package_version=2.40.0-ben.2
fork_tag=v2.40.0-ben.2
release_sync_ref=refs/heads/sync/v2.40.0
release_sync_expected_old=f219dc999012c56ecf3b74e1fe66f4f89311d25b
release_sync_update=exact-oid-leased-force
implementation_head=6f46b90155d65b543f8c16e9b16030c19ff0a1c4
release_commit=docs-only-current-head
verification=pass-prepush-17667-pass-14-skip-0-fail
review=re-review-required
tag_state=pending
atomic_push=pending
github_release=pending
<!-- v240-ben2-candidate:end -->

### v2.40.0-ben.3 四提交压缩与 CI 前置发布候选

本轮以已发布且不可变的 `v2.40.0-ben.2` peeled commit
`569f0e7b7d3388758b05553fda9ba2a13208433f` 为来源，保留其相对官方 `v2.40.0` 的 10 个
Fork commits所形成的完整能力 tree，并把当前已批准的Spec、Plan、workflow与发布规则一并纳入
最终source。目标不是追加第 11 个发布提交，而是从官方基线重新构造恰好四个线性语义提交：
runtime/用户能力、CI/脚本/维护基础设施、测试与 `2.40.0-ben.3` 版本、只修改本文档的末尾C4。

`SQUASH_TARGET_COUNT=4` 在本任务内不可改变。每次内容修复创建新的append-only `S_K`并把修改折回
所属提交；每次实际candidate push创建新的append-only `A_J`，只以精确expected-OID lease更新
`origin/dev`。同tree重试仅amend C4的候选尝试标记，不得追加C5。C4后的candidate/main CI、
security/常规review、Tag、promotion和Release证据只写任务证据与最终Release Notes，不回写候选tree。

<!-- v240-ben3-squash:start -->
official_base=35ff3a462e786bd5efc394dfb1a8a5cc946e454f
source_release=569f0e7b7d3388758b05553fda9ba2a13208433f
source_commit_count=10
target_commit_count=4
content_snapshot=S8
manifest_1_sha256=a950fca67b2b61f2abe8c19eb6eb72cfaf7eb2bcebf839dfaf635cfc9c283cbe
manifest_2_sha256=948ddd0c5cb0c09a75a43e5f4c73459a0a9f311d830c7db76f9c479c452bd717
manifest_3_sha256=73c236ebdbd895de9b20fa063df94f3aac61e2d0d2be0720843ac9f8db120fee
manifest_4_sha256=1785a879a6a3a7efff5481f40ed634476460fcd51232dcb72d702c61c0a7d68c
c1=26005e4cf1d099594990c4552200d2f61f22b2fb
c2=2d0c0d0014cdcde105d230c9dba264ec1c908cd5
c3=7ec37d5751f6e3db8baf7a2f477b13df9085540b
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

所有外部门禁当前均如实为pending；`v2.40.0-ben.3` annotated Tag、任何branch promotion和GitHub
Release均尚未创建。`v2.40.0-ben.2` 的raw Tag object、peeled commit和公开Release不得移动、删除或重建。

本轮初次常规双审的四项 Important 中，Provider 文本持久化的独立默认关闭授权与有界安全写入
已在 S6 关闭；A4 后的 S7 修复了 reasoning 多 part/EOF、Fork updater 单调性与
`install:local` deferred transaction，但 A6 `CODE_QUALITY` 仍发现三项 Important。S8 继续把修复
折回原语义层：failed/incomplete terminal 会在终态前关闭 pending summary，duplicate/late added
保持幂等；安装事务在 post-swap canonical lookup 失败时立即 rollback，marker 使用 owner-only
no-replace 发布，backup root/package 绑定 dev/ino identity，rollback 后执行严格 tree verification。
失败的新 live 先进入同卷 quarantine；若旧 backup 验证失败则保留旧对象并恢复已验证的新 live，
结构化 marker 阻止后续自动覆盖；dead owner 同时存在完整 live 与 backup 时也 fail-closed，只有
live 缺失/损坏且 backup 通过通用验证时才自动恢复。Windows wrapper 遇到 recovery marker 拒绝
自动 restore。两域预提交只读核查最终没有未决 Critical；26 个相关测试文件为
252 pass / 1 platform skip / 0 fail / 869 expect calls，typecheck 与 diff check 通过。它们不能替代
S8 四提交候选的正常 4x 完整门禁、精确候选 CI 或两名原 reviewer 的 `RE_REVIEW`，因此上方外部
门禁继续保持 pending。

历史 v2.39.0 及更早轮次记录保留在专用区块，仅用于追溯，不能作为本轮结论。

<!-- v240-rebase:start -->
official_old=v2.39.0
official_new=v2.40.0
candidate_branch=dev
candidate_before=b5d4694b1de65c9c2faf9adc063ed8b5719fb9a9
candidate_after=91ae57de114dae18842e44067563db4493525b30
overlap_path_count=44
auto_merge_path_count=32
overlap_paths=.github/workflows/dev-version-bump.yml,docs-site/src/content/docs/guides/codex-integration.md,docs-site/src/content/docs/reference/configuration/providers.md,docs-site/src/content/docs/reference/proxy-formats.md,docs-site/src/content/docs/zh-cn/guides/codex-integration.md,docs-site/src/content/docs/zh-cn/reference/configuration/providers.md,gui/src/i18n/de.ts,gui/src/i18n/en.ts,gui/src/i18n/fr.ts,gui/src/i18n/ja.ts,gui/src/i18n/ko.ts,gui/src/i18n/ru.ts,gui/src/i18n/tr.ts,gui/src/i18n/zh-TW.ts,gui/src/i18n/zh.ts,package.json,src/adapters/cursor/request-builder.ts,src/adapters/openai-chat.ts,src/adapters/openai-responses.ts,src/cli/models-runtime.ts,src/cli/models.ts,src/codex/catalog/aggregation.ts,src/codex/catalog/provider-fetch.ts,src/codex/inject.ts,src/config.ts,src/providers/registry.ts,src/router.ts,src/server/auth-cors.ts,src/server/management/model-routes.ts,src/server/management/model-rows.ts,src/server/management/provider-routes.ts,src/server/responses/agent-task-recovery.ts,src/server/responses/core.ts,src/types/provider.ts,src/usage/log.ts,structure/04_transports-and-sidecars.md,tests/bump-dev-version.test.ts,tests/cli-status-json.test.ts,tests/openai-responses-passthrough.test.ts,tests/project-config-warnings.test.ts,tests/responses-state.test.ts,tests/server-auth.test.ts,tests/shutdown-launcher.test.ts,tests/update-stop-first.test.ts
content_conflict_count=12
content_conflicts=docs-site/src/content/docs/reference/configuration/providers.md,package.json,src/adapters/cursor/request-builder.ts,src/codex/catalog/provider-fetch.ts,src/codex/inject.ts,src/config.ts,src/server/auth-cors.ts,src/server/management/provider-routes.ts,src/server/responses/core.ts,tests/cli-status-json.test.ts,tests/responses-state.test.ts,tests/server-auth.test.ts
conflict_resolution=官方 v2.40.0 新能力与 Fork 专属兼容能力逐项 union；版本收敛为 2.40.0-ben.1，测试 fixture 使用官方 helper 并保留 Fork listener/namespace 边界
external_actions=full_release；rebase 默认要求完成验证、双审和 annotated Fork Tag，再用一次 git push --atomic 同时更新 main、dev、sync/vX.Y.Z、upstream-release、Fork Tag 与官方 Tag，并创建 GitHub Release；仅用户明确叫停时中止
tests=tests/fork-maintenance-truth.test.ts,tests/fork-version-policy.test.ts
<!-- v240-rebase:end -->

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
decision_bin_ocx_mjs=official=hasPendingTeardownIn；fork=forkUpdateDecision；resolution=双方 import 与调用链均保留；tests=tests/fork-version-policy.test.ts,tests/update-stop-first.test.ts
decision_package_json=official=version 2.39.0 与 package 表面；fork=install:local 与 ben 版本策略；resolution=保留官方表面并收敛为 2.39.0-ben.1；tests=tests/fork-version-policy.test.ts
external_actions=full_release；rebase 默认要求完成验证、双审和 annotated Fork Tag，再用一次 git push --atomic 同时更新 main、dev、sync/vX.Y.Z、upstream-release、Fork Tag 与官方 Tag，并创建 GitHub Release；仅用户明确叫停时中止
tests=tests/fork-maintenance-truth.test.ts,tests/fork-version-policy.test.ts
<!-- v239-rebase:end -->

## v2.39.0-ben.1 发布后 Cross-platform CI 修复候选

不可变 Release `v2.39.0-ben.1` 继续指向
`419a1bc7b327cf1183c05e73e9c9559fea221600`；本节记录后续 `dev` 修复候选，不移动、
删除或重建既有 Tag，也不把该修复误记为已包含在 ben.1 中。

- **失败证据：** Cross-platform CI 的 `main` run `33500137925` 与 `dev` run
  `33500138061` 均在 `tests/server-auth.test.ts` 的
  `websocket passthrough refreshes pool auth for each response.create turn` 失败；Linux
  `test 4/4` 与两个 macOS 全套均显示第一轮 Authorization 已提前变为刷新后的 credential，
  其余主体门禁通过。
- **根因：** fixture 在安装 fake clock/fetch 之前调用 `startServer()`，且
  `updateAccountQuota()` 在 fake clock 之前用真实墙钟写入 `updatedAt`。startup
  pool-quota prime 直接以 2027 fake clock 对比该 quota 时间戳，把本应新鲜的 quota 判为
  过期并在第一轮 WebSocket turn 前刷新 credential。
- **上游证据：** 官方后续分支提交 `33d32b6a34049480f5457358fcd3796260ae52a4`
  固定测试账户 namespace，`c8c8dc3387742c4efe98d1c7e0a1ed2d111d009b` 将 fake
  clock/fetch 提前到 server startup 之前，`523efb84e7e0513e2d892e68f6e68cfd8c3f5e0d`
  进一步把 quota seed 移到 fake clock 之后，但其 PR run `33492261941` 仍在同一断言失败；
  后续 `ecf51c67f89b45e29303b9c5be49678733008c2e` 同时后移 credential seed，run
  `33494259452` 才通过；这是完整 fixture 顺序的 CI 实证，不把 credential `replacedAt`
  误写成 startup stale filter 的直接输入。四者均不在正式 `v2.39.0` Tag 中。
- **最小修复：** 仅调整 `tests/server-auth.test.ts` fixture：用 `ws-refresh` namespace 固定
  `pool-a`，在启动 server 前安装 fake clock/fetch，并在 fake clock 下 seed credential 与
  quota；affinity fixture 在时钟推进 24 小时的同一同步段重新 seed quota，确保未等待的
  startup prime 无论何时取 snapshot 都不会访问真实 WHAM；保留 Fork 已有的“先注册
  terminal listener、再发送 frame”顺序，不修改生产 auth、quota 或 WebSocket 行为。
- **TDD/验证：** 新增 `updatedAt === fake now` 断言后，旧顺序稳定得到 expected
  `1800000000000` / received 真实墙钟的 RED；修复后两个相关用例 2 pass / 0 fail，CI
  shard 4 的精确 12 文件 batch 242 pass / 0 fail。
- **提交与远端 CI：** 修复提交 `d5833e9d551dfba77fda63b8f9bfd2b954ccd48c`
  已普通 fast-forward 推送到 `origin/dev`；Cross-platform CI run `33507959831` attempt 2
  最终成功。首次 attempt 唯一失败为未修改的 launcher SIGTERM fixture 启动超时；本地
  独立 10 轮共 30 个 signal 场景全部通过，失败 job rerun 后 macOS 全套与 aggregate `ci`
  均成功。该负载敏感边界未混入 ben.1，也不把一次 rerun 成功误记为 launcher 隔离改动。
- **dev/Release 解耦：** 用户明确 `dev` 可以在不发布新 Fork Release 的情况下继续提交和
  推送。已删除 `tests/release-version-line.test.ts` 及 dev-bump workflow 对它的调用；Fork
  `ben.N` Release 对 `scripts/bump-dev-version.ts` 为 no-op。普通 stable/preview 发布继续由
  release helper/workflow 保护；Fork `ben.N` 发布继续执行双审、严格 Tag namespace
  preflight、不可变 annotated Tag 与 atomic leased push。`forkVersionTagError()` 只保留为
  policy/reference test，不宣称为在线发布门禁。
- **交付边界：** 本修复只推进 `dev`；不移动 `main`、`sync/v2.39.0`、既有
  `v2.39.0-ben.1` Tag 或 GitHub Release，也不创建 `ben.2`。

## v2.39.0-ben.2 同基线维护修订

用户于 2026-09-01 明确要求创建 `ben.2`，因此本节取代上一节“本次不创建 `ben.2`”的
任务边界；不可变 `v2.39.0-ben.1` 及其 Release 不移动、不删除、不重建。官方基线仍是
正式稳定 Release `v2.39.0`，Tag commit 为
`af6113a0381d6fff2e4dce587652825c7eeb6423`，本修订不执行新的上游 rebase，也不声称包含
上游 `v2.39.0` 之后尚未进入正式稳定 Release 的开发分支能力。

- **实现提交：** `dcfd2001268e05744a1f9d7f50819138ac096669` 是 reviewer finding
  修复后重新固定且不得再重赋值的 `IMPLEMENTATION_HEAD`。它在 ben.1 Release commit
  `419a1bc7b327cf1183c05e73e9c9559fea221600` 之后包含五笔提交：
  `d5833e9d5` 修复 Cross-platform CI auth fixture 并解除普通 `dev` 与 Release version line
  的强耦合；`aafdf8716` 收敛 v2.39 发布与官方历史 Tag 真源；`5a8f227ba` 只把
  `package.json` 推进为 `2.39.0-ben.2`；`4b484aa74` 是双审前的候选维护文档提交；
  `dcfd20012` 修复权威发布规则中本地 `main` / `upstream-release` 必须在同一个
  `git update-ref --stdin` transaction 内 compare-and-swap 的契约与机械门禁。旧的
  `5a8f227ba` 不再是本轮发布实现 SHA。
- **修改面：** 相对官方 `v2.39.0` 为 170 个文件、`+27,643/-579`；相对不可变 ben.1
  Release 为 12 个文件、`+381/-317`。ben.1 后没有新增生产 runtime、Provider、adapter、
  GUI 或公共 API 能力；新增内容限定为测试 fixture、CI/version-bump 治理、发布规则与
  机械门禁、维护文档和版本行。
- **审查 finding 修复：** 初轮 `SPEC_COMPLIANCE` PASS；`CODE_QUALITY` 指出权威
  `docs/fork-sync-automation.md` 只要求对本地 main/marker 做 CAS，未绑定成 all-or-none
  transaction，可能在第二个 expected-old OID 失败时留下部分本地收敛。新增测试先因缺失
  `local-ref-cas-transaction` machine block 稳定 RED；`dcfd20012` 增加精确
  `start` / 两条携带 expected-old OID 的 `update` / `prepare` / `commit` 契约，在幂等恢复
  与发布第 13 步各引用一次，并禁止顺序执行；focused GREEN 为 18 pass / 0 fail /
  416 assertions。
- **目标 Tag：** `v2.39.0-ben.2`。创建 Tag 前已确认本地与 origin 的严格
  `v2.39.0-ben.*` namespace 只有 ben.1，且 ben.1 的 raw/peeled 身份仍为
  `a6cad328d74e3a5e49a46efe4de05167f002693e` /
  `419a1bc7b327cf1183c05e73e9c9559fea221600`。新 Tag 使用中文注释且为 annotated Tag，
  raw object 为 `43361f9b2a93617fd144558a5a590cd7196f4a58`，peeled 到只含
  `FORK_CHANGES.md` 的 `RELEASE_COMMIT=5f72ca85064898d660373af9e182d226e3c1d650`。
- **能力状态：** 现有 Fork runtime 能力与 ben.1 相同，继续按本文各能力节保留；本修订只把
  已在 `origin/dev` 验证成功的 auth fixture/dev Release 解耦修复正式纳入新 Release。
  删除 `tests/release-version-line.test.ts` 只解除普通 `dev` commit 的版本强绑定，不放宽
  Fork 发布的 immutable Tag、双审、严格 namespace 或 atomic leased push 门禁。
- **官方覆盖证据：** 官方 `v2.39.0` 不包含 `d5833e9d5` 的 Fork 测试/治理修复；上游
  `33d32b6a3`、`c8c8dc338`、`523efb84e`、`ecf51c67f` 是 Tag 之后的开发分支证据，不能
  当作新的正式稳定基线，也不能触发本轮 rebase。
- **验证结果：** 旧实现 `5a8f227ba` 的全部 PASS 已作废。绑定 `dcfd20012` 的
  local-ref CAS 测试先因缺少 machine block 得到 0 pass / 1 fail，修复后定向 1 pass /
  0 fail / 13 assertions、维护真源 18 pass / 0 fail / 416 assertions；workflow/版本/维护
  真源合计 173 pass / 0 fail / 1,879 assertions，auth focused 2 pass / 0 fail /
  13 assertions。Fork changed 门禁以 `origin/dev=aafdf8716` 为 merge base，识别 4 个变化
  文件并选中维护真源测试，18 pass / 0 fail / 416 assertions。第二次完整
  `bun run prepush` 为 17,158 pass / 14 skip / 0 fail / 402,749 assertions（1055 files），
  全部 serial lanes、typecheck、privacy scan 通过；无 GUI 变化，条件 GUI 门禁按规则跳过。
- **已知缺口：** 外部 Provider/Codex App/Windows 真机等既有缺口继续保留。发布后
  `dev` Cross-platform CI attempt 1 的唯一失败是 CL-07 inactivity fixture 仅用 50 ms
  窄裕量区分 750 ms inactivity timeout，在负载较高的 macOS runner 上子结果 I/O 先于
  延迟的父超时回调被处理，收到 `pass`；同 SHA 的 `main` 成功，本地 focused 连续 25 次
  通过，`dev` 失败 job attempt 2 也以 17,319 pass / 14 skip / 0 fail 闭环。该证据只说明
  当前 CI 成功，不能冒充生产 inactivity deadline 的确定性修复。Tag namespace 最终复核到
  atomic push 之间仍有无法对 future name 建立 wildcard lease 的 TOCTOU 残余风险。
- **发布边界：** 初轮 `SPEC_COMPLIANCE` PASS；`CODE_QUALITY` 的本地双 ref 单事务 CAS
  Important 已修复，第一次 `RE_REVIEW` 新报的维护真源状态 Important 也已修复，原两位
  reviewer 第二次 `RE_REVIEW` 均 PASS。一次 `git push --atomic` 已同时把远端 `main`、`dev`、
  `sync/v2.39.0` 与 Fork Tag peeled commit 更新到
  `RELEASE_COMMIT=5f72ca85064898d660373af9e182d226e3c1d650`，并把 `upstream-release` 与官方 Tag 更新到
  `af6113a0381d6fff2e4dce587652825c7eeb6423`；本地 `main` / marker 已用一个带
  `start` / `prepare` / `commit` 的 `git update-ref --stdin` transaction 完成 CAS。
  [`v2.39.0-ben.2`](https://github.com/Trendymen/opencodex/releases/tag/v2.39.0-ben.2)
  已公开发布，非 draft、非 prerelease、无额外资产且未发布 npm。exact Release commit 的
  `main` Cross-platform CI run `33518450797` 与 `dev` run `33518449906` attempt 2 均成功。

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

新的 annotated `v2.37.0-ben.3` Tag、candidate 验证、双审、用一次 `git push --atomic` 同时更新 `main`、`sync/v2.37.0`、`upstream-release`、Fork Tag 与官方 Tag、最终 main CI 与 Release 流程沿用 `docs/fork-sync-automation.md` 完整 15 步流程执行。

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
身份为 raw=peeled=`fc4de772b58c13f7b16b5029b1e981d612a5db06`，在发布用的同一次 `git push --atomic` 中补齐。
已存在 Tag 必须逐项 exact；任何 raw、peeled 或 type mismatch 都 fail closed，禁止 force、删除、
重建或移动。固定官方仓库仍是 provenance 来源，origin Tag 不是替代证据。

上述三个 run 分别保留为失败、失败和成功但 stale 的 predecessor evidence。当前
v2.35.0-ben.2 Tag：未发生；发布用 `git push --atomic`：未发生；Final main Cross-platform CI：未发生；
GitHub Release：未发生。新的 S2R candidate 与其后的所有外部门禁仍 pending。
<!-- ben2-s2r:end -->

<!-- ben2-external-gates:start -->
| Gate | Tagged snapshot state |
| --- | --- |
| S2R candidate Cross-platform CI | `pending external gate` |
| 发布用 `git push --atomic` | `pending external gate` |
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
`v2.35.0-ben.3` Tag、candidate Cross-platform CI、用一次 `git push --atomic` 同时更新 `main`、`sync/v2.35.0`、`upstream-release`、Fork Tag 与官方 Tag、最终 main
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

- **v2.42.0 当前复核：** 官方 `v2.42.0:src/adapters/openai-responses.ts`（blob
  `d9ec1fb01ab8dd36c99179c1fd1f12073ad84654`）新增 unknown usage/rawUsage 等能力，但仍未覆盖
  Fork 的方舟/智谱 schema lowering、trailing-user 与空 assistant 兼容。当前
  `src/fork/glm-kimi-compat.ts`（blob `64ce11986a7fc2391c7b8965256e55c16a2bfa72`）及
  `tests/fork-volcengine-empty-assistant-content.test.ts`（blob
  `95cfba92ac6e3ef6ee5fe27b62519f5a144b7862`）继续保留。

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
  上游已有 phase。普通 dashboard Provider `POST` 未携带该高级字段时保留已有规范化
  数组，避免无关编辑静默关闭能力；显式删除仍只接受 `PATCH null`。
- **代码：** `src/fork/responses-message-phase.ts`，以及 config、management API、
  eager relay、SSE rewrite 和 Responses core 的窄接线。
- **测试：** `tests/responses-message-phase-config.test.ts`、
  `tests/responses-message-phase-passthrough.test.ts`、
  `tests/responses-message-phase-rewrite.test.ts`、
  `tests/fork-provider-message-phase-config.test.ts`。
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
- **行为：** 只有当前 turn 保留的 `functions` namespace 内恰有一个 `custom:exec`，且
  lowering 事实与该声明一致时，才把模型输出的
  顶层 `functions.exec` / `web__run` 转成唯一声明的 `exec` custom tool。
  Fragmented adapter event 和 passthrough SSE 原子缓冲；畸形、歧义、重复、超预算或
  冲突调用进入现有 undeclared-tool guard。Chat/Claude 转换后的普通 `function:exec`、
  顶层 `custom:exec`、其他 namespace 与多重声明都不构成来源证明，不再触发修复。
  Continuation cache 只在客户端收到有效 terminal 后提交。
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

- **v2.42.0 当前复核：** 官方 `v2.42.0:src/adapters/openai-responses.ts`（blob
  `d9ec1fb01ab8dd36c99179c1fd1f12073ad84654`）的通用错误与 usage 保真仍未替代 Fork 的
  方舟配额客户端展示。当前 `src/fork/ark-quota-display.ts`（blob
  `a80fd68a576013788bce100179c5982e2adb63ba`）和 `tests/fork-ark-weekly-quota.test.ts`（blob
  `52e4b0b0d49438ffa5c14a12cba1c4f5eb704d35`）继续保留。

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

- **v2.42.0 当前复核：** 官方 `v2.42.0:src/config.ts`（blob
  `6cd87ef29f0e06a0d0980fab26b20080243975e3`）加入 Provider editor 等配置能力，但没有完整覆盖
  Fork customModels 与 stored tool mode。当前 `src/config/custom-models.ts`（blob
  `12a84dd14a674eda773a83a31f9923c740a0e213`）、`src/config.ts`（blob
  `94b3132f2093ada47de9c98fef1d0d9eda528df9`）、`src/server/management/model-routes.ts`（blob
  `0ff0d86069a58b6cd90c46b171a6bb0d1e04d3ac`）、
  `tests/fork-custom-model-config-schema.test.ts`（blob
  `269586b983374d4bd88c678a074ec975a3152bd7`）和
  `tests/fork-custom-model-tool-mode-contract.test.ts`（blob
  `a69dc95ff93c61e4fa4be4be1ec701f87797dfb8`）继续作为当前实现与回归锚点。

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
  普通 `OCX_DEBUG=1`、`ocx debug provider on`、GUI Provider debug 和 `install:local`
  默认 macOS provider debug 都只授权结构诊断，不授权 Response/reasoning 文本持久化。
  只有在 Provider debug 同时开启，并由独立、默认关闭的 `providerText`、
  `OCX_PROVIDER_TEXT_DEBUG=1`、`ocx debug provider-text on`、`PUT /api/debug` 的
  `{"providerText": true}` 或 GUI 的 `Response/reasoning text (persisted)` 开关明确授权后，
  才可捕获有界文本样本：每条字符串硬性 UTF-8 安全截断
  （默认 256B、上限 8KB），每轮至多 512 条，总量不超 live 诊断预算；样本存入
  引用型 provider-debug artifact 文件（redactSecretString 脱敏、目录/文件权限
  加固），`provider-debug.jsonl` 只携带结构摘要与相对引用。eager relay 通过
  `onClientChunk` hook 观测改写后真正下发到客户端的字节。
- **持久化边界：** `provider-debug.jsonl`、delta timeline 与文本 artifact 统一经
  `persistProviderDebugFile()` 写入：单文件上限 4 MiB、总量上限 16 MiB、最多 256 个文件、
  最长保留 7 天；主 JSONL 满额时 rollover，不截断既有 record。ownership 登记、过期/容量
  cleanup、canonical containment 或安全创建任一步不确定即拒写；symlink parent、symlink
  final file 与非普通文件均拒绝，新增文件使用 exclusive creation，并在平台支持时使用
  `O_NOFOLLOW`。诊断落盘失败仍不得影响 relay 请求。
- **代码：** `src/fork/outbound-debug.ts`、`src/fork/debug-persistence.ts`、
  `src/fork/glm-kimi-compat.ts` 的诊断部分，以及 `src/fork/inbound-response-debug.ts`
  与 `src/server/responses-terminal-repair.ts` 的 raw tap 接线；授权表面还包括
  `src/lib/debug-settings.ts`、`src/cli/debug.ts`、management API 与 GUI Debug 页面。
- **测试：** `tests/fork-debug-persistence.test.ts`、
  `tests/fork-kimi-schema-compiler.test.ts`、`tests/fork-inbound-response-debug.test.ts`、
  `tests/fork-provider-debug-safety.test.ts` 与对应 CLI/API/GUI focused 测试。
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
  `src/adapters/openai-responses.ts` 中的 reasoning input sanitizer；当前 stateful rewrite blob 为
  `2e6788be8544b26e1783c14ec79a7b2c7e798154`。
- `ben.3` 当前增强：content part 事件补完整的
  `reasoning_summary_part.added → reasoning_summary_text.delta → reasoning_summary_text.done → reasoning_summary_part.done`
  生命周期；有状态 block rewrite 按第三句或 500 code point 中先到的边界拆分，每个
  `summary_index` 独立闭合，后续 part 发出前先关闭前一 part。EOF 会 flush 未满首段与残余段；
  `output_item.done` 和缺失/空/null `response.completed.output` 都先关闭 pending 状态再发 terminal，
  `response.failed` / `response.incomplete` 同样在终态前关闭 pending summary，并把只出现在
  terminal output 的尾部 reasoning 纳入投影；duplicate/late `content_part.added` 不重复打开
  summary index。terminal 后迟到 raw/content close 被抑制，空 part 不伪造 `**Thinking**`。SSE `event:` 字段与
  重写后 JSON `type` 保持一致；terminal summary 继续保留原始 `reasoning_text`、
  `reasoning.content` 与 opaque replay state。
- **测试：** `tests/deepseek-reasoning-replay.test.ts`、
  `tests/responses-reasoning-summary-passthrough.test.ts`、
  `tests/responses-reasoning-summary-rewrite.test.ts`、
  `tests/responses-original-field-preservation.test.ts`、
  `tests/responses-reasoning-summary-lifecycle.test.ts`、
  `tests/responses-reasoning-summary-display-projection.test.ts`、
  `tests/responses-reasoning-summary-block-lifecycle.test.ts`、
  `tests/responses-reasoning-summary-block-edge-lifecycle.test.ts`、
  `tests/responses-reasoning-summary-block-terminal-failure.test.ts`（blob
  `08e1b5f4cf3406f057a90a6de5af4fbc34fbff00`）。
- **官方对比：** 官方已有普通 reasoning text → summary 与若干 replay 清理；Fork
  继续保留 opaque terminal、跨 Provider raw-backed blob 删除，以及上述多 part/EOF/稀疏终态
  展示兼容状态机；后者是 Fork 自定义兼容契约，不归因于上游作者原有行为。

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

- **v2.42.0 当前复核：** `v2.42.0:src/codex/inject.ts`（blob
  `cb8e1434b39dc03867734ed9683b76ee37c4ee89`）新增 Realtime WebSocket 配置注入；当前实现的
  `src/codex/inject.ts` blob 为 `e9c84ee64a529b841e8af1ae50eb414de8d4834d`，同时保留 Fork
  standalone web search 注入，两条能力在同一高频入口最小并存。

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

- **v2.42.0 当前复核：** `v2.42.0:src/providers/model-discovery.ts`（blob
  `ada0bd2aecc196e003d0b1720c96d864e4793dbc`）仍未包含 Fork 的 BigModel Codex 发现分支；当前
  `src/providers/model-discovery.ts`（blob `85ea01d624b128d56400f4b699b95b32517de639`）与
  `tests/zhipu-bigmodel-codex-provider.test.ts`（blob
  `df3e37ba680fb11650aa86fdef14f5629f20629a`）继续保留。

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

- **v2.42.0 当前复核：** `v2.42.0:src/server/responses/agent-task-recovery.ts`（blob
  `e1c35932ff4610251364078bbcb966f97465157b`）。官方 `v2.42.0` 仍只覆盖 turn termination 与通用
  recovery admission；Fork 行为：strict non-Fernet envelope recognition、admission、routed trigger
  与 fail-closed forwarding 继续由 Fork 窄模块与 `responses/core.ts` 接线承担。

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

- **v2.42.0 当前复核：** 官方 `v2.42.0:package.json`（blob
  `6c7c80d9e471282778d67df6c7bacfe511278cdb`）仍没有 `install:local`。当前
  `scripts/install-local-vendor.ts`（blob `6eccd1c64fd823e9189d19f89169b4ffb8d15a93`）、
  `scripts/install-local.ts`（blob `58326e840ea6c6608ae4658efff536533cbd08d6`）、
  `tests/fork-install-local-staging.test.ts`（blob `2ab483349ae32e81b3dacc64a222dce3c18f69c5`）、
  `tests/fork-install-local-manifest-lifecycle.test.ts`（blob
  `aa9580f645df7bf27ed71062cb6eb2265d3c2274`）和
  `tests/fork-install-local-guard-recovery.test.ts`（blob
  `05d24eb1b37ab7bf70c5a52d3adf261bba51c50e`）继续保留。

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
  install argv 复用同一 validated tarball/cache 与 offline/no-script 策略。validated tarball
  不再经过独立 `npm uninstall -g`：它先安装到 live package 同卷 sibling stage，完成
  package identity、entrypoint、dependency closure 与 GUI 资源验证后，才按
  `live -> backup`、`stage -> live` 交换；live 后验入口或 GUI 验证失败时恢复旧 package tree。
  所有 swap 在第一次 `live -> backup` rename 前写入 owner-only
  `.ocx-transaction.json`；默认 updater 在 live 验证成功后立即 commit，`install:local` 则以
  `deferCommit=true` 将 backup 和 marker 保留到配置、service repair/restart 与 `ready` 全部成功。
  completion guard、配置、restart 或 readiness 任一步失败都会先停止失败的新 runtime，再按
  marker 精确恢复旧 package，并重新启动旧 runtime；marker ownership mismatch、stop 失败、
  rollback/marker cleanup 失败都传播 `localInstallRecoverySafe=false`，禁止从不可信 package tree
  继续 `restart`/`ready`。启动恢复只处理 marker 指向且通过 canonical containment、普通目录、
  非 symlink/junction/reparse-point 校验的 backup；Windows service wrapper 同样读取 marker，
  不再按“最新 backup”盲选。scope 枚举失败返回 `action:"failed"`，不会执行不确定的清理或恢复。
  S8 进一步在 deferred handle 返回前捕获 canonical backup lookup 异常并立即回滚；backup root 与
  package 目录绑定 object identity，commit/rollback 前后拒绝替换对象。rollback 先 quarantine 新 live，
  复验旧树后才决定收敛；旧树严格验证失败时保留两棵树并写入结构化 recovery reason，启动探针
  不再自动把它覆盖到完整 live。即使 recovery marker 写入失败，dead owner + 完整 live + 现存 backup
  也保持 fail-closed；只有 live 缺失/损坏且 backup 通过通用 tree verifier 时才允许自动 restore。
  Windows wrapper 看到任何 recovery marker 都拒绝自动 restore，避免绕过更严格的本地 tree verifier。
  launcher 对该 `failed` 分类仍沿用上游 non-blocking warning-and-continue 语义，未声明为启动级
  fail-closed。
- **代码：** `scripts/install-local-vendor.ts`（blob `6eccd1c64fd823e9189d19f89169b4ffb8d15a93`）；
  事务化替换前的 `scripts/install-local.ts`（blob `e1f8f8d97db8cbeab97807c7733c5829cafb1276`）；
  当前 `scripts/install-local.ts`（blob `58326e840ea6c6608ae4658efff536533cbd08d6`）与
  `src/update/transactional-install.mjs`（blob `b8b047e8b450b96738eb2a3100139f6ca59755c9`）；
  Windows wrapper 接线位于 `src/service.ts`（blob `55734675faa9e111fc4a9d75b3fb159bc382fcd6`）。
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
  `tests/install-local.test.ts` 保留相邻生命周期回归；
  `tests/fork-install-local-transaction.test.ts` 覆盖 local tarball/offline argv、stage/live
  verifier、post-swap rollback 与双故障不 restart；
  `tests/fork-install-local-deferred-transaction.test.ts`（blob
  `45d705d1f30e2e295aaf8735e4bae227ea32a3c2`）覆盖 marker-before-rename、active/dead owner、
  deferred commit/rollback、配置/restart/readiness 失败、marker race/ownership、越界/symlink、
  scope 枚举和 recovery-unsafe 传播；`tests/fork-windows-service-pending-transaction.test.ts`
  （blob `51a84ad3d0b40792b0ddfdd7959b11fe6e340865`）固定 Windows marker-owned restore 脚本表面；
  `tests/fork-install-local-transaction-hardening.test.ts`（blob
  `a997d5d085bea4bd580b40d7ec82839e9575357a`）覆盖 canonical handle failure、recovery marker
  no-follow/0600、backup identity 替换、strict rollback verification、quarantine 双树保留与
  Windows path casing。
  这些仍是 isolated/unit/static 证据；本轮未执行真实全局替换、真实 service stop/restart 恢复或
  Windows PowerShell/junction 动态运行。
- **官方对比：** 官方 `v2.39.0` 与当前 `v2.40.0` 均没有同等本地源码安装器。

### GUI Logs/Debug 恢复标签与 sidecar 契约

- **v2.42.0 当前复核：** 官方 `v2.42.0:gui/src/pages/Logs.tsx`（blob
  `0bbe286a887d6f811c9243d53e544cf4928700cd`）与
  `v2.42.0:gui/src/pages/Debug.tsx`（blob `05207fbb9097dc665c94fdef24d665782ac2f9ce`）已纳入新功能，
  Fork 当前仍在 `gui/src/pages/Logs.tsx`（blob `6152ade45c77fd127fc118225b252224efaf0f27`）和
  `gui/src/pages/Debug.tsx`（blob `988053cf9176ef234bc4ee6ef2b5fda2af96d448`）保留诊断阶段、恢复种类与
  sidecar 展示差异。当前 locale blob：`gui/src/i18n/de.ts`（blob
  `8861129f27ef3c23b2b15811bf39fd4323030ac4`）、`gui/src/i18n/en.ts`（blob
  `cde3e9adf60a32429acd8c818fea9a2dfb2e0978`）、`gui/src/i18n/fr.ts`（blob
  `a8556cdc643884c36f0192128fd5b45711db3054`）、`gui/src/i18n/ja.ts`（blob
  `418254870f0b8ad1e2dcc8924d65cd57d22ec6d6`）、`gui/src/i18n/ko.ts`（blob
  `907be16fe8d0f2f3b07e6eb0846ea7e2e4e619b8`）、`gui/src/i18n/ru.ts`（blob
  `2551c237240ef49bb37ef4a65ba98603d62e1d70`）、`gui/src/i18n/tr.ts`（blob
  `4e092b19d246d349a7c2b262fc63d4174109e87f`）、`gui/src/i18n/zh-TW.ts`（blob
  `070290392d039ce3c0551ec20f45a23b74d73dfd`）、`gui/src/i18n/zh.ts`（blob
  `88c018da067369ad2f3b45311dd3781e35672b18`）。`gui/tests/sidecar-layout.test.ts`（blob
  `e140a627260bbf952708e7f710874a5f76cc5b2b`，与官方 v2.42.0 相同）继续固定布局边界。

- **状态：** 官方已有页面能力；Fork 只保留 recovery label 增量，sidecar 回归与官方对齐。
- **行为：** Logs/Debug tab、hash source of truth、lazy-mounted Debug 与 viewer 仍由官方
  `v2.39.0` 页面能力提供；Fork 在 Logs attempt detail 增加
  `agent-task-recovery`、`oauth-account-429`、`opaque-blob-rejection` 三种 recovery kind
  映射，并为全部 9 个 locale 提供对应翻译。`Debug.tsx` 本身与官方相同，不宣称为 Fork
  独有 runtime。sidecar 本轮只删除重复且与 vertical control-band 冲突的旧断言，生产
  CSS 未修改。
- **代码：** `gui/src/pages/Logs.tsx`（blob `3cd4c4684b86a0506e154388aa5d82686b1db674`）；
  `gui/src/pages/Debug.tsx`（blob `05207fbb9097dc665c94fdef24d665782ac2f9ce`，与官方 v2.39.0 相同）。
- **9 locale：** `gui/src/i18n/de.ts`（blob `9bfe68212c4c6903d68a8a1c7ddba68eec700d0b`）；
  `gui/src/i18n/en.ts`（blob `d8888146b824876177c8ca0a391ec50dbecdb88e`）；
  `gui/src/i18n/fr.ts`（blob `daf41357d9829568cf927d3571f7fabe1c617b68`）；
  `gui/src/i18n/ja.ts`（blob `f23b0a209a6c2b6171e7edfc6c6ce8f7b5e2ba94`）；
  `gui/src/i18n/ko.ts`（blob `ceed436976c8a79c449468e1213f02314550cb03`）；
  `gui/src/i18n/ru.ts`（blob `a1d6d15c3481eb95a108c94d92df83b792c9a687`）；
  `gui/src/i18n/tr.ts`（blob `116549be44eacaf9a65494cf89b51cb54163dd04`）；
  `gui/src/i18n/zh-TW.ts`（blob `6b7cb7dc6c663ffcc5b0f2c7a690631ce0e23b2a`）；
  `gui/src/i18n/zh.ts`（blob `60228bcddf5df7442414d9b1a934a4f6f7b5c281`）。
- **当前 9 locale：** 本轮增加独立 `providerText` 开关后，当前锚点为
  `gui/src/i18n/de.ts`（blob `babc4f325610028f8daa3267b4ec4d22647aa0d8`）、
  `gui/src/i18n/en.ts`（blob `fc3897b888f679d590ebce97feda64a2ab0cb8a0`）、
  `gui/src/i18n/fr.ts`（blob `26e88f99ec5e3553c51e5f04abe117c0ce565b67`）、
  `gui/src/i18n/ja.ts`（blob `30794a660afa4c0bebfe4e307bd809ec4bf03edb`）、
  `gui/src/i18n/ko.ts`（blob `90278b28ebc4948e1845006235717ceb3b6f0e2c`）、
  `gui/src/i18n/ru.ts`（blob `9312829c66763eb003e6e62b57a5c2e5c89a1666`）、
  `gui/src/i18n/tr.ts`（blob `49f9257e52ca7840ffcf41eb98b37e2477403ed3`）、
  `gui/src/i18n/zh-TW.ts`（blob `d853de16e4f9b830f96284c78e494a0accf91daf`）、
  `gui/src/i18n/zh.ts`（blob `2adda0a8075250d0cc29836c8c640a5a63a7d9d7`）。
- **sidecar：** `gui/tests/sidecar-layout.test.ts`（blob `e140a627260bbf952708e7f710874a5f76cc5b2b`，与官方 v2.39.0 相同）；
  `gui/src/styles-dashboard-workspace.css` blob `2b854f57c1b66a9ad4cc0e53fef421f7cf14fc5f`
  也与官方相同。提交 `1476108b3` 是测试契约修正，不是新 CSS 能力。

### install-local 默认开启 macOS provider debug

- **状态：** Fork 独有——仅限本地安装脚本。
- **行为：** 本地包替换成功后，已有 macOS launchd 服务先 repair，再使用 `plutil`
  结构化写入 `EnvironmentVariables.OCX_DEBUG=1`，lint 后 unload/load。`--no-restart`
  只更新磁盘 plist；无服务的 Darwin 前台 `ocx start` 子进程继承 `OCX_DEBUG=1`；
  非 Darwin 保持原环境并跳过 launchd。该默认值只开启结构 debug；脚本不设置
  `OCX_PROVIDER_TEXT_DEBUG`，不构成 Provider Response/reasoning 文本持久化授权。
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

- **v2.42.0 当前复核：** 官方 `v2.42.0:package.json`（blob
  `6c7c80d9e471282778d67df6c7bacfe511278cdb`）只提供正式版版本号；当前
  `src/fork/version-policy.mjs`（blob `7c9e93828220d323c1c478814c70d9a93e547f9c`）与
  `tests/fork-version-policy.test.ts`（blob `40d080512c44e077875529d3969b781e5773e998`）继续负责
  `ben.N` 单调、同基线与不可变 Tag 规则。

- **状态：** Fork 独有——保留。
- **包版本：** 官方稳定版 `X.Y.Z` 对应 Fork 包版本 `X.Y.Z-ben.N`。当前为
  `2.40.0-ben.3`；`v2.40.0-ben.1`、`v2.40.0-ben.2`、`v2.39.0-ben.*` 及更早 Tag
  保留为历史不可变修订。
  `N` 从 1 开始且必须是安全整数；
  `ben.0`、前导零、超安全整数或其他 suffix 不属于该策略。
- **更新语义：** 官方同基线稳定版与当前 Fork 等价，不允许显式 `ocx update` 用同基线
  官方包覆盖 Fork；recognized `X.Y.Z-ben.N` current 会先比较 official base，再比较同基线
  `ben.N`：较低 base 或较低 revision 返回 `"older"`，相同 revision/同基线 stable 返回
  `"same"`，较高 base/revision 返回 `"proceed"`。latest channel 的 null、malformed、preview/rc
  target 返回 `"unresolved"`，Bun updater 与 Node npm launcher 都在 integrity/cache/stop/install
  前拒绝。显式 preview channel 只接受 canonical `preview.<identifier...>`；普通非 Fork current
  继续保持 legacy exact-equality/proceed 行为。
- **Tag 语义：** Git Tag 使用 `vX.Y.Z-ben.N`。必须存在对应官方 `vX.Y.Z` Tag；Fork
  对每个已 rebase 官方基线在 origin 保留同名、与固定官方仓库 type/raw/peeled 完全一致的
  official Tag。缺失只能在发布用的同一次 `git push --atomic` 中以已验证 raw ref 补齐；已存在的任一字段
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
- **代码：** `src/fork/version-policy.mjs` 的 ben 策略原锚点为
  `src/fork/version-policy.mjs`（blob `1c9351fea6dd28f5d70fb945c37e5ac46536a7b6`）；本轮加入
  monotonicity guard 后，当前 `src/fork/version-policy.mjs`（blob
  `7c9e93828220d323c1c478814c70d9a93e547f9c`）、
  `src/fork/version-policy.d.mts`；
  `src/update/notify.ts`、`src/update/index.ts` 和 `bin/ocx.mjs` 只保留窄接线。
- **测试：** 官方对比使用的原锚点为 `tests/fork-version-policy.test.ts`（blob
  `40c1092241345b88c3c26756bca1d3d59586f501`）；S7 当前文件 blob 为
  `40d080512c44e077875529d3969b781e5773e998`。Node/Bun 策略、same-base late `ben.3` 与
  immutable current Tag 均覆盖；
  `tests/fork-update-downgrade.test.ts` 单独覆盖较低 stable target；
  `tests/fork-update-monotonicity.test.ts`（blob `3e952e9050fd0d05f0133c641c1f540e60706fa2`）
  覆盖同基线较低/相同/较高 revision、malformed latest、canonical preview，以及 Node
  package-shaped launcher 在副作用前拒绝 lower/malformed target。Bun 路径当前仍以共享策略和
  源码顺序断言为主。原 `tests/release-version-line.test.ts` 已按用户规则移除：普通 `dev`
  提交不再强制绑定新 Release 版本。普通 stable/preview 发布仍由 release helper/workflow
  保护；Fork `ben.N` 发布仍由双审、严格 Tag namespace preflight、immutable annotated Tag
  与 atomic leased push 保护。
- **官方对比：** 官方 `v2.39.0` 没有该 Fork ben 版本与 Tag 策略。
- **前端边界：** 按用户要求不修改 `gui/src/App.tsx` 或 CSS。GUI 继续通过现有链路显示
  真实版本，视觉缩短仅来自实际包版本从 `2.34.1-trendymen.1` 改为 `ben` 系列。

### 默认测试 runner 与负载敏感隔离

- **v2.42.0 当前复核：** 官方 `v2.42.0:tests/update-stop-first.test.ts`（blob
  `95b6bd53daf1ef37b0fd2044aad8909cb0657355`）保留当前上游时序修复。Fork 当前
  `src/responses/state.ts`（blob `6d8c6a3a96937c61ed7af9d806cd344f0e1fddab`）、
  `tests/responses-state.test.ts`（blob `7cf404ce199696f8537706477cf5f4df8fb67329`）和
  `tests/shutdown-launcher.test.ts`（blob `de149926fc7afea9af41c461f3dfa1f2e0990be7`）继续固定
  spill/shutdown 与真实 Node launcher 行为；不以串行模式或放宽 timeout 替代默认门禁。

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
  `src/responses/state.ts`（blob `b95a1fa2c6d36b9b43269af60d51f5a64e6754ec`）、
  `tests/responses-state.test.ts`（blob `1a4d0a253b4d5991c332de114b34127dd6f30cf3`）。
- **代码：** `tests/shutdown-launcher.test.ts`、`tests/update-stop-first.test.ts`、
  `tests/cli-status-json.test.ts`。
- **官方对比：** `v2.39.0:tests/update-stop-first.test.ts`（blob
  `d20eafb5c7051744168d7ce649186c49da789d8e`，merge
  `fe063d16ef620a148ab425cfffe63a8936d00e52`）已包含 recovery PID cleanup、
  `UPDATE_SPAWN_TIMEOUT_MS`/`PROXY_READY_TIMEOUT_MS` 派生预算，以及 cleanup 后才
  `rmSync` 的防 orphan 顺序。该官方文件不含 `nodeExecutable`；该 token 只出现在当前
  Fork `tests/shutdown-launcher.test.ts`（blob `c576243cb4fd92829ebb812c98ee254c42942183`）
  明确以 `process.execPath` 绕开
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

- **v2.42.0 当前复核：** 本轮必须在当前 `2.42.0-ben.1` 精确候选上重新运行默认并发
  `bun run prepush`、privacy scan 与双审；任何 v2.40 的旧绿灯均不作为本轮证据。本轮
  A1/A2 两次默认 4x prepush 均如实记为失败；用户随后对本轮明确豁免再次运行全量门禁
  与等待远端 CI，但没有豁免精确 focused、typecheck、privacy scan、diff check 或双审。

- **状态：** 官方部分覆盖——保留 Fork 基线门禁。
- **证据：** `prepush` package script 与 `v2.39.0` 一致；Fork 只新增
  `.github/workflows/ci.yml` 的 origin-only 官方基线验证，精确验证 official ref 的
  lightweight/annotated 类型、raw/peeled commit、official main ancestry 与
  `origin/upstream-release` marker。官方 `v2.39.0` 的实测 ref type 为 `commit`，其
  raw/peeled/marker 均为 `af6113a0381d6fff2e4dce587652825c7eeb6423`；因此不得再把
  annotated-only 写成 provenance 要求。这不是对官方 CI 的替代，也不把 workflow 扩展为
  生产运行时能力。runner-local official ref proof 每轮重新验证；Fork origin 必须保留每个
  已 rebase 基线的同名 exact official Tag，但固定官方 URL 而非 origin 始终是 provenance
  来源。缺失 Tag 只能在发布用的同一次 `git push --atomic` 中补齐，existing mismatch 必须 fail closed。

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
   `OCX_DEBUG=1`；本轮未执行真实长期运行的磁盘留存验收。ownership manifest 对 unique
   artifact 路径的登记仍会单调增长，达到自身上限后会 fail closed，当前不宣称 manifest
   会自动压缩。Node 平台 API 不提供通用 `openat`，当前父组件、canonical containment、
   final file、`O_NOFOLLOW` 与 exclusive creation 防护仍有父目录被并发替换的残余竞态。
4. **安装器：** owner-only staging、offline archive validation、pending transaction 与 Bun
   probe 的 unit/static 通过不替代真实全局 package replacement 与服务模式恢复；Windows
   PowerShell wrapper/junction containment 仍需平台实跑。pending owner 使用 PID，PID reuse 与
   fsync/断电持久化仍是 residual；path identity 检查到 rename/remove 之间仍存在无法由 Node
   通用 API 完全消除的 TOCTOU。多重文件系统故障可能留下 marker 指向的人工恢复状态或
   `.ocx-failed-live-*` quarantine，但当前实现不会为自动恢复删除一个已占用 live path。
   `bootRestoreProbe()` 的失败分类不会执行不安全恢复，但 Node launcher 延续上游
   warning-and-continue，尚未完成损坏安装下的启动级动态验收。
5. **Windows 与 updater：** package-shaped npm launcher 子进程测试在 Windows 跳过；Bun
   `runUpdate()` 尚无真实 package-shaped 子进程 smoke，依赖共享策略、源码顺序断言与 CI。
   GUI update badge 仍不显示同基线更高 `ben.N`，preview badge parser 仍只覆盖既有单数字形态，
   均不是本轮发布目标。
6. **外部 Provider：** weekly quota、empty-assistant 与 custom model focused test 和 HTTP
   success 都不能替代真实 Provider/Codex App terminal 分层记录；
   相关能力变化后必须记录 Provider/模型、客户端终态与脱敏 outbound shape。
7. **同基线发布竞态：** 完整远端 ben namespace 的最终复核到 atomic push 之间无法对
   尚不存在的 differently named future Tag 建立 wildcard lease；依赖 single publisher，
   push 后必须在 GitHub Release 前复核，发现竞态时保留 immutable Tag 并停止 Release。
8. **上游版本边界：** 官方 `v2.39.0` 的两个 Fork Tag 均保持不可变；官方 `v2.40.0` 已
   发布 `v2.40.0-ben.1`，固定 `IMPLEMENTATION_HEAD=df73ecba72a50739e4060133928d5cb16d15bf4f`、
   `RELEASE_COMMIT=f219dc999012c56ecf3b74e1fe66f4f89311d25b`。后续新开发从 advanced
   `dev` 继续，不得重置回旧 Release。
9. **并行工作区：** 本清单只按 committed SHA 计算，绝不因工作区中恰好存在其他任务
   文件而把它们混入提交或能力清单。
10. **React Doctor：** `prepush` 对 changed GUI 报告 3 个官方 `v2.40.0` 测试文件中的
    `eslint/no-unused-vars`：`tests/codex-stale-banner.test.ts:11`、
    `tests/connect-pairing.test.ts:1`、`tests/provider-capacity-shell.test.tsx:300`。三者均不在
    Fork 相对官方的 diff 中，GUI lint 已通过，因此本轮按最小修改面不混入修复。
11. **Reasoning 合成事件：** 多 part/EOF/稀疏终态生命周期已有 focused 覆盖，但合成事件
    没有统一分配新的 `sequence_number`，closed-state 保留到 terminal teardown；当前 relay 会在
    terminal 后 dispose，真实第三方 Provider/Codex App 流仍需独立动态验收。

## Fork 版本、Tag 与 GitHub Release 规则

1. 官方稳定 `vX.Y.Z` 第一次完成派生 rebase 时，包版本设为 `X.Y.Z-ben.1`，创建带
   `v` 的 Git Tag `vX.Y.Z-ben.1`。
2. 同一同步任务重复执行必须幂等；不得因 heartbeat 重跑自动生成 `ben.2`。
3. `ben.2`、`ben.3` 等只在用户明确要求同一官方基线再做一次 Fork 修订时创建；每次
   revision 都必须更新包版本、本文档、Tag 与 Release。
4. 发布瞬间，`main`、`dev`、本轮 `RELEASE_SYNC_REF=refs/heads/sync/vX.Y.Z` 和最新
   `vX.Y.Z-ben.N` 的 peeled commit 必须完全等于 `RELEASE_COMMIT`。同一官方基线始终复用
   这一个 sync ref，并允许用发布前固定的精确 expected-OID lease 强制更新；禁止创建
   `sync/vX.Y.Z-ben.N`。`upstream-release` 始终等于未经修改的 `OFFICIAL_COMMIT`。发布后若
   `dev` 已有新开发提交，自动化不得把它重置回旧 Release。
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
   再用一次 `git push --atomic` 同时更新 `main`、`dev`、`sync/vX.Y.Z`、`upstream-release`、Fork Tag 和官方 Tag，并以显式 branch lease 收敛分支引用。Tag refspec 不使用 force
   或 lease。不得启动新 rebase 或生成 `ben.(N+1)`。

在任何幂等收敛 push 前，必须完成 fixed-upstream type/raw/peeled/ancestry 验证；origin
official Tag absent-or-exact preflight 必须确认当前 `refs/tags/vX.Y.Z` 不是缺失就是与固定
官方 raw/peeled/type 完全一致，existing mismatch 阻塞。pre absent/exact，post exact：若预检
缺失，必须只把已验证的官方 raw ref 纳入本次原子 push 后补齐；若预检 exact，不得重建。

`git push --atomic origin` 必须使用下列唯一完整 refset：

<!-- official-atomic-refset:start -->
branch|main|leased-force|RELEASE_COMMIT:refs/heads/main
branch|dev|leased-force|RELEASE_COMMIT:refs/heads/dev
branch|sync|leased-force|RELEASE_COMMIT:refs/heads/sync/vX.Y.Z
branch|marker|leased-force|OFFICIAL_COMMIT:refs/heads/upstream-release
tag|official|no-force-no-lease|refs/tags/vX.Y.Z:refs/tags/vX.Y.Z
tag|fork|no-force-no-lease|refs/tags/vX.Y.Z-ben.N:refs/tags/vX.Y.Z-ben.N
<!-- official-atomic-refset:end -->

<!-- fork-release-lifecycle:start -->
rebase_branch=dev
rebase_request=full_steps_1_to_15_unless_user_explicitly_stops
sync_role=single-mutable-release-pointer-per-official-baseline
release_instant_dev=must-equal-RELEASE_COMMIT
post_release_advanced_dev=must-not-reset
sync_update=exact-oid-leased-force-to-RELEASE_COMMIT
final_convergence=local-remote-main-dev-RELEASE_SYNC_REF-fork-tag-equal-RELEASE_COMMIT
<!-- fork-release-lifecycle:end -->

<!-- sync-audit-ref-policy:start -->
ref_scope=single-mutable-ref-per-official-baseline
release_sync_ref=refs/heads/sync/vX.Y.Z
revision_specific_ref=forbidden
initial_creation=expected-absent-lease
existing_update=exact-oid-leased-force-allowed
ancestry_requirement=none
release_instant=main-dev-RELEASE_SYNC_REF-fork-tag-equal-RELEASE_COMMIT
<!-- sync-audit-ref-policy:end -->

<!-- local-ref-cas-transaction:start -->
transport=git-update-ref-stdin
transaction=start-prepare-commit
main_update=refs/heads/main RELEASE_COMMIT EXPECTED_OLD_LOCAL_MAIN
sync_update=refs/heads/sync/vX.Y.Z RELEASE_COMMIT EXPECTED_OLD_LOCAL_SYNC
marker_update=refs/heads/upstream-release OFFICIAL_COMMIT EXPECTED_OLD_LOCAL_MARKER
atomicity=all-or-none
sequential_updates=forbidden
<!-- local-ref-cas-transaction:end -->

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

同基线 maintenance revision 还必须执行完整 local/origin `vX.Y.Z-ben.N` name/raw/peeled
phase-aware preflight；pre-push 只允许本地精确目标 Tag 增量，post-push 只允许远端同一
精确对象增量。每阶段重算最高 revision，其他漂移 fail closed；确定成功也必须在 GitHub
Release 前复核。final recheck 到 push 的 future-name namespace 竞态作为残余风险保留。

四个 branch 使用各自 exact lease；`main`、`dev`、`RELEASE_SYNC_REF` 与 marker 均允许按发布策略
force。`RELEASE_SYNC_REF` 始终为 `refs/heads/sync/vX.Y.Z`：首次不存在时使用 expected-absent
lease，已存在时紧邻 push 重读并使用精确 expected-OID lease；允许 non-fast-forward，不要求
ancestry。实际 sync refspec 为 `+RELEASE_COMMIT:refs/heads/sync/vX.Y.Z`。两个 Tag 均不使用
force 或 lease。出现 revision-specific sync ref、lease 漂移或确定失败时停止；
uncertain 只允许以相同完整 refset 重试，且必须重新读取 branch lease 与两个 Tag 的
raw/peeled/type。

sync 的 force 权限只属于当前发布动作：远端已存在时，atomic push 紧邻前重新读取
`refs/heads/sync/vX.Y.Z` 并确认仍等于 `EXPECTED_REMOTE_RELEASE_SYNC`，再使用精确 expected-OID
lease；首次不存在时重证 absent 并使用 expected-absent lease。禁止 ancestry/fast-forward
门禁覆盖该维护版强推，也禁止 blanket force/lease 代替逐 ref CAS。

3. 若远端 atomic push 已完成但本地 `main`、`sync/vX.Y.Z`、`upstream-release` 任一尚未
   对齐，必须严格按 `local-ref-cas-transaction` 在一个带 `start` / `prepare` / `commit` 的
   `git update-ref --stdin` transaction 中执行三 ref CAS；三个 update 分别携带
   `EXPECTED_OLD_LOCAL_MAIN`、`EXPECTED_OLD_LOCAL_SYNC`、`EXPECTED_OLD_LOCAL_MARKER`，任一
   比较失败都不得部分更新，禁止拆成顺序命令。
4. 若 Tag 已存在但 Release 缺失或元数据不合格，则只创建或修正同名 Release；必须确认
   `isDraft=false`、`isPrerelease=false`、标题等于 Tag，且中文 Notes 含官方基线、Fork
   修改点、验证结果、已知缺口与 commit。
5. 只有上述状态全部满足，且没有更新的官方稳定 Release，才允许记录“无需同步”。

## 每次稳定版 rebase 的强制流程

1. 查询 GitHub Releases，只接受非 draft、非 prerelease 的官方稳定 Release；确认 Tag
   commit 可从 upstream `main` 到达。
2. 要求工作树、索引干净且没有进行中的 Git 操作。记录本地/远端 `main`、`dev`、
   `upstream-release`、`refs/heads/sync/vX.Y.Z` 和目标 Fork Tag 的现有 SHA；固定本轮
   `RELEASE_SYNC_REF=refs/heads/sync/vX.Y.Z`，发现本基线 revision-specific sync ref 即停止。
3. 保护已有候选历史：远端 dev 与 sync 存在时必须 fetch 并记录 lease；候选固定为来源明确、
   已提交且干净的 `dev`。远端独有、分叉来源不明或 lease 无法固定时停止。
4. 在 `dev` 上执行等价于
   `git rebase --onto <new-tag-sha> <old-upstream-release-sha> dev`；rebase 阶段不得移动
   `main`，不得在 detached HEAD 上验证，也不得在任何 sync ref 上 rebase。完成最终验证
   和末尾文档提交后，才可准备本轮 `RELEASE_SYNC_REF` 指向同一 `RELEASE_COMMIT`。
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
    同步四个 branch、已验证的 official Tag 与完整本地 Fork Tag ref；`main`、`dev`、sync、
    marker 均使用各自 ref-scoped force-with-lease。sync 固定使用
    `+RELEASE_COMMIT:refs/heads/sync/vX.Y.Z`，已存在时使用发布前捕获的精确 expected-OID，
    不要求 ancestry 或 fast-forward。任一 branch lease 漂移、出现 revision-specific sync ref、
    远端 Tag 已存在但不一致、
    atomic 不支持或推送失败都 fail closed，不拆成可能部分成功的多次 push。

在 stable rebase 发布前，必须完成 fixed-upstream type/raw/peeled/ancestry 验证；origin
official Tag absent-or-exact preflight 必须读取 `refs/tags/vX.Y.Z` 的 type、raw OID 与
peeled commit，existing mismatch 阻塞。pre absent/exact，post exact：缺失时仅可将固定官方
验证后的 raw ref 放入本次 atomic refset，已存在且 exact 时保持不变。

`git push --atomic origin` 必须使用下列唯一完整 refset：

<!-- official-atomic-refset:start -->
branch|main|leased-force|RELEASE_COMMIT:refs/heads/main
branch|dev|leased-force|RELEASE_COMMIT:refs/heads/dev
branch|sync|leased-force|RELEASE_COMMIT:refs/heads/sync/vX.Y.Z
branch|marker|leased-force|OFFICIAL_COMMIT:refs/heads/upstream-release
tag|official|no-force-no-lease|refs/tags/vX.Y.Z:refs/tags/vX.Y.Z
tag|fork|no-force-no-lease|refs/tags/vX.Y.Z-ben.N:refs/tags/vX.Y.Z-ben.N
<!-- official-atomic-refset:end -->

<!-- fork-release-lifecycle:start -->
rebase_branch=dev
rebase_request=full_steps_1_to_15_unless_user_explicitly_stops
sync_role=single-mutable-release-pointer-per-official-baseline
release_instant_dev=must-equal-RELEASE_COMMIT
post_release_advanced_dev=must-not-reset
sync_update=exact-oid-leased-force-to-RELEASE_COMMIT
final_convergence=local-remote-main-dev-RELEASE_SYNC_REF-fork-tag-equal-RELEASE_COMMIT
<!-- fork-release-lifecycle:end -->

<!-- sync-audit-ref-policy:start -->
ref_scope=single-mutable-ref-per-official-baseline
release_sync_ref=refs/heads/sync/vX.Y.Z
revision_specific_ref=forbidden
initial_creation=expected-absent-lease
existing_update=exact-oid-leased-force-allowed
ancestry_requirement=none
release_instant=main-dev-RELEASE_SYNC_REF-fork-tag-equal-RELEASE_COMMIT
<!-- sync-audit-ref-policy:end -->

<!-- local-ref-cas-transaction:start -->
transport=git-update-ref-stdin
transaction=start-prepare-commit
main_update=refs/heads/main RELEASE_COMMIT EXPECTED_OLD_LOCAL_MAIN
sync_update=refs/heads/sync/vX.Y.Z RELEASE_COMMIT EXPECTED_OLD_LOCAL_SYNC
marker_update=refs/heads/upstream-release OFFICIAL_COMMIT EXPECTED_OLD_LOCAL_MARKER
atomicity=all-or-none
sequential_updates=forbidden
<!-- local-ref-cas-transaction:end -->

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

同基线 maintenance revision 还必须执行完整 local/origin `vX.Y.Z-ben.N` name/raw/peeled
phase-aware preflight；pre-push 只允许本地精确目标 Tag 增量，post-push 只允许远端同一
精确对象增量。每阶段重算最高 revision，其他漂移 fail closed；确定成功也必须在 GitHub
Release 前复核。final recheck 到 push 的 future-name namespace 竞态作为残余风险保留。

四个 branch 使用各自 exact lease；`main`、`dev`、`RELEASE_SYNC_REF` 与 marker 均允许按发布策略
force。`RELEASE_SYNC_REF` 始终为 `refs/heads/sync/vX.Y.Z`：首次不存在时使用 expected-absent
lease，已存在时紧邻 push 重读并使用精确 expected-OID lease；允许 non-fast-forward，不要求
ancestry。实际 sync refspec 为 `+RELEASE_COMMIT:refs/heads/sync/vX.Y.Z`。两个 Tag 均不使用
force 或 lease。出现 revision-specific sync ref、lease 漂移或确定失败时停止；
uncertain 只允许以相同完整 refset 重试，并且先重新证明所有 branch leases 和两个 Tag 的
type/raw/peeled。

sync 的 force 权限只属于当前发布动作：远端已存在时，atomic push 紧邻前重新读取
`refs/heads/sync/vX.Y.Z` 并确认仍等于 `EXPECTED_REMOTE_RELEASE_SYNC`，再使用精确 expected-OID
lease；首次不存在时重证 absent 并使用 expected-absent lease。禁止 ancestry/fast-forward
门禁覆盖该维护版强推，也禁止 blanket force/lease 代替逐 ref CAS。
12. 远端 atomic push 成功后、调用 GitHub Release API 前，使用之前捕获的本地旧 OID
    作为 compare-and-swap 条件，在一个 `git update-ref --stdin` transaction 中把本地
    `main` 与 `sync/vX.Y.Z` 对齐末尾文档 commit、把本地 `upstream-release` 对齐官方 Tag
    commit；三条 update 任一 CAS 失败都不得部分生效。随后刷新/核对 remote-tracking refs。即使后续
    Release 创建失败，本地/远端 branch 状态也必须保持已收敛。
13. Git 引用与本地 branch 收敛后，创建或核对同名 GitHub Release。必须查询并验证 `tagName`、
    `name`、`body`、`isDraft=false`、`isPrerelease=false` 和 URL；元数据不合格时只做
    幂等 Release 修正。创建或修正失败时保留已经推送的不可变 Tag，任务标记未完成，
    下次重试只处理 Release。
14. 最终确认发布瞬间本地/远端 `main`、`dev`、本轮
    `RELEASE_SYNC_REF=refs/heads/sync/vX.Y.Z` 和 Fork Tag peeled commit 全部等于
    `RELEASE_COMMIT`，且不存在本基线 revision-specific sync ref；`upstream-release` 等于
    `OFFICIAL_COMMIT`，GitHub Release 指向该 Fork Tag；发布后 advanced dev 不得被自动
    重置回该旧 `RELEASE_COMMIT`。

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

# 远端 atomic push 成功后，以发布前捕获的三个本地旧 OID 做单事务 CAS。
git update-ref --stdin <<'EOF'
start
update refs/heads/main RELEASE_COMMIT EXPECTED_OLD_LOCAL_MAIN
update refs/heads/sync/vX.Y.Z RELEASE_COMMIT EXPECTED_OLD_LOCAL_SYNC
update refs/heads/upstream-release OFFICIAL_COMMIT EXPECTED_OLD_LOCAL_MARKER
prepare
commit
EOF

# Fork Tag 与 Release。
test "$(git cat-file -t refs/tags/<fork-tag>)" = "tag"
git rev-parse refs/tags/<fork-tag>
git rev-parse refs/tags/<fork-tag>^{}
git ls-remote origin refs/tags/<fork-tag> refs/tags/<fork-tag>^{}
git rev-parse refs/heads/main
git rev-parse refs/heads/dev
git rev-parse refs/heads/sync/<official-version>
git rev-parse refs/heads/upstream-release
git ls-remote origin refs/heads/main refs/heads/dev refs/heads/sync/<official-version>
git ls-remote origin refs/heads/upstream-release
gh release view <fork-tag> --repo Trendymen/opencodex \
  --json tagName,name,body,isDraft,isPrerelease,url
```
