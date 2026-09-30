# Plan：Adapter 路径 reasoning 摘要投影

对应 spec：`docs/superpowers/specs/2026-09-22-adapter-reasoning-summary-projection-design.md`（用户已口头批准方向，SPEC_DOCUMENT 独立审查待通过，本 plan 待 spec 批准后实施）。本 plan 只覆盖展示投影，不动存储快照与门控语义。

## 任务清单

### Task 1：门控抽成纯函数（改写模块，约 10 行）

在 `src/server/responses-reasoning-summary-rewrite.ts` 新增导出 `shouldProjectContentChannelReasoning(rawBody: unknown, provider: { statelessResponses?: boolean; preserveReasoningContentModels?: string[] }, modelId: string): boolean`，逻辑与 `passthrough-dispatch.ts` 538–542 行逐字一致：`rawBody` 经收窄后取 `reasoning.summary`，要求其 `typeof` 为 `"string"`、长度大于 0 且不等于 `"none"`（非 string 直接返回 false），再与 `routeUsesContentChannelReasoning(provider, modelId)`。`passthrough-dispatch.ts` 改调它，行为不变。

验收：`bun test tests/responses/responses-reasoning-summary-rewrite.test.ts` 全绿；新增单测覆盖下表（行行为与旧内联一致即通过）：

| rawBody.reasoning.summary | provider/模型 | 期望 |
|---|---|---|
| 缺失 / 非 string | 任意 | false |
| `"none"` / 空串 | 任意 | false |
| 合法字符串 | statelessResponses 或命中 preserve 名单 | true |
| 合法字符串 | 两者皆无 | false |

### Task 2：流式挂载（adapter-delivery，约 10 行）

在 `src/server/responses/adapter-delivery.ts` 的 `deliverAdapterResponse`：

1. `requestState` 的 Pick 加 `"route"`（`requestState` 本来就携带 route，无需改上游调用方）。
2. 用 T1 的 helper 计算门控，输入为 `parsed._rawBody`、`route.provider`、`route.modelId`。门控身份来源只用 `route`；显示用的 `parsed._responseModelId ?? parsed.modelId` 保持现状、不作门控输入（两者路由别名下可能分叉，见 spec 门控段）。
3. 门控成立时：`sseStream = relaySseWithBlockRewrite(sseStream, createReasoningSummaryChannelBlockRewrite({ translatorBudget }), translatorBudget)`，其中 `translatorBudget` 是 `requestState` 顶层解构出的同名变量（与 `relaySseWithBlockRewrite` 第三个参数用同一变量；`parsed` 上无此字段），之后再进现有 `trackStreamLifetime`。门控不成立时流对象原样传递，零开销。导入来源：`relaySseWithBlockRewrite` 来自 `src/server/sse-payload-rewrite.ts`，`createReasoningSummaryChannelBlockRewrite` 来自 `src/server/responses-reasoning-summary-rewrite.ts`；此处单个 rewrite 等价于 passthrough 在该场景下的组合行为（其他组合项在 adapter 路径不存在，单挂即完整）。

验收：typecheck 通过；下面 T4 的组合测试覆盖此路径。

### Task 3：非流式挂载（同文件 parseResponse 分支，约 5 行）

仅改 `parseResponse` 非流式分支（约 209–229 行）：`buildResponseJSON` 返回 `json` 后，`rememberResponseState` 继续存原始 `json`（作用域要求，存储不动）；返回给客户端的改为门控成立时的 `rewriteReasoningSummaryInJson(json)` 副本。流式分支（`onCompletedResponse` 回调内的 `rememberResponseState`）不在本任务范围内，保持原始；流式客户端投影只走 T2 的 SSE 包裹。

验收：T4 用例 4。

### Task 4：测试（新文件 + 注册）

新建 `tests/responses/adapter-reasoning-summary-projection.test.ts`，并按仓库规则在 `scripts/test-layout/layout.json` 的 explicit 与 `tests/fixtures/test-layout-expected.json` 登记。用例：

1. 含 `reasoning_content` 的 chat 适配器事件流经 bridge + 挂载改写，门控开时出现 `reasoning_summary_part/text` 事件且终态快照带 summary。
2. 门控关（summary 参数为 none / 路由非 content 通道）时输出字节级不变。
3. Anthropic 风格流（已含 summary 事件）经过挂载点不受影响（防双加工）。
4. 非流式 JSON 形状的投影与存储分离（存原始、返投影）。

测试只断言输出流/对象行为，不断言模块内部状态。改写模块既有测试保持全绿。

### Task 5：验证与回归

1. `bun run typecheck`。
2. focused：`bun test tests/responses/responses-reasoning-summary-rewrite.test.ts` 与 T4 新文件 `bun test tests/responses/adapter-reasoning-summary-projection.test.ts`。
3. `bun scripts/test.ts --changed=origin/dev`（仓库本地规则，不用默认 `test:changed`）。
4. live 探针（端口与模型取值来自本机运行实例与已验证配置）：`POST http://127.0.0.1:10100/v1/responses`，body 含 `model: "opencode-go/mimo-v2.6-pro"`、`reasoning: { effort: "high", summary: "auto" }`、`stream: true`，收集 SSE 断言出现 `reasoning_summary_part/text` 事件（此前同形状请求返回 0 个 summary 事件，为回归基线）；GLM 对照是 `local/glm-5.3` 同形状请求，期望 summary 事件照常出现（不消失、不重复、不改分块节奏）。
5. 残留确认：Codex 客户端最终渲染以客户端版本为准，代理只保证事件正确。

## 顺序与依赖

T1 → T2 → T3 → T4 → T5。T1 独立可先合（passthrough 行为不变是后续一切的前提）；T2/T3 都依赖 T1 的 helper；T4 跟随实现写；T5 收尾。

## 不做的事

- 不碰 `bridge/sse.ts`（options 袋不再加字段）。
- 不碰改写模块现有导出行为（只新增一个纯函数）。
- 不改 `rememberResponseState` 存的内容。
- 不把 `modelSupportsReasoningSummaries` 引进门控。
