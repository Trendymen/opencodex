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
- 用户要求对新官方稳定 Release 执行 rebase 时，默认同时授权并要求完成本文第 1–15 步的完整发布闭环；不得自行缩窄为只在本地 rebase、验证或建 Tag。只有用户明确要求暂停、中止或限定到某个中间门禁时，才停在该边界。

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
rebase_request=full_steps_1_to_15_unless_user_explicitly_stops
sync_role=audit-release-ref
release_instant_dev=must-equal-RELEASE_COMMIT
post_release_advanced_dev=must-not-reset
sync_ancestry=EXPECTED_REMOTE_SYNC-absent-or-ancestor-of-RELEASE_COMMIT
final_convergence=local-remote-main-dev-sync-fork-tag-equal-RELEASE_COMMIT
<!-- fork-release-lifecycle:end -->

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
marker_update=refs/heads/upstream-release OFFICIAL_COMMIT EXPECTED_OLD_LOCAL_MARKER
atomicity=all-or-none
sequential_updates=forbidden
<!-- local-ref-cas-transaction:end -->

远端 atomic push 成功后的本地引用收敛必须等价于下列单事务输入；两个 `update` 都携带
发布前捕获的 expected-old OID，任一比较失败时 `prepare`/`commit` 不得让另一条 ref
单独生效：

```text
start
update refs/heads/main RELEASE_COMMIT EXPECTED_OLD_LOCAL_MAIN
update refs/heads/upstream-release OFFICIAL_COMMIT EXPECTED_OLD_LOCAL_MARKER
prepare
commit
```

四个 branch 使用各自精确 expected-SHA lease；`main`、`dev` 与 marker 允许按发布策略 force，`sync/vX.Y.Z` 只能普通 fast-forward。两个 Tag 都不 force、不使用 lease。任何 mismatch、atomic 不支持或不确定失败都 fail closed，禁止拆分推送。

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
conflict_fields=path,symbols,official_change,fork_change,resolution,official_coverage,downstream_consumers,failure_paths,state_edges,ordering_edges,risk_domains,conflict_snapshots,focused_tests,residual_risk
full_fork_diff=FULL_FORK_DIFF:git-diff-NEW_OFFICIAL-to-RELEASE_COMMIT_RN
rebase_resolution_diff=REBASE_RESOLUTION_DIFF:git-range-diff-OLD_OFFICIAL..PRE_REBASE_DEV-to-NEW_OFFICIAL..POST_REBASE_HEAD
post_rebase_fix_diff=POST_REBASE_FIX_DIFF:git-diff-POST_REBASE_HEAD-to-IMPLEMENTATION_HEAD_RN
spec_recomputation=required-independent-for-endpoint-and-touched-sets
conflict_reconciliation=captured-union-must-equal-isolated-shadow-replay-union
review_rounds=append-only-latest-round-binds-review
review_verdicts=PASS,FAIL
quality_named_risks=required
<!-- rebase-review-package:end -->

### 逐冲突证据账本

每个进入过 unresolved 状态的内容冲突路径都必须在 `FORK_CHANGES.md` 的本轮 rebase 章节和
review package 中各有一条 `CONFLICT_LEDGER` 记录。字段顺序固定如下；任何字段都不得为空，
确实不适用时写 `n/a:<原因>`，不得只写 `n/a`：

