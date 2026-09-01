# OpenCodex Fork 上游同步自动化规则

本文档是 Trendymen/opencodex Fork 每小时上游稳定版同步自动化的完整规则真源。自动化任务的消息文本是本文档的精简索引；两者冲突时以本文档为准。

## 分支职责

- `main` 只表示最新已发布的 Fork Release：必须指向最新 Fork Tag 的 peeled commit，不承载未发布开发。
- `dev` 是自由开发线，也是上游稳定版同步、rebase、验证、双审与 Fork Release 的唯一候选线。它可以在最新 Fork Release 之上继续开发，也可以为发布收敛、压缩并在有明确 lease 的前提下强制更新远端。
- `sync/vX.Y.Z` 是该官方基线的可审计发布 ref，不是 rebase 工作线；发布时与 `main`、`dev`、Fork Tag 指向同一 `RELEASE_COMMIT`。新开发从发布后的 `dev` 继续，不写入 `main`。

## 目标与候选资格

- 每小时检查上游 lidge-jun/opencodex 是否发布了比 upstream-release 更新的稳定 GitHub Release。
- 只接受非 draft、非 prerelease 的正式 Release；忽略 preview、beta、rc、draft 和仅有 Tag 的版本。
- 候选官方 Tag 必须指向可从上游默认分支 main 到达的 commit。

## 分支拓扑

- `dev` 是 Fork 的主开发/集成/推送分支：日常功能提交默认落在 dev 并推送 origin/dev；任务级 changed 模式测试以 `origin/dev` 为比较基准（`bun scripts/test.ts --changed=origin/dev`）。
- `main` 只承载最新已发布 Release：发布闭环时以显式 expected-SHA `--force-with-lease` 强制更新到该 Release 的末尾文档 commit，仅作最新 Release 指针；不承载日常开发提交，不作为日常工作或 PR 的基础分支。
- `sync/vX.Y.Z` 是单个官方基线的审计/发布 ref，发布后保留；`upstream-release` 仍指向 `OFFICIAL_COMMIT`。
- 发布瞬间，当前已验证的 `dev` 候选与 `main`、`sync/vX.Y.Z`、Fork Tag 原子收敛到同一 `RELEASE_COMMIT`。发布后若 `dev` 已产生新开发提交，自动化不得把它重置回旧 Release。

## 提交术语与唯一原子集合

- `IMPLEMENTATION_HEAD`：包含全部生产代码、测试、脚本、GUI 与 package 版本改动的最终实现提交。
- `RELEASE_COMMIT`：父提交等于 `IMPLEMENTATION_HEAD`、且只修改 `FORK_CHANGES.md` 的末尾文档提交。
- `OFFICIAL_COMMIT`：固定官方稳定 Tag 的 peeled commit。

本修复、审查与验证阶段不得移动本地或远端 `main`、`dev`、`sync/vX.Y.Z`、`upstream-release` 或任何 Tag。只有全部验证与审查通过后的发布动作才使用下列唯一完整 refset：

<!-- official-atomic-refset:start -->
branch|main|leased-force|RELEASE_COMMIT:refs/heads/main
branch|dev|leased-force|RELEASE_COMMIT:refs/heads/dev
branch|sync|leased-fast-forward|RELEASE_COMMIT:refs/heads/sync/vX.Y.Z
branch|marker|leased-force|OFFICIAL_COMMIT:refs/heads/upstream-release
tag|official|no-force-no-lease|refs/tags/vX.Y.Z:refs/tags/vX.Y.Z
tag|fork|no-force-no-lease|refs/tags/vX.Y.Z-ben.N:refs/tags/vX.Y.Z-ben.N
<!-- official-atomic-refset:end -->

<!-- fork-release-lifecycle:start -->
rebase_branch=dev
sync_role=audit-release-ref
release_instant_dev=must-equal-RELEASE_COMMIT
post_release_advanced_dev=must-not-reset
sync_ancestry=EXPECTED_REMOTE_SYNC-absent-or-ancestor-of-RELEASE_COMMIT
final_convergence=local-remote-main-dev-sync-fork-tag-equal-RELEASE_COMMIT
<!-- fork-release-lifecycle:end -->

四个 branch 使用各自精确 expected-SHA lease；`main`、`dev` 与 marker 允许按发布策略 force，`sync/vX.Y.Z` 只能普通 fast-forward。两个 Tag 都不 force、不使用 lease。任何 mismatch、atomic 不支持或不确定失败都 fail closed，禁止拆分推送。

`leased-fast-forward` 的操作含义不是“lease 可以代替 fast-forward”。若远端 sync 已存在，必须在 atomic push 紧邻前执行并通过：

```bash
git merge-base --is-ancestor "$EXPECTED_REMOTE_SYNC" "$RELEASE_COMMIT"
```

随后重新读取远端 sync，确认仍等于 `EXPECTED_REMOTE_SYNC`；push 中 sync 使用不带 `+` 的普通 refspec。exact lease 只负责拒绝检查后的并发漂移，ancestry guard 才负责禁止 audit ref 被非 fast-forward 重写。

