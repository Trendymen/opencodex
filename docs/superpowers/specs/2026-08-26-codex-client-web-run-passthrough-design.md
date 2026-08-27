# Codex client-owned `web.run` 最小兼容设计

## 结论

让 Codex CLI 0.149 自己注册并执行 `web.run`。OpenCodex 不注入顶层 `web__run`，不设置模型名单；除 managed provider capability 外，只增加通用的 `custom:exec` lowering guidance 与 request-scoped nested-call repair，用来纠正第三方模型把 code-mode nested tool 名误发成顶层 function call 的已实测兼容缺口。

该方案覆盖同一 aggregate OpenCodex provider 下的 GPT 与所有 ordinary routed 第三方模型，并覆盖 OpenAI Responses、OpenAI Chat Completions 与 Claude Messages 三种协议表面。request path 不读取模型、provider 或 dialect 白名单。

## 已验证的 Codex 0.149 协议

基线为官方 `rust-v0.149.0`，commit `758ef40f50c1a458425c7cfbf1eb12cbc07af0b0`。

1. `WebSearchExtension` 可用条件是：OpenAI provider、OpenAI actor auth，或 custom provider 声明 `supports_standalone_web_search=true`；同时 `web_search` 不能为 `disabled`。
2. `web.run` 的每轮 planning 条件是 namespace tools 可用、provider `web_search` capability 可用，并满足 `model_info.use_responses_lite || features.standalone_web_search`。
3. standalone `web.run` 已注册时，`hosted_model_tool_specs()` 明确不生成 hosted `web_search`；Responses Lite 也不生成 hosted spec。因此 OpenCodex 无需再次扫描/清理 hosted tool，`planWebSearch()` 因 `_webSearch` 不存在自然不触发。
4. 扩展真实身份是 namespace `web` / name `run`；code mode 只把它编入既有 `custom:exec.description` 并命名为 `web__run`。OpenCodex 不得注入 top-level `function:web__run`。
5. `SearchClient` 使用当前 provider 的 `base_url`，通过相对路径 `alpha/search` 请求。Codex 的拼接是去掉尾 `/` 后追加路径；所以 `http://127.0.0.1:10100/v1` 必然命中 `POST /v1/alpha/search`，不需要额外 `/alpha/search` alias。
6. `supports_search_tool` 只控制 deferred `tool_search`，不参与 standalone gate。

真实证据与源码一致：

- 同一 GPT-5.4/同一提示，standalone 开启时搜索事件 id 为 `call_*`；关闭 standalone 时 hosted `web_search_call` id 为 `ws_*`。两者都 exit 0，但协议来源不同。
- custom provider 同时开启两个 standalone flag 且 `web_search="live"` 时，第三方 raw `/v1/responses` 只有现有 `custom:exec`（description 含 `web__run` 与 `search_query`），没有顶层 hosted `web_search`，也没有原生顶层 `web__run`。
- DeepSeek 官方直连在相同 flags 下已产生 `call_*` standalone 事件；失败原因是第三方 base URL 没有 `/alpha/search`，证明缺口在 relay，而不是工具注册。
- 完整 hooks/MCP/agents 环境下，Agent Plan 的 Flash、GLM-5.2/5.3 会随机先误发顶层 `web__run` 再在重试中选择正确 `exec`；V4 Pro 稳定误发 `web__run`；Doubao 在 `web__run` 与 `functions.exec` 间误发。两模型入站工具目录逐字段相同，且旧 overlay/名单符号全仓为零。
- DeepSeek 官方 Responses provider 的普通非流式与流式请求均已 200/completed；但 client-owned search 中仍误发顶层 `web__run`，证明该缺口属于模型 code-mode tool-call dialect，而不是 Ark 或 alpha relay。
- DeepSeek 官方 `deepseek-v4-flash-vision-exp` 直连 `/responses` 已返回 200/completed；但 OpenCodex 内置 DeepSeek registry 只给 V4 Flash/Pro 设置 Responses per-model default，vision-exp 会经过 `openai-chat` adapter。因此只修 Responses passthrough 会遗漏真实 ordinary routed 模型。
- Native custom A/B：DeepSeek 官方明确 400 `Unsupported custom tool: exec; only apply_patch is supported`；Agent Plan 即使强制 `tool_choice=custom:exec`、2048 output tokens 也只返回普通 message，不产生 custom call。因此两条 provider 路径都不能假定 native custom-exec，可逆 function lowering 仍是兼容基线。
- Agent Plan 直连已验证精确模型 id `kimi-k3` 为 200/completed；`k3` 与 `k3[1m]` 均以 `UnsupportedModel` 404 拒绝。Kimi-3 必须作为独立模型测试，不能从 Kimi-k2.6 外推。
- 误发的 `function_call(name="web__run")` 在 `output_item.done` 中实测存在三种 arguments：`{input:string}`、`{search_query:...}`、`{search_query:...,response_length:...}`。正确调用的 exec input 实测为 `const result = await tools.web__run(...); text(JSON.stringify(result, null, 2));`。

