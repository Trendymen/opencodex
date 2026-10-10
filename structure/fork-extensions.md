# Trendymen Fork 扩展

本文件补充同目录的上游结构文档。能力和实现/回归入口统一见 [FORK_CHANGES.md](../FORK_CHANGES.md)，配置用法见 [Fork reference](../docs-site/src/content/docs/reference/fork-extensions.md)。
`src/fork/` 保存 Fork 专用兼容、诊断和版本模块；共享接线沿用官方 subsystem 边界。

## 文档与登记

- 上游已有 Markdown 保持当前 rebase 基线原文，包含 `INDEX.md`；Fork 合同写在同目录独立文件。
- `manifest.json` 登记本文件并标记 `forkOnly: true`。结构门禁仍检查文档/源码归属、链接、路径和行数，官方索引生成视图排除它。
- `docs/` 只保留 [同步政策](../docs/fork-sync-automation.md)。旧 Spec/Plan 从 Git 历史查阅；过程材料存 Git 忽略的 scratch，当前能力不依赖旧计划执行入口。

## 请求与工具边界

- GPT 家族和官方目的地分开判断。官方 Responses 保持原生消息/schema；Lite header 到 WS metadata 的映射只补缺失字段。
- `agentMessageFormat`、GLM/Kimi lowering 和 `encrypted` 注解清理在出站副本上运行，保持原 input、工具授权和重放状态。可信直接 key-auth relay 的注解例外不扩大到 combo。
- nested exec 和 `spawn_agent.fork_turns` 修复须由当前工具声明授权，保留 preview、完成项和 continuation 的区别。`fork_turns` 只解包一层合法字段值，重复键/未知 schema 跳过。
- tool-catalog 提示只使用当前可见工具；代理不合成进度、不执行或自动重试补丁，空成功输出的提示不能覆盖失败输出。

## 响应与恢复边界

- `src/server/responses-reasoning-summary-rewrite.ts` 仅在客户端请求 summary 且路由满足条件时投影；已有 summary 不重复投影。保留 raw reasoning、终态字段和原始存储对象，passthrough continuation 记录客户端实际收到的形状。
- projection 的唯一序号按 32 字节计入共享 `translatorBudget`；EOF、失败和取消完成资源释放，超限沿用 `translation_buffer_limit`。flush 不扩大到 reader error / nested-exec barrier。
- phase 推断只适用于显式配置的第三方原生 Responses；宣布阶段的 `final_answer` 不足以证明最终相位，已有 phase 和后续工作证据共同决定交付结果。
- `src/server/responses/encrypted-payload.ts` 和 `src/fork/passthrough-agent-task-recovery.ts` 限定 strict backend envelope；禁用 recovery 时不增加分类、恢复或重放。原生重放使用官方共享发送预算，最多一次；恢复后的请求不再进入其他重试链。
- strict 密文和恢复 body 不写 continuation cache。父任务 `MESSAGE` 超时提示不含密文，不声称正文已读；`invalid_encrypted_content` 属于 `recovery_unreadable` 终局。
- key-auth 输出预算由 `src/adapters/openai-responses/passthrough.ts` 补全；显式客户端预算优先，forward 不注入。估算不替代上游计费或超窗判断。

## 配置与诊断边界

- 官方 customModels 基础类型、CRUD、catalog 和 modality 判定继续使用。`src/config/custom-models.ts` 补校验、salvage、三方合并和公开字段投影，未知 opaque 字段只在内部保留。
- Provider 注册只在独立 draft 成功持久化后发布；遇到 `ConfigWritePublishedError` 保留已发布且与磁盘一致的 live 值。上下文上限保存失败由 `src/server/management/provider-context-cap-routes.ts` 回滚该路由字段。
- `src/fork/debug-persistence.ts`、`src/fork/inbound-response-debug.ts`、`src/fork/outbound-debug.ts` 增加结构抓包。普通 debug 不保存正文/key/工具参数；文本样本同时要求 provider debug 和独立 `providerText`，并执行脱敏及预算限制。
- 主日志与引用工件共用 4 MiB 分组、7 天和 20 GiB 预算；淘汰先删主日志，失败时保留引用工件。unsafe / 不可盘点条目保留并告警，诊断失败不影响 relay。
- `src/lib/config-ownership.ts` 仅收养带运行时标记的旧 home，收养前路径不登记为自有。debug 登记失败继续捕获，Kimi catalog 仍要求登记成功。

## 安装与维护边界

- `scripts/install-local.ts`、`scripts/install-local-vendor.ts`、`scripts/install-local-volta.ts` 在离线验证后的同卷 stage 上替换包；根 manifest 保持冻结。Volta、服务、readiness、plist 和包字节共用失败回滚边界。
- 停服、包回滚和 plist 恢复全部确认成功后，才恢复原先已加载的服务；不安全/未知状态拒绝继续 restart。Windows pending transaction 的 wrapper 和 probe 成对维护。
- macOS `install:local` 补写 `OCX_DEBUG=1` / `OCX_PROVIDER_TEXT_DEBUG=1`，运行安装命令须当前用户明确授权。普通自更新保留官方事务路径，字体补丁不扩展为滚动 CSS 改写。
- `src/fork/version-policy.mjs` 维护 `ben.N` 单调版本。更新、通知和 launcher 使用同一规则；Tag/Release 见 [Fork 维护补充](../FORK_MAINTAINERS.md) 和同步政策。
- 原生 Windows 恢复、PID reuse、断电和父目录替换竞态仍需实际环境验证；`src/usage/telemetry-contract.ts` 的恢复类型、GUI 标签及 `src/web-search/passthrough-bridge.ts` 的诊断观察保留各自合同。
