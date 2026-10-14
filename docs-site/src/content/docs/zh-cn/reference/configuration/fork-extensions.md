---
title: Fork 配置
description: Trendymen Fork 的 Provider、恢复、自定义模型和诊断配置补充。
---

本页补充上游 `v2.84.0` 配置。兼容行为见 [Fork 扩展](/zh-cn/reference/fork-extensions/)。

## Provider 配置

| 字段 | Fork 行为 |
| --- | --- |
| `agentMessageFormat` | `preserve` 保留原生消息；`user_message` 转换第三方 Responses 的完整可读文本/媒体，包含第三方 GPT 模型。官方目的地始终保留原生格式。省略时沿用目的地默认策略；密文、未知 part、空内容不做部分转换。 |
| `inferResponsesMessagePhaseModels` | 显式启用原生 phase 推断的精确模型 ID，排除官方目的地和 GPT/OpenAI 族。宣布阶段自称 `final_answer` 先降为 `commentary`，最终 item/terminal 证据决定相位；failed/incomplete 不补合成 final phase。 |
| `defaultMaxOutputTokens`、`modelMaxOutputTokens` | 既有输出默认值扩展到 key-auth Responses 缺失的 `max_output_tokens`。模型级优先于 Provider 级，客户端显式值优先于两者；forward 不注入。 |

有有效窗口且估算剩余 token 超过 512 时，补写预算为 `max(512, min(configured, remaining - headroom))`，余量为 256–4,096 token；无有效窗口或剩余 token 不超过 512 时保留配置值，让上游明确拒绝超窗。

`agentMessageFormat` 和 `inferResponsesMessagePhaseModels` 通过配置或管理 API 使用。POST 省略保留最新值，PATCH `null` 清除；`agentMessageFormat` 的 POST `null` 拒绝。显式格式转换保留身份及原请求/重放对象。

`opencode-go` 预设仅在缺失时补 `preserveResponsesReasoningContent: true`，显式 `false` 优先。推动该默认值的拒绝样本来自 DeepSeek，同 Provider 其他 Responses 模型尚未全部验证保留回放。

## GPT 官方订阅处理

`providers.<name>.codexPassthrough` 控制 20 项既有兼容处理。每项许可默认都是 `true`，包括 `normalizeEncryptedContent`。省略整个对象、写 `{}` 或把 20 项全部设为 `true`，均沿用之前的行为。许可不会强行启用原本关闭的功能：请求节流、任务恢复、reset 重试、上游 WebSocket 和 skills 仍受各自原配置及条件控制。

开关只在最终目的地满足以下条件时生效：使用 `openai-responses`、`authMode: "forward"`，规范化后的 base URL 为 `https://chatgpt.com/backend-api/codex`，且入站为原生 Responses HTTP、SSE 或 WebSocket。范围包含 Direct 主登录，以及 Pool 主登录和新增池账号。Provider 改名、模型级 adapter 选择都按最终结果判断。key 认证、第三方 GPT、其他目的地的模型，以及 Chat Completions 或 Anthropic 入站沿用既有行为；fallback 的每个目的地分别判断。

在仪表盘打开对应 Provider 的设置，展开 **GPT 官方订阅处理**。下列四组支持逐项开启或关闭，以及全部关闭。保存后从下一个请求或 WebSocket turn 生效；进行中的 turn 及其 fallback 尝试使用已捕获的许可。账号凭据撤销仍按既有规则生效。

下表字段均相对于 `codexPassthrough`，默认值全部为 `true`。

### 请求

| 字段 | 开启后允许的处理 |
| --- | --- |
| `normalizeRequestParameters` | 既有官方后端参数清理、默认值和原条件下的强制流式请求。 |
| `expandRequestHistory` | 为 `previous_response_id` 展开已保存的续接历史。 |
| `normalizeEncryptedContent` | 既有 encrypted-content 规范化；任务恢复失败处理单独保留。 |
| `snapshotSkillsCatalog` | 在既有 skills 配置要求时应用技能目录快照。 |
| `rewriteAnnotationInstructions` | 改写已识别的 Codex 注解说明，要求输出裸 directive。 |
| `bridgeLiteMetadata` | 把已识别的 Lite header 补到缺失的请求 metadata，不覆盖显式值。 |