## OpenCodex 现有闭环

OpenCodex 2.33 已有 `POST /v1/alpha/search`：

- `src/server/index.ts` 执行 admission、CORS、日志与 turn admission 后进入 `handleSearch()`；
- `src/server/search.ts` 固定选择 native ChatGPT forward，并请求 `${baseUrl}/alpha/search`；
- 普通 GPT/第三方 search body 经 JSON parse/stringify 后字段不改写；account-qualified GPT 只剥 OpenCodex 自己的账号 namespace；
- 入站 provider query/private admission secret 不转发；upstream status/body relay 给 Codex。

本任务复用该实现，不修改 `src/server/index.ts` 或 `src/server/search.ts`。

## 最小源码变更

### 删除错误实验

完全删除：

- `CLIENT_WEB_RUN_SCHEMA_V1` 与 `src/responses/client-web-run-schema.ts`；
- `_clientWebRunOverlay`、`_clientWebRunAuthorized`；
- adapter 的 `applyClientWebRunOverlay()`；
- Core 基于 metadata/exec 文本的 overlay 注入、schema digest、模型名单判断和对应 400；
- `clientWebRunPassthroughModels` 的 registry/type/router 字段与两模型数据。

不得换成另一种模型、provider 或 dialect 名单。Generic undeclared-tool guard、current-turn catalog、`custom:exec ↔ function:exec` 与 namespace 可逆兼容层保持不变。

删除 `_clientWebRunAuthorized` 后，`wsPlan` 恢复为普通 `!routedCompaction` 条件。standalone ON 请求没有 hosted declaration，因此 `planWebSearch()` 返回 `undefined`；这依赖 Codex 原生 planning，而不是 OpenCodex 文本猜测。

### 发布 aggregate provider 能力

`buildProviderTableBlock()` 统一生成：

```toml
supports_standalone_web_search = true
```

独立验收配置同时显式设置：

```toml
web_search = "live"

[features]
standalone_web_search = true
```

两个 standalone flag 在 A/B 中一起增减。不得修改用户主 `~/.codex/config.toml`。

### 通用 exec lowering guidance

`custom:exec` 仍通过现有 `custom ↔ function` 可逆层降为 `function:exec`，完整 `exec.description` 原样保留。只增强 `function:exec.parameters.properties.input.description`：

- `exec` 是 code-mode nested tools 的唯一顶层入口；
- nested `web__run`、MCP 与 agent tool name 不得作为顶层 function call 输出；
- nested tool 必须在 `exec` 的 JavaScript input 中通过 `await tools.<name>(...)` 调用；
- 需要把 nested result 返回模型时使用 `text(...)`。

该 guidance 对所有发生 custom-exec lowering 的 routed requests 生效，不读取模型/provider 名称，不从 user message 推测。

### Request-scoped nested-call repair

新增一个位于现有 custom-tool restoration 之前、generic undeclared-tool guard 之前的 SSE block rewrite。它不是新工具声明，也不扩大客户端权限。

激活条件全部来自当前请求：

