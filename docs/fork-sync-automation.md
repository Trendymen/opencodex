# OpenCodex Fork 上游同步自动化规则

本文档是 Trendymen/opencodex Fork 每小时上游稳定版同步自动化的完整规则真源。自动化任务的消息文本是本文档的精简索引；两者冲突时以本文档为准。

## 分支职责

- `main` 只表示最新已发布的 Fork Release：必须指向最新 Fork Tag 的 peeled commit，不承载未发布开发。
- `dev` 是自由开发线，也是上游稳定版同步、rebase、验证、双审与 Fork Release 的唯一候选线。它可以在最新 Fork Release 之上继续开发，也可以为发布收敛、压缩并在有明确 lease 的前提下强制更新远端。
- 每个官方基线只保留一个 `sync/vX.Y.Z` Release 指针。它不是 rebase 工作线；每次该基线的 `ben.N` 发布都用一次 `git push --atomic` 同时更新 `main`、`dev`、`sync/vX.Y.Z`、`upstream-release`、Fork Tag 和官方 Tag，其中允许用该 sync ref 的精确 expected-OID lease 强制更新到新的 `RELEASE_COMMIT`。禁止创建 `sync/vX.Y.Z-ben.N`，也禁止无 lease force、删除 sync ref 或把 sync 的可移动性扩展到任何 Tag。

## 目标与候选资格

- 每小时检查上游 lidge-jun/opencodex 是否发布了比 upstream-release 更新的稳定 GitHub Release。
- 只接受非 draft、非 prerelease 的正式 Release；忽略 preview、beta、rc、draft 和仅有 Tag 的版本。
- 候选官方 Tag 必须指向可从上游默认分支 main 到达的 commit。
- 用户要求对新官方稳定 Release 执行 rebase 时，默认同时授权并要求完成本文第 1–15 步的完整发布闭环；不得自行缩窄为只在本地 rebase、验证或建 Tag。只有用户明确要求暂停、中止或限定到某个中间门禁时，才停在该边界。

## 分支拓扑

- `dev` 是 Fork 的主开发/集成/推送分支：日常功能提交默认落在 dev 并推送 origin/dev；任务级 changed 模式测试以 `origin/dev` 为比较基准（`bun scripts/test.ts --changed=origin/dev`）。
- `main` 只承载最新已发布 Release：发布闭环时以显式 expected-SHA `--force-with-lease` 强制更新到该 Release 的末尾文档 commit，仅作最新 Release 指针；不承载日常开发提交，不作为日常工作或 PR 的基础分支。
- `RELEASE_SYNC_REF` 对同一官方基线始终固定为 `refs/heads/sync/vX.Y.Z`，不随 Fork revision 改名。首次发布可用 expected-absent lease 创建；后续 `ben.N` 用发布前固定的精确 expected-OID lease 强制更新。`upstream-release` 仍指向 `OFFICIAL_COMMIT`。
- 发布瞬间，当前已验证的 `dev` 候选与 `main`、本轮 `RELEASE_SYNC_REF`、Fork Tag 原子收敛到同一 `RELEASE_COMMIT`。发布后若 `dev` 已产生新开发提交，自动化不得把它重置回旧 Release。
- 发布终验必须证明本地/远端 `main`、`dev`、`RELEASE_SYNC_REF` 与 Fork Tag peeled commit 全部等于 `RELEASE_COMMIT`，且不存在本基线的 revision-specific sync ref。

## 提交术语与唯一原子集合

- `IMPLEMENTATION_HEAD`：包含全部生产代码、测试、脚本、GUI 与 package 版本改动的最终实现提交。
- `RELEASE_COMMIT`：父提交等于 `IMPLEMENTATION_HEAD`、且只修改 `FORK_CHANGES.md` 的末尾文档提交。
- `OFFICIAL_COMMIT`：固定官方稳定 Tag 的 peeled commit。

实现、rebase 与验证在本地 `dev` 上进行，允许它随提交推进；此阶段不移动本地 `main`、既有 sync ref、`upstream-release`、任何 Tag 或远端发布引用。压缩任务的单独 `dev` candidate push 按下文专用规则执行。发布动作使用下列唯一完整 refset：

<!-- official-atomic-refset:start -->
branch|main|leased-force|RELEASE_COMMIT:refs/heads/main
branch|dev|leased-force|RELEASE_COMMIT:refs/heads/dev
branch|sync|leased-force|RELEASE_COMMIT:refs/heads/sync/vX.Y.Z
branch|marker|leased-force|OFFICIAL_COMMIT:refs/heads/upstream-release
tag|official|no-force-no-lease|refs/tags/vX.Y.Z:refs/tags/vX.Y.Z
tag|fork|no-force-no-lease|refs/tags/vX.Y.Z-ben.N:refs/tags/vX.Y.Z-ben.N
<!-- official-atomic-refset:end -->

<!-- fork-release-lifecycle:start -->
rebase_branch=dev
rebase_request=full_steps_1_to_15_unless_user_explicitly_stops
sync_role=single-mutable-release-pointer-per-official-baseline
release_instant_dev=must-equal-RELEASE_COMMIT
post_release_advanced_dev=must-not-reset
sync_update=exact-oid-leased-force-to-RELEASE_COMMIT
final_convergence=local-remote-main-dev-RELEASE_SYNC_REF-fork-tag-equal-RELEASE_COMMIT
<!-- fork-release-lifecycle:end -->

<!-- sync-audit-ref-policy:start -->
ref_scope=single-mutable-ref-per-official-baseline
release_sync_ref=refs/heads/sync/vX.Y.Z
revision_specific_ref=forbidden
initial_creation=expected-absent-lease
existing_update=exact-oid-leased-force-allowed
ancestry_requirement=none
release_instant=main-dev-RELEASE_SYNC_REF-fork-tag-equal-RELEASE_COMMIT
<!-- sync-audit-ref-policy:end -->

<!-- same-base-ben-preflight:start -->
scope=strict-local-and-remote-vX.Y.Z-ben.N
snapshot=name-raw-peeled
pre_local_tag=freeze-local-baseline-and-remote-baseline
pre_push=local-baseline-plus-exact-target-and-remote-baseline
post_push=remote-baseline-or-remote-baseline-plus-exact-target
higher_revision=fail-closed-at-every-checkpoint
other_drift=fail-closed
post_success=required-before-github-release
serialization=single-publisher-required
toctou=final-recheck-to-push-window-is-residual-risk
<!-- same-base-ben-preflight:end -->

