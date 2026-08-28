# OpenCodex v2.35.0-ben.2 rebase 修复与可信发布设计

## 结论

在不移动已有 `v2.35.0-ben.1`、不向 `Trendymen/opencodex` 镜像官方 Tag、
不替换开发机或持久用户环境中的全局 OpenCodex 安装的前提下，修复 v2.35.0 rebase
审查发现的全部
Important finding，并将最终结果发布为不可变 Fork 修订 `v2.35.0-ben.2`。

本轮包含四个闭环：

1. 保留官方 v2.35 Kiro turn-termination 的 `OcxParsedRequest` 对象身份契约；
2. 让 origin-only GitHub Actions checkout 能从固定官方仓库取得一次性、可验证的
   `v2.35.0` Tag 证据，而不把官方 Tag 写入 origin；
3. 把 `FORK_CHANGES.md` 修正为准确的 v2.35.0 维护真源，并推进包版本为
   `2.35.0-ben.2`；
4. 在创建不可变 Tag 前先让最终候选 commit 通过远端 Cross-platform CI，随后按
   fail-closed 流程完成原子 promotion、二次 CI 和公开 GitHub Release。

## 背景与已确认问题

官方基线为 `v2.35.0` / `fc4de772b58c13f7b16b5029b1e981d612a5db06`；
当前 Fork Release 为 `v2.35.0-ben.1` / `98b14f722097abce9107c76ff0eba5f4e60c2e0f`。

审查已经确认：

- 文本三方合并只有 `package.json` 版本行冲突，实际 `0124c2809` 与标准合并树除该
  版本解决外一致；旧、新 Fork 的 105 个 path 集合相同，rebase 没有新增路径扩散；
- 官方 v2.35 的 turn-termination scope 通过
  `WeakMap<OcxParsedRequest, string>` 绑定在 `parsed` 对象身份上；Fork recovery 在
  绑定之后两次替换 `parsed`，未重新绑定；
- origin-only CI 只获取 Fork origin 的 Tag，但 Fork version gate 要求精确官方
  `v2.35.0` Tag。既定策略又禁止把官方 Tag 镜像到 origin，因此精确 commit
  `98b14f722` 的 Cross-platform CI 固定失败；
- `FORK_CHANGES.md` 同时包含 `2.35.0-ben.1` 与“当前为 `2.34.0-ben.2`”，漏记两个
  auto-merged test path，错误归属 strict backend recovery，并保留多个 v2.34 当前态
  对比；
- 官方相对 Fork patch 中有六处尾随空格，均位于 Fork 专用测试文件。

## 目标

### G1：恢复 turn-termination 对象身份契约

任何发生在 `bindTurnTerminationScope(parsed, resolvedConversationId)` 之后的
`parsed` 对象替换，都必须在新对象对 adapter、completion callback、cache 或
`localTerminal` 可见前，重新绑定同一个已归一化的 `resolvedConversationId`。

### G2：建立 CI-only 官方基线证明

GitHub Actions 必须从固定官方仓库精确获取当前 Fork package 所对应的官方 Tag，验证
Tag、官方 main 与 Fork `upstream-release` marker 三者一致，随后只在当前 runner 的
本地 refspace 暴露该官方 Tag，使现有 version-line gate 在 origin-only checkout 中
得到真实证据。

### G3：修复维护真源

`FORK_CHANGES.md` 必须准确描述 v2.35.0 当前状态、全部 16 个 path overlap、一个冲突与
15 个 auto-merge、官方/Fork 行为归属、本轮验证、当前包版本和 ben.2 发布边界。

### G4：发布不可变 ben.2

先验证远端候选 SHA，再创建 Tag。`v2.35.0-ben.1` 不移动、不删除、不覆盖；
`v2.35.0-ben.2` 只在 exact final documentation commit 上创建一次 annotated Tag，
并创建同名公开 GitHub Release。发布不包含 npm 或额外资产。

## 非目标

- 不重做或压缩现有 105-path Fork 能力栈；
- 不提取或重构 `src/server/responses/core.ts` 的其他既有接线；
- 不修改 turn-termination 的 TTL、fingerprint、WeakMap 隐私模型或 Kiro completion
  语义；
- 不把官方 `v2.35.0` Tag 推送到 origin；
- 不以缺少 Tag 为理由跳过或放宽 version gate；
- 不新增长期 tracked 官方基线 JSON/TOML 状态源；
- 不修改开发机或任何持久/self-hosted 用户环境中的全局 Volta/npm package、launchd
  service、端口 10100 或用户主配置；唯一例外是仓库既有 `npm-global-smoke` 在 disposable
  GitHub-hosted ubuntu/windows/macos runner 中执行隔离 `npm install -g` 验证，该 job 不
  发布 npm、不访问用户 service/config，也不得路由到 self-hosted runner；