1. 本轮 raw catalog 恰好存在一个可归属、无同名 function/custom/namespace 冲突的 `custom:exec`，且 adapter 确实把这一个 declaration 降为 upstream `function:exec`。重复 exec、不同 description 并存、同名 function/custom 冲突或 replay-only declaration 均不建立 repair plan；
2. 修复 `web__run` 时，同一个 exec description 必须包含 Codex code-mode 生成的独立 `web__run` 工具段标题或 typed declaration，并包含 `search_query` schema；
3. 目标 alias 未被 current-turn raw catalog 直接声明。显式 top-level `web__run`、`functions.exec` 和 raw namespace `web.run` 均保持原语义；namespace 继续先走现有 namespace restoration。直接声明永远优先于 nested repair；
4. 不读取 user text，不按 provider/model/dialect 名单授权。

只处理两个已验证 alias：

- `functions.exec`：规范化为已声明的 wire name `exec`，arguments 保持原样；
- `web__run`：
  - arguments 为 `{input:string}` 时直接规范化为 `exec` 的 wrapper；
  - arguments 为普通 JSON object 时，用 canonical JSON 生成 `const result = await tools.web__run(<json>);\ntext(JSON.stringify(result, null, 2));`，再包装为 `{"input":<javascript>}`；
  - 非 object、超预算或无法完整解析时不修复，继续由 generic guard fail closed。

repair 由共享的完整 payload transformer 与 SSE 原子 barrier 两部分组成：

- `repairNestedExecCallsInPayload()` 只处理已经完整的 call item/response snapshot，供非流式 JSON、SSE `output_item.done` 和 terminal snapshot 共用；
- 完整 payload transformer 先分析全部 enabled aliases；任一 recognized alias rejected 时返回原始完整 payload，不得把同一 response 中其他 alias 部分修复；全部安全后才一次性产生 repaired payload；
- SSE block rewrite 在看到第一个 candidate `output_item.added` 后建立全局 barrier，从该 block 起按原顺序有界保留所有 interleaved blocks，直到 barrier 内每个 candidate 都取得 matching `output_item.done`，或遇到 terminal/`[DONE]`；
- 完整解析成功时，每个 candidate 保存唯一 `normalizedArguments`。一次性按原始全局顺序输出完整转换组：added/output_item.done/terminal snapshot 使用规范 `exec` item；原始 argument deltas 全部抑制。存在唯一 `function_call_arguments.done` 时在其原位生成恰好一个包含完整 wrapper 的 deterministic delta 与一个 done；不存在 arguments.done 但 `output_item.done.item.arguments` 完整时，在对应 output_item.done 之前紧邻插入这一组 normalized delta+done；两处 arguments 并存但内容冲突、存在多个 done 或无法唯一关联时整组原样回退给 guard。不得向后级泄漏 direct search JSON fragments 或先行的已改名 `exec` added；
- 任一 candidate malformed、关联失败、超预算或 terminal 前未闭合时，一次性按原顺序输出未修改的原始 blocks，让末尾 generic guard 在第一个 undeclared added 上 fail closed；不得输出转换一半的 lifecycle；
- terminal 包含 `response.completed`、`response.incomplete`、`response.failed` 与 `[DONE]`。异常 EOF/abort/dispose 只释放 retained budget，不向客户端放行任何尚未提交的 candidate；现有 relay 负责断流失败。

转换覆盖同一 call 的 `response.output_item.added`、`response.function_call_arguments.delta/done`、`response.output_item.done` 与 terminal response `output`，保留原 `id/call_id/output_index/status/order`。它输出规范化的 `function_call(name="exec")`，随后复用现有 custom-tool restoration 转成 Codex 客户端期望的 `custom_tool_call(name="exec", input=...)`；最后 generic guard 仍比较客户端真实声明目录，其他未声明工具继续拒绝。

每个 candidate arguments 上限 64 KiB，单个 barrier 保留 blocks 上限 256 KiB。64 KiB 是 pure transformer 和 JSON path 的无状态字节校验，不重复计费；SSE barrier 对每个 retained block 只向现有 `TranslatorBudget` charge 一次，arguments 是已计费 block 的子集。成功 flush、原样回退、terminal、`[DONE]`、abort 与 dispose 均释放全部 retained bytes；超限走原样回退到 guard，禁止无界保留 arguments 或 SSE blocks。