<!-- local-ref-cas-transaction:start -->
transport=git-update-ref-stdin
transaction=start-prepare-commit
main_update=refs/heads/main RELEASE_COMMIT EXPECTED_OLD_LOCAL_MAIN
sync_update=refs/heads/sync/vX.Y.Z RELEASE_COMMIT EXPECTED_OLD_LOCAL_SYNC
marker_update=refs/heads/upstream-release OFFICIAL_COMMIT EXPECTED_OLD_LOCAL_MARKER
atomicity=all-or-none
sequential_updates=forbidden
<!-- local-ref-cas-transaction:end -->

<!-- fork-squash-release-policy:start -->
target_count=task-fixed-N-ge-2
task_inputs=OFFICIAL_COMMIT,INITIAL_SOURCE_HEAD,INITIAL_SOURCE_TREE,SQUASH_TARGET_COUNT
content_snapshot=append-only-SK-source-tree-manifests-C1-through-CN-minus-1
push_attempt=append-only-AJ-content-snapshot-CN-candidate-push-ci
final_commit=CN-docs-only-FORK_CHANGES-parent-CN-minus-1
same_tree_retry=amend-CN-attempt-marker-no-N-plus-1
material_fix=fold-into-owner-and-rebuild-all-successors-new-SK-AJ
candidate_push=dev-exact-oid-force-with-lease
candidate_ci=exact-push-dev-head-sha-completed-success-aggregate-ci
workflow_security_review=pre-candidate-push-content-snapshot-ci-yml-blob-pass
regular_reviews=post-candidate-ci-final-CN-sha-pass
pre_release_ci=exact-dev-candidate-and-main-ci-success-same-CN-sha
tagged_failure=immutable-tag-consumed-revision-release-blocked
external_evidence=task-and-release-notes-not-candidate-tree
<!-- fork-squash-release-policy:end -->

压缩发布任务开始后固定 `SQUASH_TARGET_COUNT=N`（`N>=2`）。CI 或审查失败时，只有同 tree
重试才 amend `C_N` 的候选尝试标记；实质修复必须折回所属提交并重建全部后继，任何阶段都
不得追加 `C_(N+1)`。candidate push 仅用精确 expected-OID lease 更新 `dev`；Tag、promotion
和 GitHub Release 只能绑定最终 `C_N`。Tag 已存在而 Release 缺失时，仍须重新证明同一 peeled SHA 的成功 candidate CI 和 main CI，不得复用旧 SHA 或较早 run。

远端 atomic push 成功后的本地引用收敛必须等价于下列单事务输入；三个 `update` 都携带
发布前捕获的 expected-old OID，任一比较失败时 `prepare`/`commit` 不得让其他 ref
单独生效：

```text
start
update refs/heads/main RELEASE_COMMIT EXPECTED_OLD_LOCAL_MAIN
update refs/heads/sync/vX.Y.Z RELEASE_COMMIT EXPECTED_OLD_LOCAL_SYNC
update refs/heads/upstream-release OFFICIAL_COMMIT EXPECTED_OLD_LOCAL_MARKER
prepare
commit
```

四个 branch 使用各自精确 expected-SHA lease；`main`、`dev`、`RELEASE_SYNC_REF` 与 marker 都允许按发布策略 force。`RELEASE_SYNC_REF` 始终是 `refs/heads/sync/vX.Y.Z`：首次不存在时使用 expected-absent lease，已存在时紧邻 push 重新读取并使用精确 expected-OID lease；允许 non-fast-forward，不要求 ancestry。实际 sync refspec 使用 `+RELEASE_COMMIT:refs/heads/sync/vX.Y.Z`。两个 Tag 都不 force、不使用 lease。任何 mismatch、revision-specific sync ref、atomic 不支持或不确定失败都 fail closed，禁止拆分推送。

同基线维护发布还必须枚举本地与 origin 远端完整的 `refs/tags/vX.Y.Z-ben.*` 名称空间，
仅按与 `X.Y.Z-ben.N` 解析器等价的严格规则接受有效 revision，并将每个 Tag 冻结为名称、raw
OID 与 peeled OID 的映射。阶段迁移必须精确：创建本地目标 Tag 前冻结 `LOCAL_BASELINE` 与
`REMOTE_BASELINE`；atomic push 紧邻前，本地只能等于 baseline 或 baseline 加精确 annotated
目标 Tag（raw 等于本地捕获的 Tag object、peeled 等于 `RELEASE_COMMIT`），远端必须仍精确
等于 `REMOTE_BASELINE`；确定成功或不确定结果后，本地保持不变，远端只能等于 baseline 或
baseline 加同一个精确目标对象。每个阶段都重新计算最高有效 revision；任何其他新增、删除、
替换、对象身份变化或更高 revision 都 fail closed。确定成功也必须在创建 GitHub Release 前
完成 post-push 全集合复核；若 TOCTOU 窗口出现更高 revision，保留已发布 immutable Tag，停止
Release 并报告竞态，不自动删除或移动 Tag。发布期间只允许一个 publisher。Git 无法对尚未
存在的更高 Tag 名称空间建立 lease，因此最终复核到 push 之间仍有不可完全消除的 TOCTOU
窗口，必须作为残余风险报告，不能以较早的本地测试快照替代最终远端复核。

sync 的 force 权限只来自当前发布动作，并且必须 ref-scoped：远端已存在时，atomic push 紧邻前重新读取 `refs/heads/sync/vX.Y.Z`，确认仍等于 `EXPECTED_REMOTE_RELEASE_SYNC`，再使用精确 expected-OID lease；首次不存在时重证 absent 并使用 expected-absent lease。禁止 ancestry/fast-forward 门禁覆盖用户允许的维护版强推，也禁止用 blanket `--force` 或跨 ref lease 替代该 CAS。

## 通知策略

- 无新官方稳定 Release、当前派生闭环、无失败或未决事项：按 DONT_NOTIFY 安静结束。
- 发现并完成新官方稳定 Release 同步（rebase、push、Release 任一实质进展或闭环）、发生失败、阻塞或需要用户决策的未决事项：NOTIFY，简体中文摘要（官方 Tag、Fork 版本/Tag、Release URL 或阻塞原因）。

## 最高优先级前置检查

1. 本会话存在需要用户重大决策的未决事项时，停止新的同步、rebase、Tag、Release 和 push，提醒用户先处理；不得绕过或猜测。
2. 要求工作树、索引干净且没有进行中的 Git 操作；存在其他未提交工作时 fail closed，不得 stash、覆盖或混入同步提交。
3. `main` 本地/远端必须一致，且只作为已发布 Release 指针校验。不要因 `dev` 有已提交开发内容或领先 `main` 而停止同步；`dev` 正是本流程的发布候选来源。

