# Trendymen Fork 差异

记录当前代码相对 [lidge-jun/opencodex](https://github.com/lidge-jun/opencodex) 已 rebase 基线的剩余能力。
基线：`v2.100.3`（`873ec9b3b8ddf63f06738748d9132d779abefb42`）；包版本见 [package.json](package.json)。CLI 与桌面包的版本源通过[版本同步工具](scripts/release-version-sources.ts)统一更新；Fork Tag 固定对应的发布提交，正式发布状态以 Tag 和 Release 为准。

官方文档保留上游原文。Fork 结构约束见 [structure/fork-extensions.md](structure/fork-extensions.md)，配置用法见 [Fork reference](docs-site/src/content/docs/reference/fork-extensions.md)，发布补充见 [FORK_MAINTAINERS.md](FORK_MAINTAINERS.md)。
能力变化时原地更新本文；历史设计、执行步骤、冲突和验证流水从 Git 历史、任务材料及 Release Notes 查阅。
测试和 GUI suite 默认沿用当前官方基线；Fork 独有能力不再有专项回归，只保留版本和发布元数据所必需的最小测试适配。官方测试不能视为完整覆盖这些 Fork 能力。

## 请求与工具兼容

Pool 安装身份改写后的 turn metadata 将超出 U+00FF 的字符转为 JSON 转义，保留合法 Latin-1 字符及中文、emoji 和其他字段的 JSON 值，避免写回 HTTP header 时触发本地 `TypeError`。账号身份隔离继续生效。实现见[身份头](src/codex/forward-transport-headers.ts)。

| 剩余能力 | 实现入口 |
| --- | --- |
| 日志详情区分客户端初始 Responses 顶层强度与初始输入中最后一个可识别的 `configuration_update`；列表强度列沿用官方显示。策略回退和压缩恢复保留初始观察。使用 `previous_response_id` 或 `conversation` 续接时，初始输入没有可见更新则显示未知；后续更新无法识别时也显示未知。WebSocket 后续帧不在初始观察内，观察不证明更新已转发或被上游采用。 | [观察](src/usage/session-effort-observation.ts)、[入口](src/server/responses/request-prepare.ts)、[策略回退](src/server/responses/policy-fallback.ts)、[日志](src/server/request-log.ts)、[界面](gui/src/pages/Logs.tsx) |
| GPT 官方订阅的原生 Responses 提供 23 项请求、响应、头字段和本地错误许可，全部默认开启并保留原功能条件。Direct/Pool（含新增账号）共用 Provider 配置，按每次最终目的地判断；第三方及转译入站不受影响。私有 SSE 5 秒、上游 WS 静默 90 秒及私有 HTTP 错误正文 5 秒期限可分别关闭，恢复重发与凭据保护保留；同名配置头合并时，按实际出站组核对原成员和 caller 持有情况。日志区分本地保护失败与原始上游 HTTP 状态。需保护私有值的未分类成功正文在交付前安全拒绝；不安全的 HTTP 错误正文被舍弃并保留上游状态，具体规则见 [Fork 配置](docs-site/src/content/docs/reference/configuration/fork-extensions.md#gpt-subscription-processing)。 | [配置合同](src/fork/codex-passthrough-contract.ts)、[turn](src/fork/codex-passthrough-turn.ts)、[私有值保护](src/fork/codex-passthrough-secrets.ts)、[面板](gui/src/components/provider-workspace/CodexPassthroughSettings.tsx) |
| 原生 Responses 流式 Combo 的实际 Codex 许可为 `synthesizeTerminalFailure: false` 时，带 `completed` 状态和 output 数组的真实 `response.done` 仍遵守官方必选工具合同。有效 block 不由该检查改写；关闭 `repairResponseToolCalls` 时，检查器不会把客户端未收到的修复后名称当作履约。已观察到 hosted 工具效果等不可安全重放证据时，缺工具失败不得再次发送。 | [必选工具检查](src/server/responses/combo-required-tool-stream.ts)、[交付许可](src/server/responses/passthrough-delivery.ts) |
| Canonical ChatGPT 转发在 Lite 许可允许时，把 HTTP Lite header 的 `true` 补到缺失的 WS body metadata，保留已有值和调用方 body。未声明 hosted-search 工具时的自动历史投影受 `normalizeRequestParameters` 控制，Provider 显式 Lite 历史投影保持独立。citation 索引与 title 修补、内部 `reasoning.enabled` 清理也受该许可控制；Provider input metadata 剥离保持独立。 | [passthrough.ts](src/adapters/openai-responses/passthrough.ts) |
| 分开判断 GPT 模型族、native 路由、保留别名和官方目的地；第三方托管 GPT 不等于官方服务。 | [model identity](src/providers/openai-model-identity.ts)、[destination](src/providers/openai-tiers-destination.ts) |
| Ark GLM/Kimi、BigModel GLM 的 Responses schema lowering、尾部 user turn 和空 assistant 清理，复用官方明文消息转换器。 | [glm-kimi-compat.ts](src/fork/glm-kimi-compat.ts) |
| 第三方工具 schema 清理 ChatGPT 专用 `encrypted` 注解；保留同名属性/literal，官方及显式可信直接 relay 保留注解，combo 不继承直接路由例外。清理器沿用官方逐路径副本，保留原字段顺序，使 Chat 的共享组合节点可展开，未改动 Responses 请求继续逐字节保真。 | [tool schema](src/adapters/responses-tool-schema.ts)、[transport](src/server/responses/request-transport.ts) |
| `agentMessageFormat` 选择 `preserve` / `user_message`；官方目的地保留原生格式，密文、未知 part 和空内容不做部分转换。 | [agent-message-format.ts](src/fork/agent-message-format.ts) |
| OpenAI Chat、Google、Command Code、Anthropic、Kiro 和 Cursor 适配器在各自工具条件满足时为请求加入进度提示；部分路径还加入工具发现、补丁顺序和失败恢复提示。模型 catalog 和原生 Responses 不自动追加这些提示，模型是否输出可见进度不作保证。code-mode 结果回显与宿主提示沿用官方处理。 | [progress contract](src/fork/routed-progress-contract.ts)、[tool catalog](src/adapters/tool-catalog-nudge.ts) |
| 为受支持的 `spawn_agent.fork_turns` 补字段说明，仅对当前授权工具的完成参数解包一层多余 JSON 字符串编码。 | [spawn-agent-compat.ts](src/fork/spawn-agent-compat.ts) |
| 修复当前声明允许的 nested `functions.exec` / `web__run` 调用，保留工具身份、取消和 continuation 提交边界；区分空成功与失败输出。 | [nested exec](src/responses/nested-exec-call-repair.ts)、[coordinator](src/server/responses-nested-exec-call-repair.ts) |
| 官方已有 routed custom-tool 基础；Fork 将 custom tool output 转为字符串，并在 Console Go 严格目的地合并可安全处理的重复 `call_id` 输出；无调用标识的剩余输出保留合法来源标签。 | [custom output](src/fork/custom-tool-output.ts)、[output recovery](src/adapters/openai-responses/tool-output-recovery.ts) |

## 响应、恢复与模型配置

| 剩余能力 | 实现入口 |
| --- | --- |
| `inferResponsesMessagePhaseModels` 为原生第三方 Responses 补 phase，包含普通 JSON，排除官方目的地和 GPT 族，区分宣布阶段、后续工作及终态证据。命中名单时优先使用该推断，其他路由继续使用官方 `messagePhaseInference`；避免两层缓冲丢失 EOF 尾项。 | [message phase](src/fork/responses-message-phase.ts) |
| annotation chip 入站说明改写和输出侧规范指令去反引号，保留代码块及其他正文。 | [instructions](src/fork/annotation-instructions.ts)、[directive](src/responses/annotation-directive.ts) |
| 客户端请求 summary 时投影第三方 content-channel reasoning，保留原字段、预算、生命周期及客户端实际收到的 continuation 形状。 | [summary rewrite](src/server/responses-reasoning-summary-rewrite.ts)、[adapter delivery](src/server/responses/adapter-delivery.ts) |
| `opencode-go` 缺省保留 Responses reasoning 正文，显式 `false` 优先。 | [registry](src/providers/registry/entries-core.ts) |
| SSE 正常 EOF / synthetic failure tail 前 flush；派生错误先按通用规则及选中出站凭据脱敏再限长，保留真实 Responses terminal 及单枚 `[DONE]`。裸错误采用官方 typed/untyped 证据归并和状态分类，不再增加竞争的 Fork EOF 读取重放；reader error 和 nested-exec barrier 不承诺 flush。 | [relay](src/server/relay.ts)、[eager relay](src/server/relay-eager.ts)、[rewrite](src/server/sse-payload-rewrite.ts) |
| strict backend 子任务恢复、原生 transient 5xx 耗尽后的单次重放、父任务加密 `MESSAGE` 超时通知和 `recovery_unreadable` 分类，沿用官方 admission 与发送预算。尾部 `configuration_update` 等官方元数据不改变当前任务识别，严格 envelope 与恢复授权仍需满足。恢复后因共享预算不足而未发送替代请求时，还原 Pool WS 拒绝投影，保留原 SSE 和终态处理。固定 Pool 的可选重建在发送前因安装身份失效而失败时保留原失败响应；同时取消时返回官方 `499`。普通 Pool 的替补账号回退继续遵守官方规则。 | [encrypted payload](src/server/responses/encrypted-payload.ts)、[task recovery](src/server/responses/agent-task-recovery.ts)、[native gate](src/fork/passthrough-agent-task-recovery.ts)、[dispatch](src/server/responses/passthrough-dispatch.ts) |
| 自动暂停后的同 Provider 换号先有界保存失败响应并释放旧 body 的并发槽，再发起替补；凭据跳转预算不足、无替补或旧 body 锁定时保留原响应，重建失败仍可交付原失败正文。已预留跳转但物理发送准入明确因预算拒绝时保留官方本地429及实际账号归属。 | [恢复交接](src/server/responses/account-auto-pause-recovery.ts)、[原生 dispatch](src/server/responses/passthrough-dispatch.ts)、[转译 dispatch](src/server/responses/adapter-dispatch.ts) |
| key-auth Responses 缺省补 `max_output_tokens`，模型级优先并按剩余上下文收紧；客户端显式值优先，forward 不注入。 | [passthrough](src/adapters/openai-responses/passthrough.ts) |
| 官方 customModels 上补校验、salvage、并发合并、公开投影、tool-mode API/CLI round trip 和 pricingStatus 保留；Provider 注册、更新及 caps 保存失败恢复未发布 live 值。Provider 更新包含 `setDefault: true` 时的默认值回滚，发布后的错误保留与磁盘一致的值。 | [custom models](src/config/custom-models.ts)、[model routes](src/server/management/model-routes.ts)、[Provider](src/server/management/provider-routes.ts)、[caps](src/server/management/provider-context-cap-routes.ts) |
| Ark 专用 quota 展示保留原文/reset，拒绝普通 overload；BigModel Codex `models[].slug` 动态发现。 | [Ark quota](src/fork/ark-quota-display.ts)、[discovery](src/providers/model-discovery.ts) |
| Codex Provider table 写入 `supports_standalone_web_search = true`，配合客户端 standalone 功能；尚缺绑定实现的 App 验收。 | [config-toml.ts](src/codex/inject/config-toml.ts) |

## 诊断与维护

- 可选 `forkModelApiListener` 默认关闭。回环主服务可保留独立管理端口并在 `0.0.0.0:10100` 提供原生模型数据面；非回环主服务必须使用 `10100`，不再创建辅助入口。辅助入口拒绝管理、GUI、session、配对、health/readiness 与 Remote Workspace；凭据、scope、用量和能力开关沿用原生规则。保存拓扑只影响下次启动，CLI 用同进程证明显示真实绑定和待重启状态；无证明显示未验证。配置与边界见 [Fork configuration](docs-site/src/content/docs/reference/configuration/fork-extensions.md#model-api-listener)。实现：[topology](src/fork/model-api-listener-config.ts)、[listener](src/fork/model-api-listener.ts)、[status](src/fork/model-api-listener-status.ts)。本地检查不代表已部署或外部设备连通。
- 文件读取投影已移除的 OpenCode Free 配置时，主动读取使用同一份原始字节尝试保留恢复副本，再执行 Fork listener 拓扑校验；passive 诊断不创建副本。无效的显式拓扑仍被拒绝，有效拓扑在修复后保留。入口：[配置](src/config.ts)、[诊断](src/config/diagnostics.ts)。
- 官方入站预算保留解压比例限制和 encoded body 的 reservation；捕获 Fork 请求文本时，读取器解压并测量 JSON 序列化大小，更新 reservation 后转移文本 lease。入站 reservation 保持到响应 EOF、错误或取消完成；文本 lease 随 source 生命周期释放，两者分别管理。Remote Link 的已解析 body 先执行官方限额和预算观察，按需额外保留一份 Fork JSON 文本；真实 Link 内存和深层序列化尚未验收。入口：[请求读取](src/server/request-decompress.ts)、[入站准入](src/server/inbound-body-admission.ts)、[请求来源](src/fork/codex-passthrough-source.ts)。
- Provider debug 增加磁盘结构日志、上游/重写后双阶段观察和独立授权的文本样本；按 4 MiB 分组、7 天、20 GiB 管理主日志与引用工件。工件引用统一使用 `/` 相对路径，绝对文件系统路径保留本机格式。旧 home 收养不接管预存路径。GUI 保存时，成功且仍有效的 PUT 响应先安装，再恢复控件；二态开关沿用官方 `aria-checked` 合同。入口：[persistence](src/fork/debug-persistence.ts)、[observation](src/fork/inbound-response-debug.ts)、[ownership](src/lib/config-ownership.ts)。
- `install:local` 离线 staging 后替换本地包，把 Volta、服务、readiness 和失败回滚纳入事务；macOS 安装补写结构/文本诊断环境，字体栈补丁保留。共享安装事务在验证后及每次 live→backup 重试前要求官方 `mayReplacePackage` 同步授权，并在重试授权前后复核 Fork pending marker 身份。`recoveryUnsafe: true` 优先拒绝 launcher/服务恢复，即使报告已回滚；安全 `pending-marker` 只适用于旧包未改且 `lstat` 确认 marker 不存在。启动恢复读取同样只将 `lstat` 的 `ENOENT` 视为不存在；链接、非普通文件或读取失败均拒绝自动清理和恢复，保留 marker、备份与 recovery 记录。入口：[installer](scripts/install-local.ts)、[transaction](src/update/transactional-install.mjs)。
- `X.Y.Z-ben.N` 更新保持同基线修订单调，稳定版同基线不覆盖 Fork，Tag 不可变。入口：[version policy](src/fork/version-policy.mjs)。同步和发布按 [现行政策](FORK_SYNC_AUTOMATION.md) 执行。
- gates 的[历史对象准备器](.github/scripts/fork-prepare-release-history.cjs)只为缺失的官方旧发布对象核对固定 Tag 与 SHA 并导入对象，保持 checkout、refs 和 `FETCH_HEAD`；查询本地对象时禁用 promisor 隐式补取，Git 不支持该约束时拒绝继续。准备对象不授予发布资格。[发布证据策略](.github/scripts/release-evidence-policy.json)单独登记当前 Fork 执行输入的精确指纹，保留官方历史策略记录；只有精确匹配的输入组合可使用对应记录。
- 官方基线准备先向固定上游查询精确 Tag 的 raw/peeled 身份；本地已持有相同类型和身份的 Tag、commit 时复用对象，缺少对象才在临时仓库抓取一层历史。候选 checkout 仍须证明基线祖先，必要时先补齐固定 HEAD 历史；异常或同名 Tag 冲突直接拒绝，不增加 CI 预算。
- 开发与发布候选统一在 `dev`，CI 的事件、job、条件、分片和预算跟随官方。Fork 的[来源准备](scripts/prepare-fork-official-base.ts)始终核对固定官方仓库的正式 Release、精确发布 SHA、Tag 类型及 raw/peeled 身份，并证明官方基线为固定候选 HEAD 的祖先；不依赖 main 或 upstream-release。浅克隆按固定 HEAD 补取历史，查询 fatal、抓取失败、HEAD 漂移或本地同名 Tag 不符均拒绝继续。Git 子进程排除 API token、仓库及对象库覆盖，禁用 replace/graft；Actions 只向固定官方 API 发送只读短期 token，本地缺省不带 token，错误只保留状态或固定阶段。候选以精确 lease 推至 dev 后执行 `workflow_dispatch lane=all`，核对同一完整 SHA 的 aggregate ci 和实际 checkout，不再要求 main push CI。本地不再自动跑整体测试，CI 失败后只定向验证报错项及直接相关回归。dev 与两个不可变 Tag 的原子发布及幂等恢复见[现行政策](FORK_SYNC_AUTOMATION.md)。

## 保留边界

- 官方 `omitDisabledNativeModels` 保持默认关闭，开启后仅省略符合条件的禁用原生模型；模型 catalog 不再追加 Fork 进度提示。
- Combo 的必选工具资格预筛（包括 Chat 目标与 Meta Responses）、当前轮工具目录与历史 item provenance、`additional_tools` 提升及不支持的 `output.encrypted_content` 清理采用官方实现。canonical forward 的工具提升还须 `normalizeRequestParameters` 许可允许，关闭或全关时保留字段存在性、值和数组顺序；第三方沿用官方自动目的地及 Provider opt-in 条件。Fork 的孤儿输出合法具名来源标签、Console Go 重复输出合并和订阅许可保持各自条件；缺失或非法来源使用官方 unknown 标记。
- Responses 采用官方 [pipeline](src/server/responses/core-pipeline.ts) 的 prepare、transport 和 retention 生命周期，Fork 在早退与最终交付边界附上实际许可；无效保留摘要仍返回官方 502 合同。[Combo preflight](src/server/responses/core-combo.ts) 的正常 SSE 重放与失败响应投影携带所选 child 的许可、显式 `null` 和本地失败身份。[共享头列表](src/codex/forward-transport-headers.ts) 保留 routing hint 项，HTTP/WS 共用；[transport](src/adapters/openai-responses/transport.ts) 在关闭合成时保留 Provider 静态值优先。普通 Pool 的选中身份隔离、main-pool 的身份保留及必要构建的身份错误映射采用官方实现。默认 encrypted-content 规范化沿用官方身份切换清理条件，显式关闭时跳过该规范化。canonical 缓冲 Combo 在 required-tool 校验后仍检查 `normalizeHostedImages`：关闭时保留 `image_generation_call`，不写显示工件。真实账号切换仍需验收。
- 关闭终态合成时，原始 `response.done` 的工具快照仍进入官方 [activity](src/codex/websocket-activity.ts) 观察层；客户端工具结果回传前不按 idle 回收，回传后允许回收，Provider 工具继续按实际所有权分类。原始 WS payload 保持不变。
- [canonical 请求重建](src/server/responses/request-prepare.ts) 复用初次展开的 replay 线程和 owner，保留 plaintext V2 决定及已解析的 native reasoning retention 选择；模型、账号切换及有界重建继续使用官方判定。[Fork fetch 包装](src/fork/codex-passthrough-fetch.ts)复核 canonical 目的地并注册 HTTP 预发送失败标记，底层 [fetch helper](src/server/responses/fetch-helpers.ts)保留传输职责。物理重放检查继续读取实际出站 body，Remote Link 的接受事件和 activity holds 沿用官方合同。
- 原生 reasoning 的未知来源 opaque 内容不会仅因同项存在正文而清理；已确认的身份切换和上游拒绝后的恢复继续使用官方清理条件。
- OpenGateway 精确目标的[工具结果投影](src/adapters/openai-responses/opengateway-input.ts)、单次空完成恢复、冷启动密文恢复和 DeepSeek 图片上传重检沿用官方合同。Fork 的 schema 持久化和结构诊断读取最终 `wireBody`；WS 发送计费保留官方一次 receipt，并继续传递所选 Codex 许可。Mistral 同目标暂停与本地失败、禁止重放标记分别保留，不因此禁止换 key。
- CI 选择与聚合判定采用官方 review lanes、scope reduction、privacy gate、structure gate 和文档链接合同。
- Antigravity Chat/Messages direct lane、main-account hard-lock 最早 retry 提示及 Qoder keypool 预算继续采用官方实现。启用 `repairResponseToolCalls` 时，工具修复沿用官方的 namespace 规范化与未声明调用拒绝条件；显式空目录仅在原工具守卫适用的入站和目的地执行 deny-all。订阅许可只适用于原生 Responses 的最终官方目的地，不扩大到第三方或转译入站；model-scope `model_not_allowed_for_key` 403 和硬预算始终保留。模型与服务商回退采用官方 [fallback policy](src/routing/fallback-policy.ts)，订阅许可不跳过回退授权。AgentAssertion 采用官方 [认证边界](src/lib/authorization-scheme.ts)，附加断言只随调用方原有 Bearer 发往官方 Direct，Pool 替换凭据不携带该断言。
- Claude picker 的上传拒绝与有界 linger 采用官方 [listener](src/claude/intercept/picker-listener.ts)。Fork 保留无 body 的 H1 400/503 同 socket 复用、其他上传/H2 sibling 和拒绝后重复 shutdown 的行为。
- 官方 [生命周期重放标记](src/lib/upstream-retry.ts)、same-target retry hold、模型计划拒绝与本地账号冷却身份通过 Fork 的预算和账号 lease 两层包装保留，并继续携带实际订阅许可和本地失败身份；EOF、reader error 与取消仍释放资源。官方 `x-should-retry: false` 的原响应直返、JEV committed stream 失败解 pin 及 SSE 分片扫描优化分别保留；Fork 的日志字段和 EOF flush 继续有效。
- 官方 Chat 空 assistant 配对、[Kimi 原生端点清理](src/adapters/openai-responses/empty-assistant.ts) 和 [V1 协作面识别](src/server/responses/code-mode-collab-surface.ts) 继续采用上游实现。Ark 的端点与空白处理、Console Go 重复输出合并、出站工具提示和 nested exec 调用修复仍有不同消费者，不能用上述分类覆盖替代。
- 裸上游错误采用官方 [recognizedUpstreamError](src/lib/errors.ts) 分类：未知 vendor type/code 归一化为 `upstream_error` / `upstream_server_error`。Messages/count 错误采用官方固定文案并保留受支持的状态与类型，模型 API 辅助入口复用同一合同。日志沿用官方闭集投影，不持久化任意 `upstreamError`；[本地保护分类](src/usage/error-detail.ts)保留八个 private 错误码、原始上游状态及本地归因。真实 `response.failed` 的业务终态保持保真；关闭相应许可的原生 Responses 与官方 Messages 错误合同分别维护。
- 已上游化的通用消息转换、Fernet multipart recovery、direct MCP 归一化、custom tool item type 及分别配置的 Bun runtime/test-runner 角色继续采用官方实现。删除剩余补丁须证明代码与测试等价；旧 allowlist、Spark 专属规则、动态 Fork runner 和滚动 CSS 补丁不恢复。
- Provider/App 端到端、真实 backend ciphertext、Windows 全局替换与服务恢复仍有验收缺口。官方测试、文档构建和审查不替代这些验收。
- `opencode-go` 的 Provider 级 reasoning 保留尚未逐模型验证；DeepSeek 400 与清空正文的因果关系未做 live 复现。原生 reasoning 合成事件未统一重分配 `sequence_number`。
- annotation 输出兜底不按本轮注解数量启用，跨行 code span 不处理；native 直通仅在许可允许时改写入站说明，客户端渲染仍需实机核对。
- 官方订阅开关的配置、默认值和关闭影响见 [Fork 配置](docs-site/src/content/docs/reference/configuration/fork-extensions.md#gpt-subscription-processing)。全关保留真实上游错误、agent-task-recovery 失败、硬预算及实际注入私有凭据保护；不承诺逐字节隧道。真实订阅与 App 仍需验收。
- debug ownership 元数据上限、旧 home 收养条件、安装 PID/断电/路径竞态和 Node 缺少通用 `openat` 仍是边界。