- 不发布 npm，不上传额外 Release 资产；
- 不顺手修复已知 Ark weekly quota、真实 ciphertext 验收等本轮之外的缺口。

## 设计一：保留 `parsed` 的 turn-termination scope

### 对象替换入口

在 `handleResponsesInner()` 内、`resolvedConversationId` 已经生成的位置，增加一个局部
入口，职责只有两项：

1. 用传入的新对象替换闭包中的 `parsed`；
2. 立即调用 `bindTurnTerminationScope(parsed, resolvedConversationId)`。

它不是新的公共 API，不把 scope 写进 request body，也不把原始 thread/session/account
标识写进 `OcxParsedRequest`。WeakMap 仍只接受现有 32 字节十六进制 conversation digest。

以下两条路径必须统一使用该入口：

- routed encrypted-task recovery 完成后的完整 `parseRequest(body)` 替换；
- canonical native recovery 更新 `context` / `_rawBody` 时产生的 spread replacement。

初始 `parseRequest()` 和初始 `bindTurnTerminationScope()` 保持不变。该修改不改变 recovery
触发条件、route 重选、account/tier/options、abort、cache non-persistable 或 retry 顺序。

### 组合回归

新增独立测试文件，不向官方既有测试追加 Fork-only 场景。测试必须真实经过
`handleResponses()`：

1. strict backend ciphertext child task 进入 routed recovery；
2. recovery 返回明文；
3. route 选择 Kiro；
4. Kiro 返回含 `phase: final_answer` 的完成响应；
5. 相同 conversation 的下一轮回放尾部 assistant text，但模拟客户端丢失可靠 phase；
6. 第二轮由 `localTerminal` 结束。

断言必须包括：第二轮 Kiro upstream request 数量为零、
`localTerminalReason=kiro_final_answer_already_delivered`、attempt `sendCount=0`、usage 为
reported exact zero 且无 `estimated`。测试在修复前必须因第二次 upstream send 或缺少
local-terminal 记录而稳定失败。

同一个专用测试文件还必须锁定 canonical native recovery 的第二个 replacement site。
该路径当前不会直接进入 Kiro，无法通过现有外部响应观察 WeakMap 命中，因此采用最窄的
静态 call-site contract：在初始 bind 之后不得再出现裸 `parsed = reparsed` 或
`parsed = { ...parsed, ... }`；routed 与 canonical 两处都必须调用同一个局部 adopt/rebind
入口。该断言只约束这两个明确 replacement，不扫描或重写整个 `core.ts` 结构。

## 设计二：CI-only 官方 Tag 证明

### 新脚本及职责

新增 `scripts/prepare-fork-official-base.ts`。CLI 生产入口使用写死的官方地址：

```text
https://github.com/lidge-jun/opencodex.git
```

脚本读取当前 `package.json` 后先验证原始值是 string 且
`version === version.trim()`；任何前后空白都在调用 `forkBaseVersion()` 前非零退出。随后按
确定性顺序分类：

- `forkBaseVersion()` 接受的 `X.Y.Z-ben.N`：推导唯一官方 Tag `vX.Y.Z`；
- 原始值包含保留 namespace `-ben`（结尾）或 `-ben.`，但被 `forkBaseVersion()` 拒绝：
  在任何 Git 调用前非零退出；
- 其他值只有匹配本仓库实际 non-Fork channel 才无操作成功退出：严格 `X.Y.Z` stable，
  或 `X.Y.Z-preview.<one-or-more-identifiers>`；core number和纯数字 preview identifier 都
  禁止前导零。`rc`、`beta`、`foo` 或任意其他 prerelease channel不属于本脚本无操作
  allowlist，统一非零退出；
- 其余非法 SemVer同样在任何 Git 调用前非零退出。

因此 `2.35.0-ben`、`ben.0`、前导零 revision、超安全整数、额外 suffix、空白包裹或
其他 malformed Fork-like 版本都不能退化成普通版本路径。任何不满足严格分类的字符串
都不得进入 Git ref 或参数。

脚本使用参数数组调用 Git，不使用 shell 拼接。Fork checkout 中只取得 origin marker 到
脚本自有的 `refs/ocx-ci/fork-marker`。官方 ancestry 在 owner-only 临时目录中的独立 bare
repository 内验证：

