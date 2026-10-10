# OpenAI 统一身份判断 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 用户已明确选择 SDD 并授权连续推进，无需再次询问执行方式。

**Goal:** 全仓统一模型家族与官方目的地判断，修复第三方非 GPT 主模型读取子代理结果的出站兼容。

**Architecture:** 共享纯模型谓词供后端与 GUI 使用；目的地判断复用现有 `openai-tiers-destination.ts`。调用者保留认证、路由、别名 opt-in 与具体协议政策，Fork 兼容只组合共享事实。

**Tech Stack:** Bun、TypeScript、React/Vite、Bun test、Astro docs。

**Spec:** `docs/superpowers/specs/2026-09-08-openai-model-identity-design.md`，已通过 `SPEC_DOCUMENT` 复审。

## Global Constraints

- 当前 worktree 执行，保留并发修改；不自动 install、restart、push 或 publish。
- 共享模块不引入配置、账户、文件系统、Bun、计时器、Lab 或其他运行时服务。
- 不改 selected model、保存的 ID 或上游 wire ID；使用 resolver 的真实 modelId。
- 模型家族不授予账户权限；保留 native catalog、implicit route、native alias opt-in 与 supported-native 条件。
- 修改文字使用 shuorenhua minimal。新增测试遵循 domain 布局并登记两张布局表。
- changed 测试只用 `bun scripts/test.ts --changed=origin/dev`。超时不是通过；不重复运行未变代码的已通过检查。
- 每个 Task 使用 general 执行、独立 SPEC_COMPLIANCE 与 CODE_QUALITY 双审，修复复用原 reviewer；认证相关改动明确安全边界审查。
- 主线程准备 scoped patch 和验证证据，审查通过后仅提交本任务路径。SDD workspace 不进生产提交；commit 和审查齐备后才记 complete。

---

### Task 1: 共享身份规则与全仓消费者迁移

**Files:**
- Create: `src/providers/openai-model-identity.ts`、`tests/providers/openai-model-identity.test.ts`。
- Modify: `src/providers/openai-tiers-destination.ts`、`src/routing/profile.ts`、`src/combos/types.ts`、`src/config.ts`、`src/server/management/model-routes.ts`、`src/router.ts`、`src/codex/catalog/metadata.ts`、`src/server/auth-cors.ts`、`src/providers/openai-sidecar.ts`。
- Modify: `gui/src/combo-workspace-data.ts`、`gui/src/provider-payload.ts`、`gui/src/provider-workspace/catalog.ts`、`gui/src/components/combo-workspace-utils.ts`。
- Modify where identity facts occur: `src/adapters/openai-chat.ts`、`src/adapters/tool-catalog-nudge.ts`。Audit `src/server/live.ts`、`src/providers/quota.ts`，已共用身份函数或仅构建协议 URL 时保留并记录原因。
- Test: `tests/adapters/openai/openai-provider-option.test.ts`、`tests/providers/provider-model-aliases.test.ts`、`tests/routing/routing-profile.test.ts`、`tests/codex-integration/combos.test.ts`、`tests/gui/combo-workspace-data.test.ts`、`tests/gui/provider-payload.test.ts`、`tests/gui/provider-workspace-data.test.ts`、`tests/providers/forward-admission-separation.test.ts`、`tests/adapters/tool-catalog-nudge.test.ts`、`tests/adapters/openai/openai-chat-native-policy.test.ts`。为更精确的现有测试定位可用 rg；只扩展同一消费者相关文件，报告实际路径。
- Register new test: `scripts/test-layout/layout.json`、`tests/fixtures/test-layout-expected.json`。
- Owner boundary: 本 Task 不改 `src/fork/glm-kimi-compat.ts`、`src/fork/responses-message-phase.ts`、已有未提交消息兼容测试和 docs；这些由 Task 2 接入并统一文档。文档同步为整个交付的门禁。

**Requirements:**
- 遵守 Spec 的“模型命名”“官方目的地”“消费者迁移”以及 native alias 例外，不将完整 Plan 当任务 brief。实现前读仓库和目录 AGENTS、相关 structure 文档；当前工作区有其他修改，不回滚、不代为提交。不得派子代理，问题报告主线程。
- 相对官方基线最小改动；不得新造 registry、身份 DTO、缓存、服务或通用策略框架。
- 所有 Task 1 生产修改与新增测试属于本执行者；主线程负责 commit、审查包和最终门禁。