## 维护真源

FORK_CHANGES.md 是当前 Fork 已提交能力及相对官方覆盖状态的维护真源。每次任务先读取它，以实际提交代码、测试和真实验收为能力基准，不以旧 Spec、Plan、devlog 或安装包残留为准。文档、任务状态、Tag 注释与 GitHub Release Notes 必须使用简体中文；代码符号、路径、命令、Provider/模型 ID 和版本号保持原样。

`FORK_CHANGES.md` 按能力组织，只保留一处当前已 rebase 的官方 Tag/SHA、现存差异、代码与测试入口、必要的覆盖/移除结论和已知边界。rebase 后原地更新，不追加版本章节，也不保存逐次候选 SHA、shortstat、测试计数、冲突账本或发布状态。包版本读取 `package.json`；目标 Tag、实现/发布 SHA、验证、冲突和审查证据保存在本轮 review package 与任务记录，发布结果写入对应 Release Notes。旧记录从 Git 历史查阅，本文保留完整同步与发布规则，能力清单只引用本文。

## 跟随官方门禁

- 新官方稳定 Tag 的 `AGENTS.md`、目录级 `AGENTS.md`、package scripts、测试布局和 CI 拓扑是本轮默认基线。Fork 只保留有当前能力证据支持的差异。
- Fork 测试只固定 Fork 新增语义，不固定官方自行维护的 job 名、shard 数、timeout、目录旧路径或实现细节；官方门禁改变时，先采用官方合同，再补最小 Fork 断言。
- 同一行为已由当前官方源码与测试完整覆盖时，删除重复 Fork 实现或测试，并在 `FORK_CHANGES.md` 留下证据。不能为了让旧 Fork 测试继续通过而恢复已经过时的官方结构。
- 验证命令失败时，先在 `NEW_OFFICIAL` 的干净临时工作区运行同一命令。官方基线同样失败且不影响本轮 Fork 修改路径或发布产物时，记录为 upstream-baseline residual risk，不算 Fork 回归；不能借此忽略只在 Fork 候选出现的失败，也不能改弱断言。
- 测试文件使用官方 `tests/<domain>/` 布局；当前命令和维护文档更新真实路径，已经结束的历史 Spec/Plan 不做纯路径批量改写。

### 验证选择与结果复用

- 实现和冲突修复期间只跑相关定向测试；跨模块时用 `bun scripts/test.ts --changed=origin/dev`，并记录该次 `origin/dev` 的完整 SHA。若远端已经包含候选而使 changed 集合失去覆盖意义，直接指定受影响的测试文件；不能把空集合当作验证通过。源码读取、子进程、fixture 等间接依赖需显式补测。
- 新官方基线完成适配后，对最终实现运行一次当前官方 `prepush`；它已包含的 typecheck、全量测试、privacy scan 等不再逐项重复执行。GUI 或文档站构建按本轮实际影响和官方规则补充。保持官方 runner 的默认并发，不以降并发、加 timeout 或删除断言替代通过。
- 同一实现、依赖、测试输入、runner 和环境未变时，复用已通过的检查，不因进入双审、补附件或整理日志重跑。只改说明文字时，先证明其不是测试/构建输入；若文档被源码真值测试读取，重跑对应测试；若影响文档站则构建文档站。更新后的文本仍需 privacy scan 和 `git diff --check`。
- 生产代码、依赖、测试或构建/runner 的实质变化仍须在最终实现上完成适用的完整门禁。修复期间先跑定向检查，修复收敛后再跑全量；不要每修一条 finding 就重复全量。这里的“完整验证”指本节适用检查，不要求未受影响的 GUI/docs 构建重复运行。
- 验证记录保留命令、工作目录、实际执行 SHA、退出码和日志。复用时列出旧 SHA 到当前 SHA 的差异及未受影响依据，不把旧日志改标成新 SHA 的执行结果。需要 exact-SHA CI 的发布任务仍按原要求检查最终 SHA；本地验证复用不豁免 CI 或未关闭 finding。

## 官方 Tag 保留规则

每个官方稳定基线 Tag（vX.Y.Z，非 preview/beta/rc/draft）必须同时保留在本地与 origin 远端：

- 每次新官方基线同步完成时，在该次 atomic push 中一并推送官方 Tag ref（refs/tags/vX.Y.Z:refs/tags/vX.Y.Z，不加 +、不 force）。
- 发现远端缺失历史官方 Tag 时，用一次普通（非 force）push 补齐并报告。
- 禁止删除或改写任何官方 Tag 与 Fork Tag。

## 双审门禁

完成 rebase、冲突处理与最终验证之后，必须先通过双审并修复到通过，才允许 Tag、push 和 Release：

- 按用户级 requesting-code-review 规则派发两个独立 reviewer（SPEC_COMPLIANCE 与 CODE_QUALITY），以 fork_turns "none" 派发。
- 审查包只包含当前任务 brief、官方旧/新 Tag SHA、scoped diff（相对新官方 Tag 的完整 Fork 修改面）、冲突处理说明与验证证据；不得携带主会话历史。
- 任一 Critical/Important finding 阻塞推送与发布：修复后按“验证选择与结果复用”完成适用检查，用当前实现 SHA 更新 FORK_CHANGES.md 并重建末尾文档提交，再以 REVIEW_PHASE RE_REVIEW 携带完整 PRIOR_FINDINGS、FIX_DIFF 与真实 VERIFICATION_EVIDENCE 复用原 reviewer 复审。
- 两个 reviewer 的固定 verdict 均为 `PASS`，且无未决 Critical/Important finding 后，才进入 Tag / push / Release；正式 verdict 只使用 `PASS` / `FAIL`。
- 无双审通过证据时执行 push 或 Release 视为违规，必须回滚未发布状态并登记失败。

## Rebase 冲突证据包与审查粒度

本节适用于本文档本次强化之后启动的每一次官方稳定版 rebase。已经完成且不可变的历史
Release 不要求倒推重写旧账本。新同步必须在对应阶段捕获下列 SHA。任务级 rebase 输入一经
捕获便永久固定；实现与末尾文档输出则按审查轮次追加固定快照，不得覆盖旧轮次：

