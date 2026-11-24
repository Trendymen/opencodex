# Trendymen Fork 扩展

本文件补充同目录的上游结构文档。能力和实现入口统一见 [FORK_CHANGES.md](../FORK_CHANGES.md)，配置用法见 [Fork reference](../docs-site/src/content/docs/reference/fork-extensions.md)。
`src/fork/` 保存 Fork 专用兼容、诊断和版本模块；共享接线沿用官方 subsystem 边界。

## 文档与登记

- 上游已有 Markdown 保持当前 rebase 基线原文，包含 `INDEX.md`；Fork 合同写在同目录独立文件。
- `manifest.json` 登记本文件并标记 `forkOnly: true`。结构门禁仍检查文档/源码归属、链接、路径和行数，官方索引生成视图排除它。
- [同步政策](../FORK_SYNC_AUTOMATION.md)位于仓库根目录。旧 Spec/Plan 从 Git 历史查阅；过程材料存 Git 忽略的 scratch，当前能力不依赖旧计划执行入口。

## 请求与工具边界

- `src/server/index/serve-options.ts` 在本机直连回环主入口的 Responses、Compact 和 Responses WebSocket 握手校验可选 Relay Key，保留回环准入，把原 `apiKeyId` 写入日志和用量。WebSocket 每轮用当前配置校验握手时所选用量 Key 的指纹。被过滤的重放 Bearer 仅保留进程内盐化指纹，后续按该凭据的当前身份解析。HTTP 将经过 Grok 与调用方会话处理后的请求交给准入和分发，将已验证的重放主体传给同次请求的路由回退，并在读取该主体时复验实际配置。HTTP 密文恢复仍校验调用者自带的原生 ChatGPT bearer 及匹配账号。辅助模型入口沿用原准入和归属规则。`src/server/management/api-key-usage.ts` 将带 Key ID 的回环记录和经 Key 准入的记录归到同一个 ID。`src/usage/source-filter.ts` 与用量索引保留已移除 Key 的历史记录。
- `/v1/alpha/search` 经 ChatGPT 转发时，可为明确指定 Provider 或模型别名的已知第三方模型选择独立搜索模型。启用的 `openai` 搜索后端从 `webSearchSidecar.model` 读取无需账号专属权限的原生模型。受限 key 需要同时允许原对话路由和实际搜索模型。原生及账号限定的搜索仍使用客户端选择的模型。
- `/v1/alpha/search` 和独立图片接口识别有效 OCX Bearer，包括主动带 key 的回环请求。上游鉴权由当前配置的账号或凭据完成，key 的模型和 Provider 限制仍生效。Direct 在读取主账号凭据前，沿用主账号策略绑定的等待期限。Direct 图片优先使用符合 key 权限的已有图片后端。默认图片 key 池在发送前暂停时，可改用已登录主账号。客户端创建的语音通话可经官方 Realtime 地址加入，`x-opencodex-api-key` 携带 OCX key，`Authorization` 携带原 ChatGPT 账号的 Bearer，`chatgpt-account-id` 须与 Bearer 中的账号声明一致。代理发出的语音别名继续绑定创建者 key。
- GPT 家族和官方目的地分开判断。官方 Responses 保持原生消息/schema；`src/server/responses/codex-ws-request.ts` 只在构造 canonical 上游 WebSocket 帧时按对应许可映射有效的 Lite header，显式 HTTP 值优先同名 metadata。HTTP 请求体不预先合成 WS metadata，其他字段保持原样。
- `agentMessageFormat`、GLM/Kimi lowering 和 `encrypted` 注解清理在出站副本上运行，保持原 input、工具授权和重放状态。未设置 `agentMessageFormat` 的 forward 鉴权在前后两次处理均保留原生 agent message；第三方显式 `user_message` 仍可转换可读内容。可信直接 key-auth relay 的注解例外不扩大到 combo。
- `src/fork/kimi-reasoning-replay.ts` 对配置的非 forward Kimi 路由逐项判断推理来源。原生条目必须命中当前调用者、会话、模型、实际端点和凭据的登记，条目 ID 与密文按同一条记录配对。无 Relay Key 时只允许直连主回环的本机请求匹配已持有的密文，WebSocket 还要求有效连接绑定当前线程。其他项的可读内容在原位置转为历史消息，清理无法解析的条目引用。上游明确拒绝后的重建优先清理密文。登记受进程内容量和期限限制。无 replay scope 的直接 adapter 调用沿用原清理。
- `src/adapters/openai-responses/tool-output-recovery.ts` 将孤儿工具输出转为用户消息时，同时保留官方 item provenance 与 Fork 的合法具名来源标签；缺失或非法来源使用官方 unknown 标记。历史工具声明继续按官方当前轮目录判断。
- nested exec 和 `spawn_agent.fork_turns` 修复须由当前工具声明授权，保留 preview、完成项和 continuation 的区别。`fork_turns` 只解包一层合法字段值，重复键/未知 schema 跳过。
- V2 明文任务开启时，非 forward Responses 路由仅对 `arkKimiResponsesModels` 中未允许原生密文的模型添加协作正文提示。`src/fork/spawn-agent-compat.ts` 按本轮授权识别 `collaboration` 的 `spawn_agent`、`send_message` 和 `followup_task`。发往这些模型的历史中，这三个具名工具的 `message` 若整体匹配后端密文形态，Relay 会替换该字段为省略标记，保留调用 ID 和工具结果。若模型新返回的 `message` 整体匹配该形态，`src/fork/kimi-plaintext-agent-guard.ts` 在交付工具调用前终止响应并提示用明文重发。拒绝的响应不进入续接缓存。
- `src/fork/kimi-split-agent-call.ts` 仅在配置的 Kimi Responses 路由处理已授权的 `collaboration.spawn_agent` 和 `collaboration.wait_agent` 碎片。Relay 校验工具身份、碎片顺序和完整 JSON 参数，再交付正常调用。发往 Kimi 的续接请求过滤已确认的失败碎片组，并移除会隔开已确认调用及其唯一匹配结果的空助手项。桌面会话记录保留。
- OpenAI Chat、Google、Command Code、Anthropic、Kiro 和 Cursor 适配器在各自工具条件满足时为请求加入进度提示；tool-catalog 提示只使用当前可见工具。模型 catalog 及派生缓存和原生 Responses 不自动追加这些提示，模型是否输出可见进度不作保证。code-mode 结果回显和宿主提示沿用官方处理；代理不合成进度、不执行或自动重试补丁，空成功输出的提示不能覆盖失败输出。
- `src/fork/annotation-instructions.ts` 改写入站 annotation chip 说明；输出侧保留代码块及其他正文，并去除规范指令的反引号。
- `src/claude/intercept/picker-listener.ts` 的上传拒绝与有界 linger 沿用[官方 picker 合同](clients/claude-desktop.md#picker-mode-the-desktop-egress-proxy)。无 body 的 HTTP/1.1 400/503 可复用同一 socket，其他上传与 HTTP/2 sibling 不受拒绝影响，拒绝后可重复 shutdown。

## 官方订阅逐项许可

- `src/codex/forward-transport-headers.ts` 仅在写回 HTTP header 时，将 Pool 身份改写后的 turn metadata 中超出 U+00FF 的字符转为 JSON 转义，保留合法 Latin-1 字符和其他字段的 JSON 值；请求体 metadata 沿用原序列化，避免转义扩张影响重复投影。账号身份隔离仍独立于兼容处理许可。
- `src/fork/codex-passthrough-contract.ts` 是配置、面板和运行时共用的纯 23 项目录。默认 `true` 只允许既有处理，仍受原功能开关约束；配置说明统一见 [Fork 配置](../docs-site/src/content/docs/reference/configuration/fork-extensions.md#gpt-subscription-processing)。
- `src/adapters/openai-responses/passthrough.ts` 对未声明 hosted-search 工具的请求做自动历史投影时，检查 `normalizeRequestParameters`；显式 `projectResponsesLiteHostedSearchHistory` 沿用独立的 Provider opt-in 条件。非 canonical 路径继续采用官方默认处理。
- canonical forward 的 `additional_tools` 提升同样检查 `normalizeRequestParameters`；关闭该许可或全关时保留输入条目及顶层 `tools` 的值、存在性和顺序。其他目的地沿用官方自动提升及 Provider opt-in 条件。
- `codex-passthrough-turn.ts` 按 turn 冻结 Provider 覆盖值，最终 native Responses + canonical forward 目的地才解析许可；Direct、Pool、模型级 adapter 和 fallback 使用同一判断。原生 Responses 在入口没有 canonical 候选时仍携带不持有来源的 turn；读取期间配置新增 canonical 目标时，来源不可用则在官方账号认证及 canonical transport 派发前拒绝，Combo、policy 与 compaction 继承该状态。它按当前许可、目的地和客户端偏好计算上游流模式与 JSON 客户端的 HTTP 选择；发送、恢复、预算和取消仍由 dispatch 管理。响应携带实际尝试的许可，非官方目的地不能继承父目标许可。
- `src/server/responses/core-lifetime.ts` 的预算与账号 lease 包装共用 marker 搬运，保留官方 same-target retry hold、模型计划拒绝、本地账号冷却标记、禁止重放状态及 Fork 的实际订阅许可和本地失败身份；包装后的响应继续使用原有 EOF、错误与取消释放路径。
- `src/adapters/openai-responses/transport.ts` 在共享传输构建点转发 caller 的 routing hint。关闭 hint 合成时，Provider 静态同名头优先；开启时仍按最终 body 合成。`normalizeEncryptedContent: false` 跳过 OCX1 解封装和 native compaction 密文规范化；默认开启时沿用官方身份切换清理条件。
- `src/server/responses/core-pipeline.ts` 为准备阶段的早退响应附上 admission 许可；路由确定后为实际尝试的响应附上许可，包括 retention 交付后的响应与无效摘要的 502。retention 的 prepare、deliver、dispose 和发送资源释放仍由官方 pipeline 管理。
- `src/server/responses/request-prepare.ts` 在尝试恢复加密任务前，按重定向后的目标拒绝 Command Code System One 决策模型。Responses pipeline 也检查恢复后重新选出的目标。决策模型不会触发 Combo 的恢复请求。
- `src/server/responses/core-combo.ts` 采用 child 的预检结果时携带原响应的订阅许可、内部 `null` 哨兵和本地失败/重放身份，覆盖 SSE 回放与失败投影；不以父路由默认值覆盖 child，官方工具 ownership 的携带规则保持不变。Codex Pool 主账号的 429 按实际请求模型的额度组判断账号冷却，目标级冷却仍关联原 Combo 条目。
- `src/fork/combo-adapter-preflight.ts` 为转译事件预检处理停滞、取消和迭代器关闭；`src/server/responses/run-turn-execution.ts` 使用该预检。
- `src/server/responses/request-prepare.ts` 在 canonical source 重建时向 `src/fork/codex-passthrough-request.ts` 传入首次展开使用的 `replayThreadId` 和 `replayOwnerKey`，并保留初次解析的 plaintext V2 决定、已准备状态及 native reasoning retention 选项。明文编译仍检查该决定和当前配置；模型、账号切换及流内恢复沿用原 retention 值，sticky strip 仍由官方 replay 模块管理。
- `src/adapters/openai-responses/reasoning.ts` 不根据同项的正文推测未知 opaque 内容的来源；身份切换或上游拒绝后的恢复沿用官方清理条件。
- `codex-passthrough-source.ts` 对普通读取在既有解压/读入点持有原始 JSON 文本，按共享 translator budget 观察副本；`codex-passthrough-request.ts` 在最终路由后按许可准备请求，提交选中尝试的 skills 副作用。EOF、错误、取消和 abort 释放来源，不增加独立硬上限。官方入站并发 reservation 与文本 lease 各自持有：普通读取捕获文本时，`src/server/request-decompress.ts` 在解压和序列化测量后更新 reservation，再转移文本 lease；`src/server/inbound-body-admission.ts` 在响应 EOF、错误或取消完成后释放 reservation。
- Remote Link 附带的已解析 body 先按官方序列化大小限制和预算观察处理；仅在需要 Fork source 且尚未持有时，才额外序列化并保留一份 JSON 文本。translator budget 观察其字节，文本及其观察量随来源释放。深层合法 JSON 会触发递归 `JSON.stringify` 栈溢出并误报无效 JSON；Link WS 发布门保持关闭，开门前须修复。真实 Link 的内存使用尚未验收，该路径未达到官方无第二副本的目标。
- 已获准的 agent-task-recovery 替换按原始/历史 item 来源登记，canonical 重建只重放这些替换，不回灌整份旧输入，也不再次恢复或查询缓存。Combo 序列化转移实际 child item 的来源；关闭历史展开不带回历史替换。新副本保留禁止持久化标记，替换字符串记入既有观察预算并随来源释放。
- `codex-passthrough-response.ts` 和 `codex-passthrough-snapshot.ts` 接入已有 JSON/SSE/WS 交付点。关闭终态合成时，`response.done` 保留原有载荷，内部沿用官方完成帧的有效错误判定。原生 WS 控制与客户端交付按每个响应的首个原样终态结算，合法后继响应有自己的终态和错误归属，整个调用链仍累计用量。开启终态合成时，WS 沿用官方完成帧投影及其错误判定。无终态 EOF 不记作成功。
- `src/server/responses/combo-required-tool-stream.ts` 在原生 Responses 流式 Combo 中执行官方必选工具检查；仅当实际 Codex 许可 `synthesizeTerminalFailure: false` 时，带 `completed` 状态和 output 数组的真实 `response.done` 也进入检查。有效 block 原样保留；`repairResponseToolCalls: false` 时，检查器不把客户端未收到的修复后名称当作履约。已观察到 hosted 工具效果等不可安全重放证据时缺工具失败不得重放。
- `src/codex/websocket-activity.ts` 将原样交付的 `response.done` 终态快照纳入既有工具活动追踪，按选中响应的 ownership 区分客户端与 Provider 执行的工具；等待客户端结果时不可按 idle 回收，收到匹配结果后才解除等待，不改写交付 payload。
- `codex-passthrough-secrets.ts` 仅按本次真实出站值保护实际注入的私有凭据，覆盖 header、JSON 转义和跨 chunk 文本；一般脱敏关闭不取消这项保护。大小写不同的配置头合并时，仅当配置组与实际出站值经 `Headers` 规范化后相同，才按原成员判断 caller 持有情况。成功响应的正文格式既非 SSE 也非 JSON 时，若存在私有保护值，则在交付正文前取消上游并返回保护失败；无正文、没有实际私有值或值已由 caller 持有时沿用原交付。成功响应和 SSE 的保护失败在提交前返回错误、提交后中止，受既有取消和有界读取约束。
- 私有保护下的 HTTP 错误正文先按 64 KiB 上限与严格 UTF-8 读取：标为 JSON 的完整合法正文逐字符串遮盖，其他文本整体遮盖。标为 JSON 的非法正文仅在不含反斜杠且完整文本遮盖无命中时原样保留；超限、解码失败或其余不安全的非法 JSON 舍弃正文。正文被舍弃时，默认 Direct 使用官方格式化器保留状态并生成仅含状态信息的 JSON；关闭 `redactUpstreamErrors` 时 Direct 保留状态、返回空体。Combo 保留状态并在无正文时按状态分类；读取期限和 abort 规则不变。
- `privateSseReadDeadline` 只控制私有 SSE 首输出及不完整块的固定 5 秒期限；关闭后使用 `stallTimeoutSec` 的停滞期限，并保留 abort、预算、格式验证和凭据遮盖。共享 HTTP 错误体期限保持原值。保护失败通过闭合 `private-*` 错误码、`local-refusal` 与 `synthetic` 归因为本地；`src/server/request-log.ts` 和 `src/usage/log.ts` 持久化实际响应头的 `upstreamHttpStatus`，不从最终状态反推。
- 原生 Responses 流已有上游静默计时器时，私有凭据保护复用该计时器。即使首个安全 SSE 块尚未交付，显式静默超时仍进入官方 SSE 失败处理。开启失败合成时发送 `upstream_stall_timeout`，关闭时以流错误结束。尚未通过凭据检查的字节不会交付。
- `upstreamWsSilenceDeadline` 仅控制官方订阅上游 WS 等待首次响应的 90 秒静默期限；关闭后保留 ping、连接期限、abort 和传输预算。`privateErrorBodyReadDeadline` 控制使用私有凭据保护的 HTTP 错误正文固定 5 秒期限。关闭后，普通交付、Combo 分类读取和 pacing 重试保留正文时，首字节和停滞等待使用当前目的地的 `stallTimeoutSec`。重试保留按 64 KiB 上限读取原始字节，交付仍执行严格解码、JSON 检查和凭据遮盖。pacing 保留自身的租约上限和取消规则。Pool 凭据刷新后若替代请求未获准发送，保留响应使用产生它的原请求和账号归属。
- `codex-passthrough-local-errors.ts` 按已分类来源决定五项可选策略；`codex-passthrough-routing.ts` 将本次普通额度预检许可传给既有账号选择。真实上游错误、恢复失败、硬预算、认证/身份和明确账号政策保留，关闭拒绝说明不增加重放。
- `src/fork/codex-passthrough-fetch.ts` 通过纯目的地分类器再次核对 canonical forward，只向该目的地应用许可，并注册 HTTP 预发送失败标记。分类器的运行时依赖限定为 URL 与 model-identity 两个叶模块，不引入 registry、router 或 OAuth 执行图；`src/server/responses/fetch-helpers.ts` 保留传输职责，不承担路由或认证决策。WS 错误重组仍使用既有 64 KiB 有界 reader、读取期限及取消，关闭通用脱敏不关闭这些资源限制。

## 响应与恢复边界

- `src/types/agent-task-recovery.ts` 保存 `OcxConfig.agentTaskRecovery` 的原有七个可选字段及默认值说明；`src/types/config.ts` 通过 `import type` 引用，不增加运行时依赖或改变配置结构。
- `src/server/responses-passthrough-dispatch-types.ts` 与 `src/server/responses-adapter-dispatch-types.ts` 保存原生直通和转译 dispatch 的参数类型。发送预算、取消和恢复仍由各自的 dispatch 处理。
- `src/server/responses/account-auto-pause-recovery.ts` 只在凭据跳转预算允许且已选中替补后，按现有有界错误读取保存失败响应、释放旧 body 的 pacing slot，再进入替补发送。没有跳转预算、没有替补或 body 被外部 reader 锁定时不读取原 body；重建失败保留原响应。已预留跳转但物理发送准入明确因预算拒绝时，沿用官方本地429；其他发送前失败仍保留原响应，请求取消沿用abort路径。
- `src/server/responses-reasoning-summary-rewrite.ts` 仅用于客户端请求 summary 且路由满足条件的转译适配器响应；已有 summary 不重复投影。xAI 官方目的地的 `openai-chat` 响应保留原始 reasoning content，并在完成前流式交付，不做 summary 投影；流式、JSON 和已存重放形状一致。原生 Responses 沿用官方 content-channel 合同，在 SSE、JSON 和已存重放中保留 content，不再通过 Fork 投影为 summary。
- `src/server/relay.ts` 和 `src/server/relay-eager.ts` 使用官方 `src/server/bare-upstream-error.ts` 的 typed/untyped 证据归并：typed 优先于 untyped，同类取后，真实终态与已确认的 policy terminal 按官方边界处理。Fork 不再增加 `cleanEof` / `pendingRead` 竞争读取重放；正常 EOF flush 和私有凭据保护沿用原条件。
- `synthesizeTerminalFailure: false` 时，面向 Codex 客户端的 canonical ChatGPT Responses HTTP SSE 保留原始错误帧。只有结构化证据确认过载、上游正常结束且未收到输出、工具活动或有效终态时，才在客户端流尾追加一个 `response.failed`。错误码为 `server_is_overloaded`，`response.error.headers.retry-after` 使用有效的上游等待建议，缺省为 1 秒。重试由客户端发起。
- projection 的唯一序号按 32 字节计入共享 `translatorBudget`；EOF、失败和取消完成资源释放，超限沿用 `translation_buffer_limit`。flush 不扩大到 reader error / nested-exec barrier。
- Fork 的 `inferResponsesMessagePhaseModels` 只作用于显式列出的第三方原生 Responses 模型，包含普通 JSON 交付；宣布阶段的 `final_answer` 或缺省 phase 不足以证明最终相位，已有 phase 和后续工作证据共同决定交付结果。命中该名单时优先使用 Fork 推断，避免两层缓冲吞掉 EOF 尾项。其余路由按官方 `messagePhaseInference` 控制 SSE 推断及由 SSE 重建的 JSON，保留官方适用条件。
- `src/server/responses/encrypted-payload.ts` 和 `src/fork/passthrough-agent-task-recovery.ts` 限定 strict backend envelope；当前任务识别只跳过尾部 `compaction_trigger`、`additional_tools` 和 `configuration_update`，不跨过新的消息回溯历史任务。禁用 recovery 时不增加分类、恢复或重放。原生重放使用官方共享发送预算，最多一次；恢复后的请求不再进入其他重试链。
- `src/server/responses/agent-task-recovery.ts` 对普通有效 Fernet 保留官方单一 deadline（默认 45000 毫秒，显式配置优先），不增加超时重试。已准入的 strict backend `NEW_TASK` 和严格子→父 `MESSAGE` 才使用默认 120000 毫秒、45 秒 stall 上限和 `maxRetries`；共享 flight 的 key 区分该策略，取消优先于 owned deadline 分类。
- strict 密文和恢复 body 不写 continuation cache。父任务 `MESSAGE` 超时提示不含密文，不声称正文已读；`invalid_encrypted_content` 属于 `recovery_unreadable` 终局。
- key-auth 输出预算由 `src/adapters/openai-responses/passthrough.ts` 补全；显式客户端预算优先，forward 不注入。估算不替代上游计费或超窗判断。

## 配置与诊断边界

- `src/config/custom-models.ts` 允许仅填写 Provider 和模型的旧配置参与官方路由校验。加载时为缺省 ID 的行补稳定管理 ID，显式 ID 仍按管理规则验证和去重。

- `src/fork/model-api-listener-config.ts` 定义可选的 `forkModelApiListener: { enabled: boolean }`，省略或 `false` 保持原主入口。开启时，回环主入口端口必须与 `10100` 不同，resolver 返回 `0.0.0.0:10100` 的 auxiliary 拓扑；非回环主入口必须使用 `10100`，resolver 返回 primary 拓扑。默认地址及 `localhost` / `localhost.` 按原生绑定规则归一化，CLI 的有效主端口优先于配置端口；合同模块只计算和校验，不绑定 socket。
- `src/config.ts` 在 schema 和修复前严格检查该字段及拓扑，正常、repair、salvage 返回前核对显式开启及主拓扑保留；无法保留时抛出 `ForkModelApiConfigurationError`，不退回关闭状态。未开启时继续使用原有 fallback。`src/config/diagnostics.ts` 的诊断读取在降级前使用同一检查，并对正常、repair、salvage 的结果核对保留；typed 错误返回固定的 schema 诊断，使无关配置编辑不能绕过原始拓扑拒绝。candidate 写入和 `src/config/persist-unlocked.ts` 的统一保存边界也使用同一检查，显式非法端口不会被当作省略值。`src/config/live-topology.ts` 将该字段纳入活动拓扑基线，guarded save 只保存下次启动的 desired 值，保留运行中 config 的旧拓扑。
- 读取文件投影已移除的 OpenCode Free 配置时，`src/config.ts` 与 `src/config/diagnostics.ts` 在 Fork 原始拓扑校验前使用同一次读取的字节尝试保留恢复副本；passive 诊断不创建副本。
- `src/fork/model-api-listener.ts` 在 auxiliary 拓扑中创建同进程模型 API listener，复用完整 serve options 与原生数据面 handler。`src/server/index/serve-options.ts` 使用官方 `src/server/index/serve-contract.ts` 的 `ServerIngress` 和 `ServeOptionsContext` 合同。入口只允许经 `codexCompatibleUrl` 归一化的 `/v1/` 路径并拒绝 Link 管理前缀；GUI、管理、session、配对、health/readiness 和 Remote Workspace 在分发前返回 JSON 404。来源由实际 server 对象识别，每请求使用非回环 `requestPolicyView`，启动凭据检查复用原生数据 Key/token 规则，admin token 不充当数据凭据。primary 拓扑保留主服务原生路由。
- 辅助入口仅在内核观察到回环对端且未识别到代理转发时允许 Responses HTTP 或 WebSocket 恢复 V2 密文。按 Key 转换模型时，通过进程内关联保留原请求的对端地址。入口经 `x-opencodex-api-key` 完成 Relay 鉴权并按原 Key ID 归属用量。恢复仍校验调用者自己的原生 ChatGPT Bearer 与匹配账号。发给 ChatGPT 的恢复请求不含 Relay Key。
- `src/fork/model-conversion.ts` 在 auxiliary listener 上按认证 key 的启动快照包装对话请求及响应；primary 拓扑存在启用的非空策略时拒绝启动。规则、适用路径、后续路由及预算边界见 [per-key model conversion](../docs-site/src/content/docs/reference/configuration/fork-extensions.md#per-key-model-conversion)。
- `src/fork/model-conversion-request.ts` 对 Messages 的 effort 应用上限后，复用官方映射将 `minimal` 写成 `low`、`ultra` 写成 `max`；`none` 禁用 thinking 并省略 effort。转换时保留 `output_config` 其他字段，仍启用 thinking 时不改变其 token 预算；后续转译和目的地策略由主服务处理。
- `src/server/index.ts` 将模型 API listener 纳入 spend-ledger track、同步失败回滚及 `runListenerShutdown`；原生 WS 仍在接收请求的 server 上 upgrade。controller 导出唯一的 `ForkModelApiRuntimeSnapshot` 类型，包含 topology、active 与安全 bind 信息。`src/cli/index.ts` 在 reclaim 和探测前校验有效拓扑，开启时固定主端口；`src/cli/auxiliary-listener-preflight.ts` 按真实辅助地址预检并拒绝端口冲突，bind 竞态不触发主端口重选。`src/cli/start-command-exit.ts` 只定义共享的退出错误类，选口与捕获保留同一类身份。
- `src/fork/model-api-listener-status.ts` 只投影 controller snapshot：topology 保留启动时逻辑配置，bind 来自持有的真实 server，临时 socket 映射不影响待重启比较。配置 port 为 0 时，启动逻辑意图保留 0；非零覆盖继续记录有效启动端口，绑定与冲突校验始终使用有效拓扑。保存 fixed port 为 0 不会改写启动意图，仍需重启。`src/server/management/context.ts` 的当前 server 闭包将 snapshot 提供给已鉴权的 `GET /api/system/health`；公开 health 和 runtime-port 格式不变。`src/lib/local-management-capability.ts` 将该 GET 纳入现有本机只读合同，`src/cli/status.ts` 强制校验 response proof 后读取，缺少证明时 active 与 restartRequired 均为 null；服务未运行时明确 not-running。`src/cli/index.ts` 输出模型入口状态，CLI JSON 保持 schemaVersion 1。
- 官方 customModels 基础类型、CRUD、catalog 和 modality 判定继续使用。`src/config/custom-models.ts` 补校验、salvage、三方合并和公开字段投影，未知 opaque 字段只在内部保留。
- `src/server/management/provider-routes.ts` 在 Provider 保存尚未发布便失败时，恢复原 Provider 属性；`setDefault: true` 同时恢复原默认值。遇到 `ConfigWritePublishedError` 保留已发布且与磁盘一致的 Provider 与默认值。上下文上限保存失败由 `src/server/management/provider-context-cap-routes.ts` 回滚该路由字段。
- `src/fork/debug-persistence.ts`、`src/fork/inbound-response-debug.ts`、`src/fork/outbound-debug.ts` 增加结构抓包。普通 debug 不保存正文/key/工具参数；文本样本同时要求 provider debug 和独立 `providerText`，并执行脱敏及预算限制。
- 主日志与引用工件共用 4 MiB 分组、7 天和 20 GiB 预算；淘汰先删主日志，失败时保留引用工件。unsafe / 不可盘点条目保留并告警，诊断失败不影响 relay。
- `textRef` 与 `timelineRef` 在所有平台均使用 `/` 分隔的相对路径；文件系统绝对路径使用本机分隔符。逐文件持久化回调沿用同一引用格式，安全解析器继续拒绝反斜杠。
- `src/lib/config-ownership.ts` 仅收养带运行时标记的旧 home，收养前路径不登记为自有。debug 登记失败继续捕获，Kimi catalog 仍要求登记成功。

## 安装与维护边界

- CI 的 job、条件、分片、worker 和运行预算跟随官方 `.github/workflows/ci.yml` 与 `scripts/ci/run-bun-test-batches.sh`；Fork 的 `scripts/prepare-fork-official-base.ts` 从包版本推导官方基线，核对固定上游正式 Release、Tag raw/peeled 和候选历史。开发与发布候选统一在 dev，不依赖 main、sync 或 upstream-release。候选触发与精确 SHA 验收见[同步政策](../FORK_SYNC_AUTOMATION.md)。
- 官方 Tag 的精确 raw/peeled 查询在隔离 Git 配置中执行，固定官方 URL；Windows 参数约束及返回行的精确匹配见[同步政策](../FORK_SYNC_AUTOMATION.md)。本地 raw 对象的类型、OID 与 peeled commit 全部匹配时复用，不要求已存在同名 Tag 引用；确证对象缺失才回到独立临时仓库的一层历史抓取。异常或同名 Tag 冲突直接拒绝。候选祖先证明在 checkout 中完成：固定 HEAD 后，浅克隆先从 origin 对该完整 SHA 加深 64 层，再运行同一祖先检查；仍缺少对象或无法证明且仓库仍浅时，才补齐完整历史。Git fatal、抓取失败及完整历史中的非祖先继续拒绝；已有当版 Fork Tag 的专门完整补取规则保持。准备过程不改分支、现有 Tag 或 FETCH_HEAD，不把临时验证仓库的浅边界写入 checkout。
- `scripts/install-local.ts`、`scripts/install-local-vendor.ts`、`scripts/install-local-volta.ts` 严格核对官方 `runNpm` 参数并保留唯一 stage 的 `--prefix`，使用已准备的 tarball 离线安装；回调返回 stage 成功前校验包身份、字体、日志滚动 CSS 补丁和 CLI，失败保留旧 live 并尝试清理 stage，清理失败时保留并记录，根 manifest 保持冻结。官方事务完成后依次静态校验 live 身份和 GUI 补丁、同步并验证 Volta、检查 launcher/CLI，再按条件处理服务、debug 和 readiness；这些后续步骤失败不自动回滚包。Volta 元数据同步自身失败时仍使用 `restoreBeforeImages` 和 journal 做内部补偿，不提供面向后续服务或 readiness 失败的登记回滚句柄。
- 事务失败且要求重启时，只有 `recoveryUnsafe` 不为 `true`，且阶段为 `stage`、`verify`、`authorize`、`swap-backup` 之一或报告 `rolledBack: true`，才可尝试恢复原运行状态；其他事务失败不自动重启。`double-fault` 只有报告 `rolledBack: true` 且未标为 `recoveryUnsafe` 才可能恢复。该恢复不依赖延迟提交句柄，也不把包事务成功后的失败称为旧包已恢复；`src/update/update-failure-guidance.mjs` 仍优先提示不安全的恢复状态。
- `src/update/transactional-install.mjs` 使用官方 stage 验证、swap 后验证和失败时回滚；`mayReplacePackage` 须在 stage 验证后及每次 live→backup rename 重试前同步返回 `true`。成功后事务返回 `done`，不提供延迟提交或外部 rollback 句柄。
- 安装树内容沿用官方校验，按需核对目标版本、launcher、Bun 大小和依赖；校验会跟随符号链接，不证明链接目标均位于包目录内。Fork 原有目录对象身份、pending 事务所有权、专用 marker 写入和延迟提交保护已撤回；官方验证及替换授权不等价覆盖这些保护。
- 启动恢复和新事务开始前仅用 `lstat` 检查旧 `.ocx-transaction.json`：已有任意条目或非 `ENOENT` 检查错误时，分别返回 `failed` 或 `pending-existing` / `recoveryUnsafe: true`；不读取、写入或删除该 marker，也不探测 PID。启动器对 `failed` 只警告并继续启动；旧 pending 不自动恢复或删除，处理前须人工核查事务、包与备份。检查后新建 marker 仍有竞态。
- `install:local` 在 GUI 构建后、tarball 打包前修补字体，并向主界面与 classic 中包含日志表格样式的产物 CSS 追加 `.logs-table-wrap{position:relative}`。滚动补丁幂等，缺少目标样式时拒绝安装；GUI 源码保持原样，单独构建 GUI 和普通自更新不运行这项补丁。
- macOS `install:local` 补写 `OCX_DEBUG=1` / `OCX_PROVIDER_TEXT_DEBUG=1`，运行安装命令须当前用户明确授权。普通自更新保留官方同步/异步事务路径及 Windows 安装进程树退出屏障。
- `src/fork/version-policy.mjs` 维护 `ben.N` 单调版本。更新、通知和 launcher 使用同一规则；Tag/Release 见 [Fork 维护补充](../FORK_MAINTAINERS.md) 和同步政策。
- 原生 Windows 恢复、PID reuse、断电和父目录替换竞态仍需实际环境验证；`src/usage/telemetry-contract.ts` 的恢复类型、GUI 标签及 `src/web-search/passthrough-bridge.ts` 的诊断观察保留各自合同。
