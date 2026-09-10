# Trendymen Fork 修改清单

本文记录 [Trendymen/opencodex](https://github.com/Trendymen/opencodex) 相对已 rebase 的
[上游](https://github.com/lidge-jun/opencodex)基线仍保留的改动，以当前已提交代码和测试为准。

- 上游基线：`v2.50.0`（`2d4d7a22381a2e497c2442902104619e25f937c7`）。
- Fork 包版本以 [package.json](package.json) 为准；发布状态查看对应 Git Tag 和 GitHub Release。
- rebase 后原地更新基线、能力差异和覆盖结论，不追加版本章节、冲突流水账、候选 SHA 或测试计数。
- 新增、删除或改变 Fork 能力时更新对应条目。只在上游源码与测试证明等价覆盖后删除补丁；部分覆盖时保留剩余差异。
- 同步与发布流程统一见 [fork-sync-automation.md](docs/fork-sync-automation.md)。逐次冲突、验证和审查证据保存在对应 review package、任务记录与 Release Notes；旧记录可从 Git 历史查阅。

## 当前运行时差异

### Codex 官方转发的 HTTP Responses Lite 元数据

在上游已有的 Codex 请求头转发与 WebSocket metadata 处理上，Fork 补充 HTTP 入站 Lite 标识到出站 body 的映射：使用 Codex 账号转发到官方 ChatGPT 后端时，若 `x-openai-internal-codex-responses-lite` 请求头为 `true`，将缺失的 `client_metadata.ws_request_header_x_openai_internal_codex_responses_lite` 补为字符串 `"true"`，使上游 WebSocket `response.create` 帧保留该标识。
保留已有 metadata 字段和显式 Lite 值，不修改调用方原始 body；请求头缺失或值不是 `true`、已存在的 `client_metadata` 不是普通对象时不补写。最终 wire model 为 `gpt-5.3-codex-spark` 时遵循官方的 Lite 禁用策略，同时移除 Lite header 和对应 body metadata，保留其他 metadata。公共 OpenAI API-key 提供方与第三方 forward 不参与此映射。

代码：`src/adapters/openai-responses.ts` 的 `addCanonicalForwardResponsesLiteMetadata()`。
测试：`tests/codex-integration/codex-responses-lite-metadata.test.ts`，覆盖请求头转发、映射边界、原始输入保真与上游 WebSocket 帧；使用模拟 WebSocket，不代表真实服务端验收。

### 模型家族与官方目的地判断

模型家族与请求目的地分别判断：共用 `src/providers/openai-model-identity.ts` 的具名函数，保留原生路由、保留别名、清理候选各自的匹配范围，不把第三方托管的 GPT 模型视为官方服务。官方 Responses 目的地按实际请求 URL 判断，第三方消息兼容的默认策略另要求非 GPT/OpenAI 模型族；显式 `agentMessageFormat` 的覆盖边界见下文。
代码入口：`src/providers/openai-tiers-destination.ts`、router、config、catalog 及 GUI 的调用点。测试：`tests/providers/openai-model-identity.test.ts`、`tests/routing/routing-profile.test.ts`、`tests/gui/combo-workspace-data.test.ts`。

### 火山方舟 Agent Plan GLM/Kimi 与智谱 GLM Responses 兼容

Fork 补充第三方 Responses 的消息转换，并保留以下 schema 和历史消息兼容：

- 默认对第三方非 GPT/OpenAI 模型的原生 Responses 请求，将可读 `agent_message` 转为普通 user message，保留正文、发送者、接收者、消息顺序及图片/文件；覆盖 key-auth 和第三方 forward，转换不修改原始输入或重放数据。默认转换排除 OpenAI 运营目的地与 GPT/OpenAI 模型族，已有 Go 专用处理保留；包含真正密文、未知 part 或空内容时不做部分转换。显式配置可切换明文格式，见下文。
- Ark `https://ark.cn-beijing.volces.com/api/plan/v3` 的 GLM/Kimi-K3，以及 BigModel `https://open.bigmodel.cn/api/v1` 的 `glm-5.3` / `glm-5.3-flash` schema lowering。仅用于 `openai-responses`，保留 App 原始 schema；GLM 不写 Kimi schema catalog。
- 在深度和节点预算内处理 `$defs`、`$ref`、`oneOf`、`allOf` 与根级 `anyOf`，保留嵌套 `anyOf`、工具名、描述和可见 properties。
- 对拒绝 assistant prefill 的第三方 Responses 请求补尾部 user turn；OpenAI 运营目的地与 GPT 模型族硬排除。Volcengine 历史中的空 assistant text 会先清理，保留 refusal、非文本 part 和其他有效字段。

普通第三方 Responses（含智谱 GLM）还会在最终 `function.parameters` 中清理 ChatGPT 专用的 `encrypted` 注解，覆盖顶层工具、namespace 降低后的工具和 `additional_tools`。保留名为 `encrypted` 的属性、定义及 literal values，不修改 App 原始 schema；无注解时序列化保持不变。
官方 `stripUnicodePropertyPatterns()` 先处理不兼容的 schema pattern；Fork 在其结果上按原有条件清理 `encrypted`，不恢复已移除的 pattern，也不扩大注解清理范围。
OpenAI 运营目标，以及显式设置 `allowEncryptedV2AgentTasks=true` 的 key-auth 直接 relay 保留注解。combo 成员不继承该直接路由例外，发送前刷新 key selection 后仍执行清理，原 route/global 配置保持不变。
这项清理不改变密文 guard、strict-backend 分类或 recovery/auth，也不保证恢复旧异常密文。真实 GLM 小型请求已验证注解清理和明文工具参数，尚不代表 Codex App 子任务全链路验收。

代码：`src/fork/glm-kimi-compat.ts` 复用官方 `src/adapters/routed-agent-messages.ts` 的明文消息转换，schema 清理位于 `src/adapters/responses-tool-schema.ts`；通过 `src/adapters/openai-responses.ts` 和 `src/server/responses/core.ts` 接线。旧 `opencode-go.ts` 已由官方通用转换模块替代，不恢复重复实现。
测试：`tests/adapters/routed-agent-messages.test.ts`、`tests/providers/fork-glm-kimi-compat.test.ts`、`tests/providers/fork-kimi-schema-compiler.test.ts`、`tests/providers/fork-zhipu-glm-schema-lowering.test.ts`、`tests/providers/fork-trailing-user-turn-compat.test.ts`、`tests/providers/fork-volcengine-empty-assistant-content.test.ts`、`tests/responses/openai-responses-passthrough.test.ts`、`tests/server/agent-task-recovery-combo.test.ts`。

### 可配置的 agent_message 明文格式

Provider 可设置 `agentMessageFormat: "preserve" | "user_message"`。`preserve` 在前后两次 adapter 处理中均保留原生消息项；`user_message` 对第三方 Responses 显式转换合法明文数组和非空字符串，保留身份与原始正文。显式转换可用于第三方 GPT 模型，但官方 OpenAI/ChatGPT 目的地始终保留原生格式。
未配置时保持既有策略：Go 非 forward 的结构化明文跨模型转换，其他第三方非 GPT 路由（含 forward）转换结构化明文，xAI 非 forward 的非 GPT 模型另支持字符串正文。密文、空内容和未知 part 不做部分转换，不绕过原有恢复与安全检查。
配置 schema 和直接写入拒绝非法枚举；GET/DTO 返回字段。POST 省略字段时保留 mutation lock 内最新值，显式值覆盖；POST null 拒绝，PATCH null 清除并恢复默认。当前通过配置文件和管理 API 使用，没有新增 GUI 控件。

代码：`src/fork/agent-message-format.ts`、`src/adapters/routed-agent-messages.ts`、`src/config.ts`、`src/server/management/provider-routes.ts`。
测试：`tests/responses/agent-message-format.test.ts`、`tests/server/fork-provider-agent-message-format.test.ts`。

### 原生 Responses message phase 推断

上游 bridge 已有 phase 推断；Fork 为原生 passthrough 增加 `inferResponsesMessagePhaseModels` 显式配置。
OpenAI 运营目的地与 GPT/OpenAI 模型硬排除，已有 phase 原样保留。模型判断使用解析后的 ID：`gpt`、`chatgpt`、`codex`、`o1`、`o3`、`o4`、`openai/gpt-*` 和 `openai-gpt-*` 不会启用；只含 `gpt` 或 `openai` 的普通名称仍可在显式列表中启用。SSE 与有界 JSON 使用相同语义，区分 `commentary` 和 `final_answer`，只补 phase，不丢原字段。
管理 API 普通 POST 省略该字段时保留最新配置；显式清除使用 `PATCH null`，异步校验后在 mutation lock 内重读，避免旧快照恢复已删除的值。

代码：`src/fork/responses-message-phase.ts`、`src/server/management/provider-routes.ts` 及 relay/core 接线。
测试：`tests/responses/responses-message-phase-config.test.ts`、`tests/responses/responses-message-phase-passthrough.test.ts`、`tests/responses/responses-message-phase-rewrite.test.ts`、`tests/server/fork-provider-message-phase-config.test.ts`。

### 第三方工具任务的用户可见进度契约

为第三方工具任务加入普通 assistant 文本进度要求：首次工具调用前、重要里程碑后、长操作前、最多连续四个纯工具响应后，以及收到新用户消息后更新；完成时给出自包含结果，并尊重用户的静默或节奏要求。
转换型 adapter 复用上游 tool-catalog nudge；原生 passthrough 仅在非 OpenAI 目的地、带工具且已有字符串 `instructions` 时幂等注入。
原生 passthrough 的工具目录提示从最终 wire catalog 提取可调用名称，覆盖 namespace lowering 后的名称；已识别的 code-mode exec 说明嵌套 `tools.*` 调用、`ALL_TOOLS` 发现方式和结果回显，避免重复追加已有回显要求。
已知 GPT channel 指令转换为普通 assistant 语义；compaction、缺失 instructions 和 OpenAI 转发保持原形状。代理不合成进度消息，debug 只记录字节数和契约存在布尔值。

代码：`src/fork/routed-progress-contract.ts`，adapter、catalog 与 `src/fork/outbound-debug.ts` 的窄接线。
测试：`tests/codex-integration/fork-routed-progress-contract.test.ts`。

### apply_patch 顺序与失败恢复提示

OpenAI 兼容 Chat 和原生 Responses 路由中，当前可见 Codex `apply_patch` 或已识别的 code-mode `exec` 时，非 OpenAI 工具目录提示要求同一文件的补丁块按源码从上到下排列。遇到 `Failed to find expected lines` 时，提示模型检查补丁块倒序、重读当前文件，必要时拆成独立小补丁。
Kiro 当前通过已识别的 code-mode `exec` 接收该提示，仅有直接 `apply_patch` 的目录不适用。工具不可见或属于其他 namespace 时不据同名推断补丁能力。提示不重排补丁、不解析或改写 `exec` JavaScript、不修改非空失败输出，也不自动重试。

代码：`src/adapters/tool-catalog-nudge.ts`，复用 `src/adapters/openai-responses.ts` 的工具提示入口。
测试：`tests/adapters/tool-catalog-nudge.test.ts`、`tests/adapters/adapter-usage.test.ts`、`tests/responses/openai-responses-passthrough.test.ts`。

### spawn_agent fork_turns 字段说明与修复

原生 Responses 向第三方发送当前可用的 `collaboration.spawn_agent` 工具声明时，为受支持的 `fork_turns` string 字段保留原描述并补充完整 JSON 示例，说明值内容不包含引号字符。
返回侧复用普通函数完成项修复入口，只对当前已授权的该工具字段解包一层多余 JSON 字符串编码；解包后还须是合法的受支持值。不支持的 schema、非法值、多层编码、其他工具和其他字段保持原样，保留已有 unsafe-number 与工具身份检查。流式预览不变，完成项、JSON 与重放使用同一修复路径；规范 ChatGPT 登录转发不参与该完成参数修复。
去引号规则只支持普通 object 参数 schema 中仅含 `type: "string"` 和可选字符串 description 的字段，跳过引用、组合、enum/pattern 等未知约束。整数候选限于 `1..9007199254740991` 的无前导零十进制字符串，超范围值不推断或改写为其他轮次。
修复只替换该字段的字符串片段，保留其余参数原文；原始参数中存在重复的顶层 `fork_turns` 键时跳过去引号，其他已有参数转换仍按原规则处理。

代码：`src/fork/spawn-agent-compat.ts`、`src/adapters/openai-responses.ts`、`src/responses/function-call-compat.ts`。
测试：`tests/responses/openai-responses-passthrough.test.ts`、`tests/responses/responses-function-tool-repair.test.ts`。

### Nested code-mode 工具修复

上游已将裸 `exec_command` / `apply_patch` 接入统一 exec。Fork 额外修复 `functions.exec` / `web__run`，要求当前 turn 的 `functions` namespace 内恰有一个 `custom:exec`，且 lowering 来源一致。
普通 `function:exec`、顶层 `custom:exec`、其他 namespace 或多重声明不授权该修复。碎片事件与 passthrough SSE 原子缓冲；畸形、歧义、重复、超预算调用交给 undeclared-tool guard。
Continuation cache 仅在客户端收到有效 terminal 后提交；有界 JSON 在 inspection 仍有效时完成校验和缓存提交。
code-mode 历史输出另要求字符串 `instructions`、唯一 bare unnamespaced `custom_tool_call(name=exec)` 与对应输出。同一 `call_id` 与 function、local-shell 或 standalone output 碰撞时视为歧义，不改写非 custom exec 输出。

代码：`src/responses/nested-exec-call-repair.ts`、`src/responses/nested-exec-adapter-events.ts`、`src/server/responses-nested-exec-call-repair.ts`、`src/chat/nested-exec-eligibility.ts`、`src/adapters/responses-code-mode.ts`、`src/adapters/exec-tool-result-normalize.ts`。
测试：`tests/responses/nested-exec-eligibility.test.ts`、`tests/responses/nested-exec-repair-context.test.ts`、`tests/responses/nested-exec-repair.test.ts`、`tests/responses/responses-code-mode-exec-output-guard.test.ts`。

### Ark quota 在 Codex Desktop 中的展示

将匹配的永久 Ark usage quota 429 投影为不可重试的 HTTP 400 `invalid_request_error`，code 为 `volcengine_usage_quota_exhausted`。
保留 Ark 原文和 reset 时间，删除 `Retry-After`。仅接受无窗口、数字 `N-hour` 或 `weekly` 文案并要求完整 reset 时间及 `+0800 CST`；其他窗口、malformed JSON、普通 overload 和 legacy `usage_limit_reached` 不转换。
上游通用 quota/error pipeline 未覆盖这一客户端展示差异。

代码：`src/fork/ark-quota-display.ts`、`src/server/responses/passthrough-error.ts`。
测试：`tests/providers/fork-ark-weekly-quota.test.ts`、`tests/server/fork-ark-quota-error.test.ts`。

### 自定义模型配置、工具模式与公开投影

Fork 增加 `customModels` schema、stored tool mode 和 API/CLI round trip：

- 加载时逐行保留合法数据且不写盘；严格写入拒绝坏行、无效枚举、stable-ID 重复和新增 routed/native identity collision。历史冲突可保留，但歧义 selector 拒绝路由，仍可按精确 ID 删除。
- 按 stable-ID 三方合并，正确处理首次新增、删除最后一行与并发新增；reasoning efforts 规范化，未知 opaque 字段只在内部保存，公开 API/CLI/export 使用已知字段投影。
- `codexToolMode` 创建时省略为 inherit；更新时省略保留、枚举设置、`null` 清除。CLI 支持 `--tool-mode code_mode_only|shell|inherit`，列表展示存储值。
- 管理 API 按字段是否存在严格验证 provider、modelId、displayName、contextWindow、modalities、reasoning/default effort 和 tool mode；非法输入在持久化与 catalog 更新前返回 400。
- 自定义模型替换相同 Provider/模型的发现行时，管理 API 保留官方发现得到的 `pricingStatus`；免费、付费和未分类三种状态不互相替换。该字段只用于管理 API、CLI 和 GUI 筛选，不写入 Codex catalog。

代码：`src/config/custom-models.ts`、`src/config.ts`、`src/server/management/model-routes.ts`，router、catalog、CLI 的窄接线。
测试：`tests/config/fork-custom-model-config-schema.test.ts`、`tests/codex-integration/fork-custom-model-tool-mode-contract.test.ts`、`tests/codex-integration/catalog-free-pricing-status.test.ts`。

### Routed custom tool output 字符串化

上游已转换 item type；Fork 确保 `custom_tool_call_output` 降为 `function_call_output` 时 output 是字符串：字符串不变，text/refusal 按序换行拼接，其他结构转 JSON。

代码：`src/fork/custom-tool-output.ts`、`src/responses/custom-tool-compat.ts`。
测试：`tests/responses/custom-tool-compat.test.ts`、`tests/responses/fork-custom-tool-output-lowering.test.ts`。

### Provider diagnostics 与有界持久化

在上游内存诊断基础上增加 `provider-debug.jsonl`、outbound shape 摘要及入站结构摘要，分别观测 `upstream-inbound` 和 `downstream-after-rewrite`。
官方 hosted web-search bridge 开启时，通过其现有 SSE 解析点观察首段与续接段的原始 payload；不把合成的搜索事件记为原始上游响应，也不重复触发后续入站观察。诊断回调异常不影响 bridge 转发。关闭 bridge 时保留原有 terminal-repair 观察路径。
普通 Provider debug 只记录结构，不持久化请求正文、key、工具参数或 Response/reasoning 文本。
文本样本要求 Provider debug 和独立、默认关闭的 `providerText` 同时开启，可经 `OCX_PROVIDER_TEXT_DEBUG=1`、`ocx debug provider-text on`、API 或 GUI 明确授权。
样本经脱敏并保存为引用型 artifact；每字符串默认 256B、上限 8KB，UTF-8 安全截断，每轮最多 512 条并受总预算约束。
持久化统一经 `persistProviderDebugFile()`：单文件 4 MiB、总量 16 MiB、最多 256 文件、保留 7 天。ownership、canonical containment 或安全创建不确定即拒写；拒绝 symlink 与非普通文件。诊断失败不影响 relay。
旧版本创建、尚无 ownership 元数据的非空 OpenCodex home，只有存在 `runtime-port.json`、`service-state.json` 等 OpenCodex 运行时标记时才会被收养。收养状态写入 owner 与 manifest，并在进程重启后继续生效。每次登记前重新读取两份磁盘元数据；缺失、损坏或收养状态不一致时不会信任进程内缓存。新 manifest 从空路径集开始；收养前已存在的目录、普通文件、symlink 或越界父路径不会进入 ownership manifest，也不会由 uninstall 作为自有路径删除。只有收养后新建的安全路径可登记。Provider debug 和 Kimi schema 诊断把登记结果作为写入门槛，会拒绝预存容器；debug rotation 只扫描已登记的根。其他 config/runtime 写入器保持既有写入语义。没有运行时标记或其他 ownership 检查失败时仍拒写。Provider debug 拒写时每个进程最多输出一次不含内容的告警。
Kimi schema catalog 有独立的目录、文件数量、ownership 和权限预算；收养 home 中既有的 catalog 路径不会被接管，只有收养后新建并完成 ownership 登记的目录才能写入。

代码：`src/fork/outbound-debug.ts`、`src/fork/inbound-response-debug.ts`、`src/fork/debug-persistence.ts`、`src/fork/glm-kimi-compat.ts`、`src/lib/config-ownership.ts`、`src/lib/debug-settings.ts`、`src/web-search/passthrough-bridge.ts` 及 CLI/API/GUI 接线。
测试：`tests/config/config-ownership-uninstall.test.ts`、`tests/providers/fork-kimi-schema-compiler.test.ts`、`tests/server/fork-debug-persistence.test.ts`、`tests/server/fork-inbound-response-debug.test.ts`、`tests/server/fork-provider-debug-safety.test.ts`、`tests/server/fork-relay-eager-client-observation.test.ts`、`tests/web-search/web-search-passthrough-bridge.test.ts`。

### 第三方 reasoning summary 与 GPT continuation 清理

在上游通用 reasoning 投影基础上，Fork 保留 opaque terminal 与 raw content，为第三方 reasoning 补完整 summary part 生命周期。
同一历史转向原生 OpenAI GPT 时，只删除由第三方 `reasoning_text` 支撑的 opaque token，保留真正的 OpenAI blob。summary 只追加 `summary_text`，保留 `reasoning.content`、原始字段与 replay state。
有状态 rewrite 按第三句或 500 code point 中先到的边界分段，每个 `summary_index` 独立闭合。
EOF、稀疏 terminal、failed/incomplete 会先收尾；terminal-only reasoning 尾部仍投影。重复/迟到 part 不重开 index，终态后迟到 close 被抑制，空 part 不造 `**Thinking**`，SSE `event:` 与 JSON `type` 一致。
SSE continuation cache 复用相同的分段摘要规则，并保留官方 inspector 的稀疏 output 重建与已确定的 response ID；完整历史回传不因摘要格式不同而重复追加工具调用，Copilot 固定首个 ID 后仍能用该 ID 续接。首个失败终态后的 completed 不写缓存，重复 completed 不覆盖首份候选。

代码：`src/server/responses-reasoning-summary-rewrite.ts`、`src/adapters/openai-responses.ts`。
测试：`tests/providers/deepseek-reasoning-replay.test.ts`、`tests/providers/opencode-go-luna-wire.test.ts`、`tests/responses/responses-original-field-preservation.test.ts` 及同目录 `responses-reasoning-summary-*.test.ts`。

### SSE block rewrite flush 与终态兼容

Fork 为 block rewrite 增加可选 `flush` 和 stage 间传递：pull 正常 EOF、eager synthetic failure tail 前输出 retained block。
普通 pull reader error 只 dispose；nested-exec barrier 只有 dispose，不承诺 flush。
保留 Volcengine 默认开启、显式 `false` 关闭的 snapshot repair；客户端与 Provider 开关独立，沿用上游 Grok framing。
裸顶层 upstream error 保留分类和状态码；message-only nested error 沿用原始 frame；legacy/eager 终态后的重复 `[DONE]` 只发送一枚。

代码：`src/server/sse-payload-rewrite.ts`、`src/server/relay.ts`、`src/server/relay-eager.ts`、`src/server/responses/core.ts`。
测试：`tests/responses/fork-sse-block-rewrite-flush.test.ts`、`tests/server/fork-relay-eager-flush.test.ts`、`tests/server/fork-overload-error-eof-fidelity.test.ts`、`tests/responses/responses-snapshot-repair-server.test.ts`、`tests/responses/sse-failed-tail.test.ts`。

### Standalone web search 能力注入

在生成的 Codex Provider table 写入 `supports_standalone_web_search = true`；客户端启用 `[features].standalone_web_search` 后可用自身的 `exec` / `web__run` 路径。

代码：`src/codex/inject.ts`。相邻测试：`tests/codex-integration/codex-inject-integration.test.ts`；该 capability 尚缺专门断言和绑定当前实现的真实 App 验收。

### 智谱 BigModel Codex 模型发现

仅对 `zhipu-bigmodel-codex`、`openai-responses`、`https://open.bigmodel.cn/api/v1`（允许尾部 `/`）组合，将 `{ models: [{ slug }] }` 映射为内部 ID。
其他 Provider 保持默认 `data[].id`；沿用全局 2,000 条上限，无额外 64 条限制。
上游 `zhipu-bigmodel-responses` 静态预设未替代该动态目录；两种 ID 不同，不自动迁移用户配置。

代码：`src/providers/model-discovery.ts`、`src/providers/registry.ts`。
测试：`tests/providers/zhipu-bigmodel-codex-provider.test.ts`。

### 原生加密子任务恢复接力

上游提供通用 recovery admission、turn termination 与失败原因；Fork 扩展 strict non-Fernet backend ciphertext 的识别、admission、routed trigger 和 fail-closed forwarding。
官方 `v2.50.0` 已覆盖直接路由中原生模型切换为第三方后重放加密历史的恢复入口，不再要求该请求是派生子任务；Fork 保留严格 backend envelope、父任务 `MESSAGE`、原生 5xx 重试恢复和超时通知等扩展。
受 `agentTaskRecovery.enabled` 控制：原生目标的 transient 5xx 重试耗尽后，严格匹配 canonical `NEW_TASK` envelope 才恢复，并对已确定的 Provider、模型、account、tier、options 重放一次。
Slow 5xx、abort、直接成功、非 transient 和非原生 direct/combo 不触发该重试恢复。
严格 backend 子任务派发到非官方转发 Provider 前也经同一恢复路径；失败拒转，重放不再进入其他 OAuth/429/account/opaque/combo 重试，canonical OpenAI 转发保持拒转边界。
路由到第三方模型的父任务收到 worker 的加密 `MESSAGE` 时，也进入相同恢复入口；不再要求当前请求本身是 spawned child。既有 admission、缓存作用域和严格 envelope 校验仍决定是否允许恢复。
恢复默认使用 `gpt-5.6-luna`、`medium`，单次总时限 120 秒，响应头返回后的首字节与空闲等待最多 45 秒；超时最多重试两次。配置可通过 `reasoningEffort`、`timeoutMs`、`maxRetries` 调整。
已准入的子到父 `MESSAGE` 在超时重试耗尽后转为不含密文的未恢复提示：要求父任务向子任务请求重发，最多两次，仍失败则读取子任务最终回复。按调用者、父任务和密文隔离的短期状态支持后续历史重放；提示不代表正文已读或审查通过。`NEW_TASK`、父到子指令、拒绝、无效输出及取消仍保留原有失败边界。
严格 envelope 只接受精确 header/author/recipient/task、两段 content 与单个完整 ciphertext；成功和恢复后的 body 都不得写入 continuation state。

代码：`src/server/responses/encrypted-payload.ts`、`src/server/responses/agent-task-recovery.ts`、`src/server/responses/core.ts`、`src/lib/upstream-retry.ts`、`src/usage/log.ts`。
测试：`tests/server/fork-agent-message-strict-envelope.test.ts`、`tests/server/fork-agent-task-recovery-backend.test.ts`、`tests/server/fork-agent-task-recovery-body-ceiling.test.ts`、`tests/server/agent-task-recovery-routed-backend.test.ts`。

### key-auth Responses 的输出预算补全

上游只在 `openai-chat` 上使用 `defaultMaxOutputTokens` 与 `modelMaxOutputTokens`。Codex 不发送 `max_output_tokens`，上游自身默认值又可能远低于模型上限（DeepSeek 的 Responses 路由为 65,536），长回答因此以 `incomplete: max_output_tokens` 提前结束。
Fork 在 `openai-responses` 出站序列化前补写该字段：调用方未提供时按模型级、provider 级顺序取配置值，调用方显式值优先；两级都没有配置就保持上游默认。
`authMode: "forward"` 不注入，ChatGPT 转发后端不接受该参数。
代码：`src/adapters/openai-responses.ts` 的 `applyConfiguredResponsesMaxOutputTokens()`。
测试：`tests/responses/openai-responses-passthrough.test.ts`，覆盖未配置时不注入、模型级覆盖 provider 默认、调用方值优先与 forward 不注入。
文档：`docs-site` 的 provider 配置参考与 `structure/02_config-and-codex-home.md` 已同步。

### DeepSeek V4 Flash 直连图片输入

上游按 issue #88 把 DeepSeek 的全部 API 模型列入 `noVisionModels`，由视觉 sidecar 代读图片。
`deepseek-v4-flash` 现在自己接受图片输入：2026-09-10 直连实测，`POST /chat/completions` 与 Codex 实际使用的 `POST /responses`（`input_image`）携带纯色图都返回 200，该模型在两条线路上都从像素答出颜色；`deepseek-v4-flash-vision-exp` 对照返回相同答案。仓库内 2026-08-01 记录的“`/responses` 会把 `input_image` 换成占位文本”已不成立，官方 API 文档在测量当日仍写着这条占位行为与 Chat 线路的 400，属文档滞后，不要据此回退本项分类。Fork 把该模型移出 `noVisionModels` 并在 registry 声明 `["text", "image"]`，图片按原样发给上游，不再经过 sidecar；`deepseek-chat`、`deepseek-reasoner` 与 `deepseek-v4-pro` 保留 sidecar 覆盖，Pro 的图片路径未验证。
生效边界：`routedProviderConfig()` 把 registry 与配置中的 `noVisionModels` 取并集，配置里仍写有 `deepseek-v4-flash` 的安装要删除该条目才会生效。
代码：`src/providers/registry.ts` 的 deepseek 条目。
测试：`tests/providers/provider-registry-parity.test.ts` 覆盖 registry 声明与合并后的路由判定；`tests/routing/router.test.ts` 与 `tests/routing/routing-capability-model-matching.test.ts` 原有两条按 issue #88 断言全部 DeepSeek 模型为 text-only 的用例已改按新分类断言，并补一例“registry 图片能力模型可满足图片策略要求”。

## 当前维护、安装与测试差异

### 本地源码包安装

Fork 提供 `bun run install:local`，构建 GUI 后安装本地源码包，上游没有等价安装事务。
根 `package.json` 保持只读，构建前冻结 manifest；后续 staging、pack、验证、替换和 cleanup 比较同一快照。
owner-only stage 收集完整 runtime dependency closure，校验 tarball 文件、完整性、入口、资源和当前平台 Bun binary；使用隔离 cache 离线验证，关闭 install scripts，不回退联网。
同卷 sibling stage 验证后才执行 `live -> backup`、`stage -> live`，首次 rename 前写 transaction marker。
安装器保留 backup 到配置、service repair/restart 与 readiness 全部成功；失败先停新 runtime，再按 marker 恢复旧包和服务。
stage/backup 对象身份、普通目录与 containment 必须可验证；恢复不安全时拒绝继续 restart，必要时保留 quarantine 供人工恢复。
Windows wrapper 遇到 recovery marker 拒绝自动 restore；Node launcher 的失败提示仍沿用上游 warning-and-continue。
安装目标识别包含活动服务与 Volta 实际包路径；服务从新包的绝对入口 repair/restart，并验证 readiness。
Volta 登记同步与包替换共用事务，校验失败触发回滚，避免包已更新但 shim 或服务仍选择旧版本。
macOS 本地安装默认补 `OCX_DEBUG=1` 和 `OCX_PROVIDER_TEXT_DEBUG=1` 后 reload；`--no-restart` 只更新磁盘 plist，非 Darwin 保持环境。该默认值同时授权结构诊断与有界文本样本持久化。

代码：`scripts/install-local.ts`、`scripts/install-local-vendor.ts`、`scripts/install-local-volta.ts`、`src/update/transactional-install.mjs`、`src/service.ts`。
测试：`tests/ci-workflows/fork-install-local-*.test.ts`、`tests/ci-workflows/install-local.test.ts`、`tests/ci-workflows/install-local-vendor.test.ts`、`tests/windows/fork-windows-service-pending-transaction.test.ts`。

### GUI Logs/Debug 增量

采用上游 Logs/Debug 页面和 sidecar 布局。Fork 增加 `agent-task-recovery`、`oauth-account-429`、`opaque-blob-rejection`、`key-401` 恢复标签及 9 个 locale 翻译；Debug 增加独立 `providerText` 授权开关和对应设置字段。

代码：`gui/src/pages/Logs.tsx`、`gui/src/pages/Debug.tsx`、`gui/src/pages/debug-settings-panel.tsx`、`gui/src/pages/debug-shared.ts`、`gui/src/i18n/`。
测试：`gui/tests/debug-cache-revisit.test.tsx`、`gui/tests/debug-mutation-busy.test.tsx`、`gui/tests/debug-put-install-order.test.tsx`；sidecar 沿用 `gui/tests/sidecar-layout.test.ts`。

### `ben` Fork 修订版本策略

官方 `X.Y.Z` 对应 Fork `X.Y.Z-ben.N`，`N` 从 1 开始且为安全整数，拒绝前导零和其他 suffix。
更新先比较官方基线，再比较同基线 revision；同基线官方 stable 视为相同，不覆盖 Fork。
latest 的 null、malformed、preview/rc 在下载、停服务或安装前拒绝；显式 preview 只接受 canonical `preview.<identifier...>`。非 Fork 版本沿用上游策略。
Fork Tag 不可变，同基线 revision 单调，官方 Tag 必须保持原 type/raw/peeled；发布细则统一见同步文档。

代码：`src/fork/version-policy.mjs`、`src/update/index.ts`、`src/update/notify.ts`、`bin/ocx.mjs`、`scripts/bump-dev-version.ts`。
测试：`tests/update/fork-version-policy.test.ts`、`tests/update/fork-update-downgrade.test.ts`、`tests/update/fork-update-monotonicity.test.ts`、`tests/ci-workflows/bump-dev-version.test.ts`、`tests/ci-workflows/release-version-line.test.ts`。

### 测试、CI 与维护规则

Fork 暂时固定 Bun 与 `@types/bun` 为 `1.4.0`，lockfile、Docker 镜像和显式 workflow 版本同步。官方 `v2.49.0` 固定的 `1.4.2` 在本机默认并发门禁中重复发生 `SIGSEGV`，干净官方基线也复现；用户已授权这一运行时差异。该现象不证明其他平台同样失败，升级前需重新验证。

沿用上游 domain 布局、runner、并发、shard 和 timeout。Fork 保留 launcher/update 的真实 Node executable 与 PATH 可用性检查，以及 Responses state 的定向回归，不维护旧 runner 拓扑。
HTTP/SSE fixture 显式隔离 canonical ChatGPT 上游 WebSocket，避免真实外网握手影响本地测试；需要本地 WebSocket 的鉴权与 profile admission 测试保留真实客户端。共享隔离入口为 `tests/helpers/http-only-codex-websocket.ts`，不改变产品的 WS 选择或回退行为。
CI 保留无 workflow 级 `push.paths` 的逐 SHA 触发和 `scripts/prepare-fork-official-base.ts` 官方基线验证；采用上游 Docker job/filter/aggregate。
官方 Tag 来源、marker 与 ancestry 必须一致；缺失或冲突不能通过放宽测试解决。
本地实现与审查遵循 `AGENTS.local.md` 的最小修改面要求，优先窄模块和已有官方测试入口。

测试：`tests/ci-workflows/fork-ci-official-baseline.test.ts`、`tests/ci-workflows/fork-maintenance-truth.test.ts`、`tests/service/shutdown-launcher.test.ts`、`tests/update/update-stop-first.test.ts`、`tests/responses/responses-state.test.ts`。

## 已覆盖或不再恢复的方向

只保留会影响后续维护判断的结论；完整历史从 Git 查阅。

| 旧差异 | 当前处理与证据入口 |
| --- | --- |
| 缺失/非法 `call_id` 的独立 Fork 修复与测试 | 上游 passthrough、compaction 和 parser 已覆盖。Fork 会从经过类型和字符校验的 `namespace`、`name` 写入来源提示；无可用来源时采用 `[Tool output without call identification]`。见 `tests/responses/openai-responses-passthrough.test.ts`。 |
| 动态 `scripts/fork-test-runner.ts`、local-only worker group、quarantine list | 已移除，隔离和 serial lane 由上游 `scripts/test.ts` 管理。 |
| 按工具名过滤 Kimi 工具、automation 专用 lowering | 已由通用 compiler 替代，不恢复 allowlist 或过滤工具目录；见 `src/fork/glm-kimi-compat.ts`。 |
| Kimi 自动调用 `normalizeResponsesToolResultAdjacency` | 已移除；并行 `call A, call B, output A, output B` 合法。 |
| `usage_limit_reached` + promo header 展示 Ark quota | 已移除，避免覆盖 Ark reset，使用 Provider 专用错误。 |
| 旧 message-phase 模块、Fork sidecar 布局断言、MiniMax fixed-port workaround | phase 已迁至 `src/fork/responses-message-phase.ts`；sidecar 沿用上游测试；无同基线失败证据不恢复 fixed-port 补丁。 |

## 已知缺口与验证边界

- 合成测试和静态断言不替代真实 Provider/Codex App 验收。Standalone web search、真实 minted backend ciphertext + recovery SSE，以及 weekly quota、empty-assistant、custom model 的客户端终态仍需绑定具体实现验证。
- Reasoning 合成事件没有统一分配新的 `sequence_number`；closed-state 到 terminal teardown 才释放。
- Provider debug ownership manifest 仍可能随 unique artifact 增长到上限并拒写，不承诺自动压缩。旧 home 只有存在已知 OpenCodex 运行时标记时才会被收养；仅含通用 `config.json` 等文件的目录继续拒绝。收养前已存在的 debug 或 Kimi catalog 目录不会被接管，对应写入会继续拒绝，需由用户迁移或清理该路径。独立 `ocx service repair/install` 可能覆盖本地安装写入的 `OCX_DEBUG=1`。
- 安装与恢复的 isolated/unit/static 测试不证明 Windows PowerShell/junction、真实全局替换与服务恢复均已验收。PID reuse、断电持久化及路径检查到 rename/remove 的竞态仍是边界；损坏安装下的 launcher 启动仍需动态验证。
- Node 缺少通用 `openat`，诊断持久化和安装器的路径防护不能完全排除父目录并发替换。
- Windows 跳过 package-shaped npm launcher 子进程用例；Bun `runUpdate()` 缺真实 package-shaped smoke。GUI update badge 尚不显示同基线更高 `ben.N`，preview parser 仍是既有单数字形态。
- 同基线新 Tag 名称无法建立 wildcard lease，发布依赖 single publisher，并在 push 后、Release 前复核；具体规则与结果记录按同步文档执行。
