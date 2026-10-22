# Trendymen Fork 扩展

本文件补充同目录的上游结构文档。能力和实现/回归入口统一见 [FORK_CHANGES.md](../FORK_CHANGES.md)，配置用法见 [Fork reference](../docs-site/src/content/docs/reference/fork-extensions.md)。
`src/fork/` 保存 Fork 专用兼容、诊断和版本模块；共享接线沿用官方 subsystem 边界。

## 文档与登记

- 上游已有 Markdown 保持当前 rebase 基线原文，包含 `INDEX.md`；Fork 合同写在同目录独立文件。
- `manifest.json` 登记本文件并标记 `forkOnly: true`。结构门禁仍检查文档/源码归属、链接、路径和行数，官方索引生成视图排除它。
- `docs/` 只保留 [同步政策](../docs/fork-sync-automation.md)。旧 Spec/Plan 从 Git 历史查阅；过程材料存 Git 忽略的 scratch，当前能力不依赖旧计划执行入口。

## 请求与工具边界

- GPT 家族和官方目的地分开判断。官方 Responses 保持原生消息/schema；Lite header 到 WS metadata 的映射在对应许可允许时只补缺失字段。
- `agentMessageFormat`、GLM/Kimi lowering 和 `encrypted` 注解清理在出站副本上运行，保持原 input、工具授权和重放状态。可信直接 key-auth relay 的注解例外不扩大到 combo。
- nested exec 和 `spawn_agent.fork_turns` 修复须由当前工具声明授权，保留 preview、完成项和 continuation 的区别。`fork_turns` 只解包一层合法字段值，重复键/未知 schema 跳过。
- tool-catalog 提示只使用当前可见工具；代理不合成进度、不执行或自动重试补丁，空成功输出的提示不能覆盖失败输出。
- `src/claude/intercept/picker-listener.ts` 的上传拒绝与有界 linger 沿用[官方 picker 合同](clients/claude-desktop.md#picker-mode-the-desktop-egress-proxy)。`tests/claude-integration/claude-picker-upload.test.ts` 补充无 body 的 HTTP/1.1 400/503 同 socket 复用、其他上传与 HTTP/2 sibling 不受拒绝影响、拒绝后重复 shutdown 的外部回归。

## 官方订阅逐项许可

- `src/fork/codex-passthrough-contract.ts` 是配置、面板和运行时共用的纯 23 项目录。默认 `true` 只允许既有处理，仍受原功能开关约束；配置说明统一见 [Fork 配置](../docs-site/src/content/docs/reference/configuration/fork-extensions.md#gpt-subscription-processing)。
- `src/adapters/openai-responses/passthrough.ts` 对未声明 hosted-search 工具的请求做自动历史投影时，检查 `normalizeRequestParameters`；显式 `projectResponsesLiteHostedSearchHistory` 沿用独立的 Provider opt-in 条件。非 canonical 路径继续采用官方默认处理。
- `codex-passthrough-turn.ts` 按 turn 冻结 Provider 覆盖值，最终 native Responses + canonical forward 目的地才解析许可；Direct、Pool、模型级 adapter 和 fallback 使用同一判断。它按当前许可、目的地和客户端偏好计算上游流模式与 JSON 客户端的 HTTP 选择；发送、恢复、预算和取消仍由 dispatch 管理。响应携带实际尝试的许可，非官方目的地不能继承父目标许可。
- `src/adapters/openai-responses/transport.ts` 在共享传输构建点转发 caller 的 routing hint。关闭 hint 合成时，Provider 静态同名头优先；开启时仍按最终 body 合成。`normalizeEncryptedContent: false` 跳过 OCX1 解封装和 native compaction 密文规范化；默认开启时沿用官方身份切换清理条件。
- `src/server/responses/core-pipeline.ts` 为准备阶段的早退响应附上 admission 许可；路由确定后为实际尝试的响应附上许可，包括 retention 交付后的响应与无效摘要的 502。retention 的 prepare、deliver、dispose 和发送资源释放仍由官方 pipeline 管理。
- `src/server/responses/core-combo.ts` 采用 child 的预检结果时携带原响应的订阅许可、内部 `null` 哨兵和本地失败/重放身份，覆盖 SSE 回放与失败投影；不以父路由默认值覆盖 child，官方工具 ownership 的携带规则保持不变。`tests/responses/codex-passthrough-ws.test.ts` 覆盖真实 Combo 到最终 WS 的 raw terminal 和预检失败交付。
- `src/server/responses/request-prepare.ts` 在 canonical source 重建时保留初次解析的 native reasoning retention 选项，供官方模型、账号切换及流内恢复判定使用；原值直接搬运，sticky strip 仍由官方 replay 模块管理。
- `codex-passthrough-source.ts` 在既有解压/读入点持有原始 JSON 文本，按共享 translator budget 管理副本；`codex-passthrough-request.ts` 在最终路由后按许可准备请求，提交选中尝试的 skills 副作用。EOF、错误、取消和 abort 释放来源，不增加独立硬上限。
- 已获准的 agent-task-recovery 替换按原始/历史 item 来源登记，canonical 重建只重放这些替换，不回灌整份旧输入，也不再次恢复或查询缓存。Combo 序列化转移实际 child item 的来源；关闭历史展开不带回历史替换。新副本保留禁止持久化标记，替换字符串记入既有观察预算并随来源释放。
- `codex-passthrough-response.ts` 和 `codex-passthrough-snapshot.ts` 接入已有 JSON/SSE/WS 交付点；关闭改写时保留业务字段，WS 仍需协议 framing，错误体保存在 `response`。缓存记录实际交付形状，不把无终态 EOF 记作成功。
- `src/codex/websocket-activity.ts` 将原样交付的 `response.done` 终态快照纳入既有工具活动追踪，按选中响应的 ownership 区分客户端与 Provider 执行的工具；等待客户端结果时不可按 idle 回收，收到匹配结果后才解除等待，不改写交付 payload。`tests/responses/ws-capacity-tool-ownership.test.ts` 覆盖仅终态含工具调用时的实际容量回收及 Provider 工具对照。
- `codex-passthrough-secrets.ts` 仅按本次真实出站值保护实际注入的私有凭据，覆盖 header、JSON 转义和跨 chunk 文本；一般脱敏关闭不取消这项保护。成功响应的正文格式既非 SSE 也非 JSON 时，若存在私有保护值，则在交付正文前取消上游并返回保护失败；无正文、没有实际私有值或值已由 caller 持有时沿用原交付。保护失败在提交前返回错误、提交后中止，受既有取消和有界读取约束。
- `privateSseReadDeadline` 只控制私有 SSE 首输出及不完整块的固定 5 秒期限；关闭后使用 `stallTimeoutSec` 的停滞期限，并保留 abort、预算、格式验证和凭据遮盖。共享 HTTP 错误体期限保持原值。保护失败通过闭合 `private-*` 错误码、`local-refusal` 与 `synthetic` 归因为本地；`src/server/request-log.ts` 和 `src/usage/log.ts` 持久化实际响应头的 `upstreamHttpStatus`，不从最终状态反推。
- `upstreamWsSilenceDeadline` 仅控制官方订阅上游 WS 等待首次响应的 90 秒静默期限；关闭后保留 ping、连接期限、abort 和传输预算。`privateErrorBodyReadDeadline` 仅控制使用私有凭据保护的 HTTP 错误正文固定 5 秒期限；关闭后取消总期限，首字节和停滞等待使用 `stallTimeoutSec`。普通投递和 `src/server/responses/core-combo-failure.ts` 的同一次分类读取共用 Fork 期限转换，不额外读取正文；无私有保护的 combo 调用者保持原期限。64 KiB、严格解码、JSON 检查及 token 遮盖继续执行。`src/lib/bounded-body.ts` 允许 `Infinity` 表示无期限，已有默认及有限期限不变；Fork 调用点显式选择，其他调用者不受影响。
- `codex-passthrough-local-errors.ts` 按已分类来源决定五项可选策略；`codex-passthrough-routing.ts` 将本次普通额度预检许可传给既有账号选择。真实上游错误、恢复失败、硬预算、认证/身份和明确账号政策保留，关闭拒绝说明不增加重放。
- `src/server/responses/fetch-helpers.ts` 通过纯目的地分类器只向 canonical forward 应用许可，并调用该错误模块的预发送失败标记。分类器的运行时依赖限定为 URL 与 model-identity 两个叶模块，不引入 registry、router 或 OAuth 执行图；传输层继续不承担路由或认证决策。WS 错误重组仍使用既有 64 KiB 有界 reader、读取期限及取消，关闭通用脱敏不关闭这些资源限制。

## 响应与恢复边界

- `src/server/responses/passthrough-dispatch-types.ts` 与 `src/server/responses/adapter-dispatch-types.ts` 分别保存对应 dispatch 的参数类型，母文件通过 `import type` 引用，发送预算、取消和恢复逻辑仍在母文件中。
- `src/server/responses/account-auto-pause-recovery.ts` 只在预算允许且已选中替补后，按现有有界错误读取保存失败响应、释放旧 body 的 pacing slot，再进入替补发送。没有预算、没有替补或 body 被外部 reader 锁定时不读取原 body；重建失败使用保留的失败响应，请求取消仍沿用 abort 路径。
- `src/server/responses-reasoning-summary-rewrite.ts` 仅在客户端请求 summary 且路由满足条件时投影；已有 summary 不重复投影。保留 raw reasoning、终态字段和原始存储对象，passthrough continuation 记录客户端实际收到的形状。
- projection 的唯一序号按 32 字节计入共享 `translatorBudget`；EOF、失败和取消完成资源释放，超限沿用 `translation_buffer_limit`。flush 不扩大到 reader error / nested-exec barrier。
- phase 推断只适用于显式配置的第三方原生 Responses；宣布阶段的 `final_answer` 不足以证明最终相位，已有 phase 和后续工作证据共同决定交付结果。
- `src/server/responses/encrypted-payload.ts` 和 `src/fork/passthrough-agent-task-recovery.ts` 限定 strict backend envelope；当前任务识别只跳过尾部 `compaction_trigger`、`additional_tools` 和 `configuration_update`，不跨过新的消息回溯历史任务。禁用 recovery 时不增加分类、恢复或重放。原生重放使用官方共享发送预算，最多一次；恢复后的请求不再进入其他重试链。
- strict 密文和恢复 body 不写 continuation cache。父任务 `MESSAGE` 超时提示不含密文，不声称正文已读；`invalid_encrypted_content` 属于 `recovery_unreadable` 终局。
- key-auth 输出预算由 `src/adapters/openai-responses/passthrough.ts` 补全；显式客户端预算优先，forward 不注入。估算不替代上游计费或超窗判断。

## 配置与诊断边界

- 官方 customModels 基础类型、CRUD、catalog 和 modality 判定继续使用。`src/config/custom-models.ts` 补校验、salvage、三方合并和公开字段投影，未知 opaque 字段只在内部保留。
- `src/server/management/provider-routes.ts` 在 Provider 保存尚未发布便失败时，恢复原 Provider 属性；`setDefault: true` 同时恢复原默认值。遇到 `ConfigWritePublishedError` 保留已发布且与磁盘一致的 Provider 与默认值。上下文上限保存失败由 `src/server/management/provider-context-cap-routes.ts` 回滚该路由字段。
- `src/fork/debug-persistence.ts`、`src/fork/inbound-response-debug.ts`、`src/fork/outbound-debug.ts` 增加结构抓包。普通 debug 不保存正文/key/工具参数；文本样本同时要求 provider debug 和独立 `providerText`，并执行脱敏及预算限制。
- 主日志与引用工件共用 4 MiB 分组、7 天和 20 GiB 预算；淘汰先删主日志，失败时保留引用工件。unsafe / 不可盘点条目保留并告警，诊断失败不影响 relay。
- `textRef` 与 `timelineRef` 在所有平台均使用 `/` 分隔的相对路径；文件系统绝对路径使用本机分隔符。逐文件持久化回调沿用同一引用格式，安全解析器继续拒绝反斜杠。
- `src/lib/config-ownership.ts` 仅收养带运行时标记的旧 home，收养前路径不登记为自有。debug 登记失败继续捕获，Kimi catalog 仍要求登记成功。

## 安装与维护边界

- CI 的 job、条件、分片、worker 和运行预算跟随官方 `.github/workflows/ci.yml` 与 `scripts/ci/run-bun-test-batches.sh`；Fork 保留 `scripts/prepare-fork-official-base.ts` 的官方基线、Tag 和 marker 校验。候选触发与精确 SHA 验收见[同步政策](../docs/fork-sync-automation.md)。本地 runner 继续沿用官方主池和预算，保留 Fork helper 与隔离回归。`scripts/test-run-lock.ts` 在成员写入后确认路径是普通文件；注册失败仍使用脱敏诊断，owner 更换时沿用让出与重试。
- `scripts/install-local.ts`、`scripts/install-local-vendor.ts`、`scripts/install-local-volta.ts` 在离线验证后的同卷 stage 上替换包；根 manifest 保持冻结。Volta、服务、readiness、plist 和包字节共用失败回滚边界。
- 停服、包回滚和 plist 恢复全部确认成功后，才恢复原先已加载的服务；不安全/未知状态拒绝继续 restart。Windows pending transaction 的 wrapper 和 probe 成对维护。
- macOS `install:local` 补写 `OCX_DEBUG=1` / `OCX_PROVIDER_TEXT_DEBUG=1`，运行安装命令须当前用户明确授权。普通自更新保留官方事务路径，字体补丁不扩展为滚动 CSS 改写。
- `src/fork/version-policy.mjs` 维护 `ben.N` 单调版本。更新、通知和 launcher 使用同一规则；Tag/Release 见 [Fork 维护补充](../FORK_MAINTAINERS.md) 和同步政策。
- 原生 Windows 恢复、PID reuse、断电和父目录替换竞态仍需实际环境验证；`src/usage/telemetry-contract.ts` 的恢复类型、GUI 标签及 `src/web-search/passthrough-bridge.ts` 的诊断观察保留各自合同。
