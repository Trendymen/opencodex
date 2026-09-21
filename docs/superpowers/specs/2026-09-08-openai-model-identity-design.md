# OpenAI 模型与官方目的地统一判断

## 目标

全仓共用模型家族和官方目的地判断，覆盖第三方 provider 托管的 GPT，以及 Codex 官方原生 GPT。清除消费者内重复或含义模糊的判断，并用这些共享规则完成第三方非 GPT Responses 的 `agent_message` 兼容修复。

用户已确认共享纯函数方案，并授权连续完成设计、审查和实施，指定 `superpowers:subagent-driven-development`。当前工作区继续使用，不创建 worktree；不把无关并发修改纳入本任务。

## 已确认的问题

Codex 的子代理结果已进入主任务日志和 OCX 请求，但部分第三方 Responses 服务会忽略私有 `agent_message`。解析后的内部 messages 已有结果，原生 Responses 出站却仍可能使用含私有 item 的 `_rawBody`。现有 OpenCode Go 转换能保留内容，但入口只覆盖特定 provider。

扩大兼容范围时，原 GPT 排除判断漏掉了 `openai/gpt-*` 和 `o1`。全仓还存在五处不一致的别名正则、GUI 官方地址猜测、`phase` 的字符串包含判断。模型名称和服务目的地必须分别判断。

## 判断边界

| 路由 | 模型家族 | 目的地 | 新增的非 GPT 消息转换 |
| --- | --- | --- | --- |
| Codex 官方原生 GPT | GPT/OpenAI | canonical Codex forward | 不启用 |
| OpenAI 官方 API GPT | GPT/OpenAI | official Responses endpoint | 不启用 |
| 第三方 GPT，包括 GPT OSS | GPT/OpenAI | 第三方 | 不启用 |
| 第三方 GLM、Kimi、DeepSeek 等 | 非 GPT/OpenAI | 第三方 Responses | 启用 |
| Chat、Anthropic、Google 适配器 | 各自模型 | 各自协议 | 保持已有 messages 翻译路径 |

以上“非 GPT”是兼容用途的模型命名分类，不证明模型的训练来源。任意自定义名称无法据名字证明真实模型家族；使用解析后的明确模型 ID 判断，不读取用户文本，也不凭 provider 品牌猜测模型。

官方目的地与账户权限分开。`authMode=forward`、provider 名称、裸 `gpt-*`、配置中的 `native` 意图都不能单独授权官方凭证或账户原生路由。

## 共享模块

### 模型命名

新增 `src/providers/openai-model-identity.ts`，只依赖纯字符串逻辑和常量；不得引入配置、账户、文件系统、Bun、计时器、Lab 或其他运行时服务。GUI 可直接导入。

公开以下用途明确的谓词，底层规则集中在本模块：

- `isOpenAiGptFamilyModel(modelId: string): boolean`：兼容用途的家族识别。比较前 trim 并转小写；识别 `gpt`、`chatgpt`、`codex`、`o1`、`o3`、`o4`，后接字符串结束或 `-`、`_`、`.`。允许剥离一次明确的 `openai/`；另外识别 registry 已使用的 `openai-gpt-*`。不剥离任意 provider、账户、profile 或 combo 前缀，不接受嵌套斜线模型名。
- `isBareOpenAiGptOrReasoningSlug(modelId: string): boolean`：保留现有大小写敏感、无斜线且 `gpt-`、`o1-`、`o3-`、`o4-` 前缀规则，供账户 catalog 形状判断使用。
- `isImplicitNativeOpenAiRouteModel(modelId: string): boolean`：上一谓词或精确 `codex-auto-review`；不扩大到任意 `codex-*`。
- `isReservedNativeOpenAiAlias(modelId: string): boolean`：统一五处保留别名规则，大小写不敏感的 `gpt-`、`o1-`、`o3-`、`o4-`、`codex-` 前缀。不新增 trim 或改变消费者已有语法校验顺序。只统一家族识别；保留消费者的 `allowNativeAlias`、`nativeAlias` opt-in、supported-native 校验，以及 GUI 编辑时 native alias 元数据的既有维护规则。
- `isOpenAiNativeCleanupCandidate(modelId: string): boolean`：保留大小写敏感、无斜线的 `gpt-`、`codex-` 形状；是否支持仍由调用方的 catalog 集合决定。