- `OLD_OFFICIAL`：rebase 前 `upstream-release` 指向的官方 peeled commit。
- `NEW_OFFICIAL`：目标官方稳定 Tag 的 peeled commit。
- `PRE_REBASE_DEV`：执行 rebase 前已提交、已确认来源的 `dev` 候选。
- `POST_REBASE_HEAD`：rebase 完成且所有冲突解决后、任何 rebase 后修复开始前的 `dev` commit。
- `IMPLEMENTATION_HEAD_RN`：审查轮次 `RN` 的全部实现与测试修复 commit。
- `RELEASE_COMMIT_RN`：父提交等于同轮 `IMPLEMENTATION_HEAD_RN`、且只修改
  `FORK_CHANGES.md` 的末尾文档 commit。

验证完成前使用独立的候选尝试 `AK`，`K` 为从 1 开始的正整数；验证失败的 `AK` 只记录为
abandoned task evidence，不得占用 `RN`，也不写入 `PRIOR_FINDINGS`。只有最终验证通过且
`IMPLEMENTATION_HEAD` / `RELEASE_COMMIT` 完整 SHA 对已经存在时，才分配审查轮次 `RN`。
`N` 为从 1 开始的正整数，与 reviewer phase 分开：第一次真正派发 reviewer 之前，无论出现过
多少 `AK`，均使用 `REVIEW_PHASE: INITIAL`；只有收到过该 reviewer 的 verdict 后产生的新完整
`RN` 才使用 `REVIEW_PHASE: RE_REVIEW`。已审旧轮 SHA 永久保留在 `PRIOR_FINDINGS` 与审查记录中，
最新一轮必须重新绑定完整验证和三层 diff。正文其他位置未带 `_RN` 的
`IMPLEMENTATION_HEAD` / `RELEASE_COMMIT`，均指当前最新轮次的别名，不允许借此覆盖历史值。

审查包必须同时包含以下机器契约，不得用一段总括性“双方保留”描述代替：

<!-- rebase-review-package:start -->
fixed_shas=task:OLD_OFFICIAL,NEW_OFFICIAL,PRE_REBASE_DEV,POST_REBASE_HEAD;round:IMPLEMENTATION_HEAD_RN,RELEASE_COMMIT_RN
path_sets=OFFICIAL_CHANGED_PATHS,OLD_FORK_NET_PATHS,OLD_FORK_TOUCHED_PATHS,NET_OVERLAP_PATHS,OVERLAP_PATHS,CONTENT_CONFLICTS,NON_OVERLAP_CONFLICTS,AUTO_MERGES
conflict_ledger=one-entry-per-content-conflict-path
conflict_fields=path,symbols,official_change,fork_change,resolution,official_coverage,conflict_snapshots,focused_tests,residual_risk
risk_fields=on-specific-reviewer-evidence-request-only:downstream_consumers,failure_paths,state_edges,ordering_edges,risk_domains
full_fork_diff=FULL_FORK_DIFF:git-diff-NEW_OFFICIAL-to-RELEASE_COMMIT_RN
rebase_resolution_diff=REBASE_RESOLUTION_DIFF:git-range-diff-OLD_OFFICIAL..PRE_REBASE_DEV-to-NEW_OFFICIAL..POST_REBASE_HEAD
post_rebase_fix_diff=POST_REBASE_FIX_DIFF:git-diff-POST_REBASE_HEAD-to-IMPLEMENTATION_HEAD_RN
spec_recomputation=required-independent-for-endpoint-and-touched-sets
conflict_reconciliation=captured-stop-union-plus-conditional-shadow-replay
review_rounds=append-only-latest-round-binds-review
review_verdicts=PASS,FAIL
quality_named_risks=required
<!-- rebase-review-package:end -->

### 逐冲突证据账本

每个进入过 unresolved 状态的内容冲突路径都必须在本轮 review package 中有一条记录，
并由任务记录保留其证据入口。核心字段顺序固定如下；任何字段都不得为空，确实不适用时写
`n/a:<原因>`，不得只写 `n/a`：

```text
path=<仓库相对路径>
symbols=<涉及符号、配置键、workflow job 或文档章节>
official_change=<新官方相对旧官方改变了什么语义>
fork_change=<旧 Fork 相对旧官方保留了什么能力>
resolution=<最终 union、替换或删除的精确决定>
official_coverage=<官方是否完整覆盖 Fork；证据路径、符号与测试>
conflict_snapshots=<覆盖该记录的 rebase step、REBASE_HEAD 与 hunk_id>
focused_tests=<本轮实际执行且直接覆盖该决定的测试>
residual_risk=<尚未验证的真实边界；没有则写 none:<理由>>
```

上述核心字段保存在 review package，`FORK_CHANGES.md` 只更新冲突处理后的能力差异与必要的覆盖结论。五项补充字段
`downstream_consumers`、`failure_paths`、`state_edges`、`ordering_edges` 与 `risk_domains` 只在 reviewer
针对具体链路要求补证时写入 review package；不写入 `FORK_CHANGES.md`。纯文档、测试路径迁移和没有
运行时消费者的维护配置不需要补模板字段。

同一路径有多个互不相干的冲突符号时可以拆成多条，但至少一条记录必须覆盖该路径。仅列
文件名、只描述冲突文本、只写“采用 ours/theirs”或只附一次 HTTP 200 均不合格。删除 Fork
行为时，`official_coverage` 必须同时给出当前官方源码、当前官方测试和最终消费者证据；证据
不足就保留能力或请求用户决定。

### SHA 独立机械重算

`SPEC_COMPLIANCE` reviewer 必须从任务级固定 SHA 在自己的审查回合中独立计算官方变更、
旧 Fork 端点净差异、旧 Fork 逐 commit 触及路径以及两种 overlap，不能信任
`FORK_CHANGES.md`、review package 或测试文件里复制的计数和数组。路径计算统一关闭 rename
侦测，并用 `LC_ALL=C` 排序去重。实现方应在 `.tmp/` 或 `mktemp -d` scratch 中生成下列文件，
不得把临时集合写到仓库顶层；等价命令如下：

```bash
git diff --name-only --no-renames "$OLD_OFFICIAL" "$NEW_OFFICIAL" | LC_ALL=C sort -u > OFFICIAL_CHANGED_PATHS
git diff --name-only --no-renames "$OLD_OFFICIAL" "$PRE_REBASE_DEV" | LC_ALL=C sort -u > OLD_FORK_NET_PATHS
git log --format= --name-only --no-renames --no-merges "$OLD_OFFICIAL..$PRE_REBASE_DEV" | sed '/^$/d' | LC_ALL=C sort -u > OLD_FORK_TOUCHED_PATHS
LC_ALL=C comm -12 OFFICIAL_CHANGED_PATHS OLD_FORK_NET_PATHS > NET_OVERLAP_PATHS
LC_ALL=C comm -12 OFFICIAL_CHANGED_PATHS OLD_FORK_TOUCHED_PATHS > OVERLAP_PATHS
LC_ALL=C sort -u CAPTURED_REBASE_CONFLICT_PATHS > CONTENT_CONFLICTS
LC_ALL=C comm -23 CONTENT_CONFLICTS OVERLAP_PATHS > NON_OVERLAP_CONFLICTS
LC_ALL=C comm -23 OVERLAP_PATHS CONTENT_CONFLICTS > AUTO_MERGES
```

