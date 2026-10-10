# Trendymen Fork 差异

记录当前代码相对 [lidge-jun/opencodex](https://github.com/lidge-jun/opencodex) 已 rebase 基线的剩余能力。
基线：`v2.81.0`（`19bd34a15354ba8c21fca89598fb18467f9cf9ee`）；包版本见 [package.json](package.json)，发布状态以 Tag 和 Release 为准。

官方文档保留上游原文。Fork 结构约束见 [structure/fork-extensions.md](structure/fork-extensions.md)，配置用法见 [Fork reference](docs-site/src/content/docs/reference/fork-extensions.md)，发布补充见 [FORK_MAINTAINERS.md](FORK_MAINTAINERS.md)。
能力变化时原地更新本文；历史设计、执行步骤、冲突和验证流水从 Git 历史、任务材料及 Release Notes 查阅。

## 请求与工具兼容

| 剩余能力 | 实现入口 | 主要回归 |
| --- | --- | --- |
| Canonical ChatGPT 转发把 HTTP Lite header 的 `true` 补到缺失的 WS body metadata，保留已有值和调用方 body。 | [passthrough.ts](src/adapters/openai-responses/passthrough.ts) | [Lite metadata](tests/codex-integration/codex-responses-lite-metadata.test.ts) |
| 分开判断 GPT 模型族、native 路由、保留别名和官方目的地；第三方托管 GPT 不等于官方服务。 | [model identity](src/providers/openai-model-identity.ts)、[destination](src/providers/openai-tiers-destination.ts) | [model identity](tests/providers/openai-model-identity.test.ts) |
| Ark GLM/Kimi、BigModel GLM 的 Responses schema lowering、尾部 user turn 和空 assistant 清理，复用官方明文消息转换器。 | [glm-kimi-compat.ts](src/fork/glm-kimi-compat.ts) | [Kimi schema](tests/providers/fork-kimi-schema-compiler.test.ts)、[GLM schema](tests/providers/fork-zhipu-glm-schema-lowering.test.ts)、[user turn](tests/providers/fork-trailing-user-turn-compat.test.ts) |
| 第三方工具 schema 清理 ChatGPT 专用 `encrypted` 注解；保留同名属性/literal，官方及显式可信直接 relay 保留注解，combo 不继承直接路由例外。 | [tool schema](src/adapters/responses-tool-schema.ts)、[transport](src/server/responses/request-transport.ts) | [passthrough](tests/responses/openai-responses-passthrough.test.ts)、[combo recovery](tests/server/agent-task-recovery-combo.test.ts) |
| `agentMessageFormat` 选择 `preserve` / `user_message`；官方目的地保留原生格式，密文、未知 part 和空内容不做部分转换。 | [agent-message-format.ts](src/fork/agent-message-format.ts) | [message format](tests/responses/agent-message-format.test.ts) |
| 第三方工具任务的可见进度、code-mode 工具发现和结果回显要求；可见补丁工具接收顺序及失败恢复提示。 | [progress contract](src/fork/routed-progress-contract.ts)、[tool catalog](src/adapters/tool-catalog-nudge.ts) | [progress](tests/codex-integration/fork-routed-progress-contract.test.ts)、[tool catalog](tests/adapters/tool-catalog-nudge.test.ts) |
| 为受支持的 `spawn_agent.fork_turns` 补字段说明，仅对当前授权工具的完成参数解包一层多余 JSON 字符串编码。 | [spawn-agent-compat.ts](src/fork/spawn-agent-compat.ts) | [function-tool repair](tests/responses/responses-function-tool-repair.test.ts) |
| 修复当前声明允许的 nested `functions.exec` / `web__run` 调用，保留工具身份、取消和 continuation 提交边界；区分空成功与失败输出。 | [nested exec](src/responses/nested-exec-call-repair.ts)、[coordinator](src/server/responses-nested-exec-call-repair.ts) | [nested exec](tests/responses/nested-exec-repair.test.ts)、[output guard](tests/responses/responses-code-mode-exec-output-guard.test.ts) |
| Routed custom tool output 字符串化；Console Go 严格目的地合并重复 `call_id` 输出；无调用标识的剩余输出保留合法来源标签。 | [custom output](src/fork/custom-tool-output.ts)、[output recovery](src/adapters/openai-responses/tool-output-recovery.ts) | [custom output](tests/responses/fork-custom-tool-output-lowering.test.ts)、[passthrough](tests/responses/openai-responses-passthrough.test.ts) |

## 响应、恢复与模型配置

| 剩余能力 | 实现入口 | 主要回归 |
| --- | --- | --- |
| `inferResponsesMessagePhaseModels` 为原生第三方 Responses 补 phase，排除官方目的地和 GPT 族，区分宣布阶段、后续工作及终态证据。 | [message phase](src/fork/responses-message-phase.ts) | [phase rewrite](tests/responses/responses-message-phase-rewrite.test.ts) |
| annotation chip 入站说明改写和输出侧规范指令去反引号，保留代码块及其他正文。 | [instructions](src/server/responses/annotation-instructions.ts)、[directive](src/responses/annotation-directive.ts) | [annotation](tests/responses/annotation-directive.test.ts)、[bridge](tests/adapters/bridge-annotation-directive.test.ts) |
| 客户端请求 summary 时投影第三方 content-channel reasoning，保留原字段、预算、生命周期及客户端实际收到的 continuation 形状。 | [summary rewrite](src/server/responses-reasoning-summary-rewrite.ts)、[adapter delivery](src/server/responses/adapter-delivery.ts) | [lifecycle](tests/responses/responses-reasoning-summary-lifecycle.test.ts)、[adapter projection](tests/responses/adapter-reasoning-summary-projection.test.ts) |
| 转向原生 GPT 时清理第三方 reasoning 支撑的 opaque token；`opencode-go` 缺省保留 Responses reasoning 正文，显式 `false` 优先。 | [reasoning](src/adapters/openai-responses/reasoning.ts)、[registry](src/providers/registry/entries-core.ts) | [opaque reasoning](tests/providers/fork-deepseek-opaque-reasoning.test.ts)、[Go wire](tests/providers/opencode-go-luna-wire.test.ts) |
| SSE 正常 EOF / synthetic failure tail 前 flush，保留错误来源、终态及单枚 `[DONE]`；reader error 和 nested-exec barrier 不承诺 flush。 | [relay](src/server/relay.ts)、[eager relay](src/server/relay-eager.ts)、[rewrite](src/server/sse-payload-rewrite.ts) | [flush](tests/responses/fork-sse-block-rewrite-flush.test.ts)、[error fidelity](tests/server/fork-overload-error-eof-fidelity.test.ts) |
| strict backend 子任务恢复、原生 transient 5xx 耗尽后的单次重放、父任务加密 `MESSAGE` 超时通知和 `recovery_unreadable` 分类，沿用官方 admission 与发送预算。 | [encrypted payload](src/server/responses/encrypted-payload.ts)、[task recovery](src/server/responses/agent-task-recovery.ts)、[native gate](src/fork/passthrough-agent-task-recovery.ts) | [envelope](tests/server/fork-agent-message-strict-envelope.test.ts)、[backend](tests/server/fork-agent-task-recovery-backend.test.ts)、[egress](tests/server/fork-tool-call-ciphertext-egress.test.ts) |
| key-auth Responses 缺省补 `max_output_tokens`，模型级优先并按剩余上下文收紧；客户端显式值优先，forward 不注入。 | [passthrough](src/adapters/openai-responses/passthrough.ts) | [output budget](tests/responses/openai-responses-passthrough.test.ts) |
| 官方 customModels 上补校验、salvage、并发合并、公开投影、tool-mode API/CLI round trip 和 pricingStatus 保留；Provider 注册及 caps 保存失败恢复未发布 live 值。 | [custom models](src/config/custom-models.ts)、[model routes](src/server/management/model-routes.ts)、[caps](src/server/management/provider-context-cap-routes.ts) | [config](tests/config/fork-custom-model-config-schema.test.ts)、[tool mode](tests/codex-integration/fork-custom-model-tool-mode-contract.test.ts)、[rollback](tests/server/provider-context-cap-rollback.test.ts) |
| Ark 专用 quota 展示保留原文/reset，拒绝普通 overload；BigModel Codex `models[].slug` 动态发现；DeepSeek `deepseek-v4-flash` 旧别名直连图片。 | [Ark quota](src/fork/ark-quota-display.ts)、[discovery](src/providers/model-discovery.ts)、[registry](src/providers/registry/entries-core.ts) | [quota](tests/providers/fork-ark-weekly-quota.test.ts)、[BigModel](tests/providers/zhipu-bigmodel-codex-provider.test.ts)、[registry](tests/providers/provider-registry-parity.test.ts) |
| Codex Provider table 写入 `supports_standalone_web_search = true`，配合客户端 standalone 功能。 | [config-toml.ts](src/codex/inject/config-toml.ts) | 尚缺专门断言及绑定实现的 App 验收。 |

## 诊断与维护

- Provider debug 增加磁盘结构日志、上游/重写后双阶段观察和独立授权的文本样本；按 4 MiB 分组、7 天、20 GiB 管理主日志与引用工件。旧 home 收养不接管预存路径。入口：[persistence](src/fork/debug-persistence.ts)、[observation](src/fork/inbound-response-debug.ts)、[ownership](src/lib/config-ownership.ts)；回归：[persistence](tests/server/fork-debug-persistence.test.ts)、[safety](tests/server/fork-provider-debug-safety.test.ts)。
- `install:local` 离线 staging 后替换本地包，把 Volta、服务、readiness 和失败回滚纳入事务；macOS 安装补写结构/文本诊断环境，字体栈补丁保留。入口：[installer](scripts/install-local.ts)、[transaction](src/update/transactional-install.mjs)；回归：[lifecycle](tests/ci-workflows/fork-install-local-lifecycle.test.ts)、[transaction](tests/ci-workflows/fork-install-local-deferred-transaction.test.ts)。
- `X.Y.Z-ben.N` 更新保持同基线修订单调，稳定版同基线不覆盖 Fork，Tag 不可变。入口：[version policy](src/fork/version-policy.mjs)；回归：[version](tests/update/fork-version-policy.test.ts)。同步和发布按 [现行政策](docs/fork-sync-automation.md) 执行。
- 测试沿用官方布局、Bun runtime/test runner 分离和预算；Fork 补 Node shim 解析、HTTP fixture 外网隔离与独立进程调度。回归：[test runner](tests/ci-workflows/test-runner.test.ts)。CI 保留逐 SHA 触发和官方基线/Tag/marker 验证，见 [preparation](scripts/prepare-fork-official-base.ts)、[baseline regression](tests/ci-workflows/fork-ci-official-baseline.test.ts)。

## 保留边界

- 已上游化的通用消息转换、Fernet multipart recovery、direct MCP 归一化、custom tool item type 和 Bun pin 分离继续采用官方实现。删除剩余补丁须证明代码与测试等价；旧 allowlist、Spark 专属规则、动态 Fork runner 和滚动 CSS 补丁不恢复。
- Provider/App 端到端、真实 backend ciphertext、Windows 全局替换与服务恢复仍有验收缺口。合成回归、文档构建和审查通过不替代这些验收。
- `opencode-go` 的 Provider 级 reasoning 保留尚未逐模型验证；DeepSeek 400 与清空正文的因果关系未做 live 复现。原生 reasoning 合成事件未统一重分配 `sequence_number`。
- annotation 输出兜底不按本轮注解数量启用，跨行 code span 不处理，native 直通只经过入站改写；客户端渲染仍需实机核对。
- debug ownership 元数据上限、旧 home 收养条件、安装 PID/断电/路径竞态和 Node 缺少通用 `openat` 仍是边界。完整测试池的历史间歇超时尚无统一根因，不以单文件通过宣布解决。