1. 当前 origin 的 `refs/heads/upstream-release` 精确 fetch 到 checkout 临时 ref；
2. 在临时 bare repo 中从固定官方仓库 fetch 完整 commit graph 的 `refs/heads/main` 和
   精确 `refs/tags/vX.Y.Z`；使用 `--filter=blob:none`，但不使用 `--depth`、
   `--shallow-since` 或 checkout 继承的 shallow boundary；
3. 官方验证通过后，从该 bare repo 把 verified raw Tag object fetch 到 checkout 的
   `refs/ocx-ci/official-tag`。

为兼容会保留 `.git` 的 self-hosted runner，脚本先删除自己拥有的精确 checkout 临时
refs，再 fetch；临时 bare repo 每次新建。普通成功与失败退出都在同一个 finally 中
best-effort 删除 `refs/ocx-ci/*` 和 bare repo。进程强杀/runner终止无法保证 finally时，
下一轮 invocation 的精确 pre-clean 是兜底。不得清理其他 refs、Tag、Git objects 或
工作树。完整 commit graph 使“不是 ancestor”和“历史不足”成为不同状态；
任何无法取得完整 ancestry 证据的情况都 fail closed，不能当作真实 non-ancestor。

### 验证顺序

在创建本地官方 Tag 前必须按顺序验证：

1. bare repo 中官方临时 Tag ref 的 object type 是 `tag`，拒绝 lightweight Tag；
2. bare repo 中 Tag peeled commit 是完整官方 main commit graph 的 ancestor；
3. 导入 checkout 后的 Tag peeled commit 等于临时 `upstream-release` marker commit；
4. 本地若已有 `refs/tags/vX.Y.Z`，其 raw Tag object OID 与 peeled commit 都必须与
   官方临时 Tag 一致；冲突时 fail closed。

全部通过后：

- 本地没有官方 Tag时，以 compare-and-swap `update-ref` 创建
  `refs/tags/vX.Y.Z`，值为官方 raw Tag object；
- 已有且一致时保持不变；
- 删除脚本拥有的 `refs/ocx-ci/*` 临时 refs和临时 bare repo；
- 不执行任何 push，不修改 remote URL，不打印 raw Git stderr、remote URL 或其中可能存在
  的凭据，不修改工作树文件。

网络失败、remote/ref 缺失、Git 命令失败、非 annotated Tag、marker mismatch、ancestry
失败、本地同名 Tag 冲突均给出不含凭据的可操作错误，并以非零退出。

### 测试隔离

新增独立 `tests/fork-ci-official-baseline.test.ts`。测试通过临时本地 Git repositories
或注入的 Git runner 覆盖：

- origin-only clone 不含官方 Tag，但脚本成功准备；
- 合法 stable/preview 非 Fork package 无操作；
- `2.35.0-ben`、`ben.0`、revision 前导零、超安全整数、额外 suffix、空白包裹等
  reserved namespace malformed版本在Git调用前fail closed；`rc`/`beta`/其他非 preview
  channel 也不进入无操作 allowlist；
- marker 与官方 Tag peeled commit 不同；
- 官方 Tag 不可从 official main 到达；
- 官方 ref 是 lightweight Tag；
- 本地已存在一致官方 Tag；
- 本地已有同名伪造 Tag；
- origin marker、官方 Tag、官方 main 或 fetch 失败；
- shallow 起始 checkout 中，官方 main 比 Tag 领先多个 commit时仍能通过完整 ancestry；
- Git 参数保持为离散 argv，生产 CLI 不接受 env/CLI 覆盖官方 URL。
- 模拟 Git stderr / origin URL 含 userinfo、token、Authorization header 与绝对私有路径；
  用户可见错误不得包含原值，只报告固定操作名和经现有 redaction 处理的有界摘要。

测试可对导出的内部函数注入本地 fake official URL；生产 CLI 必须始终传入固定 URL。

### Workflow 接线与安全边界

`.github/workflows/ci.yml` 的三类完整 suite job 在 Setup Bun 后、运行测试前调用：

```bash
bun scripts/prepare-fork-official-base.ts
```

覆盖 `test` Linux shards、`platform-macos` 和 `platform-windows` suite。不得把该动作
塞进通用 Bun setup composite action，避免无关 job 网络访问。既有
`fetch-tags: true` 保留，用于 Fork Release Tag；新脚本只补充精确官方 Tag 证据。

