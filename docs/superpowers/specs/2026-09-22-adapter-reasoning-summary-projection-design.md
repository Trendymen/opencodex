# Adapter 路径 reasoning 摘要投影

日期：2026-09-22。状态：待评审（未批准实施）。

## 背景

Codex 桌面端可展开的思考块读的是 summary 通道（`response.reasoning_summary_*` 事件与 item 的 `summary` 字段）。fork 有一套 content→summary 投影器（`src/server/responses-reasoning-summary-rewrite.ts`，fork 独有，上游与 v2.60.0 基线均无此文件），只服务原生 Responses 转发路径：门控决策在 `passthrough-dispatch.ts`，流组合在 `passthrough-delivery.ts` 的 `blockRewrites[]`。走 `openai-chat` 的模型（如 `opencode-go/mimo-v2.6-pro`）经过 `bridge/sse.ts` 后只发出 content 通道的 `response.reasoning_text.delta`（实测：effort=high 请求返回 2 个 reasoning_text 事件、0 个 summary 事件），在 Codex 里形不成摘要块。

## 目标

把同一套投影行为挂到 adapter 交付流，让 chat 线路模型的思考展示与 GLM 等 Responses 线路模型一致：流式出现 `reasoning_summary_part/text` 事件，SSE 线上的终态事件带 `summary`。

分裂语义（本 spec 的硬性边界）：投影只发生在发往客户端的 SSE 文本流上；桥经 `onCompletedResponse` 交给内存对象与 `rememberResponseState` 存的 response 保持原始（`summary: []` + 原始 content）。测试断言对象一律是 SSE 文本流里的终态事件，不是 remembered 快照。

## 非目标

- 不改变存储快照形状：`rememberResponseState` 存的内容保持原样（`summary: []` + 原始 content），续轮回放语义不变。
- 不改变门控语义：不把 `modelSupportsReasoningSummaries` 引进门控（该属性只管 catalog 声明与 responses 出站剥离，改写器从不读它）。
- 不改桥（`bridge/sse.ts`）与改写模块本身。

## 设计

转写模块的接口已经足够小：门控谓词 `routeUsesContentChannelReasoning`、流变换 `createReasoningSummaryChannelBlockRewrite`、JSON 变体。它的外部 seam 是 `SseBlockRewrite` 类型（SSE 文本块进、零或多个块出），passthrough 侧已经在这个 seam 上做组合。新工作只是在 adapter 侧接上同一个 seam。

### 挂载点：deliverAdapterResponse 的流式出口

`bridgeToResponsesSSE(...)` 返回的 `ReadableStream` 与 passthrough 的上游 SSE 是同一线性 SSE 文本流形态。门控成立时包一层已有的 helper：

```ts
const projected = gate
  ? relaySseWithBlockRewrite(sseStream, createReasoningSummaryChannelBlockRewrite({ translatorBudget }), translatorBudget)
  : sseStream;
```

然后 `projected` 交给现有的 `trackStreamLifetime`。`relaySseWithBlockRewrite` 正是 passthrough 非 eager 路径用的同一个函数，背压、取消、dispose 语义已验证，不引入新机制。

### 门控：与 passthrough 逐字一致

四要素钉死，任一不符即不投影：

1. `parsed._rawBody.reasoning.summary` 的 `typeof` 为 `"string"`（非 string 直接判否，与 passthrough 538 行同）。
2. 该字符串长度大于 0 且不等于 `"none"`。
3. `routeUsesContentChannelReasoning(route.provider, route.modelId)`：`statelessResponses === true` 或模型在 `preserveReasoningContentModels` 里。身份来源只用 `route`（与 passthrough 542 行一致）；`parsed` 里的模型名（路由别名、compaction 改路、failover 后可能分叉）不作门控输入。
4. `translatorBudget` 用 `requestState` 顶层解构出的变量（adapter-delivery 内 `parsed` 上无此字段）。

`deliverAdapterResponse` 的 `requestState` Pick 加 `"route"` 只是类型层补齐：core 传的是整个 `requestState` 对象，运行时本就带着 route，无需改调用方。

可选但推荐：把门控的四行判断抽成改写模块导出的纯函数，两处调用；`passthrough-dispatch.ts` 538–542 行改调它。谓词的归属知识回到拥有它的模块，既有测试为网。

### 非流式路径

`buildResponseJSON` 的结果按同门控套 `rewriteReasoningSummaryInJson`（仅改返回给客户端的副本，存储仍走原始对象，见分裂语义）。该变体已存在，就是为裸 response 文档形状准备的。

### 为什么不在桥里加开关

`bridgeToResponsesSSE` 的 options 袋已有十五个左右的字段，再加投影开关只会让接口变大而不增加杠杆，且桥被 streaming、non-streaming、runTurn 多条路径共用，交付策略会泄漏进翻译层。策略活在交付层，与 passthrough 的 `blockRewrites[]` 对称。

### 幂等保证

改写器对 summary 通道事件无操作（只匹配 content_part 的 reasoning_text、reasoning_text.delta/done，以及缺 summary 的 reasoning item）。Anthropic/kiro 适配器经 `thinking_delta` 分支已经发出的 summary 事件穿透不变，不存在双加工。门控本身只在被请求摘要且是 content 通道路由时才挂载。

## 测试

- 改写模块零改动：`tests/responses/responses-reasoning-summary-rewrite.test.ts` 原样通过即回归网。
- 新增 delivery 输出流测试（新文件 `tests/responses/adapter-reasoning-summary-projection.test.ts`，按仓库规则在 `scripts/test-layout/layout.json` 的 explicit 与 `tests/fixtures/test-layout-expected.json` 双登记）：chat 适配器事件流含 `reasoning_content` 时，门控开断言 SSE 文本流出现 summary 事件且流终态带 summary；门控关断言字节级不变。断言对象是流，不含 remembered 快照。不断言模块内部状态。
- 加一条 Anthropic 风格流（已含 summary 事件）经过新挂载点不受影响的用例。
- 门控 helper 若抽出，给它纯函数单测。

## 验证

`bun run typecheck`、相关 focused tests、`bun run test:changed`（以 `origin/dev` 为基准，按仓库本地规则不用默认的 `test:changed`）。live 验证：`POST http://127.0.0.1:10100/v1/responses`，body 含 `model: "opencode-go/mimo-v2.6-pro"`、`reasoning: { effort: "high", summary: "auto" }`、`stream: true`，收集 SSE 并断言出现 `reasoning_summary_part/text` 事件（此前同形状请求返回 0 个 summary 事件，这是回归基线）；GLM 对照是 `local/glm-5.3` 同形状请求，期望 summary 事件照常出现（行为不变指已有 summary 不消失、不重复、不改分块节奏）。

## 残留风险

- 存储快照仍是 `summary: []` + 原始 content（有意为之，见非目标）；续轮回放走现有翻译，不受影响。
- Codex 客户端对投影后摘要的最终渲染以客户端版本为准，代理只保证事件正确。
- 若上游某天给 chat 线路也原生发 summary 事件，挂载点因幂等保证自动透传，无需改动。