```text
path=<仓库相对路径>
symbols=<涉及符号、配置键、workflow job 或文档章节>
official_change=<新官方相对旧官方改变了什么语义>
fork_change=<旧 Fork 相对旧官方保留了什么能力>
resolution=<最终 union、替换或删除的精确决定>
official_coverage=<官方是否完整覆盖 Fork；证据路径、符号与测试>
downstream_consumers=<最终读取者、二次转换者和公开投影>
failure_paths=<异常、abort、timeout、retry、资源释放等路径>
state_edges=<undefined/absent/null/false/empty、初建/重建等状态边界>
ordering_edges=<并发、SSE、terminal、flush、dispose 等时序边界>
risk_domains=<auth/secret/release/dependency-install/shared-entrypoint/runtime/config/persistence/ui/none，可多值并说明命中证据>
conflict_snapshots=<覆盖该记录的 rebase step、REBASE_HEAD 与 hunk_id>
focused_tests=<本轮实际执行且直接覆盖该决定的测试>
residual_risk=<尚未验证的真实边界；没有则写 none:<理由>>
```

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
stage snapshot，并必须与隔离 shadow replay 的路径与 hunk 并集完全一致；不得仅凭
`OVERLAP_PATHS` 推导、也不得为了满足子集关系删除真实冲突。`NON_OVERLAP_CONFLICTS` 可以非空，
但每一项都要在 ledger 说明中间 commit 或 rename 原因。固定 SHA 不可读取、snapshot 缺失、
shadow replay 不一致、count 不是从集合计算，或账本漏项时，正式 verdict 必须为
`SPEC_COMPLIANCE: FAIL`。

<!-- mechanical-recomputation:start -->
official_changed_paths=git-diff-name-only-no-renames-OLD_OFFICIAL-to-NEW_OFFICIAL
old_fork_net_paths=git-diff-name-only-no-renames-OLD_OFFICIAL-to-PRE_REBASE_DEV
old_fork_touched_paths=union-of-per-nonmerge-commit-no-renames-paths
net_overlap_paths=OFFICIAL_CHANGED_PATHS-intersect-OLD_FORK_NET_PATHS
overlap_paths=OFFICIAL_CHANGED_PATHS-intersect-OLD_FORK_TOUCHED_PATHS
content_conflicts=captured-union-equals-isolated-shadow-replay-union
non_overlap_conflicts=CONTENT_CONFLICTS-minus-OVERLAP_PATHS-retained-and-explained
auto_merges=OVERLAP_PATHS-minus-CONTENT_CONFLICTS
counts=derived-from-recomputed-sets
copied_constants=forbidden
verdict=SPEC_COMPLIANCE:FAIL-on-missing-or-mismatch
<!-- mechanical-recomputation:end -->

### 冲突 stop 与 shadow replay 证据

主 rebase 开始前必须创建并保留隔离的 shared temporary clone，使其拥有独立 ref 指向
`PRE_REBASE_DEV`，同时固定完整 replay manifest：Git version、原始与有效 rebase invocation、
会影响 commit 选择/merge/rename/换行的 config 及来源、两端 `.gitattributes` 和有效 merge
driver。主流程与 shadow invocation 都显式设置 `rerere.enabled=false`、
`rerere.autoupdate=false`，不得读取既有 `rr-cache`；非确定性 external merge driver 阻塞同步。

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

最终 review 前，在 `mktemp -d` 的隔离临时 clone 中按 pre-rebase manifest 从相同任务级固定 SHA
重放同一非 merge commit 序列。每个 shadow stop 先独立捕获路径、stage mode+blob 与 hunk，再将
主 rebase 记录的完整 resolved index tree 恢复到 shadow index/worktree 后执行同一
`resolution_action`。replay 前必须从 shadow clone 对所有 recorded stage 0 blob 与 resolved
index tree 执行 `git cat-file -e`，证明 shared source objects 可读。动作序列、commit/dropped
映射、每个实际生成 commit 的 tree、post-action tree、最终 tree，以及主/影子两套 stop、路径、`hunk_id` 并集必须完全一致，否则 fail
closed。临时 clone 不得复用或移动主仓库的 worktree、index、
HEAD、branch 或 ref，完成比对后删除。reviewer 不自行执行可变 rebase，只静态核对两套完整
证据和集合相等性；缺少 shadow replay 不能降级成 residual risk。

