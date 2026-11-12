---
title: Trendymen Fork 扩展
description: 相对已 rebase 上游版本的兼容与维护差异。
---

本附录描述 Trendymen Fork 相对上游增加的行为。其他参考页保留上游原文；配置差异见 [Fork 配置](/zh-cn/reference/configuration/fork-extensions/)。

## 兼容差异

- 日志详情区分客户端初始 Responses 顶层强度与初始输入中最后一个可识别的 `configuration_update`，列表强度列沿用官方显示。续接请求没有可见更新或后续更新无法识别时，会话值显示为未知，不推断隐藏历史。观察不证明已转发或被上游采用；WebSocket 后续帧可能改变设置，不属于初始观察。
- Pool 账号身份改写将 turn metadata 中超出 U+00FF 的字符转为 JSON 转义后再写入 HTTP header，保留合法 Latin-1 字符和 JSON 值，避免中文或 emoji 导致本地请求头错误；关闭兼容处理时，账号身份隔离仍然生效。
- 原生 GPT 官方订阅 Responses 请求提供 23 项 Provider 级处理许可，全部默认开启，覆盖请求/响应兼容、生成头和可选本地错误，包含 Direct 与 Pool 账号。各功能仍受原条件约束，其他目的地和转译入站沿用既有行为。逐项配置及保留的恢复、预算和凭据保护见 [GPT 官方订阅处理](/zh-cn/reference/configuration/fork-extensions/#gpt-官方订阅处理)。
- Ark GLM/Kimi 和 BigModel GLM 的 Responses 路由降低不支持的工具 schema，并处理 assistant prefill 限制。普通第三方工具清理 ChatGPT 专用 `encrypted` 注解，保留同名属性和 literal。官方目的地和显式可信直接 relay 保留注解，combo 不继承直接路由例外。
- OpenAI Chat、Google、Command Code、Anthropic、Kiro 和 Cursor 适配器在各自工具条件满足时为请求加入进度提示，部分路径还加入工具发现和补丁顺序提示。模型 catalog 和原生 Responses 不自动追加这些提示，模型是否输出可见进度不作保证。code-mode 结果回显和宿主提示沿用官方处理；代理不合成进度，不执行或自动重试补丁。
- 当前声明允许的 nested `functions.exec` / `web__run` 及受支持的 `spawn_agent.fork_turns` 完成参数执行有界修复。官方 routed custom-tool 基础保持不变；Fork 将 custom tool output 转为字符串，并在 Console Go 严格目的地合并可安全匹配的重复 `call_id` 输出。工具声明仍决定授权范围。
- 按模型启用的原生 Responses phase 推断包含普通 JSON 交付，并保留官方 Provider 级 SSE 选项。content-channel reasoning 摘要投影须客户端显式请求 summary，保留原字段，passthrough continuation 与实际交付形状一致。
- 注解说明使用裸 chip 指令。输出修复保留代码块，但不按本轮注解数量启用，也不处理跨行 code span；native 直通仅在许可允许时改写入站说明。
- 对应处理许可开启时，SSE flush 和终态处理保留有效上游错误与单枚 `[DONE]`。Canonical 转发将 true Lite header 补到缺失的 WebSocket metadata，不覆盖显式值。
- Ark quota 错误保留原消息和 reset，阻止自动重试。BigModel Codex 发现接受 `models[].slug`。

## 恢复与维护

可选模型 API 入口把回环管理服务与 `10100` 端口上的局域网数据入口分开。它复用原生模型路由和凭据，辅助入口拒绝管理和配对，并通过已验证的本机管理读取报告真实状态。默认关闭，拓扑变更需要重启。两种有效配置和原生 primary 模式边界见[模型 API 入口](/zh-cn/reference/configuration/fork-extensions/#模型-api-入口)。

加密子任务恢复增加 strict backend envelope、原生 transient 5xx 重试耗尽后的单次重放，以及已准入父任务 `MESSAGE` 超时后的无密文通知。拒解密文是终局，不转发到普通第三方路由，也不写 continuation state；恢复保持显式启用。

Fork 提供磁盘诊断、独立文本样本开关和 `install:local` 的包/服务/Volta 回滚。`ben.N` 先比较上游主版本，再比较 Fork 修订；同主版本 stable 不覆盖 Fork，已发布 Tag 保持不变。

开发和发布候选统一使用 `dev`。已发布版本由不可变 Fork Tag 和正式 GitHub Release 确定；发布前使用官方 workflow 对精确 dev 提交执行完整 `workflow_dispatch` 检查，不再依赖 main push CI。

Standalone web search 标识、真实 backend ciphertext 恢复和 Windows 全局替换/服务恢复仍需绑定实现的端到端验收；官方测试不能证明这些结果。