端点净差异不能证明逐 commit rebase 的完整冲突集：早期修改可能在后续 commit 中被恢复，
rename/modify 也可能使用不同路径名。因此 `CONTENT_CONFLICTS` 的真值来自每次 rebase stop 的
stage snapshot，不得仅凭 `OVERLAP_PATHS` 推导，也不得为了满足子集关系删除真实冲突。
`NON_OVERLAP_CONFLICTS` 可以非空，但每一项都要在 ledger 说明中间 commit 或 rename 原因。
固定 SHA 不可读取、snapshot 缺失、count 不是从集合计算、账本漏项，或触发 shadow replay 后
主/影证据不一致时，正式 verdict 必须为 `SPEC_COMPLIANCE: FAIL`。

<!-- mechanical-recomputation:start -->
official_changed_paths=git-diff-name-only-no-renames-OLD_OFFICIAL-to-NEW_OFFICIAL
old_fork_net_paths=git-diff-name-only-no-renames-OLD_OFFICIAL-to-PRE_REBASE_DEV
old_fork_touched_paths=union-of-per-nonmerge-commit-no-renames-paths
net_overlap_paths=OFFICIAL_CHANGED_PATHS-intersect-OLD_FORK_NET_PATHS
overlap_paths=OFFICIAL_CHANGED_PATHS-intersect-OLD_FORK_TOUCHED_PATHS
content_conflicts=captured-union-from-all-rebase-stops
non_overlap_conflicts=CONTENT_CONFLICTS-minus-OVERLAP_PATHS-retained-and-explained
auto_merges=OVERLAP_PATHS-minus-CONTENT_CONFLICTS
counts=derived-from-recomputed-sets
copied_constants=forbidden
verdict=SPEC_COMPLIANCE:FAIL-on-missing-or-mismatch
<!-- mechanical-recomputation:end -->

### 冲突 stop 与条件式 shadow replay

主 rebase 开始前固定 replay 输入：Git version、原始与有效 rebase invocation、会影响
commit 选择/merge/rename/换行的 config 及来源、两端 `.gitattributes` 和有效 merge driver。可以记录
replay manifest 摘要 hash 方便比对，但它不是发布门禁；固定输入、每个 stop 的 stage/hunk/action/tree
证据可复算即可。
主流程显式设置 `rerere.enabled=false`、`rerere.autoupdate=false`，不得读取既有 `rr-cache`；
非确定性 external merge driver 阻塞同步。

每次 rebase 停在 unresolved 状态时，必须在继续之前捕获 rebase step、`REBASE_HEAD`、
`git diff --name-only --diff-filter=U`、`git ls-files -u` 的 stage 1/2/3 mode+blob，以及禁用 color 和
external diff 后的逐路径 combined diff。每个 `@@@` hunk 只把 CRLF 规范成 LF，再以 rebase
step、`REBASE_HEAD`、path、stage mode+blobs 和规范化 hunk bytes 共同计算 SHA-256；同一 hunk 只有
完整 `hunk_id` 相同才去重。
冲突解决并 `git add` 后，再记录每条路径的 stage 0 mode+blob（删除记录为 `deleted`），以及
`git write-tree` 得到的完整 resolved index tree；后者必须包含该 stop 在 continue 前所有 staged
路径，包括原本未处于 U 状态但作为语义配套修复暂存的路径。随后记录 `resolution_action`：
`continue-created-commit`、`skip-empty`，或仅在原始 invocation 明确启用保留空提交时使用
`continue-kept-empty`。动作后记录 `REBASE_HEAD -> replayed commit | dropped:<原因>` 映射和
post-action `HEAD^{tree}`；`skip-empty` 不得伪造 replayed commit。

下列任一情况才必须在最终 review 前执行隔离 shadow replay：候选来源或 commit 序列不能从固定
SHA 唯一证明；使用 `--rebase-merges`、merge commit、custom/external merge driver；主流程可能
读取过 rerere；任一 stop 的 stage、hunk、resolved tree 或 action 证据不完整；需要同时压缩或
重排提交；机械集合出现不一致；reviewer 根据具体证据要求复核。普通线性、来源明确且逐 stop
证据完整的 rebase 不重复重放。

触发时，在 `mktemp -d` 的隔离临时 clone 中按 manifest 从相同固定 SHA 重放同一 commit 序列，
显式禁用 rerere。每个 shadow stop 独立捕获路径、stage mode+blob 与 hunk，再恢复主流程记录的
resolved index tree 并执行同一 `resolution_action`。动作序列、commit/dropped 映射、每个生成
commit 的 tree、post-action tree、最终 tree，以及主/影 stop、路径、`hunk_id` 并集必须一致，
否则 fail closed。未触发时，review package 写明未触发的逐项依据，reviewer 只核对固定 SHA、
主流程 stop 证据和最终 scoped diff。

<!-- conflict-snapshot-contract:start -->
per_stop=rebase-step,REBASE_HEAD,resolution-action,resolved-index-tree,post-action-HEAD-tree
per_path=path,stage1-mode-blob,stage2-mode-blob,stage3-mode-blob,combined-diff,stage0-mode-blob-or-deleted
resolution_action=continue-created-commit,skip-empty,continue-kept-empty
commit_mapping=REBASE_HEAD-to-replayed-commit-or-dropped-with-reason
hunk_id=sha256-rebase-step-REBASE_HEAD-path-stage-mode-blobs-normalized-hunk
hunk_dedupe=exact-hunk-id-only
captured_union=all-unresolved-paths-from-all-stops
replay_environment=pre-rebase-git-version-invocation-config-attributes-and-rerere-disabled
replay_manifest_digest=optional-summary-not-release-gate
shadow_trigger=ambiguous-source-or-nonlinear-history-or-custom-driver-or-rerere-or-incomplete-evidence-or-history-rewrite-or-mechanical-mismatch-or-reviewer-request
shadow_clone=created-only-when-triggered-and-preserves-PRE_REBASE_DEV
object_access=shared-source-objects-cat-file-verified-before-replay
shadow_replay=conditional-isolated-temp-clone-fixed-task-shas-recorded-resolutions
shadow_match=actions-mappings-stops-paths-hunk-ids-produced-trees-and-final-tree-must-equal-before-review
mismatch_verdict=SPEC_COMPLIANCE:FAIL
<!-- conflict-snapshot-contract:end -->