<!-- conflict-snapshot-contract:start -->
per_stop=rebase-step,REBASE_HEAD,resolution-action,resolved-index-tree,post-action-HEAD-tree
per_path=path,stage1-mode-blob,stage2-mode-blob,stage3-mode-blob,combined-diff,stage0-mode-blob-or-deleted
resolution_action=continue-created-commit,skip-empty,continue-kept-empty
commit_mapping=REBASE_HEAD-to-replayed-commit-or-dropped-with-reason
hunk_id=sha256-rebase-step-REBASE_HEAD-path-stage-mode-blobs-normalized-hunk
hunk_dedupe=exact-hunk-id-only
captured_union=all-unresolved-paths-from-all-stops
replay_environment=pre-rebase-git-version-invocation-config-attributes-and-rerere-disabled
shadow_clone=created-before-main-rebase-and-preserves-PRE_REBASE_DEV
object_access=shared-source-objects-cat-file-verified-before-replay
shadow_replay=isolated-temp-clone-fixed-task-shas-recorded-resolutions
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

### CODE_QUALITY 命名风险清单

`CODE_QUALITY` reviewer 必须逐项检查下列风险，并沿每个冲突符号追到最终消费者与错误路径；
“测试通过”不能替代数据流审查：

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

默认仍是两个独立 reviewer，不泛化增加人数。下列输入全部从 review package 机械派生：

- `SENSITIVE_SCOPE` 检查 `FULL_FORK_DIFF` 的全部 changed path、所有增删 hunk 原始文本，以及
  conflict ledger 的全部 `symbols`：路径匹配
  `.github/workflows/**`、`scripts/release.ts`、`scripts/release-*.ts`、`scripts/install*`，依赖字段
  发生改变的 `package.json`/lockfile；hunk/symbol 使用大小写不敏感的保守子串
  `auth|oauth|credential|token|secret|api[_-]?key|apikey|keyring`。扫描不排除注释或字符串，宁可
  多触发 explorer，不能漏掉 `apiKey`、`resolveApiKey`、`oauthClient` 或 `tokenProvider`。
- `SHARED_ENTRYPOINTS` 是精确集合：`src/router.ts`、`src/server/lifecycle.ts`、
  `src/server/responses/core.ts`、`src/codex/inject.ts`；不得自行扩缩。
- `CONFLICT_HUNK_COUNT` 是全部 stop snapshot 的唯一 `hunk_id` 数，不是复制的整数，也不按路径
  粗略计数。同一 path 在不同 rebase step 的 hunk 不合并。

`SENSITIVE_SCOPE` 非空、命中任一 `SHARED_ENTRYPOINTS`、内容冲突路径达到 5 个，或唯一 hunk
达到 10 个时，最终双审前必须先派只读 explorer 生成冲突数据流、最终消费者和错误路径证据；
explorer 不下 verdict。每条 ledger 用 `risk_domains` 标注 `runtime`、`config`、`persistence`、
`ui`、`release` 中命中的边界；允许一条记录命中多个边界，但“命中两个类别”本身不触发第三审。
只有证据明确给出从一个边界的具体 path/symbol 到另一边界具体 path/symbol 的消费者链 edge，
或 explorer 仍报告跨边界不确定性，才增加一个独立 `CODE_QUALITY` reviewer。第三 reviewer 的
scope 必须精确列出这些 path、symbol 与 edge，只审跨边界风险；不得重复整份泛化审查制造票数。