现有 Windows suite 是显式测量 lane，不是 shipping gate，并记录有独立的历史失败清单。
为避免 candidate `workflow_dispatch` 自动把该测量 lane变成不可变 Tag 前的发布阻塞，
`workflow_dispatch` 新增 boolean input `run_windows`，默认 `false`；
`platform-windows.if` 只在 `workflow_dispatch && inputs.run_windows == true` 时运行。ben.2
candidate dispatch 不传该 input。GitHub 在展开 matrix 前评估 job-level `if`，所以普通
candidate只要求 `platform-windows` job-level result=`skipped`，不期待生成四个 Windows
shard records。维护者需要测量 Windows 时可另行显式 dispatch `run_windows=true`；该次
run必须展开四个 Windows shard并让它们全部到terminal，但结果不替代shipping-boundary
CI。
`npm-global-smoke` 的 `windows-latest` 仍是 disposable hosted package smoke，candidate
必须运行并通过。

同一专用测试必须静态解析 `.github/workflows/ci.yml`，证明：

- 上述三个 job 各且仅有一个精确命令；
- step 位于 Setup Bun 之后、Install/Test 之前；
- `storage-policy`、`api-usage`、`gates`、`keyring-smoke`、`npm-global-smoke` 和通用
  composite action 中不存在该命令；
- workflow 仍为 `contents: read`，没有新增 secrets、write permission 或 credential
  persistence；
- `npm-global-smoke` 的条件为 packaging path 命中或 `workflow_dispatch`，保证候选发布
  在不可变 Tag 前运行 package-install smoke；
- `npm-global-smoke` 必须保持 `runs-on: ${{ matrix.os }}`，matrix精确为
  `ubuntu-latest`、`windows-latest`、`macos-latest`，不得包含 `self-hosted`、动态 runner
  selector 或 `select-windows-runner` dependency。专用测试必须逐项固定这些条件。
- `workflow_dispatch.inputs.run_windows` 必须是 boolean/default false；
  `platform-windows.if` 必须精确依赖该 input，普通 candidate dispatch 的 aggregate gate
  保持现有通用 success/skipped 语义，不为本任务重写；独立的 candidate release verifier
  只允许 `platform-windows` job-level skipped，不允许其他发布 job/matrix skipped，也不
  要求不存在的 Windows shard records。

Workflow 改动属于安全边界，review 必须单独检查：固定 remote、严格 ref 派生、最小
`contents: read` 权限、无 secrets、无远端代码执行、无 push/force、失败不降级、
external PR 与 trusted workflow_dispatch 的 runner 边界不被扩大。安全 review 同时核对
workflow 静态 contract 与 credential-bearing failure redaction 测试。

## 设计三：版本、维护真源与最小修改面

### 包版本与实现提交

实现完成后把 `package.json` 从 `2.35.0-ben.1` 推进到 `2.35.0-ben.2`；不修改官方
dependency、script 或 package metadata，除非是本 Spec 明确新增的 CI baseline script
入口且该入口无需 package script。

Spec 与 Plan 均为公开、tracked 的前置文档，使用以下固定路径并在任何实现前分别提交：

- `docs/superpowers/specs/2026-08-29-v2350-ben2-rebase-repair-design.md`；
- `docs/superpowers/plans/2026-08-29-v2350-ben2-rebase-repair.md`。

它们必须各自通过仓库的文档 reviewer gate；不得留为 untracked 文件，也不得塞进末尾
`FORK_CHANGES.md` commit。之后的提交按独立职责分组：

1. runtime scope 修复与新组合测试；
2. CI official-base 准备脚本、专用测试和 workflow 接线；
3. 四个 Fork test 文件的六处尾随空格机械清理；
4. `package.json` ben.2 版本推进与 tracked
   `tests/fork-maintenance-truth.test.ts` red contract。

每个提交使用中文 subject。不得把 `FORK_CHANGES.md` 混入实现提交。
第 4 个实现提交在 `IMPLEMENTATION_HEAD` 上预期因旧 `FORK_CHANGES.md` 而保持红色；这是
文档 TDD 的明确 red phase。随后更新但尚未提交的 `FORK_CHANGES.md` 必须使该测试转绿，
再运行最终本地门禁和 reviewer re-review，最后只提交 `FORK_CHANGES.md`。这样 tagged
documentation commit 绿，而 final commit 仍满足 docs-only 约束。

### `FORK_CHANGES.md` 修复

捕获实现与版本推进完成后的精确 `IMPLEMENTATION_HEAD`，随后更新维护真源：