### Responses、Chat 与 Claude Messages 三协议一致性

修复必须覆盖两类内部传输，而不是把某个模型强制切到 Responses 来规避：

1. **Responses passthrough**：继续在 raw Responses JSON/SSE 上运行完整 payload transformer 与原子 block barrier；
2. **adapter event bridge**：`openai-chat`、`anthropic` 以及其他经过 `AdapterEvent` 的 routed adapter，在 `bridgeToResponsesSSE()` / `buildResponseJSON()` 之前运行共享的 request-scoped event repair。它从 `tool_call_start` 起原子保留 candidate 的 start/delta/end，取得完整 arguments 后调用同一个 pure call normalizer，再一次性发出 `tool_call_start(name="exec")`、规范 arguments delta 与 end。malformed、冲突、超 64 KiB、在 done/error 前未闭合时整组原样放行给 bridge 的 undeclared guard，不能泄漏半转换 lifecycle；普通 text/thinking/usage/heartbeat 事件保持全局原顺序。

OpenAI Chat Completions 和 ordinary routed Claude Messages 入站会先翻译成内部 Responses request，再进入相同 routed adapter pipeline；协议入口测试必须分别以三种原始请求格式证明 current-turn `exec` declaration、显式 alias precedence、tool result replay 与 client output restoration 一致。Chat key/local provider 的 native fast path 若收到具有 code-mode nested declaration 的 `exec`，必须让该请求进入相同 provider/credential 的 canonical routed pipeline，不能绕过修复；不含该 surface 的普通 native Chat 请求保持原 fast path。

Claude direct-native passthrough（调用者自行提供 Anthropic credential、原生模型 id/headers/betas）不属于 ordinary routed provider，本任务不改变其 shortcut、认证域或原生序列化。用户新增的 `volcengine-claude/deepseek-v4-flash` 是 configured routed provider：模型 selector 会先命中 OpenCodex route，再通过 `anthropic` adapter，因此属于本任务并使用 canonical AdapterEvent repair。不得把 direct-native caller credential 导入 routed `handleResponses`。

授权 catalog 同时接受三种协议翻译后唯一、无冲突的当前轮顶层 `exec` declaration：Responses `custom:exec` lowering，或 Chat/Claude 翻译得到的 `function:exec`。两者都必须携带同一个 exec description，`web__run` 仍需独立工具段/typed declaration 与 `search_query`。历史 replay、同名 custom/function/namespace 冲突、直接声明的 `web__run` / `functions.exec` / namespace `web.run` 均不得授权 alias repair。

三协议共享同一个 pure normalizer、64 KiB candidate 上限、undeclared guard 和 continuation/cache 规范结果；不得为 Chat、Responses 或 Claude Messages 建模型名单、不同 alias schema 或宽松兜底。pure normalizer 只规范 alias/name/arguments，不决定客户端 call kind。最终输出与 replay 必须保持原始 declaration provenance：

| 入站声明 | 内部规范 call | 客户端输出 | 下一轮结果 |
|---|---|---|---|
| Responses `custom:exec` | upstream-wire `function_call(name="exec")`，随后 existing custom restoration | Responses `custom_tool_call(name="exec", input=...)` | `custom_tool_call_output` 经现有 lowering 回到 matching function output |
| Responses/Chat `function:exec` | `function_call(name="exec", arguments=...)` | Responses function call 或 Chat `tool_calls[].function` | matching `function_call_output` 或 Chat `role:"tool"` |
| Claude Messages tool `exec` | `function_call(name="exec", arguments=...)` | Claude `tool_use(name="exec", input=...)` | Claude `tool_result` 翻译为 matching function output |

Responses raw barrier 的 256 KiB block 保留上限继续生效；AdapterEvent barrier 复用 `TranslatorBudget` 对保留事件字节逐次 charge/release，并采用同等 256 KiB retained ceiling。

### JSON 与 replay 一致性

非流式 `application/json` 和 provider forced bounded-JSON 路径必须在 existing custom restoration 与 undeclared guard 之前调用同一个完整 payload transformer。SSE terminal snapshot 也使用该 transformer，保证 streaming/non-streaming 对同一 call 得到相同 `id/call_id/name/type/arguments`。

