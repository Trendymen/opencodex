# OpenCodex v2.35.0-ben.3 全量历史压缩设计

## 结论

将当前 v2.35.0..v2.35.0-ben.2（peeled 42282c405dc4c3dcb4f1e2877b89ac6ab49eeaba）的 39 个线性 Fork commits 压缩为恰好 5 个语义提交，然后作为不可变 v2.35.0-ben.3 发布。

## 压缩不变量

ben.2 定义为 tag （peeled 42282c405dc4c3dcb4f1e2877b89ac6ab49eeaba，tree 8499fcec058d61a42a4fa382118e4c7f92bbff58）。

1. 树一致性：C1+C2+C3 合并 tree 包含 112 个与 `8499fcec058d61a42a4fa382118e4c7f92bbff58` 逐 blob 相同的共享路径，外加本轮两份受跟踪 spec/plan 文档
2. 提交数：官方基线之后恰好 5 个 commit
3. 修改面：C3 相对 v2.35.0 为 ben.2 的 112 paths +15856/-174，外加两份本轮设计文档，共 114 paths

## 五个提交

| # | Subject | 边界 | Tree |
|---|---------|------|------|
| C1 | feat: 汇总 Fork 运行时与兼容扩展 | src/ bin/ gui/ docs-site/ | != ben2 tree |
| C2 | test: 汇总 Fork 回归与兼容覆盖 | tests/ | != ben2 tree |
| C3 | chore: 汇总 Fork CI、发布与审计基础设施 | .github/ scripts/ .gitignore AGENTS.local.md docs/superpowers/ package.json(ben.2) FORK_CHANGES.md(ben.2) | **112 个共享路径 == ben.2，另加两份 spec/plan 文档** |
| C4 | chore: 推进 v2.35.0-ben.3 版本真源 | package.json 2.35.0-ben.2 到 2.35.0-ben.3 + tests/fork-maintenance-truth.test.ts（仅版本断言与 ben3-squash 机器块） | != ben2 tree |
| C5 | docs: 记录 v2.35.0-ben.3 全量压缩与发布边界 | FORK_CHANGES.md + 补齐 C4 遗留的 FORK_CHANGES 依赖测试断言 | != ben2 tree |

C3 是硬不变量检查点：C3 的 112 个共享路径必须逐字节等于 8499fcec058d61a42a4fa382118e4c7f92bbff58；另外只允许新增本轮两份 spec/plan 文档。任何其他差异立即停止。

## 历史重写方式

1. 创建本地恢复分支 ben3-squash-backup 指向 ben.2（不推送）。
2. 使用 git commit-tree + git read-tree 从 v2.35.0 逐步构建 5 commits。C3 tree 精确等于 ben.2 tree。
3. 将 sync/v2.35.0 移动到 C5（仅全部 tree 断言通过后）。
4. backup 分支仅在 Release 终态验证后删除。

## 修改面证明

- git diff --shortstat v2.35.0 C3 包含 ben.2 的修改面及两份新设计文档
- git diff --name-only v2.35.0 C3 排序后等于 ben.2 的 112 路径及两份指定文档
- git diff --name-only C3 C5 恰好为 FORK_CHANGES.md package.json tests/fork-maintenance-truth.test.ts

## ben.3 版本与维护真源

C4 修改：package.json 2.35.0-ben.2 到 2.35.0-ben.3。tests/fork-maintenance-truth.test.ts 仅修改版本断言（接受 ben.3）并新增 ben3-squash 机器块（记录 39→5、C3 tree identity、C4 commit SHA 占位）。所有仅依赖 FORK_CHANGES 的断言移到 C5 补齐。保持用一次 `git push --atomic` 同时更新 `main`、`sync/v2.35.0`、`upstream-release`、Fork Tag 与官方 Tag 的既有契约。

C5 修改：FORK_CHANGES.md 新增 ben.3 全量压缩段落，记录 39→5、C3 tree identity、112-path delta、ben.2 不可变历史；promotion/final CI/Release 标记为 pending external gate。同时补齐 C4 遗留的仅依赖 FORK_CHANGES 的测试断言。

## 发布流程

1. 以远端 sync/v2.35.0 = 42282c405dc4c3dcb4f1e2877b89ac6ab49eeaba 为 exact expected-SHA，使用 --force-with-lease 重写推送 sync/v2.35.0 到 C5。同一次 atomic push 中 main 使用 lease 42282c405dc4c3dcb4f1e2877b89ac6ab49eeaba、marker 使用 lease fc4de772b58c13f7b16b5029b1e981d612a5db06、两个 Tag 使用 no-force-no-lease。
2. workflow_dispatch 启动 candidate CI。使用 mode-restricted 临时 controller 构建精确 job/cardinality allowlist（从当前 ci.yml 展开矩阵，含 Windows job-level skip），不复用 ben.2 旧 controller。
3. CI 成功后复用原 SPEC/QUALITY reviewer 做一轮审查。
4. 无 Critical/Important 才创建 annotated v2.35.0-ben.3 Tag，peeled 等于 C5。
5. 执行一次 `git push --atomic`，同时更新 main（lease 42282c405dc4c3dcb4f1e2877b89ac6ab49eeaba）、sync（lease C5 已在 remote）、marker（lease fc4de772b58c13f7b16b5029b1e981d612a5db06）、official v2.35.0（no-force）与 fork ben.3（no-force）。
6. 独立 main-push CI 成功后创建公开 Release。

## 非目标

- 不修改 runtime 内容
- 不修改 workflow
- 不删除或移动 v2.35.0-ben.2
- 不执行 npm publish 或全局安装

## 已知缺口

- 继承 ben.2 已知缺口（Real minted ciphertext、Ark weekly quota、OCX_DEBUG boundary）。