### 审查轮次 SHA 生命周期

任务级输入与 rebase 完成点跨所有尝试和轮次不变。预审准备从 `A1` 开始；验证促成实现变化
时，将当前 `AK` 标记为 abandoned 并以最大 `K + 1` 重做，不产生半个 `RN`。验证通过、同一
实现 SHA 的末尾文档 commit 创建后，才把该完整 SHA 对晋升为审查轮次：尚无轮次时创建 `R1`；
已有 reviewed round 时使用当前最大 `N + 1`，绝不复用已有轮次号。任何 review finding 促成的
生产代码、测试、脚本、GUI、package 或末尾文档变化都从新 `AK` 开始，形成下一完整 `RN` 后
重新生成三层 diff 与验证。复审包必须引用最新轮，并在 `PRIOR_FINDINGS` 只保留已经收到 verdict
的旧轮 finding、完整 SHA 对与处置；不得把 abandoned attempt 写成 prior finding。

<!-- review-round-lifecycle:start -->
task_immutable=OLD_OFFICIAL,NEW_OFFICIAL,PRE_REBASE_DEV,POST_REBASE_HEAD
attempt_id=A-positive-integer-before-completed-round
attempt_state=abandoned-on-implementation-change-or-promoted-after-verification
round_assignment=only-after-IMPLEMENTATION_HEAD-and-RELEASE_COMMIT-pair-exists
round_id=R-positive-integer-append-only
review_phase=INITIAL-before-first-dispatch;RE_REVIEW-after-prior-verdict
round_outputs=IMPLEMENTATION_HEAD_RN,RELEASE_COMMIT_RN
round_immutability=append-only-never-overwrite
latest_binding=all-diffs-verification-review-package-use-latest-round
prior_binding=reviewed-rounds-only-retained-in-PRIOR_FINDINGS
implementation_change=requires-new-round-and-full-verification
<!-- review-round-lifecycle:end -->

### 三层 diff

两个默认 reviewer 都必须拿到三份彼此独立、由固定 SHA 生成的材料：

1. `FULL_FORK_DIFF`：`git diff --find-renames "$NEW_OFFICIAL" "$RELEASE_COMMIT_RN"`，覆盖相对新官方
   Tag 的全部 Fork 修改面，不能只给冲突文件或本轮 repair diff。
2. `REBASE_RESOLUTION_DIFF`：
   `git range-diff "$OLD_OFFICIAL..$PRE_REBASE_DEV" "$NEW_OFFICIAL..$POST_REBASE_HEAD"`，并为每个
   `CONTENT_CONFLICTS` 路径附 `git diff "$NEW_OFFICIAL" "$POST_REBASE_HEAD" -- <path>`；它用于
   区分旧 Fork commit 被如何重放、冲突决定落在何处。
3. `POST_REBASE_FIX_DIFF`：`git diff "$POST_REBASE_HEAD" "$IMPLEMENTATION_HEAD_RN"`，只显示 rebase
   完成后由验证或 review 促成的修复。若两 SHA 相等，也必须附命令、两端 SHA 和空 diff 结果，
   不得省略该层。

所有 diff 都必须标明生成命令和端点完整 SHA；过大时可按文件分片，但不得截断或只提供
shortstat。reviewer 可自行读取固定 commit 中的文件和运行只读命令，不得依赖主会话口述。

完整 Fork diff 用于核对能力和定位上下文，不表示每次 rebase 都重新审计全部历史功能。
本轮深审范围是冲突决定、官方与 Fork 的交叠改动、rebase 后修复，以及这些改动实际影响的
消费者和失败路径。finding 必须说明是本轮引入、因官方改动暴露，还是与本轮无关的既有问题，
并给出差异或调用链依据。无关既有问题单列，不自动混入同步修复；明确影响本次发布安全、
数据完整性或能力可用性的问题仍须停止并处理。复审聚焦原 finding、FIX_DIFF 及受影响链路，
不重新开始无边界扫描；已经捕获的 SHA、集合和冲突附件用原记录引用，无需复制重写。

### CODE_QUALITY 命名风险清单

`CODE_QUALITY` reviewer 按本轮涉及的行为选择下列风险，沿相关冲突符号检查最终消费者与错误路径；
不适用项简述理由，不为纯文档或版本改动构造流式、缓存等检查任务。“测试通过”不能替代相关数据流审查：

<!-- rebase-conflict-named-risks:start -->
final_consumers=secondary-defaulting-and-final-projection
nullish_values=undefined,absent,null,false,empty
failure_paths=abort,retry-exhausted,one-shot,timeout,body-ceiling,resource-release
stream_ordering=sparse,out-of-order,duplicate,terminal,flush,dispose
rebuild_parity=initial-build-versus-rebuild
round_trip=schema,load,POST,PATCH,GET,DTO,persistence,runtime-consumer
capability_reachability=official-and-fork-capabilities-remain-reachable
minimal_official_diff=required-per-file-necessity-and-no-unrelated-change
<!-- rebase-conflict-named-risks:end -->

- 检查中间状态正确但最终 catalog、DTO、序列化或 UI 投影被二次默认化覆盖的情况。
- 分别验证 `undefined`、字段 absent、`null`、`false`、空字符串/数组/对象，不能把它们视为同值。
- 覆盖 abort、retry exhausted、one-shot 恢复、timeout、body ceiling 与所有资源释放/取消路径。
- 对流式代码覆盖稀疏、乱序、重复事件，以及 terminal、flush、dispose 前后的 pending 状态。
- 对缓存、catalog、runtime snapshot 检查首次 build 与 rebuild/refresh 是否一致。
- 对配置字段检查 schema → load → POST/PATCH → GET DTO → persistence → runtime consumer 往返。
- 从公开入口证明官方新增能力和 Fork 保留能力都仍可达，不接受“代码还在”作为可达性证明。
- 按文件列出相对官方的修改必要性；存在更窄扩展点、无关格式化或无关重构时必须提出 finding。

### 高风险升级与 hook 边界

默认就是两个独立 reviewer。敏感路径、shared entrypoint、冲突路径数量和 hunk 数量用于提醒双审
覆盖范围，不自动增加 explorer 或 reviewer。