客户端看到的 call kind 由上表的原始 declaration provenance 决定；不得把 Chat/Claude function/tool 声明统一恢复为 Responses custom call。下一轮结果按现有入口 translator/adapter 映射回 matching `function_call_output`，不得保存或 replay 原始 `web__run/functions.exec` alias。测试必须覆盖三协议两轮 replay、call ID、output、item order 和最终客户端 call kind。

### Inspection 与 continuation cache 一致性

inspection 分支不能在 repairable alias 的 `output_item.added` 上立即设置 sticky undeclared。新增一个由 client SSE barrier 与 inspection/cache 共享的 request-local outcome coordinator；client-visible barrier 是是否允许 continuation cache 的唯一提交权威。inspection state 复用同一个完整 payload transformer，但只能准备 cache candidate：

- enabled alias 的 added 只登记 pending，不判未声明；matching done/terminal 完整修复成功后，以 upstream-wire `function_call(name="exec", arguments={input:string})` 参与 undeclared 检查；
- malformed、超预算、关联失败或 terminal 前未闭合时设置 sticky undeclared，禁止 continuation cache 写入；
- 成功 done item 按 output index 有界保留到 terminal。terminal snapshot 中 alias 被同一 transformer 修复；若 provider terminal output 缺失对应 item，则用已完成的规范 done item补入 cache candidate，保持顺序且不覆盖 provider 已给出的其他 output；
- inspection terminal 先到时只把 repair 后的 response 作为 pending cache candidate 交给 coordinator。只有 client barrier 已实际原子提交完整 repair、到达 client terminal 且末尾 guard 未拒绝时，coordinator 才调用 `rememberResponseState`；
- client barrier overflow、原样回退、guard rejection、client abort、EOF 或 dispose 均把 coordinator 置为 sticky rejected，丢弃 pending cache candidate。inspection 不自行估算 interleaved block budget，也不得覆盖 client-visible 256 KiB 决策；
- `rememberResponseState`、tee inspection、eager inspection 和 JSON cache 都只能接收 repair 后的 upstream-wire response。缓存中不得出现 `web__run/functions.exec`；
- inspection retained item 同样使用 `TranslatorBudget` charge/release，terminal、abort、EOF、dispose 全部清理。

generic guard 继续是最后一个会改变客户端 payload 的安全 rewrite，并通过可选 rejection callback 把任何拒绝写入 coordinator。guard 之后只允许一个不改变 block bytes 的 outcome observer；它仅在真实 client terminal 已穿过 guard 时标记 committed，并触发已暂存 cache candidate 的 remember。JSON 路径则在同步 guard 检查通过后才直接 remember repair 后 response。

真实 replay probe 必须调用现有 remember→expand 路径，而不是手工构造“已经修好”的第二轮。

### 延后 Ark continuation 修复

`missing partial` 与 Minimax assistant-prefill 400 当前都发生在 nested-tool leakage 触发重试之后。本阶段不添加 `partial`、不删除 trailing assistant item，也不做模型 capability 名单。只有 nested-call repair 后仍能在“零错误 tool call”的独立路径稳定复现，才另写 Ark continuation Spec。

### 保持不变

- 所有 routed catalog 行继续 `supports_search_tool=true`，仅作为 deferred tool inventory；
- `responsesSnapshotRepair` 继续作为火山 SSE 独立修复；
- `namespace-tool-compat.ts`、`server/search.ts`、`server/index.ts` 保持不变；
- 不新增 top-level tool、模型白名单、hosted-tool strip、搜索三态或 search sidecar 分支。

## 验收

使用独立 `CODEX_HOME` 和独立 `config.toml` 指向 `http://127.0.0.1:10100/v1`。

