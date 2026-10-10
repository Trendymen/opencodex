---
title: Fork 配置
description: Trendymen Fork 的 Provider、恢复、自定义模型和诊断配置补充。
---

本页补充上游 `v2.81.0` 配置。兼容行为见 [Fork 扩展](/zh-cn/reference/fork-extensions/)。

## Provider 配置

| 字段 | Fork 行为 |
| --- | --- |
| `agentMessageFormat` | `preserve` 保留原生消息；`user_message` 转换第三方 Responses 的完整可读文本/媒体，包含第三方 GPT 模型。官方目的地始终保留原生格式。省略时沿用目的地默认策略；密文、未知 part、空内容不做部分转换。 |
| `inferResponsesMessagePhaseModels` | 显式启用原生 phase 推断的精确模型 ID，排除官方目的地和 GPT/OpenAI 族。宣布阶段自称 `final_answer` 先降为 `commentary`，最终 item/terminal 证据决定相位；failed/incomplete 不补合成 final phase。 |
| `defaultMaxOutputTokens`、`modelMaxOutputTokens` | 既有输出默认值扩展到 key-auth Responses 缺失的 `max_output_tokens`。模型级优先于 Provider 级，客户端显式值优先于两者；forward 不注入。 |

有有效窗口且估算剩余 token 超过 512 时，补写预算为 `max(512, min(configured, remaining - headroom))`，余量为 256–4,096 token；无有效窗口或剩余 token 不超过 512 时保留配置值，让上游明确拒绝超窗。

`agentMessageFormat` 和 `inferResponsesMessagePhaseModels` 通过配置或管理 API 使用。POST 省略保留最新值，PATCH `null` 清除；`agentMessageFormat` 的 POST `null` 拒绝。显式格式转换保留身份及原请求/重放对象。

`opencode-go` 预设仅在缺失时补 `preserveResponsesReasoningContent: true`，显式 `false` 优先。推动该默认值的拒绝样本来自 DeepSeek，同 Provider 其他 Responses 模型尚未全部验证保留回放。

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
