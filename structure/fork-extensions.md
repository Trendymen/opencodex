# Trendymen Fork 扩展

## 边界

`src/fork/` 保存 Trendymen Fork 相对上游仍需维护的窄模块。共享 adapter、router、server、GUI
和管理 API 只保留接线；上游已经完整覆盖的行为不在这里复制。当前能力清单和覆盖状态见
[`FORK_CHANGES.md`](../FORK_CHANGES.md)，本文件只描述这些模块在系统中的职责和运行边界。

Fork 模块不能绕过上游的认证、路由、translator budget、continuation state、工具授权或
客户端终态。第三方兼容只在目标 Provider、adapter、模型和 auth mode 同时满足条件时启用；
OpenAI 运营目的地和 ChatGPT forward 继续使用上游原生协议。

## 模块职责

| 模块 | 当前职责 |
| --- | --- |
| `src/fork/agent-message-format.ts` | 解析 `preserve` / `user_message`，决定第三方 Responses 的明文 `agent_message` 是否转换。 |
| `src/fork/glm-kimi-compat.ts` | 为 Ark Agent Plan GLM/Kimi 与 BigModel GLM 降低工具 schema、补尾部 user turn，并保留应用传入对象。 |
| `src/fork/responses-message-phase.ts` | 对显式列入配置的第三方模型补缺失的 assistant `phase`；不生成、复制或摘要文字。 |
| `src/fork/routed-progress-contract.ts` | 给带工具的第三方请求追加普通 assistant 文本进度约定；不合成进度消息。 |
| `src/fork/custom-tool-output.ts` | 将 routed `custom_tool_call_output` 降为字符串形式的 `function_call_output`。 |
| `src/fork/spawn-agent-compat.ts` | 补充 `fork_turns` 工具字段说明，并只修复当前已授权 `spawn_agent` 的一层多余 JSON 字符串编码。 |
| `src/fork/ark-quota-display.ts` | 将严格匹配的永久 Ark usage quota 429 投影为 Codex 可显示、不可重试的客户端错误。 |
| `src/fork/outbound-debug.ts`、`src/fork/inbound-response-debug.ts` | 记录请求和响应结构摘要；文本样本要求单独授权。 |
| `src/fork/debug-persistence.ts` | 对诊断 artifact 执行 containment、文件类型、单文件、总量、数量和保留期限制。 |
| `src/fork/version-policy.mjs` | 解析和比较 `X.Y.Z-ben.N`，拒绝非规范 revision、降级和不合法 preview。 |

## 第三方消息与工具兼容

默认策略只转换第三方非 GPT/OpenAI 模型的可读 `agent_message`。显式
`agentMessageFormat` 可以覆盖第三方模型的明文格式，但不能让 OpenAI 运营目的地进入转换路径。
密文、未知 part、空内容和无法完整转换的数组保持原样；转换不修改调用方原始 body 或重放缓存。

GLM/Kimi schema lowering 在深度、节点和 variant 预算内处理 `$defs`、`$ref`、`oneOf`、`allOf`
和根级 `anyOf`。预算耗尽或语义不能安全保留时，沿既有失败边界拒绝或放过，不能产生更宽的
工具授权。ChatGPT 专用 `encrypted` 注解只从第三方最终 function schema 的注解位置移除；同名
属性、定义和值保持不变。

`spawn_agent` 参数修复同时要求工具身份、namespace、当前声明和字段 schema 全部匹配。其他工具、
重复顶层键、多层编码、非法整数和未知 schema 约束不修复。Nested code-mode 修复位于
`src/responses/` 与 `src/server/`，但它只由当前 turn 唯一的 `functions.exec` custom tool 声明授权；
普通同名函数不能扩大 exec、授权或参数边界。

## Responses 输出与 continuation

phase 推断只处理缺少 phase 的文本 item。后续仍有工作时标为 `commentary`，正常完成的终态文本
标为 `final_answer`；失败或 incomplete 不合成终态。SSE、有界 JSON 和 continuation replay 使用
同一分类，OpenAI/GPT 目的地硬排除。

第三方 reasoning summary 保留原始 content、opaque terminal 和 replay state。分段、terminal、
EOF、重复或迟到事件通过同一有状态 rewrite 处理；切回原生 OpenAI GPT 时只删除由第三方
`reasoning_text` 支撑的 opaque token，不删除真实 OpenAI blob。

Routed progress contract 只在非 OpenAI 目的地、请求实际带工具且 `instructions` 为字符串时追加。
它要求模型在首次工具调用前、重要里程碑后、长操作前、最多四个连续纯工具响应后，以及收到新
用户消息后输出普通 assistant 文本。compaction、缺失 instructions、ChatGPT forward 和公共 OpenAI
Responses 保持原样。该合同是提示，不是执行门禁；proxy 不推断仓库进度，也不替模型生成文字。

SSE block rewrite 在正常 EOF 和 eager synthetic failure 前 flush retained block。普通 pull reader
错误只 dispose；nested-exec barrier 不承诺 flush。高置信 policy terminal 统一为单个失败终态；
普通顶层 upstream error 若在无 terminal 的干净 EOF 前出现，则保留有界 type、code 和脱敏 message，
否则生成 `adapter_eof` incomplete。客户端最多收到一个终态和一个 `[DONE]`。

## 诊断与持久化

Provider debug 默认只记录结构、字节数、阶段和转换标志，不记录 key、请求正文、工具参数、
Response 文本或 reasoning 文本。文本样本同时要求 Provider debug 和 `providerText` 授权，经过脱敏、
UTF-8 安全截断、每轮条数和总预算限制后写入引用型 artifact。

`persistProviderDebugFile()` 对每个诊断根独立检查 canonical containment、symlink、普通文件和清理
结果。单文件上限 4 MiB，总量 16 MiB，最多 256 个文件，保留 7 天。一个根无法枚举或清理时只
影响该根的当次预算，不能阻塞另一个安全根；目标路径自身不安全时拒写。ownership 登记用于卸载
记账，不是 Provider debug 写入门槛；Kimi schema catalog 仍要求成功登记后才能写入。

## 版本与发布

Fork 稳定修订使用 `X.Y.Z-ben.N`，`N` 从 1 开始且不能有前导零。比较顺序先看官方基线，再看
同基线 revision；显式 preview 只接受规范 `preview.<identifier...>`。Tag 不可移动，GitHub Release
必须指向 annotated Fork Tag。完整 rebase、验证、双审、atomic push 和 Release 流程见
[`docs/fork-sync-automation.md`](../docs/fork-sync-automation.md)。