不改 selected model、保存的 ID 或上游 wire ID。`custom/openai/gpt-5.6` 应由既有 resolver 得到 provider `custom` 和 modelId `openai/gpt-5.6`，共享谓词消费后者。

### 官方目的地

继续以 `src/providers/openai-tiers-destination.ts` 为权威，保留现有公开 exports。将身份判断的输入收窄为可供 GUI 使用的 readonly structural shape，字段为可选 `adapter`、`authMode`、`baseUrl`、`responsesPath`；必要字段缺失返回 false。含额外能力字段的 compact/blob 函数保留各自类型和政策。

- canonical Codex forward 继续要求 Responses adapter、forward auth 和规范化后的精确 Codex base URL。
- official API 判断继续使用 adapter 实际构建的 Responses endpoint，包括 `responsesPath`，不得只检查域名或 base URL。
- 继续拒绝 URL userinfo、query、hash、相似域名等现有排除形状。
- 默认值在已有配置/GUI 边界先解析；共享函数不依据 provider 名填入官方地址。
- GUI 和后端消费者保留自己的 built-in provider-name、legacy alias、API-key、默认 auth 等业务条件，只替换重复身份判断。
- Images sidecar 与 compact 的官方 API base 检查共用用途明确的 API base 谓词，保留现有字符串规范化和准入政策。Images 不使用 Responses endpoint 作为准入依据，`responsesPath` 不影响其 Images API 选择。

Chat adapter 的官方 API host 判断、提示策略的 OpenAI/ChatGPT host 范围、Live 的协议 URL 路径各有独立语义。实现时审计这些候选：重复的身份事实也归入该纯模块的用途明确函数；路径拼接、协议能力及提示政策留在原处。不得用严格 Responses endpoint 判断替代整个 Chat/Live 协议策略。

### 兼容组合判断

在目的地模块提供 `isThirdPartyNonGptResponsesRoute(provider, resolvedModelId): boolean`，组合 Responses adapter、非官方目的地、非 GPT 家族三个条件。模型模块不反向导入目的地模块。

`agent_message` 与 assistant-tail 兼容调用该组合谓词。`phase` 保留现有显式模型 opt-in 和不完整 provider DTO 的处理，仅替换家族与官方目的地判断；不因为复用组合谓词而要求它原先不要求的字段。

## 消费者迁移

| 范围 | 文件 | 迁移要求 |
| --- | --- | --- |
| Fork 兼容 | `src/fork/glm-kimi-compat.ts`、`src/fork/responses-message-phase.ts` | 移除私有 family regex 和模糊 includes；精确 provider schema lowering 保持独立 |
| 保留别名 | `src/routing/profile.ts`、`src/combos/types.ts`、`src/config.ts`、`src/server/management/model-routes.ts`、`gui/src/combo-workspace-data.ts` | 五处调用同一个别名函数 |
| 原生路由与 catalog | `src/router.ts`、`src/codex/catalog/metadata.ts` | 迁移命名规则，保留账户和 supported 集合准入 |
| 后端官方目的地 | `src/config.ts`、`src/server/auth-cors.ts`、`src/providers/openai-sidecar.ts`、`src/providers/quota.ts` | 复用权威函数；已调用权威函数的包装不为形式统一而修改 |
| GUI 目的地 | `gui/src/provider-payload.ts`、`gui/src/provider-workspace/catalog.ts`、`gui/src/components/combo-workspace-utils.ts` | 使用相同严格规则；保留 legacy `chatgpt` 映射政策 |
| 协议候选 | `src/adapters/openai-chat.ts`、`src/adapters/tool-catalog-nudge.ts`、`src/server/live.ts` | 审计剩余判断，抽取身份事实，保留不同协议语义；逐项记录保留原因 |

最终以全仓搜索核对遗漏。测试 fixture、版本能力、精确协议 ID、catalog provenance 以及 DTO `native` 消费不改成家族猜测。脚本中的精确测试向量保持独立字面断言，避免测试和实现共享错误规则。