explorer 可以用于补充数据流、最终消费者和错误路径证据，但不是发布硬门槛，也不下 verdict。只有
`SPEC_COMPLIANCE` 或 `CODE_QUALITY` 明确指出某个跨边界 path、symbol 或消费者链 edge 仍无法收敛，
或者主线程已有同样具体的不确定性，才增加一个独立 `CODE_QUALITY` reviewer。该 reviewer 只审列出的
未收敛链路；不得用泛化第三审重复整份 diff。

<!-- rebase-review-escalation:start -->
default_reviewers=SPEC_COMPLIANCE,CODE_QUALITY
review_priority=paths-hunks-and-symbols-cover-sensitive-and-shared-boundaries
explorer=optional-evidence-only-not-release-gate
annex=on-specific-reviewer-evidence-request-only
narrow_review_trigger=dual-reviewer-unresolved-specific-cross-boundary-path-symbol-or-edge-or-owner-specific-uncertainty
narrow_review_mode=CODE_QUALITY
narrow_review_scope=exact-unresolved-paths-symbols-and-edges-only
generic_reviewer_expansion=forbidden
<!-- rebase-review-escalation:end -->

不自动安装或恢复用户已删除的 `pre-push` hook。若本地安装了 `pre-push` hook，它执行的检查可以作为真实验证证据，
没有 hook 时按“验证选择与结果复用”显式验证；完整测试已覆盖
`tests/ci-workflows/fork-maintenance-truth.test.ts` 且相关输入未变时，不再单独重复执行。
hook 不是发布状态真源，只能证明它实际执行过的静态契约与测试通过，
不能证明双审通过，也不能证明 reviewer 真正完成了 SHA 重算、数据流检查或复审。禁止 hook
自动生成 approval、自动清除 finding、自动移动 ref，自动化也不得用 `--no-verify` 绕过它。

## 幂等收敛（判断新 Release 之前）

从已提交 package.json 推导预期 X.Y.Z-ben.N 和 vX.Y.Z-ben.N，并核对 FORK_CHANGES.md 的当前官方基线与包版本对应：

- 实现、最终验证或末尾文档提交未完成：只恢复当前 ben.N 剩余收尾；不重新 rebase、不递增 revision。工作树不干净、来源不明或证据不足时登记未完成并 fail closed。
- `RELEASE_COMMIT` 完成但 Fork Tag 缺失：验证 package/document 一致、其父提交等于此前捕获的 `IMPLEMENTATION_HEAD`、该提交只含 `FORK_CHANGES.md`，再按 annotated Tag 和一次 `git push --atomic` 同时更新 `main`、`dev`、`sync/vX.Y.Z`、`upstream-release`、Fork Tag 与官方 Tag 的流程补齐；不得生成 ben.(N+1)。
- 远端 push 完成但本地 main / sync / upstream-release 未对齐：严格按 `local-ref-cas-transaction`
  使用一个带 `start` / `prepare` / `commit` 的 `git update-ref --stdin` transaction，同时用
  捕获的三个本地旧 OID 做 compare-and-swap；任一 CAS 失败时三条 ref 都不得更新。sync
  只更新固定的 `refs/heads/sync/vX.Y.Z`，禁止把三条 update 拆成顺序执行的命令。
- Tag 存在但 GitHub Release 缺失或元数据不合格：只创建或幂等修正同名 Release，不移动 Tag、不递增 revision。Release 须满足 tagName 精确、name 等于 Tag、isDraft=false、isPrerelease=false，中文 body 至少含官方基线、Fork 修改点、验证结果、已知缺口与 commit。

`dev` 可以在已发布 `main` 之上有自由的已提交开发内容；这不是 drift。只有候选来源、远端 `dev` 预期 SHA、或其重写权限无法确定时才 fail closed。

上述每个补 Tag、atomic push 重试或不确定结果恢复入口都必须重新执行完整同基线远端 Fork
Tag 集 preflight；发现高于目标 revision 的有效 Tag、集合漂移或 raw/peeled 身份漂移时停止，
不得仅因目标 Tag 本身仍缺失而继续创建较低 revision。

全部闭环且无更新官方稳定 Release 才可记录无需同步。

## 新官方稳定 Release 同步流程