**Interfaces:**
- Produces from `openai-model-identity.ts`: `isOpenAiGptFamilyModel(modelId: string): boolean`、`isBareOpenAiGptOrReasoningSlug(modelId: string): boolean`、`isImplicitNativeOpenAiRouteModel(modelId: string): boolean`、`isReservedNativeOpenAiAlias(modelId: string): boolean`、`isOpenAiNativeCleanupCandidate(modelId: string): boolean`。
- Produces from destination module: `OpenAiDestinationShape` readonly optional string fields `adapter`, `authMode`, `baseUrl`, `responsesPath`; existing destination functions accept this compatible shape; `isThirdPartyNonGptResponsesRoute(provider: OpenAiDestinationShape, resolvedModelId: string): boolean`。
- Preserves existing exports, compact/blob extra fields and their policy. Add small named pure host/base helpers only for real consumers; record names and exact semantics in report. Images raw trailing-slash comparison and compact normalized-URL comparison must retain their existing differences.

- [ ] **Step 1: Add failing behavioral tests.**

```ts
import { describe, expect, test } from "bun:test";
import { isOpenAiGptFamilyModel, isImplicitNativeOpenAiRouteModel,
  isReservedNativeOpenAiAlias } from "../../src/providers/openai-model-identity";

test.each(["gpt-5.6-sol", "openai/gpt-oss-120b", "openai-gpt-5.6-luna", "o1", "o3-mini", "o4-mini", " CHATGPT-4O "])("family: %s", id => {
  expect(isOpenAiGptFamilyModel(id)).toBe(true);
});
test.each(["glm-5.3", "my-gpt-helper", "openai-compatible-glm", "other/gpt-5.6", "openai/other/gpt-5.6", "gpt-model/other"])("not family: %s", id => {
  expect(isOpenAiGptFamilyModel(id)).toBe(false);
});
test("family, aliases and native routing keep different policy boundaries", () => {
  expect(isReservedNativeOpenAiAlias("GPT-custom")).toBe(true);
  expect(isImplicitNativeOpenAiRouteModel("GPT-custom")).toBe(false);
  expect(isImplicitNativeOpenAiRouteModel("codex-auto-review")).toBe(true);
  expect(isImplicitNativeOpenAiRouteModel("codex-custom")).toBe(false);
  expect(isImplicitNativeOpenAiRouteModel("openai/gpt-5.6")).toBe(false);
});
```

Expand table for bare separators, blanks, `o1-*`, `codex-*`, cleanup shape. Add consumer regressions: normal uppercase alias rejection; existing valid `allowNativeAlias`/`nativeAlias` acceptance; unsupported native rejection; GUI draft metadata maintenance. Add `isChatGptForwardOption` cases with missing URL and misleading host in existing combo GUI test. Add endpoint cases with missing fields, explicit path, URL variants and unchanged compact/Images differences; use public sidecar selection with synthetic configured keys and no network.

Run focused new/changed files before production edits, save raw failing output to Task workspace. A missing-export failure proves the new test runs, but changed consumer behavior must also have a failing assertion before its fix.

- [ ] **Step 2: Implement pure model predicates and destination shape.**

The family algorithm is bounded and does not modify the caller's ID:

```ts
const normalized = typeof modelId === "string" ? modelId.trim().toLowerCase() : "";
const slug = normalized.startsWith("openai/") ? normalized.slice(7) : normalized;
if (slug.includes("/")) return false;
return /^(?:gpt|chatgpt|codex|o1|o3|o4)(?:[-_.]|$)/.test(slug)
  || /^openai-gpt-/.test(slug);
```

Keep narrow bare shapes case-sensitive. Alias prefix regex is case-insensitive without added trim. Destination identity functions return false on missing required fields, retain strict existing canonical and actual endpoint checks. Keep browser imports on the pure destination leaf, not the `openai-tiers` runtime facade.

```ts
export function isThirdPartyNonGptResponsesRoute(
  provider: OpenAiDestinationShape,
  resolvedModelId: string,
): boolean {
  return provider.adapter === "openai-responses"
    && !isOpenAiOperatedResponsesDestination(provider)
    && !isOpenAiGptFamilyModel(resolvedModelId);
}
```

- [ ] **Step 3: Replace consumers without changing their surrounding policy.**