## 通知策略

- 无新官方稳定 Release、当前派生闭环、无失败或未决事项：按 DONT_NOTIFY 安静结束。
- 发现并完成新官方稳定 Release 同步（rebase、push、Release 任一实质进展或闭环）、发生失败、阻塞或需要用户决策的未决事项：NOTIFY，简体中文摘要（官方 Tag、Fork 版本/Tag、Release URL 或阻塞原因）。

## 最高优先级前置检查

1. 本会话存在需要用户重大决策的未决事项时，停止新的同步、rebase、Tag、Release 和 push，提醒用户先处理；不得绕过或猜测。
2. 要求工作树、索引干净且没有进行中的 Git 操作；存在其他未提交工作时 fail closed，不得 stash、覆盖或混入同步提交。
3. `main` 本地/远端必须一致，且只作为已发布 Release 指针校验。不要因 `dev` 有已提交开发内容或领先 `main` 而停止同步；`dev` 正是本流程的发布候选来源。

## 维护真源

FORK_CHANGES.md 是当前 Fork 已提交能力及相对官方覆盖状态的维护真源。每次任务先读取它，以实际提交代码、测试和真实验收为能力基准，不以旧 Spec、Plan、devlog 或安装包残留为准。文档、任务状态、Tag 注释与 GitHub Release Notes 必须使用简体中文；代码符号、路径、命令、Provider/模型 ID 和版本号保持原样。

## 官方 Tag 保留规则

每个官方稳定基线 Tag（vX.Y.Z，非 preview/beta/rc/draft）必须同时保留在本地与 origin 远端：

- 每次新官方基线同步完成时，在该次 atomic push 中一并推送官方 Tag ref（refs/tags/vX.Y.Z:refs/tags/vX.Y.Z，不加 +、不 force）。
- 发现远端缺失历史官方 Tag 时，用一次普通（非 force）push 补齐并报告。
- 禁止删除或改写任何官方 Tag 与 Fork Tag。

## 双审门禁

完成 rebase、冲突处理与最终验证之后，必须先通过双审并修复到通过，才允许 Tag、push 和 Release：

- 按用户级 requesting-code-review 规则派发两个独立 reviewer（SPEC_COMPLIANCE 与 CODE_QUALITY），以 fork_turns "none" 派发。
- 审查包只包含当前任务 brief、官方旧/新 Tag SHA、scoped diff（相对新官方 Tag 的完整 Fork 修改面）、冲突处理说明与验证证据；不得携带主会话历史。
- 任一 Critical/Important finding 阻塞推送与发布：修复后重跑完整验证门禁，用新实现 SHA 重写 FORK_CHANGES.md 并重建末尾文档提交，再以 REVIEW_PHASE RE_REVIEW 携带完整 PRIOR_FINDINGS、FIX_DIFF 与真实 VERIFICATION_EVIDENCE 复用原 reviewer 复审。
- 两个 reviewer 均无未决 Critical/Important finding（Approved）后，才进入 Tag / push / Release。
- 无双审通过证据时执行 push 或 Release 视为违规，必须回滚未发布状态并登记失败。

## 幂等收敛（判断新 Release 之前）

从已提交 FORK_CHANGES.md 与 package.json 推导预期 X.Y.Z-ben.N 和 vX.Y.Z-ben.N：

- 实现、最终验证或末尾文档提交未完成：只恢复当前 ben.N 剩余收尾；不重新 rebase、不递增 revision。工作树不干净、来源不明或证据不足时登记未完成并 fail closed。
- `RELEASE_COMMIT` 完成但 Fork Tag 缺失：验证 package/document 一致、其父提交等于此前捕获的 `IMPLEMENTATION_HEAD`、该提交只含 `FORK_CHANGES.md`，再按 annotated Tag 与六成员 atomic leased push 流程补齐；不得生成 ben.(N+1)。
- 远端 push 完成但本地 main / upstream-release 未对齐：用捕获的本地旧 OID 做 compare-and-swap 对齐；不得移动已验证的 sync branch。
- Tag 存在但 GitHub Release 缺失或元数据不合格：只创建或幂等修正同名 Release，不移动 Tag、不递增 revision。Release 须满足 tagName 精确、name 等于 Tag、isDraft=false、isPrerelease=false，中文 body 至少含官方基线、Fork 修改点、验证结果、已知缺口与 commit。

`dev` 可以在已发布 `main` 之上有自由的已提交开发内容；这不是 drift。只有候选来源、远端 `dev` 预期 SHA、或其重写权限无法确定时才 fail closed。

全部闭环且无更新官方稳定 Release 才可记录无需同步。

## 新官方稳定 Release 同步流程