- 当前版本改为 `2.35.0-ben.2`，目标 Tag 改为 `v2.35.0-ben.2`；
- 保留 ben.1 为不可变历史修订，新增 ben.2 的 finding、修复与验证记录；
- 写明官方升级与 Fork 的交集为 16 paths：一个 `package.json` 冲突和 15 个
  auto-merge；明确列出 `tests/openai-responses-passthrough.test.ts` 与
  `tests/update-stop-first.test.ts` 两个 overlap tests；
- strict backend recovery 归属 Fork；官方 v2.35 turn termination 与 Fork recovery 的
  组合修复准确记录；
- 所有活跃“官方对比”改为 `v2.35.0`。官方 path/blob 从 v2.34 到 v2.35 未变时明确
  记录，而不是继续引用旧基线；
- 区分 local prepush 与显式 GUI/其他 changed-path gate；在末尾文档 commit 中把尚未发生的
  candidate workflow_dispatch CI、Tag promotion、final main CI 和 GitHub Release 明确标记
  为 `pending external gate`，不得预写成功、run ID 或 Release URL，也不得把 skipped
  conditional job 写成 passed；
- 记录 `e10b2ee28`/ben.1 的历史 shortstat 和 ben.2 新实现 HEAD/shortstat，避免把最终
  docs-only delta当成 runtime 扩散；
- 记录官方 Tag 是经过每轮重新验证的 runner-local、non-origin proof；在 retained
  self-hosted `.git` 中可以持久存在。只有 `refs/ocx-ci/*` 和临时 bare repo 是本轮结束时
  删除的 ephemeral state；
- 保留真实 ciphertext、Ark weekly quota等未在本轮关闭的已知缺口。

完成文档后只暂存 `FORK_CHANGES.md`，运行 staged name list、staged diff check，创建单独
末尾文档 commit，并机械验证其父提交等于提前捕获的 `IMPLEMENTATION_HEAD`。

该末尾 commit 是不可变的 **pre-promotion code-state snapshot**：它只记录 commit 前已经
完成的本地门禁、文档门禁与原 reviewer re-review；candidate/final CI、Tag、remote refs 和
Release 在文档中保持 pending。后置证据按“发生时已经可知”的边界分层：

- `FORK_CHANGES.md`：完成的本地/review证据；全部外部门禁 pending；
- candidate CI 绿后创建的 annotated Tag message：写入 candidate
  `workflow_dispatch/sync` run identity、local/review证据，并明确 promotion、final main CI
  与 Release 仍 pending；
- Final main CI 绿后创建的 GitHub Release Notes：写入 candidate/final run identities、
  promotion 后已可读取的 branch/Tag raw/peeled、验证摘要与已知缺口；
- GitHub Release 创建后的 `tagName/name/body/isDraft/isPrerelease/url` 后验结果只进入本次
  最终实现/发布报告和外部 GitHub audit state，不能回写既有 Tag annotation或tracked
  document。

不得为补记后置结果再创建 tracked 文档 commit，也不得重建 Tag annotation，否则会改变
已经验证/Tag 的 candidate SHA或raw Tag OID。

## 验证与 review 门禁

### TDD 与 focused gates

每个行为修复先得到红色证据：

- runtime：新的 recovery × Kiro 组合测试先红，scope 修复后绿；
- CI：origin-only fixture 先证明现有 gate 缺官方 Tag，再实现 prepare script 使之通过；
- 文档/版本：新增 tracked `tests/fork-maintenance-truth.test.ts`，识别当前版本、明确命名的
  16-path overlap、官方/Fork 归属、active v2.35 comparisons、ben.2，以及 candidate/final
  CI/Tag/Release 在 tagged 文档中仍是 pending external gates；不得用一次性未记录命令
  代替该 contract。该测试与 package version 同 commit进入 red phase，在 staged
  `FORK_CHANGES.md` 后转绿。

实现阶段运行最小 focused tests 和 `bun run typecheck`。Workflow/script 改动还运行现有
CI workflow tests、Fork version policy/release-line tests，并检查跨平台 argv/path 语义。

### 最终本地门禁

在 `FORK_CHANGES.md` 已更新但尚未创建末尾文档 commit 的状态运行：

- 全部相关 focused tests；
- `bun run typecheck`；
- `bun run privacy:scan`；
- `bun run prepush`；
- `git diff --check <official-base>...HEAD` 和末尾文档 staged diff check；
- GUI/docs-site 只在本轮实际 changed path 命中其规则时运行对应完整门禁。