<!-- rebase-review-escalation:start -->
default_reviewers=SPEC_COMPLIANCE,CODE_QUALITY
sensitive_scope=exact-path-or-sensitive-substring-in-all-diff-hunks-and-ledger-symbols
sensitive_identifiers=auth,oauth,credential,token,secret,api-key,apikey,keyring
sensitive_scan=case-insensitive-conservative-no-comment-or-string-exclusion
shared_entrypoints=src/router.ts,src/server/lifecycle.ts,src/server/responses/core.ts,src/codex/inject.ts
conflict_hunk_count=unique-hunk-id-count
explorer_trigger=sensitive-scope-or-shared-entrypoint-or-5-plus-conflict-paths-or-10-plus-unique-hunks
explorer_scope=evidence-only-no-verdict
boundary_set=runtime,config,persistence,ui,release
cross_boundary_edges=consumer-chain-edges-not-category-count
third_reviewer_trigger=cross-boundary-edge-or-explorer-unresolved-risk
third_reviewer_mode=CODE_QUALITY
third_reviewer_scope=exact-cross-boundary-paths-symbols-and-edges-only
generic_reviewer_expansion=forbidden
<!-- rebase-review-escalation:end -->

现有 `pre-push` hook 会执行 `bun run prepush`，因此会运行
`tests/fork-maintenance-truth.test.ts` 并阻止上述机器契约被静默删改；未安装 hook 时，发布者必须
在 push 前显式运行该 focused test 和完整验证。hook 只能证明仓库内的静态契约与测试通过，
不能证明双审通过，也不能证明 reviewer 真正完成了 SHA 重算、数据流检查或复审。禁止 hook
自动生成 approval、自动清除 finding、自动移动 ref，自动化也不得用 `--no-verify` 绕过它。

## 幂等收敛（判断新 Release 之前）

从已提交 FORK_CHANGES.md 与 package.json 推导预期 X.Y.Z-ben.N 和 vX.Y.Z-ben.N：

- 实现、最终验证或末尾文档提交未完成：只恢复当前 ben.N 剩余收尾；不重新 rebase、不递增 revision。工作树不干净、来源不明或证据不足时登记未完成并 fail closed。
- `RELEASE_COMMIT` 完成但 Fork Tag 缺失：验证 package/document 一致、其父提交等于此前捕获的 `IMPLEMENTATION_HEAD`、该提交只含 `FORK_CHANGES.md`，再按 annotated Tag 与六成员 atomic leased push 流程补齐；不得生成 ben.(N+1)。
- 远端 push 完成但本地 main / upstream-release 未对齐：严格按 `local-ref-cas-transaction`
  使用一个带 `start` / `prepare` / `commit` 的 `git update-ref --stdin` transaction，同时用
  捕获的两个本地旧 OID 做 compare-and-swap；任一 CAS 失败时两条 ref 都不得更新。不得移动
  已验证的 sync branch，禁止把两条 update 拆成顺序执行的命令。
- Tag 存在但 GitHub Release 缺失或元数据不合格：只创建或幂等修正同名 Release，不移动 Tag、不递增 revision。Release 须满足 tagName 精确、name 等于 Tag、isDraft=false、isPrerelease=false，中文 body 至少含官方基线、Fork 修改点、验证结果、已知缺口与 commit。

`dev` 可以在已发布 `main` 之上有自由的已提交开发内容；这不是 drift。只有候选来源、远端 `dev` 预期 SHA、或其重写权限无法确定时才 fail closed。

上述每个补 Tag、atomic push 重试或不确定结果恢复入口都必须重新执行完整同基线远端 Fork
Tag 集 preflight；发现高于目标 revision 的有效 Tag、集合漂移或 raw/peeled 身份漂移时停止，
不得仅因目标 Tag 本身仍缺失而继续创建较低 revision。

全部闭环且无更新官方稳定 Release 才可记录无需同步。

## 新官方稳定 Release 同步流程