```ts
// Combo policy keeps the existing native-alias exception.
if (isReservedNativeOpenAiAlias(alias) && options.allowNativeAlias !== true) {
  // Keep the existing issue construction here.
}
// Account availability remains with catalog data.
if (SUPPORTED_NATIVE_OPENAI_SLUGS.has(slug)) return false;
return isOpenAiNativeCleanupCandidate(slug);
```

Use the shared canonical function for GUI/state/auth shape checks; retain provider-name filters and resolve only already-defined defaults before calling it. For Chat and nudge, move host facts to pure named exports while preserving existing host scope. Keep Live endpoint construction and quota wrapper if no duplicate fact remains. The comments in these snippets explain the edit and need not be copied into production.

- [ ] **Step 4: Verify and report.**

Run directly affected test files, then `bun run typecheck`; run `bun run build` in `gui/` once. Explicitly run layout guards, `tests/lab/core-lab-boundary.test.ts` and any modified source-oracle tests. Run auth/sidecar tests with isolated synthetic credentials. Log each command, exit status and original output in workspace. No full suite or changed run here; final import-connected coverage belongs to Task 2. Do not rerun untouched passing files during a fix.

Run `git diff --check` and scoped full-repo searches for family regex/official URL guesses. Report every remaining candidate as shared, protocol-specific, capability/catalog authority, or literal fixture, with file and reason; do not claim zero identity duplication without this inventory.

- [ ] **Step 5: Task gate and commit.**

Write Task 1 implementation report with changed-file necessity, API signatures, TDD evidence, validation, remaining candidates and risks. Controller creates a scoped patch against recorded BASE excluding pending Task 2 paths. Dispatch independent `SPEC_COMPLIANCE` and `CODE_QUALITY` reviewers; quality review explicitly covers credential injection/sidecar admission and GUI pure dependencies. Resolve blocking findings with original reviewers, then controller commits only Task 1 paths using a concise Chinese subject. Record commit, patch hash and verdict in ledger.

### Task 2: 接入共享身份并完成子代理消息兼容与交付验证

**Files:**
- Modify: `src/fork/glm-kimi-compat.ts`、`src/fork/responses-message-phase.ts`。
- Modify tests: `tests/providers/opencode-go-agent-messages.test.ts`、`tests/providers/fork-trailing-user-turn-compat.test.ts`、`tests/responses/responses-message-phase-passthrough.test.ts`、`tests/responses/responses-message-phase-rewrite.test.ts`。Resolver 场景优先放在已有 provider regression 中。
- Modify docs: `FORK_CHANGES.md`、`docs-site/src/content/docs/reference/proxy-formats.md`、`docs-site/src/content/docs/zh-cn/reference/proxy-formats.md`、`docs-site/src/content/docs/reference/adapters.md`，以及现有翻译中的 Go-only 矛盾表述和涉及保留别名的相关 reference 页。修改前用 rg 定位实际对应段落，不做全站文风重写。
- Audit-only: 全仓模型/目的地剩余命名判断、测试布局和 core/Lab import graph。

**Requirements:**
- 该 Task 接管工作区已有消息兼容改动和文档，保留其他任务已提交内容。读 Spec 的消息契约、验收和有意变化条款；用户已授权连续 SDD。不得派子代理或自行 commit/install/restart/push。
- 只复用 Task 1 API；不添加私有家族 regex，不重写 agent_message converter。非 canonical forward 也受新规则覆盖，官方/GPT 排除和旧 Go 规则并存且幂等。
- 转换出站副本，不改变 raw、事件 ID、元数据、order、image/file 或 reviewer 意义；保持 phase explicit opt-in 和不完整 provider DTO 的既有行为。
- 前一轮消息兼容 SPEC_COMPLIANCE 的 F1 与 CODE_QUALITY 的 CQ-1 均为漏判 `openai/gpt-*`、`o1` 的 Important；修复后由主线程发原 reviewer 复审，不用新的报告替代。

**Interfaces:**
- Consumes `isOpenAiGptFamilyModel(modelId: string): boolean` from `src/providers/openai-model-identity.ts`。
- Consumes `isThirdPartyNonGptResponsesRoute(provider: OpenAiDestinationShape, resolvedModelId: string): boolean`、`isOpenAiOperatedResponsesDestination(provider: OpenAiDestinationShape): boolean` from destination leaf。
- Reuses `normalizeOpenCodeGoAgentMessages(body)` current helper and existing outbound compatibility hook. No new public wire fields or UI completion events.

- [ ] **Step 1: Prove missing cases at final outbound boundary.**