1. fetch 后固定本地/远端 main、dev、upstream-release、sync/vX.Y.Z 和目标 Fork Tag 的 raw/peeled SHA。本地 main 与 marker 必须和远端一致；dev 的本地/远端状态同时记录为候选证据。
2. 保护候选历史：候选固定为已提交的 `dev`。远端 dev 必须 fetch；本地 dev 领先、落后或分叉时均须记录两端 SHA 与来源。只要本地 dev 是当前已知、干净的发布候选，可继续；来源不明、远端独有而无法证明、或 lease 预期无法固定时停止。远端 sync 存在必须 fetch；发布时 sync 必须 fast-forward 到 Release commit，远端独有或来源不明时停止。
3. 在 `dev` 上执行等价于 `git rebase --onto <new-tag-sha> <old-upstream-release-sha> dev`。rebase 阶段不得移动 main，不得 detached HEAD 验证。完成实现、验证和末尾文档提交后，本地 `sync/vX.Y.Z` 才可准备为同一 `RELEASE_COMMIT`；不得将 dev 当作只读证据，也不得在 sync 上 rebase。
4. 冲突处理以 FORK_CHANGES.md、src/fork 边界、AGENTS.local.md、既有测试和新官方实现为依据。仅当前官方源码与测试证明等价或更优才可删除 Fork 行为；名称相似、旧文档或单次 HTTP 200 不算证据。部分覆盖只移除被替代部分；语义改变、能力放弃或无法判定时请用户决定。Fork 逻辑优先放窄模块或 src/fork，官方高频文件最小接线。
5. revision：新官方 vX.Y.Z 首次派生固定 X.Y.Z-ben.1 / vX.Y.Z-ben.1。同基线已有 Release 不自动递增；仅用户明确要求才允许 ben.2、ben.3。重复 heartbeat 幂等。
6. 完成并提交全部 rebase、冲突、版本与实现修复。
7. 捕获固定 `IMPLEMENTATION_HEAD`，不得从后续 HEAD 反推。按该 SHA 中文更新 FORK_CHANGES.md：官方 Release/Tag/SHA、实现 commit、shortstat、包版本、目标 Tag、能力状态、官方覆盖证据、已移除方向、已知缺口与验收边界。历史移除记录不删，旧 PASS 不沿用。
8. 文档更新后执行最终验证：定向测试；共享 runtime/adapter/server/script/runner/version 改动跑一次 bun run prepush；GUI 改动按规则构建；privacy scan 必须通过。验证促成实现修改时回到第 7 步。
9. 只暂存 `FORK_CHANGES.md`，核对 staged list 与 diff check，创建 `RELEASE_COMMIT`。机械验证其父提交等于 `IMPLEMENTATION_HEAD` 且该提交只含本文档。
10. 执行双审门禁（见上）。未通过前禁止后续 push、Tag、Release。
11. 双审通过后创建中文注释 annotated Tag vX.Y.Z-ben.N；raw 类型必须是 tag，peeled 等于 `RELEASE_COMMIT`。远端已存在时核对 OID，否则 fail closed。禁止 force Tag。
12. 先执行 sync ancestry guard 并重新读取全部 expected OID，再按“提交术语与唯一原子集合”的六成员 refset 执行一次 `git push --atomic`：`main`、`dev`、`sync/vX.Y.Z` 与 Fork Tag 指向 `RELEASE_COMMIT`，marker 与官方 Tag 指向 `OFFICIAL_COMMIT`。`main`、`dev`、marker 使用各自 ref-scoped force lease；sync 使用普通 refspec及其 exact lease，且不得省略 ancestry guard。任一 lease 漂移、冲突或失败都 fail closed；禁止无 lease force、blanket force 和拆分推送。
13. push 成功后、Release API 前，用旧 OID compare-and-swap 对齐本地 main / upstream-release；dev 已是候选 checkout，不重写到其他内容；fetch 核对。Release 失败也保持 branch 收敛。
14. 创建或核对同名 GitHub Release：ben.N 为正式修订，非 prerelease 非 draft；标题等于 Tag；中文 Notes 含官方基线、修改点、验证、已知缺口、commit。默认仅 source archive。后验查询元数据；不合格只幂等修正。失败保留 Tag，任务标未完成，下次只收敛 Release。
15. 终验：发布瞬间本地/远端 `main`、`dev`、`sync/vX.Y.Z` 与 Fork Tag peeled commit 全部等于 `RELEASE_COMMIT`；Fork Tag 为 annotated；`upstream-release` 等于 `OFFICIAL_COMMIT`；官方基线 Tag 在 origin；Release 公开指向 Fork Tag。发布后 `dev` 可以继续领先 `main`，后续自动化不得把 advanced dev 重置回该旧 `RELEASE_COMMIT`。报告官方 Tag、修改点、冲突摘要、双审结论、验证、commit、push、Release URL 与残余风险。

## 通用约束

- 普通 Fork 功能提交新增/删除/替换/实质改变 FORK_CHANGES.md 能力时，同步中文更新文档。
- origin 为 Trendymen/opencodex，upstream 为 lidge-jun/opencodex。不创建 GitHub App、Secrets、PR 或 Issue；保留完整上游历史与原始 SHA。
- 官方基线证据用本地 upstream remote Tag 与 origin/upstream-release marker 证明。
- CI 因 origin clone 缺官方基线 Tag 失败时，登记为需用户决策事项并停止，不自行镜像、不改测试断言、不放宽门禁。