1. fetch 后固定本地/远端 main、dev、upstream-release、sync/vX.Y.Z 和目标 Fork Tag 的 raw/peeled SHA，并将 `OLD_OFFICIAL`、`NEW_OFFICIAL`、`PRE_REBASE_DEV` 记为任务级不可变输入。本地 main 与 marker 必须和远端一致；dev 的本地/远端状态同时记录为候选证据。
2. 保护候选历史：候选固定为已提交的 `dev`。远端 dev 必须 fetch；本地 dev 领先、落后或分叉时均须记录两端 SHA 与来源。只要本地 dev 是当前已知、干净的发布候选，可继续；来源不明、远端独有而无法证明、或 lease 预期无法固定时停止。远端 sync 存在必须 fetch；发布时 sync 必须 fast-forward 到 Release commit，远端独有或来源不明时停止。
3. 在启动主 rebase 前先创建保留 `PRE_REBASE_DEV` 的 shared temporary clone、按 `conflict-snapshot-contract` 固定 replay manifest，并在主流程与 shadow 中显式禁用 `rerere`/`rerere.autoupdate`。随后在 `dev` 上执行等价于 `git rebase --onto <new-tag-sha> <old-upstream-release-sha> dev`。rebase 每次停住时先捕获完整证据，才允许解决并继续；完成后立即固定 `POST_REBASE_HEAD`，再进行 shadow replay 对账。rebase 阶段不得移动 main，不得 detached HEAD 验证。完成实现、验证和末尾文档提交后，本地 `sync/vX.Y.Z` 才可准备为同一 `RELEASE_COMMIT`；不得将 dev 当作只读证据，也不得在 sync 上 rebase。
4. 冲突处理以 FORK_CHANGES.md、src/fork 边界、AGENTS.local.md、既有测试和新官方实现为依据，并为全部 `CONTENT_CONFLICTS` 写逐冲突 ledger。仅当前官方源码与测试证明等价或更优才可删除 Fork 行为；名称相似、旧文档或单次 HTTP 200 不算证据。部分覆盖只移除被替代部分；语义改变、能力放弃或无法判定时请用户决定。Fork 逻辑优先放窄模块或 src/fork，官方高频文件最小接线。
5. revision：新官方 vX.Y.Z 首次派生固定 X.Y.Z-ben.1 / vX.Y.Z-ben.1。同基线已有 Release 不自动递增；仅用户明确要求才允许 ben.2、ben.3。`ben.N` 按官方基线独立维护：即使完整 Tag 集已有更新官方稳定版，明确授权的旧基线维护修订仍可继续，但必须存在精确官方基线 Tag、不得低于同基线最高有效 ben revision、不得复用或移动既有 Fork Tag，也不得声称包含更新官方版本能力。普通 stable/preview 仍遵守全局单调版本门禁。重复 heartbeat 幂等。
6. 完成并提交全部 rebase、冲突、版本与实现修复。
7. 创建下一个候选尝试 `AK`（首次为 `A1`，否则最大 `K + 1`），捕获 `CANDIDATE_IMPLEMENTATION_HEAD_AK`，不得从后续 HEAD 反推。按该 SHA 中文更新 FORK_CHANGES.md：官方 Release/Tag/SHA、实现 commit、shortstat、包版本、目标 Tag、能力状态、官方覆盖证据、逐冲突 ledger、已移除方向、已知缺口与验收边界。历史移除记录不删，旧 PASS 不沿用。
8. 文档更新后执行最终验证：定向测试；共享 runtime/adapter/server/script/runner/version 改动跑一次 bun run prepush；GUI 改动按规则构建；privacy scan 必须通过。验证促成实现修改时把当前 `AK` 标记为 abandoned，以最大 `K + 1` 回到第 7 步；验证失败的 `AK` 不得占用 `RN`，也不得写入 `PRIOR_FINDINGS`。
9. 验证通过后只暂存 `FORK_CHANGES.md`，核对 staged list 与 diff check，创建 docs-only commit，并机械验证其父提交等于当前 `CANDIDATE_IMPLEMENTATION_HEAD_AK`。此时才将完整 SHA 对晋升为下一个审查轮次：尚无轮次时创建 `R1`；已有 reviewed round 时使用当前最大 `N + 1`。令 `IMPLEMENTATION_HEAD_RN=CANDIDATE_IMPLEMENTATION_HEAD_AK`、`RELEASE_COMMIT_RN=<docs-only commit>`，两者同时存在后才算分配成功。
10. 生成最新完整 `RN` 的 review package，执行机械集合/冲突 replay 对账、命名风险检查、高风险升级与双审门禁（见上）。首次真实派发使用 `REVIEW_PHASE: INITIAL`。任一 Critical/Important finding 都从新 `AK` 回到第 7 步；新候选经第 7–9 步晋升为下一完整 `RN` 后，按 `REVIEW_PHASE: RE_REVIEW` 复用原 reviewer 并保留完整 `PRIOR_FINDINGS`。未取得两个 `PASS` 以及必要的跨边界第三审 `PASS` 前，禁止后续 push、Tag、Release。
11. 双审通过后创建中文注释 annotated Tag vX.Y.Z-ben.N；raw 类型必须是 tag，peeled 等于 `RELEASE_COMMIT`。远端已存在时核对 OID，否则 fail closed。禁止 force Tag。
12. 先执行 sync ancestry guard 并重新读取全部 expected OID，再按“提交术语与唯一原子集合”的六成员 refset 执行一次 `git push --atomic`：`main`、`dev`、`sync/vX.Y.Z` 与 Fork Tag 指向 `RELEASE_COMMIT`，marker 与官方 Tag 指向 `OFFICIAL_COMMIT`。`main`、`dev`、marker 使用各自 ref-scoped force lease；sync 使用普通 refspec及其 exact lease，且不得省略 ancestry guard。任一 lease 漂移、冲突或失败都 fail closed；禁止无 lease force、blanket force 和拆分推送。
13. push 成功后、Release API 前，严格按 `local-ref-cas-transaction` 使用一个带
    `start` / `prepare` / `commit` 的 `git update-ref --stdin` transaction，把本地
    `refs/heads/main` 与 `refs/heads/upstream-release` 同时 compare-and-swap 到
    `RELEASE_COMMIT` / `OFFICIAL_COMMIT`；两行分别携带发布前捕获的
    `EXPECTED_OLD_LOCAL_MAIN` / `EXPECTED_OLD_LOCAL_MARKER`，任一失败则两者都不更新。
    禁止顺序执行两个 update；dev 已是候选 checkout，不重写到其他内容；随后 fetch 核对。
    Release 失败也保持 branch 收敛。