Shared runtime 与 workflow 均属 L2/L3。全部实现后复用原
`SPEC_COMPLIANCE` 与 `CODE_QUALITY` reviewer，以 `REVIEW_PHASE: RE_REVIEW` 携带完整
prior findings、fix diff 和真实 verification evidence。CODE_QUALITY re-review 必须包含
workflow 安全 named-risk check。任何 Critical/Important finding 阻塞候选 push。

## 候选 CI 与不可变发布流程

### 1. 远端候选验证

最终 documentation commit 完成、本地门禁和 re-review 通过后：

1. 捕获本地/远端 `main`、`sync/v2.35.0`、`upstream-release`、目标 Tag 的 raw/peeled
   SHA；初次进入候选阶段时本地/远端 ben.2 Tag 都必须不存在；
2. 仅将 final documentation commit 以显式 expected-SHA lease 推送到
   `origin/sync/v2.35.0`；不移动 `main`、不创建/推送 Tag、不创建 Release；
3. 使用现有 `workflow_dispatch`，以 `ref=sync/v2.35.0` 启动 Cross-platform CI；
4. 在 dispatch 前记录 UTC 时间边界和 workflow id；固定唯一满足以下全部条件的 run：
   `event=workflow_dispatch`、`headBranch=sync/v2.35.0`、`headSha=candidate`、创建时间晚于
   dispatch boundary。零个或多个无法消歧的匹配都 fail closed；
5. 等待该 run terminal，并要求以下 candidate jobs/matrix 实际 success、不得 skipped：
   `test` 1–4/4、`storage-policy`、`api-usage`、`gates`、`platform-macos`、
   `keyring-smoke` 的 ubuntu/windows/macos、`npm-global-smoke` 的
   ubuntu/windows/macos，以及 aggregate `ci`。外部 candidate verifier 另行要求
   `platform-windows` job-level result=`skipped`，并确认没有 Windows suite shard实际执行；
   这是 candidate 唯一允许的发布 job skip。Aggregate `ci` success只是附加要求，其对
   skipped 的一般容忍不能替代这份发布候选 allowlist；
6. 失败时不创建 Tag。可确定为 runner/runtime transient 的失败只允许对同一 candidate
   rerun；代码、文档、CI contract 或策略失败必须在该 candidate 之后追加修复提交，重新
   捕获 `IMPLEMENTATION_HEAD`、追加新的最终 `FORK_CHANGES.md` commit，并以旧 candidate
   remote SHA 为 lease 做 fast-forward candidate push。不得 amend/rebase 已推送的失败
   candidate；新 candidate 不是旧 candidate descendant 时停止；随后重新执行 review、
   本地门禁和 candidate CI。

### 2. 原子 promotion

Candidate CI 绿后，在 exact candidate commit 上创建中文注释的 annotated
`v2.35.0-ben.2`。核对 raw ref type=tag、peeled commit=candidate。
Tag message 只记录此刻已完成的 candidate run identity、local/review验证和已知缺口，并
明确 promotion、final main CI 与 GitHub Release 尚 pending；不得预写 final run、远端
promotion后验或Release metadata。

使用一次 atomic push：

- candidate → `main`，expected SHA 为旧 ben.1 main；
- candidate → `sync/v2.35.0`，expected SHA 为已验证 candidate；
- 未修改的官方 `fc4de772b` → `upstream-release`，expected SHA 仍为当前 marker；
- 完整本地 `refs/tags/v2.35.0-ben.2` → 同名远端 Tag，不 force、不加 lease。

本地 Tag 创建后冻结代码与文档：不得再修改 candidate，也不得删除/重建该本地 Tag；
annotated Tag 的 raw object OID 必须在所有重试中逐字节复用。

任何 branch lease 漂移、远端 Tag 已存在但不一致、atomic 不支持或确定 push 失败都
停止，不拆分 push。远端成功后，用捕获的本地旧 OID 在一个
`git update-ref --stdin` transaction 中对齐本地 `main` / `upstream-release`；当前 sync
branch保持在 candidate。

Atomic push 返回不确定结果或后续本地 transaction 失败时，必须 fresh 读取远端
`main`、sync、marker 与 Tag raw/peeled，只接受两种完整状态：

- **完整 pre-state**：main 仍为 ben.1、sync 为已验证 candidate、marker 为官方 SHA、
  远端 ben.2 Tag 不存在。此时复用原本地 Tag raw OID和 fresh leases重试 atomic push；
- **完整 post-state**：main/sync 都为 candidate、marker 为官方 SHA、远端 ben.2 raw Tag
  等于原本地 Tag raw OID且 peeled 为 candidate。此时不再 push，只补本地 ref
  transaction。

