---
title: Trendymen Fork 扩展
description: 相对已 rebase 上游版本的兼容与维护差异。
---

本附录描述 Trendymen Fork 相对上游 `v2.81.0` 的行为。其他参考页保留上游原文；配置差异见 [Fork 配置](/zh-cn/reference/configuration/fork-extensions/)。

## 兼容差异

- Ark GLM/Kimi 和 BigModel GLM 的 Responses 路由降低不支持的工具 schema，并处理 assistant prefill 限制。普通第三方工具清理 ChatGPT 专用 `encrypted` 注解，保留同名属性和 literal。官方目的地和显式可信直接 relay 保留注解，combo 不继承直接路由例外。
- 第三方工具任务接收进度、code-mode 结果回显和补丁顺序提示；代理不合成进度，不执行或自动重试补丁。
- 当前声明允许的 nested `functions.exec` / `web__run` 及受支持的 `spawn_agent.fork_turns` 完成参数执行有界修复。custom tool output 转为字符串，Console Go 严格目的地合并重复调用输出；工具声明仍决定授权范围。
- 原生 Responses phase 推断和 content-channel reasoning 摘要投影补充官方 bridge 之外的路径。投影须客户端显式请求 summary，保留原字段，passthrough continuation 与实际交付形状一致。
- 注解说明使用裸 chip 指令。输出修复保留代码块，但不按本轮注解数量启用，也不处理跨行 code span；native 直通仅改写入站说明。
- SSE flush 和终态处理保留有效上游错误与单枚 `[DONE]`。Canonical 转发将 true Lite header 补到缺失的 WebSocket metadata，不覆盖显式值。
- Ark quota 错误保留原消息和 reset，阻止自动重试。BigModel Codex 发现接受 `models[].slug`；`deepseek-v4-flash` 旧别名可直连图片，用户配置仍显式排除时继续服从配置。

## 恢复与维护

加密子任务恢复增加 strict backend envelope、原生 transient 5xx 重试耗尽后的单次重放，以及已准入父任务 `MESSAGE` 超时后的无密文通知。拒解密文是终局，不转发到普通第三方路由，也不写 continuation state；恢复保持显式启用。

Fork 提供磁盘诊断、独立文本样本开关和 `install:local` 的包/服务/Volta 回滚。`ben.N` 先比较上游主版本，再比较 Fork 修订；同主版本 stable 不覆盖 Fork，已发布 Tag 保持不变。

Standalone web search 标识、真实 backend ciphertext 恢复和 Windows 全局替换/服务恢复仍需绑定实现的端到端验收；合成测试不证明这些结果。