14. 创建或核对同名 GitHub Release：ben.N 为正式修订，非 prerelease 非 draft；标题等于 Tag；中文 Notes 含官方基线、修改点、验证、已知缺口、commit。默认仅 source archive。后验查询元数据；不合格只幂等修正。失败保留 Tag，任务标未完成，下次只收敛 Release。
15. 终验：发布瞬间本地/远端 `main`、`dev`、`sync/vX.Y.Z` 与 Fork Tag peeled commit 全部等于 `RELEASE_COMMIT`；Fork Tag 为 annotated；`upstream-release` 等于 `OFFICIAL_COMMIT`；官方基线 Tag 在 origin；Release 公开指向 Fork Tag。发布后 `dev` 可以继续领先 `main`，后续自动化不得把 advanced dev 重置回该旧 `RELEASE_COMMIT`。报告官方 Tag、修改点、冲突摘要、双审结论、验证、commit、push、Release URL 与残余风险。

## 通用约束

- 普通 Fork 功能提交新增/删除/替换/实质改变 FORK_CHANGES.md 能力时，同步中文更新文档。
- origin 为 Trendymen/opencodex，upstream 为 lidge-jun/opencodex。不创建 GitHub App、Secrets、PR 或 Issue；保留完整上游历史与原始 SHA。
- 官方基线证据用本地 upstream remote Tag 与 origin/upstream-release marker 证明。
- CI 因 origin clone 缺官方基线 Tag 失败时，登记为需用户决策事项并停止，不自行镜像、不改测试断言、不放宽门禁。