## 消息转换契约

复用 `normalizeOpenCodeGoAgentMessages` 的既有转换，不重写第二套消息遍历。新增通用入口仅覆盖第三方非 GPT Responses，包括 key auth 和 noncanonical forward；原 Go 专用行为保持兼容，重复处理必须幂等。

转换发生在出站副本中。原请求、内部 `agent_message`、事件 ID 和元数据保持不变。转换保留文本、author/recipient 语义、内容顺序、图片和文件；不伪造 reviewer verdict，不把 provider 结果改成系统指令，不修改 Codex 的子代理 UI 完成事件。JSON、SSE 及 continuation/replay 最终发出的请求均应含模型可读结果。

## 有意变化与保持的行为

有意变化：普通别名的保留家族识别统一为不区分大小写，显式 native alias 继续按原 opt-in 和 supported-native 条件处理；`phase` 不再误判仅包含 `gpt`/`openai` 的普通名称，同时正确排除 o 系列；GUI 不再凭空地址或 substring URL 认定官方。

保持：隐式 native route 的大小写和前缀范围、精确 `codex-auto-review`、账户授权、native catalog provenance、模型支持集合、Daybreak 产品映射、模型版本能力、认证所有权、compact opt-in、Live 协议、既有 OpenCode Go 行为。

## 验收

1. 共享命名表覆盖裸 GPT、`openai/gpt-*`、`openai-gpt-*`、GPT OSS、o1/o3/o4、大小写和边界分隔符，排除任意 namespace 和含关键词的非 GPT 名称。
2. 真实 resolver 的别名双向案例验证以目标 modelId 判断：GPT 名别名指向 GLM 与普通别名指向 GPT 不互相误判；路由与账户准入保持原边界。
3. 五处 alias 消费者对大小写给出一致的家族识别结果，保留各自准入政策。验证普通别名拒绝、合法 native opt-in 保留、不满足原 native 条件仍拒绝，以及 GUI 编辑后元数据按既有条件保留/清除。GUI 与后端对完整、缺失、默认解析和相似 URL 的官方身份结果符合各自调用前置条件。
4. 出站适配器测试覆盖官方 Codex、官方 API、第三方 GPT 与非 GPT；raw input 不变，结构化内容和 replay 顺序保留。实际上游合成标记探针与本地 mock 证据分开记录，不声称所有 provider 已联网验收。
5. 使用直接覆盖变更的定向测试，新增 test 文件按两个布局表登记。运行 `bun run typecheck`、GUI `bun run build`、`bun run privacy:scan`、相关源真值/布局/Lab 边界测试和显式 `bun scripts/test.ts --changed=origin/dev`。若 changed 再次超时，定位并用可解释的分组获得结果，不将超时算通过。
6. 同步 `FORK_CHANGES.md` 与 `docs-site` 的 adapter、proxy-format、别名说明；保持已有中英文内容一致，修改文案使用 shuorenhua minimal。变更后的 docs 按项目门禁构建。
7. 每个实现 Task 独立双审；最小相对官方修改面为必查项。涉及认证的 Task 明确执行安全边界审查。原 agent_message 的两位 reviewer 需在原 scope/mode 下复审并裁定已有 finding。

## 实施与交付约束

按 SDD 创建该 Plan 专属 ignored workspace，维护 brief、报告、review package、验证日志与 ledger。不得将本地探针、测试输出、耗时、进度或 review hash 写入生产提交。现有 agent_message 改动属于本任务，其他工作区改动保留。

当前 HEAD `8afc05e1ff04e360d05d7e055fd418cf73e5c204`；官方比较基线 `upstream-release` 当前为 `bba63222d3eeb5c8e397edae35798225e4fa1a6f`。实施前记录实际基线并检查漂移。提交仅包含本任务文件，提交与审查证据真实齐备后才在 ledger 标 complete。

交付说明分别列出源码/测试、真实 provider 探针、Codex App UI 和已安装运行时状态。安装、重启、发布不作为源码验收的隐含结果；不执行推送或发布。
