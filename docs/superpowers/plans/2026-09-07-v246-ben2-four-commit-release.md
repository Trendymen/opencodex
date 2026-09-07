# v2.46.0-ben.2 四提交压缩发布实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to execute this plan. 执行方式由用户选择；步骤使用 checkbox 跟踪。

**Goal:** 将当前 Fork 相对官方 `v2.46.0` 的 27 个提交压缩为 4 个线性提交，保留现有内容，发布 `v2.46.0-ben.2`。

**Architecture:** 从固定源树按文件归属构造四个提交，不再次 rebase 上游，不重写生产逻辑。使用隔离临时 index 生成 Git 对象，核验完整文件树后才以 CAS 更新本地 dev；先取得 dev candidate CI 和双审，再原子 promotion，main CI 成功后创建 Release。

**Tech Stack:** Git plumbing、Node ESM、Bun、GitHub CLI。

**Spec:** 用户“四提交并发布 ben.2”的当前请求；`AGENTS.local.md` 与 `docs/fork-sync-automation.md` 的压缩发布合同。

## 固定输入与约束

- `OFFICIAL_COMMIT=bba63222d3eeb5c8e397edae35798225e4fa1a6f`，官方 Tag `v2.46.0`。
- `INITIAL_SOURCE_HEAD=b14fa152b818a1f4e157b351676c69be4dc4b3c9`。
- `INITIAL_SOURCE_TREE=e1d6773030097b19db41413e2cd73923de0a5fb2`。
- `SQUASH_TARGET_COUNT=4`。旧范围为 27 个提交；初始净差异 215 个路径，按 C1/C2/C3/C4 分为 102/27/85/1。
- 当前 main、sync/v2.46.0 本地/远端均为 `d82c8c776b75daae174b816ab080c9f4a88a980c`；dev 本地/远端均为初始源提交；marker 本地/远端均为官方 commit。
- 已有 `v2.46.0-ben.1`：raw `958238ade04085b042ad3f1e4fbe80abfc57d092`，peeled `d82c8c776b75daae174b816ab080c9f4a88a980c`。本次不移动旧 Tag；执行时重验整个同基线 Tag 名称空间。
- 目标包版本 `2.46.0-ben.2`、目标 annotated Tag / Release `v2.46.0-ben.2`。禁止创建 `sync/v2.46.0-ben.2`。
- 源树以当前 dev 为准，包含 ben.1 后安装/Volta、Responses V2 注解与能力文档修复；不只压缩 main，也不丢弃 dev 增量。
- 本任务允许的源树增量只有 `package.json` 的 version 字段和本计划文件。计划归 C2；预期总路径因此为 216，分组为 102/28/85/1。其余文件的 mode/blob 必须与初始源树完全一致，包括 `FORK_CHANGES.md`。
- `FORK_CHANGES.md` 沿用当前按能力组织的内容，不添加候选 SHA、测试计数、冲突账本、版本历史或 attempt 标记。C4 相对 C3 单独加入该文件；attempt 标记仅放 C4 commit message。
- 每次准备或发布前检查干净工作区、Git 操作和固定引用。只暂存本任务文件，发现他人修改或引用变化立即停止；不 stash、不覆盖。
- 本次没有生产行为变更，不新增业务修复或测试。若验证发现问题，先判定是否由本任务引入；需要扩大修复范围时报告，不自动纳入。
- 不新建工作区；在当前 dev 执行，保存精确备份 ref。所有临时 index、manifest、日志、attempt 和审查材料放 `.tmp/v246-ben2-squash/`，不进入发布树。
- 不恢复已删除的 hook，不创建 PR/Issue，不发布 npm 或额外资产。

## 四个提交

| 提交 | 中文主题 | 路径归属 |
| --- | --- | --- |
| C1 | `feat: 汇总 Fork 运行时与用户能力` | `src/`、`bin/`、`docs-site/`、`gui/` 中非 `gui/tests/` 路径 |
| C2 | `chore: 汇总 Fork CI、安装与维护基础设施` | `.github/`、`scripts/`、`structure/`、`docs/`、`.gitignore`、`AGENTS.local.md`、`MAINTAINERS.md` |
| C3 | `test: 汇总 Fork 回归并推进 v2.46.0-ben.2` | `tests/`、`gui/tests/`、`package.json` |
| C4 | `docs: 汇总 Fork 能力差异清单` | 仅 `FORK_CHANGES.md` |

## Task 1：准备源快照与可复算分组

**Files:** 修改 `package.json` 的 version；新增本计划；读取当前 `FORK_CHANGES.md`。过程材料位于 `.tmp/v246-ben2-squash/`。

**Interfaces:** 输入上述固定 OID；输出不可改写的 `initial.json`、`S1/source-head`、`S1/source-tree`、M1–M4 与路径 mode/blob 清单。