### 响应

| 字段 | 开启后允许的处理 |
| --- | --- |
| `backfillResponseFields` | 补充缺失的 response item ID、message status 和文本 annotations。 |
| `repairResponseToolCalls` | 按原工具映射条件执行既有、已授权的工具调用修复。 |
| `redactUpstreamErrors` | 通用上游错误脱敏及规范化；关闭后仍保护实际注入的私有凭据。 |
| `synthesizeTerminalFailure` | 没有可用终态事件时，执行既有合成失败终态处理。 |
| `normalizeHostedImages` | 为受支持客户端转换 hosted-image 返回，并清理后续输入中的显示路径。 |

### 请求与返回头

| 字段 | 开启后允许的处理 |
| --- | --- |
| `synthesizeRoutingHint` | 生成缺失的 `x-codex-routing-hint`。 |
| `synthesizeSessionId` | 生成缺失的 `session_id`。 |
| `addResponseRequestId` | 添加 OCX 的 `x-opencodex-request-id` 返回头。 |
| `addResponseBrowserHeaders` | 添加 OCX 的浏览器 CORS/可见头字段；关闭后，跨域浏览器客户端可能无法读取响应。 |

关闭头字段生成不会删除调用方或 Provider 的显式头。认证、选中账号身份、必要 HTTP/WebSocket framing 和既有传输及安全检查继续生效。

### 本地错误策略

| 字段 | 关闭后的行为 |
| --- | --- |
| `localErrorPolicies.resetReplayRefusal` | 不生成可选的 Codex 拒绝重放说明及其 `x-should-retry: false` 头。发送结果不明确时仍不可重放；必要网关错误仍为 502 或 504。 |
| `localErrorPolicies.requestPacingAdmission` | 本次尝试跳过可选的本地请求节流准入。 |
| `localErrorPolicies.inputAdmissionPrecheck` | 跳过可选的本地输入大小估算预检；硬限制仍有效。 |
| `localErrorPolicies.accountSoftPrecheck` | 跳过普通缓存额度/冷却预检；显式暂停、账号锁定、重新认证、credit/reserve 政策及其他受保护的账号决策继续生效。 |
| `localErrorPolicies.transportErrorMapping` | 本地传输失败返回纯文本 502 `Bad Gateway` 或 504 `Gateway Timeout`，不添加可选的 Codex 错误说明。 |

这些设置不会隐藏真实上游错误（包括 OpenAI 429），也不会关闭任务恢复的转换/解密失败错误。共享发送预算、认证和身份检查继续执行。关闭拒绝说明或错误映射不会增加代理重试。没有拒绝重放提示时，Codex 客户端可能按自己的预算重试；若上游已经处理过请求，可能重复执行或额外消耗额度。

### 保存与清除覆盖值

配置文件和完整 JSON 配置只接受布尔叶子值；恢复默认时删除对应字段。以下 Provider 片段关闭注解说明改写及本地软额度预检，其余许可沿用默认值：

```json
{
  "codexPassthrough": {
    "rewriteAnnotationInstructions": false,
    "localErrorPolicies": {
      "accountSoftPrecheck": false
    }
  }
}
```

`PATCH /api/providers?name=<name>` 只合并 `codexPassthrough` 中实际提供的叶子字段。PATCH 的 `null` 用于清除覆盖值：叶子为 `null` 恢复该项默认，`localErrorPolicies: null` 清除整组，`codexPassthrough: null` 清除整个对象。GET 只返回已存储覆盖值，不补写默认字段。配置文件中不要写 `null`；清除不等于关闭。

全部关闭时使用面板操作，或明确把 20 项都设为 `false`：

