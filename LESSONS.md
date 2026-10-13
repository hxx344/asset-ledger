# Lessons from merged work

这里保存 asset-ledger 的合并经验。改动前先读本文件。每条先给加粗祈使规则，再给证据（SHA / 现象），结尾 `Seen N× (日期…)`。满 3 个不同复盘日迁入 [docs/code-standards.md](docs/code-standards.md) 并在此留 Moved 索引。

## Database

**在同一 SQLite 连接内复用编译后的 Statement，并设有界淘汰；每次调用仍各自 bind。**

- 证据：`5ea37c8f` 在 `lib/sqlite.ts` 用 `Map` 缓存 `StatementSync`，上限 128；`tests/sqlite-cache.test.ts` 覆盖同 SQL 只 prepare 一次、不同 bind 不串、满容量淘汰。
- 现象：热路径每次 `connection.prepare(相同 SQL)` 重复编译。
- Seen 1× (2026-10-13)

## Frontend performance

**`React.memo` 子树时，把会重建的回调提成稳定 `useCallback`，否则浅比较形同虚设。**

- 证据：`8bafa81b` 给 `AssetTrend` 加 `memo`，并在 `dashboard.tsx` 用 `openHistory=useCallback(...)` 替代内联 `()=>navigate('history')`。
- 现象：仪表盘无关状态更新时趋势图仍因新函数引用重渲。
- Seen 1× (2026-10-13)

## Theme / docs

本窗口另有 `be6fe698`（深色主题与图表配色），属样式统一，无新增可推广缺陷教训。

## Moved to the code standards

尚无。