1. fetch 后固定本地/远端 main、dev、upstream-release、`refs/heads/sync/vX.Y.Z` 和目标 Fork Tag 的 raw/peeled SHA；按 `sync-audit-ref-policy` 固定本轮 `RELEASE_SYNC_REF=refs/heads/sync/vX.Y.Z`，并将 `OLD_OFFICIAL`、`NEW_OFFICIAL`、`PRE_REBASE_DEV` 记为任务级不可变输入。本地 main 与 marker 必须和远端一致；dev 的本地/远端状态同时记录为候选证据；发现本基线 `sync/vX.Y.Z-ben.N` 即停止。
2. 保护候选历史：候选固定为已提交的 `dev`。远端 dev 必须 fetch；本地 dev 领先、落后或分叉时均须记录两端 SHA 与来源。只要本地 dev 是当前已知、干净的发布候选，可继续；来源不明、远端独有而无法证明、或 lease 预期无法固定时停止。目标 `RELEASE_SYNC_REF` 已存在时必须 fetch 并记录精确 expected-OID lease；首次不存在时记录 expected-absent lease。sync 不要求是 `RELEASE_COMMIT` 的祖先，允许在发布时 non-fast-forward 强制更新。
3. 启动主 rebase 前按 `conflict-snapshot-contract` 固定 replay 输入，并显式禁用 `rerere`/`rerere.autoupdate`。随后在 `dev` 上执行等价于 `git rebase --onto <new-tag-sha> <old-upstream-release-sha> dev`。每次停住时先捕获完整证据，才允许解决并继续；完成后立即固定 `POST_REBASE_HEAD`，并按条件判断是否需要 shadow replay。rebase 阶段不得移动 main，不得 detached HEAD 验证。完成实现、验证和末尾文档提交后，才能准备本轮 `RELEASE_SYNC_REF` 指向同一 `RELEASE_COMMIT`；不得将 dev 当作只读证据，也不得在任何 sync ref 上 rebase。
4. 冲突处理以 FORK_CHANGES.md、src/fork 边界、AGENTS.local.md、既有测试和新官方实现为依据，并为全部 `CONTENT_CONFLICTS` 写逐冲突 ledger。仅当前官方源码与测试证明等价或更优才可删除 Fork 行为；名称相似、旧文档或单次 HTTP 200 不算证据。部分覆盖只移除被替代部分；语义改变、能力放弃或无法判定时请用户决定。Fork 逻辑优先放窄模块或 src/fork，官方高频文件最小接线。
5. revision：新官方 vX.Y.Z 首次派生固定 X.Y.Z-ben.1 / vX.Y.Z-ben.1。同基线已有 Release 不自动递增；仅用户明确要求才允许 ben.2、ben.3。`ben.N` 按官方基线独立维护：即使完整 Tag 集已有更新官方稳定版，明确授权的旧基线维护修订仍可继续，但必须存在精确官方基线 Tag、不得低于同基线最高有效 ben revision、不得复用或移动既有 Fork Tag，也不得声称包含更新官方版本能力。普通 stable/preview 仍遵守全局单调版本门禁。重复 heartbeat 幂等。
6. 完成并提交全部 rebase、冲突、版本与实现修复。
7. 创建下一个候选尝试 `AK`（首次为 `A1`，否则最大 `K + 1`），捕获 `CANDIDATE_IMPLEMENTATION_HEAD_AK`，不得从后续 HEAD 反推。按该 SHA 原地更新 FORK_CHANGES.md 的当前官方 Tag/SHA、能力差异、代码与测试入口、覆盖/移除结论及已知边界，不追加版本历史。实现 commit、shortstat、包版本、目标 Tag、逐冲突 ledger 和验证证据保存在本轮任务记录，供第 10 步 review package 使用。只保留仍影响维护判断的移除结论，旧 PASS 不沿用。
8. 文档更新后按“验证选择与结果复用”完成最终验证；新基线的最终实现必须有当前官方 prepush 的通过证据。验证促成实现修改时把当前 `AK` 标记为 abandoned，以最大 `K + 1` 回到第 7 步；验证失败的 `AK` 不得占用 `RN`，也不得写入 `PRIOR_FINDINGS`。
9. 验证通过后只暂存 `FORK_CHANGES.md`，核对 staged list 与 diff check，创建 docs-only commit，并机械验证其父提交等于当前 `CANDIDATE_IMPLEMENTATION_HEAD_AK`。此时才将完整 SHA 对晋升为下一个审查轮次：尚无轮次时创建 `R1`；已有 reviewed round 时使用当前最大 `N + 1`。令 `IMPLEMENTATION_HEAD_RN=CANDIDATE_IMPLEMENTATION_HEAD_AK`、`RELEASE_COMMIT_RN=<docs-only commit>`，两者同时存在后才算分配成功。
10. 生成最新完整 `RN` 的 review package，执行机械集合/冲突 replay 对账、命名风险检查与双审门禁（见上）。首次真实派发使用 `REVIEW_PHASE: INITIAL`。任一 Critical/Important finding 都从新 `AK` 回到第 7 步；新候选经第 7–9 步晋升为下一完整 `RN` 后，按 `REVIEW_PHASE: RE_REVIEW` 复用原 reviewer 并保留完整 `PRIOR_FINDINGS`。未取得两个 `PASS`，以及仅在明确未收敛跨边界风险时所需的窄审 `PASS` 前，禁止后续 push、Tag、Release。
11. 双审通过后创建中文注释 annotated Tag vX.Y.Z-ben.N；raw 类型必须是 tag，peeled 等于 `RELEASE_COMMIT`。远端已存在时核对 OID，否则 fail closed。禁止 force Tag。
12. 紧邻 push 重新读取 `main`、`dev`、`refs/heads/sync/vX.Y.Z` 与 marker 的 expected OID；sync 首次不存在则重证 absent。按“提交术语与唯一原子集合”执行一次 `git push --atomic`，同时更新 `main`、`dev`、`RELEASE_SYNC_REF`、`upstream-release`、Fork Tag 和官方 Tag：前三个 branch 与 Fork Tag 指向 `RELEASE_COMMIT`，`upstream-release` 与官方 Tag 指向 `OFFICIAL_COMMIT`。四个 branch 均使用各自 ref-scoped force-with-lease；sync 使用 `+RELEASE_COMMIT:refs/heads/sync/vX.Y.Z`，允许 non-fast-forward。任一 lease 漂移、出现 revision-specific sync ref、Tag 冲突或 push 失败都 fail closed；禁止无 lease force、blanket force 和拆分推送。
13. push 成功后、Release API 前，严格按 `local-ref-cas-transaction` 使用一个带
    `start` / `prepare` / `commit` 的 `git update-ref --stdin` transaction，把本地
    `refs/heads/main`、`refs/heads/sync/vX.Y.Z` 与 `refs/heads/upstream-release` 同时
    compare-and-swap 到 `RELEASE_COMMIT` / `RELEASE_COMMIT` / `OFFICIAL_COMMIT`；三行分别
    携带发布前捕获的 `EXPECTED_OLD_LOCAL_MAIN` / `EXPECTED_OLD_LOCAL_SYNC` /
    `EXPECTED_OLD_LOCAL_MARKER`，任一失败则三者都不更新。禁止顺序执行三个 update；dev
    已是候选 checkout，不重写到其他内容；随后 fetch 核对。
    Release 失败也保持 branch 收敛。
14. 创建或核对同名 GitHub Release：ben.N 为正式修订，非 prerelease 非 draft；标题等于 Tag；中文 Notes 含官方基线、修改点、验证、已知缺口、commit。默认仅 source archive。后验查询元数据；不合格只幂等修正。失败保留 Tag，任务标未完成，下次只收敛 Release。
15. 终验：发布瞬间本地/远端 `main`、`dev`、本轮 `RELEASE_SYNC_REF=refs/heads/sync/vX.Y.Z` 与 Fork Tag peeled commit 全部等于 `RELEASE_COMMIT`，且不存在本基线 revision-specific sync ref；Fork Tag 为 annotated；`upstream-release` 等于 `OFFICIAL_COMMIT`；官方基线 Tag 在 origin；Release 公开指向 Fork Tag。发布后 `dev` 可以继续领先 `main`，后续自动化不得把 advanced dev 重置回该旧 `RELEASE_COMMIT`。报告官方 Tag、修改点、冲突摘要、双审结论、验证、commit、push、Release URL 与残余风险。

## 通用约束

- 普通 Fork 功能提交新增/删除/替换/实质改变 FORK_CHANGES.md 能力时，同步中文更新文档。
- origin 为 Trendymen/opencodex，upstream 为 lidge-jun/opencodex。不创建 GitHub App、Secrets、PR 或 Issue；保留完整上游历史与原始 SHA。
- 官方基线证据用本地 upstream remote Tag 与 origin/upstream-release marker 证明。
- CI 因 origin clone 缺官方基线 Tag 失败时，登记为需用户决策事项并停止，不自行镜像、不改测试断言、不放宽门禁。