任何 mixed state、远端 Tag raw/peeled不一致或无法判定的状态都停止并请求人工处理，
不得自行删除 Tag、重写 branch 或猜测 push 结果。

### 3. Final CI 与 GitHub Release

Main push 会为同一 SHA 触发 Cross-platform CI。Atomic push 前记录 UTC promotion
boundary；只接受唯一满足 `event=push`、`headBranch=main`、`headSha=candidate`、创建时间
晚于 promotion boundary 的 Cross-platform run。不得复用先前
`workflow_dispatch/sync/v2.35.0` candidate run。零个或多个无法消歧的匹配都 fail
closed。等待该 final run 及发布所需 jobs success；失败时 Tag 保持不可变但不创建
GitHub Release。只允许对同一 SHA rerun 可判定为 runner/transient 的失败；代码或策略
缺陷需要新的用户授权修订，不能移动 ben.2 Tag。

Final CI 绿后才创建公开 GitHub Release：

- `tagName` 和标题均为 `v2.35.0-ben.2`；
- `isDraft=false`、`isPrerelease=false`；
- 中文 Notes 包含官方基线、四类修复、candidate/final CI、验证、已知缺口和 commit；
- 只使用 GitHub source archives，不发布 npm、不上传额外资产。

创建后查询并后验验证 Release metadata、远端 Tag raw/peeled、`main`、sync、
`upstream-release`。Release API 失败时保留 Tag/branch 状态并标记未完成，后续只补
Release，不生成 ben.3。

## 失败处理与幂等性

- 所有 read/compare 在 write 前完成；任何不确定状态停止；
- 不 stash、不覆盖来源不明的工作树改动；
- candidate sync push 后重复执行时，先核对 remote SHA：相同则复用；新修复 candidate
  必须是该 SHA descendant并以它为 lease fast-forward；其他分叉停止；
- CI prepare script 不删除或改写非自身临时 refs；
- 已存在的官方本地 Tag必须与官方 raw/peeled一致；
- 初始候选阶段要求 Fork ben.2 Tag 不存在；进入 promotion 后已存在的本地 Fork Tag必须
  复用同一 raw OID，远端存在时必须 raw/peeled 与本地一致，否则停止；
- 已有合格 GitHub Release 时只核对，不重复创建；不合格时只修 metadata，不移动 Tag；
- `v2.35.0-ben.1` 在任何路径都不可修改。

### 阶段状态表

| 状态 | 允许动作 | 禁止/恢复规则 |
| --- | --- | --- |
| S0 初始 | 本地门禁、review、推首个 sync candidate | 本地/远端 ben.2 Tag 必须不存在。 |
| S1 candidate 已远端化 | dispatch并绑定唯一 candidate run | 失败修复只追加 descendant commits；不重写远端历史。 |
| S2 candidate CI 绿 | 创建一次本地 annotated Tag | 创建后 candidate冻结，Tag raw OID冻结。 |
| S3 promotion push 中/结果不明 | fresh读取完整远端 refs | 只接受完整 pre/post state；mixed state停止。 |
| S4 远端 promotion 完整 | 补本地 transaction，等待 final main CI | 不再 push或重建 Tag。 |
| S5 final CI 绿 | 创建/核对 GitHub Release | Release失败只补Release。 |
| S6 完成 | 后验核对refs/Release | 任何漂移停止，不生成新revision。 |

## 预期修改文件与必要性

| 文件 | 必要性 |
| --- | --- |
| `docs/superpowers/specs/2026-08-29-v2350-ben2-rebase-repair-design.md` | 已批准设计；在实现前单独 tracked commit。 |
| `docs/superpowers/plans/2026-08-29-v2350-ben2-rebase-repair.md` | 已批准执行计划；在实现前单独 tracked commit。 |
| `src/server/responses/core.ts` | 在两个 post-bind parsed replacement 后恢复官方 v2.35 turn-termination identity invariant；只保留局部接线。 |
| `tests/fork-agent-task-recovery-kiro-turn-termination.test.ts` | 独立覆盖 recovery 与 Kiro local-terminal 的组合回归。 |
| `scripts/prepare-fork-official-base.ts` | 集中、可测试地准备 CI-only 官方 Tag 证明。 |
| `tests/fork-ci-official-baseline.test.ts` | 独立覆盖 origin-only、reserved version、mismatch、完整 ancestry、Tag object、workflow placement、credential redaction 与 fail-closed 行为。 |
| `tests/fork-maintenance-truth.test.ts` | 锁定 package/FORK_CHANGES current version、16-path overlap、v2.35 active comparison、ben.2 与后置外部门禁 pending 边界；和 version 同 commit进入red phase。 |
| `.github/workflows/ci.yml` | 让三类完整 suite 在测试前执行官方基线准备；安全边界需显式审查。 |
| `package.json` | 推进不可变 Fork revision 到 `2.35.0-ben.2`。 |
| `FORK_CHANGES.md` | 修正 v2.35 维护真源并作为 Tag 指向的末尾文档提交。 |
| `tests/fork-custom-tool-output-lowering.test.ts` | 仅删除 1 处尾随空格。 |
| `tests/fork-relay-eager-flush.test.ts` | 仅删除 2 处尾随空格。 |
| `tests/fork-sse-block-rewrite-flush.test.ts` | 仅删除 2 处尾随空格。 |
| `tests/fork-usage-recovery-kinds.test.ts` | 仅删除 1 处尾随空格。 |