1. GPT-5.4 A/B：OFF 同时移除 provider capability 与 feature，得到 `ws_*` hosted 对照；ON 同时开启两个 flag、`web_search="live"`，得到 `call_*` standalone。两次均保留 JSONL/stderr。
2. ON 的 raw observer：首个 `/v1/responses` 不含 `type:web_search` 或 top-level `web__run`；现有 exec description 含 `web__run/search_query`。
3. 协议 probes 必须覆盖：`web__run` 的 input wrapper/direct JSON、`functions.exec`、两个 candidate 与普通事件交错、无 arguments.done、done 与 item.arguments 冲突、malformed、64 KiB/256 KiB 边界、terminal-before-done、`response.failed`、client barrier overflow/abort 与 inspection terminal 竞态、非流式 JSON、forced bounded JSON、两轮 replay，以及显式 top-level/namespace 同名声明保持原样。
4. 自动化协议矩阵覆盖所有 ordinary routed `ingress × upstream adapter` 组合：Responses、Chat Completions、Claude Messages 三种原始 HTTP ingress，分别配本地 fake `openai-responses`、`openai-chat`、`anthropic` upstream，共 9 种真实 handler/router/adapter 组合；每种均断言实际 upstream pathname，并覆盖 streaming/non-streaming、合法 `exec`、两个 alias 的受限恢复、malformed fail closed、tool result replay/call-id、direct declaration precedence 和正确客户端 call kind。另测无 code-mode surface 时 Chat native fast path不变，以及 Claude caller-credential direct-native passthrough完全不进入本修复。
5. 使用与主配置对齐的独立 HOME：同步 hooks、MCP、agents、rules、skills/plugins 和认证副本；只改临时 catalog path、provider base URL 与 WebSocket observer 条件。所有临时 HOME 在 `umask 077` 下创建为 `0700`，认证文件不放宽原 mode，日志不得含凭据；无论成功/失败，最终健康检查前都删除敏感临时副本。工具保持可见，但不得把子代理/MCP/shell/memory 的结果算作目标模型搜索成功。
6. 最终真实矩阵只重跑每类协议的最小代表集，每个至少连续两次相同搜索提示：Responses 为 `volcengine-agent-plan/deepseek-v4-flash`、`deepseek/deepseek-v4-flash`、`volcengine-agent-plan/kimi-k3`；Chat 为实际解析到 `openai-chat` 的 `deepseek/deepseek-v4-flash-vision-exp`；Claude Messages 为 `volcengine-claude/deepseek-v4-flash`。此前其余已通过模型保留现有证据，不再重复全量调用。Kimi-3 已由用户手动持久加入 OpenCodex provider，并明确要求执行 `ocx sync` 写入主模型目录；本任务不得删除、回滚或把它视为临时残留。Chat/Claude 两条必须以 usage/attempt provenance 证明真实 resolved adapter 为 `openai-chat` / `anthropic`，不得为了通过而切 Responses。每次都必须由目标模型产生合法 `exec-*` standalone begin/end、命中本地 `/v1/alpha/search` 2xx、包含来源 URL，并在工具结果后完成最终答案。
7. 所有运行必须零 `web__run/functions.exec` reconnect、零 `unsupported/undeclared_tool_call`、零 `missing partial/prefill`、零 `OutputTextDelta/ReasoningSummary* without active item`。任何一次自动重试后成功仍判定失败。
8. 结合固定 relay 源码与本地 observer 的 2xx，确认上游唯一目标为 ChatGPT `/alpha/search`；不得把 search 发到第三方 model provider。
9. `rg` 证明 overlay/名单符号为零；main Codex config 验收前后 SHA-256 相同；OpenCodex 最终 ready。

真实验收若发现 ON raw body 仍含 hosted `web_search`，或 `base_url=/v1` 未命中现有 route，立即停止并回到 Spec；不得临时恢复 overlay、名单或文本扫描架构。

## 回滚

`$OPENCODEX_HOME` 是包含用户管理的 `config.json` 与 `patch-backups/` 的 OpenCodex 状态根目录；回滚只能使用后者 manifest 列出的 package 源码文件，绝不操作前者。写源码前记录精确 package root、present/absent 状态、权限和 SHA-256 到 `$OPENCODEX_HOME/patch-backups/`。回滚仅恢复 manifest 中 package 源码文件，并删除 manifest 标为 absent-before 的新增源码；主 catalog 和主 Codex config 均不属于代码回滚。恢复后静态加载、重启已核验的 `localhost:10100` proxy 并验证 ready。