```json
{
  "codexPassthrough": {
    "normalizeRequestParameters": false,
    "expandRequestHistory": false,
    "normalizeEncryptedContent": false,
    "snapshotSkillsCatalog": false,
    "rewriteAnnotationInstructions": false,
    "bridgeLiteMetadata": false,
    "backfillResponseFields": false,
    "repairResponseToolCalls": false,
    "redactUpstreamErrors": false,
    "synthesizeTerminalFailure": false,
    "normalizeHostedImages": false,
    "synthesizeRoutingHint": false,
    "synthesizeSessionId": false,
    "addResponseRequestId": false,
    "addResponseBrowserHeaders": false,
    "localErrorPolicies": {
      "resetReplayRefusal": false,
      "requestPacingAdmission": false,
      "inputAdmissionPrecheck": false,
      "accountSoftPrecheck": false,
      "transportErrorMapping": false
    }
  }
}
```

全部关闭时，保留请求 JSON 值、字段是否存在、未知字段和数组顺序；显式模型/Fast 路由、选中账号认证和必要传输规则仍生效。JSON 可以重新序列化。需要 framing 或私有凭据保护时，不保证响应字节完全一致。关闭错误改写时，客户端 WebSocket 错误帧在 `response` 中保留完整上游错误体。

OCX 实际注入的私有凭据始终在交付前受保护，包含 Pool/已存主登录凭据及敏感配置头值。无法确认安全交付时，在响应提交前返回 `upstream_error_protection_failed`，已提交的流则中止，不伪造成功终态。

## 自定义模型与上下文上限

customModels 类型、CRUD 和 catalog 行已是官方能力。Fork 增加严格写入、逐行 salvage、按 stable-ID 并发合并和已知字段公开投影，未知 opaque 字段仅内部保存。custom row 替换发现行时保留其 `pricingStatus`。

`customModels[].codexToolMode` 支持 `code_mode_only`、`shell` 或继承：创建省略为继承，更新省略保留存储值，更新 `null` 清除。CLI 使用 `--tool-mode code_mode_only|shell|inherit`，补齐既有 catalog 字段的管理入口。

`PUT /api/provider-context-caps` 保存失败恢复该路由的 live 上限字段与 pending deletions，不刷新 catalog；这不保证所有配置字段都具备回滚。Provider 注册只在 draft 保存后发布；`ConfigWritePublishedError` 保留已发布且与磁盘一致的值。

## 加密子任务恢复

恢复默认关闭，启用后使用额外的认证 ChatGPT 请求。以下示例开启恢复，其余字段使用 Fork 默认值：

```json
{
  "agentTaskRecovery": {
    "enabled": true,
    "model": "gpt-5.6-luna",
    "reasoningEffort": "medium",
    "timeoutMs": 120000,
    "maxRetries": 2,
    "retries": 0
  }
}
```

`timeoutMs` 限制每次尝试，响应首字节/空闲等待仍限 45 秒。`maxRetries` 允许最多两次额外超时尝试；既有 `retries` 处理短暂 HTTP/传输失败，额度跨超时尝试共享且受当前尝试 deadline 限制。取消和 `invalid_encrypted_content` 停止两类重试。

原生 transient 5xx 恢复只准入 strict `NEW_TASK`，按共享发送预算对已选择的同一目标重放一次。已准入父任务加密 `MESSAGE` 的超时可生成无密文重发通知，不声称正文已读；strict 密文和恢复 body 不写 continuation storage。

## 诊断与本地安装

普通 Provider debug 只记录结构；文本工件同时要求 provider debug 和独立 `provider-text`，CLI、API、仪表盘共用开关：

```bash
ocx debug provider on
ocx debug provider-text on
ocx debug provider-text off
```

主日志与引用工件在 UTC 日期/小时目录下共用 4 MiB 分组，两个根目录的可管理数据最多保留七天和 20 GiB。清理先删最旧主日志，再删工件；unsafe/不可读旁路条目不计入该预算。样本脱敏并限制单字符串/每轮额度。手动删除前先停代理，再一起删除 `provider-debug` 和 `provider-debug-artifacts`，只删工件会损坏保留引用。

`bun run install:local` 是须明确请求的本机维护操作：离线 staging 并验证依赖闭包，同步 Volta，服务 ready 后才提交替换。macOS 补写 `OCX_DEBUG=1` / `OCX_PROVIDER_TEXT_DEBUG=1`；`--no-restart` 的服务配置只写磁盘 plist，不 reload 服务。字体栈补丁保留，旧滚动 CSS 补丁已退役。