- [ ] 重读规则与工作区状态。核对官方 Tag raw/peeled、main/dev/sync/marker、本地与远端完整 `v2.46.0-ben.*` 空间；确认 ben.2 不存在且 ben.1 元数据合格。初始化记录只保存必要引用，不复制全局 Git 配置或凭据。
- [ ] 用 `git update-ref refs/heads/backup/v246-ben2-source-initial b14fa152b818a1f4e157b351676c69be4dc4b3c9 0000000000000000000000000000000000000000` 保留初始源。备份已存在时先核对，不能改写。
- [ ] 用 apply_patch 将 package version 从 `2.46.0-ben.1` 改成 `2.46.0-ben.2`。用 `git status --porcelain=v1 -z` 核对 tracked/untracked 变更恰为 package 和本计划；暂存后用 `git diff --cached --name-only -z` 再证明只有这两个路径，并检查无其他工作区变化。解析前后 package 并移除 version 后作 deep equality。
- [ ] 只暂存这两个文件，`git diff --cached --check` 后创建源准备提交，捕获 `SOURCE_S1` 和 `SOURCE_TREE_S1`；保存到新建 S1 目录并以 `backup/v246-ben2-source-S1` 保留。此提交只是重建输入，不在最终四提交后追加。
- [ ] 通过 `git diff --name-only --no-renames -z OFFICIAL_COMMIT SOURCE_S1` 取得全集，按上表归类。使用 NUL 分隔处理路径。每条路径必须恰有一个 owner；M1–M4 两两不交且并集等于全集，未知路径立即停止。SHA、数量和 manifest hash 从实际数据计算。

## Task 2：构造并验证四提交候选

**Files:** 只操作隔离 index 与 Git 对象；最终工作区内容必须与 SOURCE_S1 tree 一致。

**Interfaces:** 输入 SOURCE_S1 和 M1–M4；输出 C1/C2/C3/C4 OID、预期 tree、验证证据与 candidate attempt A1。

- [ ] 不执行历史 replay。对每个 Mi，使用独立的新临时 index，从前一个 commit 的 tree 开始；通过 `git ls-tree -rz SOURCE_S1` 获取精确 mode/blob。存在路径使用 `git update-index --add --cacheinfo <mode> <blob> <path>`，源树中已删除的路径用 `git update-index --force-remove -- <path>`；均显式传入该次 `GIT_INDEX_FILE`。`git write-tree` 生成 tree，`git commit-tree <tree> -p <parent>` 按上表生成提交。第一个 parent 必须是 OFFICIAL_COMMIT。
- [ ] 在创建 C4 前固定 `IMPLEMENTATION_HEAD=C3`。C4 只应用 M4，并在 message 中写 `候选尝试: A1`。保存作者信息与相关 Co-authored-by 来源；不伪造上游原作者身份。命令输入与输出写入新建 attempt 目录，禁止覆盖旧记录。
- [ ] 以下条件全部机械通过：完整链恰为 `OFFICIAL_COMMIT -> C1 -> C2 -> C3 -> C4`、无 merge、C4 tree 等于 SOURCE_TREE_S1、C4 只改 `FORK_CHANGES.md`、C4 parent 等于预先捕获 C3、各层实际 changed path 等于对应 Mi。输出相对初始源的 diff，除 package version 与本计划外必须为空；运行 `git diff --check OFFICIAL_COMMIT C4`。
- [ ] 工作区与 index 仍精确等于 SOURCE_S1 时，用 `git update-ref refs/heads/dev C4 SOURCE_S1` CAS 更新当前 dev。因为两树相同，不需要 `reset --hard`、checkout、清理文件或重放；重新检查 `git status --porcelain` 为空及四提交链。
- [ ] 先运行 `bun test tests/ci-workflows/fork-maintenance-truth.test.ts tests/ci-workflows/fork-ci-official-baseline.test.ts tests/update/fork-version-policy.test.ts`，再对最终候选运行一次正常默认并发 `bun run prepush`。不再单独重复 prepush 已包含的检查。若本轮没有 GUI/docs 输入变化，沿用已有构建证据；缺少可复用的明确输入/产物证据才补构建。
- [ ] 每项验证保存完整命令、cwd、实际 SHA/tree、输入 hash、退出码与日志。内容变化后形成新 S_K；不追加第五个提交，修复折回 owner 层并重建后继。相同 tree 重试仅 amend C4 message 为新 A_J，并证明 tree/parent/四提交数量未变。
- [ ] candidate push 前，独立 CODE_QUALITY reviewer 核对当前快照的 `.github/workflows/ci.yml` 及相关 provenance 接线，确认内容 hash、权限、逐 SHA 触发与官方 job/aggregate 逻辑。它是压缩专用的推送前 workflow 审查，不代替后续常规双审。
- [ ] 紧邻 push 重新核对远端 dev 仍等于本次 attempt 的 expected-old（A1 为初始 b14fa152…）；用 `git push --force-with-lease=refs/heads/dev:<该完整OID> origin <C4>:refs/heads/dev` 只推候选 dev。记录 raw push 输出；不确定结果先查远端，不盲目重试。
- [ ] 等待 `push/dev`、headSha=C4 的 `ci.yml` completed/success 和 aggregate ci；按当前 workflow 确认必要 job，不能拿旧 SHA 或其他分支 run 代替。保存 run/jobs JSON。