本次 rebase overlap 中同时由官方/Fork 修改、但本轮不应再编辑的两个 tests 是
`tests/openai-responses-passthrough.test.ts` 与 `tests/update-stop-first.test.ts`；它们只在
`FORK_CHANGES.md` 中被准确记录，不承载新的 ben.2 用例。

当前 Fork 相对官方是 105 paths。上述新增 Spec、Plan、runtime test、CI script、CI test、
maintenance-truth test 和首次 `.github/workflows/ci.yml` Fork diff 共新增 7 paths，因此
ben.2 预期 official-relative path count 为 112。`core.ts`、`package.json`、
`FORK_CHANGES.md` 与四个 whitespace 文件已在原 105 paths 内，不增加 path count。
实现后必须机械重算；若不是 112，必须逐 path 说明并重新通过 Spec review。

若实现需要新增上述清单之外的生产文件或改动其他官方高频文件，必须先回到本 Spec 说明
原因，并重新通过 Spec review；不得以“顺手”为由扩大修改面。

## 验收标准

1. 新组合测试在旧实现上失败，在修复后通过；Kiro 第二轮零 upstream send、零 usage；
2. routed组合行为测试与 canonical native replacement 静态 invariant均先红后绿；
3. origin-only fixture 能准备官方 Tag；reserved malformed、mismatch、伪造、浅历史和
   缺失场景按定义 fail closed；
4. CI production path只访问固定官方 URL和 origin marker，不接收用户可控 remote，
   credential-bearing失败输出通过专门redaction测试；
5. 本地 `release-version-line` 在有/无预置官方 Tag的受控 fixture中都执行真实检查，不能
   通过空 Tag 集合绕过；
6. workflow静态测试证明精确job/step/order/permission，强制workflow_dispatch运行
   npm-global ubuntu/windows/macos，并固定 run_windows default false、Windows job-level
   candidate skip 与外部 verifier allowlist contract；
7. Cross-platform candidate workflow_dispatch 以 event/branch/time/run-id/sha唯一绑定，
   所有列名的发布相关job/matrix成功；
8. 原两位 reviewer 的全部 Important finding 在 re-review 中关闭，workflow 安全检查通过；
9. 本地最终门禁、privacy 与 official-relative diff check 全绿；
10. `FORK_CHANGES.md` 当前版本、16-path overlap、v2.35 coverage、已完成本地/review证据、
    后置外部门禁 pending 状态和 known gaps准确；后置 run IDs/results只进入Tag/Release证据；
11. official-relative path count为112，新增/既有修改路径与本表完全一致；
12. `v2.35.0-ben.2` 是 annotated Tag，remote raw/peeled一致，`main`/sync指向同一 commit，
   `upstream-release` 仍为官方 `fc4de772b`；Tag message只包含candidate阶段已完成证据并把
   promotion/final CI/Release标为pending；
13. Final main CI 以 push/main/time/run-id/sha唯一绑定并成功后，才存在公开、非
    prerelease、非 draft 的同名 GitHub
    Release；Release Notes包含candidate/final run identities与promotion ref证据；创建后
    metadata后验只进入最终报告/GitHub外部状态，不要求回写Tag或tracked文档；
14. origin 不出现官方 `v2.35.0` Tag；不发生 npm publish，不在开发机、持久环境或
    self-hosted runner执行全局安装/服务替换；只允许既有 disposable GitHub-hosted
    `npm-global-smoke` 的隔离全局安装验证；
15. 工作树、索引无遗留改动，Spec/Plan已tracked，所有后台命令均已跟进到terminal。