Expand existing adapter tests rather than testing only the private helper. Use the existing `routeModel` and adapter context factories for `custom/openai/gpt-5.6`, `openai-gpt-5.6-sol`, `o1`, a GPT-looking alias resolving to GLM, and an ordinary alias resolving to GPT. Assert resolved ID and serialized `input` together. Assertions keep exact fixture strings independent of shared regex.

```ts
expect(route.modelId).toBe("openai/gpt-5.6");
expect(JSON.parse(request.body as string).input).toContainEqual(agentMessage);
expect(rawBody.input).toEqual(originalInput);
```

For GLM, assert private item replaced by one user message containing the unique reviewer marker, author/recipient and supported media in order. Keep synthetic wait output followed by FINAL_ANSWER replay case and Go idempotence. Add phase cases proving explicitly opted-in `my-gpt-helper`/`openai-compatible-glm` eligible, o1 and third-party GPT ineligible, and absent opt-in still ineligible. Save actual RED output for currently failing cases.

- [ ] **Step 2: Replace private predicates and use the existing outbound conversion.**

```ts
if (!isThirdPartyNonGptResponsesRoute(provider, modelId)) return body;
return normalizePlaintextAgentMessages(body);
```

Use this gate for message conversion and assistant-tail compatibility; remove the old private family helper. Preserve order: existing provider normalization, new message conversion, existing assistant-tail logic. In phase, keep normalized nonempty ID and explicit list matching, replace fuzzy includes with `isOpenAiGptFamilyModel`, and retain official destination exclusion without adding missing-field admission requirements.

- [ ] **Step 3: Sync current behavior documentation.**

Update the existing capability entry in FORK_CHANGES and relevant docs in place. Explain third-party GPT versus official route, recognized family spellings, non-GPT Responses conversion, ordinary alias case handling and retained native alias opt-in. Remove outdated Go-only statements where they describe the general behavior; retain Go-specific legacy behavior descriptions. Do not promise UI card changes, all-provider live acceptance or installed-runtime activation. Use shuorenhua minimal; preserve unrelated patch-ordering documentation.

- [ ] **Step 4: Run focused and final integrated verification.**

Run the changed provider and phase files plus relevant responses passthrough coverage. Run `bun run typecheck`, `bun run privacy:scan`, source-oracle `tests/ci-workflows/fork-maintenance-truth.test.ts`, and required layout guards if changed. Task 1 GUI build remains valid unless its source/dependencies change. Run docs-site `bun install --frozen-lockfile` and `bun run build` for edited docs.

Run `bun scripts/test.ts --changed=origin/dev` once after final production edits. Use exec session and follow output until completion. The earlier attempt before this Plan exited 124 at 900 seconds and is not passing evidence. If repeated, capture the actual phase/process evidence, stop only this test run, select affected tests from the changed imports plus explicit source-oracle consumers and run bounded groups with isolated runner; record the omitted graph selection and resulting coverage. Do not modify the production test runner or pretend changed passed. Escalate to full suite only if no reliable affected set covers the change, per repository rules.

Refresh the synthetic live JSON/SSE probe from `.tmp/agent-message-fix-2026-09-08/verify-live.mjs` only after inspecting it. It may use already-authorized provider credentials through the normal config path, must send only generated marker content and must never print secrets. Bind output to final source hashes. Existing Chat/Anthropic/Google offline request checks are protocol-shape evidence only. No installed-service restart or App UI claim.

- [ ] **Step 5: Review, commit and final handoff.**

Write report and final inventory in workspace. Create scoped Task 2 diff against recorded BASE while including its pre-existing uncommitted paths. Dispatch separate Task 2 spec/quality reviews; reuse original agent_message reviewers with original modes/scope for F1/CQ-1 using complete prior findings, fix diff against original reviewed projection, and current verification evidence. Task 2 broader phase change also receives a scoped independent pair if original scope cannot cover it without changing identity.

Resolve blocking findings and re-review with original reviewer. Controller commits only Task 2 files, updates ledger with real commits and gates. Perform final bounded whole-change review of Task 1+2 interaction, final inventory and evidence; use separate spec/quality reviewers, no test reruns by reviewers. Record any final fix and its scoped re-review.

Final response lists changes, passed checks and concrete limits. Keep SDD recovery material ignored for user inspection; no push, install, restart or release. If all code gates are green, report source work complete without equating it to installed/App acceptance.
