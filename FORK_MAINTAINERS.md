# Fork 维护补充

[MAINTAINERS.md](MAINTAINERS.md) 保留当前上游原文。Trendymen 的同步、候选验证、双审、Tag 和 Release 规则以 [fork-sync-automation.md](docs/fork-sync-automation.md) 为准。

- `main` 指向最新已发布 Fork Release；`dev` 可以在发布后继续开发，包版本相同不表示后续提交已发布。
- Fork 发布使用新的、未使用的 `X.Y.Z-ben.N` Tag；已发布 Tag 不移动。
- `dev-version-bump` 对 Fork `ben.N` 是显式 no-op。普通上游 stable/preview 的 pre-move 沿用官方流程。
- 官方文档随上游基线更新，Fork 说明另起同目录文件。发布记录保存在 Release Notes 和任务材料中，当前能力原地维护 [FORK_CHANGES.md](FORK_CHANGES.md)。