## Task 3：最终双审、原子 promotion 与 Release

**Files:** 审查材料及 Release Notes 只保存在本轮 scratch；不再改候选文件树。

**Interfaces:** 输入最终 C4、candidate CI 和前述证据；输出 immutable Fork Tag、六引用原子推送、本地 CAS、main CI 和公开 Release。

- [ ] 用两个独立 reviewer，分别执行 SPEC_COMPLIANCE / CODE_QUALITY，`fork_turns: none`。包内包含固定源树、四份完整 manifest、完整 `git diff OFFICIAL_COMMIT C4`、源树到候选的受控差异、验证与 exact-SHA CI。明确本轮是纯压缩，不重审无关历史功能，也不新增 rebase stop/shadow replay。旧 v2.46.0 rebase 记录仅作能力来源上下文，不冒充本次新冲突。
- [ ] 两个 reviewer 均 PASS 且无 Critical/Important 才发布。finding 修复后复用原 reviewer，RE_REVIEW 携带完整 PRIOR_FINDINGS、FIX_DIFF 和真实验证；生成新 S_K/A_J，仍恰好四提交并先取得新 C4 的 candidate CI。
- [ ] 发布前固定并重验 main/dev/sync/marker 四条远端 lease；main/sync 应仍为 d82c8c776…，dev 应是最终 C4，marker 应仍为官方 bba63222…。本地 main/sync/marker 的旧 OID 同时捕获为 CAS 输入。核对整个本地/远端同基线 Tag 空间，任何更高 revision、删除或改写均停止。
- [ ] 创建中文 annotated `v2.46.0-ben.2`，以 `git cat-file -t refs/tags/v2.46.0-ben.2` 证明 raw 类型为 tag，peeled 必须为最终 C4。再次核对远端命名空间；两个 Tag refspec 不加 `+`，不用 force 或 lease。
- [ ] 一次 `git push --atomic` 推送 C4 到 main/dev/sync/v2.46.0、官方 commit 到 upstream-release、完整本地官方与 Fork Tag ref。四个 branch 分别带显式 expected-OID lease，允许 leased non-fast-forward；任何失败禁止拆分或普通 force。
- [ ] 远端确认成功后，在一个 `git update-ref --stdin` 的 start/prepare/commit 事务中，用捕获的旧 OID 对齐本地 main/sync/marker。保持当前 dev 不变，fetch 并核对 tracking refs。
- [ ] atomic push 后立即重读本地/远端完整 `v2.46.0-ben.*` 的名称、raw OID 与 peeled OID 映射。确定成功时，远端必须精确等于冻结的 REMOTE_BASELINE 加本轮目标 Tag，且本地映射不得漂移；不确定推送结果只允许 baseline 或 baseline 加同一目标对象，先确定实际状态，不盲目重推。其他新增、删除、替换或更高 revision 均停止 Release，保留 immutable Tag 与已确认的推送状态。
- [ ] 等待同一 C4 的 `push/main` CI completed/success；Tag 后失败不移动或删除 Tag、不追加第五个提交、不创建 Release，记录已消耗 revision 与阻塞。不得在旧 immutable Tag 上修复内容后继续发布。
- [ ] CI 完成后、Release API 紧邻前，再复核上述完整 Tag 映射和发布 refs，防止等待期间发生漂移。最后一次 preflight 到 push 之间无法用 wildcard lease 排除的新 Tag TOCTOU 窗口，作为残余风险记录，不声称已消除。
- [ ] 创建 `gh release create v2.46.0-ben.2 --repo Trendymen/opencodex --verify-tag --title v2.46.0-ben.2 --notes-file <本轮中文Notes路径>`；仅 source archive，非 draft/prerelease。Notes 说明官方基线、从27压至4、ben.1后的已提交修复、验证与双审、最终commit及真实未验收边界。
- [ ] 查询 `tagName,name,body,isDraft,isPrerelease,url,assets` 并核对。最后重算官方后恰好四提交、完整链、源树等价、Tag raw/peeled、本地/远端 main/dev/sync/marker 和干净工作区；在本会话报告 Release URL、四提交 SHA、CI URL 与残余风险。

## 执行选择与恢复

本计划通过独立 PLAN_DOCUMENT 审查后，由用户选择 Inline Execution 或 Subagent-Driven。无论选择哪种，Git 引用和发布操作只由一个执行者串行负责，禁止两个 publisher 并行。
进度、manifest、attempt、验证和 reviewer 原始结论入口保存在 `.tmp/v246-ben2-squash/`；不得把旧 v240 过程目录当成本轮状态。恢复时先读取本轮记录并验证引用，不能根据当前 HEAD 反推初始源或把旧 run 改标成新候选证据。
