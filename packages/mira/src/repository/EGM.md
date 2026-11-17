# Repository

## Overview

A schema-agnostic CRUD layer sitting directly above `SqlClient.SqlClient` and
below `CollectionService`. It knows only table names, column names, and
pre-compiled WHERE fragments â€” it never validates, coerces, or decodes domain
values (that belongs to `CollectionService`). It uses the active `Dialect` for
identifier quoting, placeholder translation, and the `DELETE` result strategy.

`Repository` is a `Context.Service` tag whose operations all return `Effect`s with
`SqlError.SqlError` in the error channel. `RepositoryLive` supplies the
implementation from `SqlClient` + `CryptoService` + `Dialect`. `types.ts` holds
the shapes: `RepoRecord` (raw row), `CursorResult` (items-only page),
`WhereClause` (enforcer output), `SortOrder`, `ExpandDef`, the list/filter option
bags, and `AccessPredicate`/`AccessRow`.

Relation expansion is implemented as a `LEFT JOIN` per `ExpandDef`, emitting
prefixed columns that are reshaped back into a nested `row.expand` object.

## Interface

- `Repository` â€” `Context.Service` tag with `create`, `update`, `view`, `viewFilter`, `list`, `delete`, optional `viewWithAccess` and optional `deleteExisting` [repository.ts:Repository]
- `RepositoryLive` â€” `Layer.effect` implementation; requires `SqlClient`, `CryptoService`, and `Dialect` [repository.ts:RepositoryLive]
- `generateId` â€” 15-character unbiased alphanumeric id (`a-z A-Z 0-9`) built from `CryptoService.randomBytes` (exported from the file, **not** re-exported by `index.ts`, and currently unused by `RepositoryLive`) [id.ts:generateId]
- (type) `RepoRecord` â€” `Record<string, unknown>`, the only row shape this layer sees [types.ts:RepoRecord]
- (type) `CursorResult<A>` â€” `{ items: ReadonlyArray<A> }`, no total count [types.ts:CursorResult]
- (type) `WhereClause` â€” `{ sql, params }`, a pre-compiled fragment from `enforcerForAction()` [types.ts:WhereClause]
- (type) `SortOrder` â€” `{ field, direction: "asc" | "desc" }` [types.ts:SortOrder]
- (type) `ExpandDef` â€” `{ localField, targetTable, targetColumns, onClause? }` describing one `LEFT JOIN` [types.ts:ExpandDef]
- (type) `ListOptions` - optional `where`, `sort`, `tieBreaker`, `fields`, `expand` [types.ts:ListOptions]
- (type) `FilterOptions` â€” same as `ListOptions` but `where` is required [types.ts:FilterOptions]

## Invariants

- `create` injects `id`, `created`, `updated` into the caller's record before inserting and returns the merged record [repository.ts:RepositoryLive]
- `update` always overwrites `updated` and excludes `id` and `created` from the `SET` clause via `sql.update(patch, ["id", "created"])`, then re-reads the row [repository.ts:RepositoryLive]
- `update`, `view` and `delete` return `Option.none()` when no row matches; `delete` performs an existence `SELECT 1` before issuing `DELETE` and returns `Option.some(undefined)` only when it actually deleted [repository.ts:RepositoryLive]
- `viewWithAccess` returns the row plus `__mira_access_<name>` booleans from `CASE WHEN (<predicate>) THEN 1 ELSE 0 END`; the aliases are stripped before returning, and a missing key is `false` at the call site [repository.ts:RepositoryLive]
- `deleteExisting` is the fast path: it uses `Dialect.deleteResult` (`returning`, `affectedRows`, or `precheck`) to report whether the `DELETE` removed a row, so callers that already confirmed existence do not pay a second `SELECT` [repository.ts:RepositoryLive]
- `list` never issues `COUNT(*)`; pagination is carried entirely by `LIMIT` plus a caller-supplied cursor predicate inside `where` [types.ts:CursorResult], [repository.ts:RepositoryLive]
- `where` is optional for `list` (public collections) but required for `viewFilter`; raw statements are rendered, `rewritePlaceholders` numbers the `?` tokens, and `sql.unsafe` executes them [types.ts:ListOptions], [types.ts:FilterOptions], [repository.ts:RepositoryLive].
- Table names, join aliases, join columns, selected aliases, and `ORDER BY` all go through `Dialect.quoteIdentifier` in the pure `sql.ts` renderers; field names come from the collection schema or validated request parameters [sql.ts:buildSelect], [sql.ts:buildJoins], [sql.ts:orderFrag].
- When neither `fields` nor `expand` is supplied, the select is `SELECT *`; supplying `fields` alone selects only `t."<field>"` [repository.ts:buildSelect]
- `expand` selects each target column as `__e_<localField>__<col>`; `reshapeExpand` moves those into `row.expand[<localField>]` and deletes the flat keys [repository.ts:reshapeExpand]
- A relation is materialised only when at least one target column is non-`null`; a left-join miss leaves the field absent from `row.expand` [repository.ts:reshapeExpand]
- `onClause` params are interpolated in the JOIN before the WHERE, preserving textual parameter order, and the clause's compile-time `t.` alias is rewritten to the join alias [repository.ts:buildJoins]
- `ORDER BY` is only emitted when a `SortOrder` is supplied, always as `t."<field>" ASC|DESC` plus `t."seqId" ASC|DESC` as the tie-breaker when the field is not `seqId`; `CollectionService.list` supplies `seqId ASC` by default [repository.ts:orderFrag]
- The list shape `WHERE ... ORDER BY seqId LIMIT` is index-friendly: a single-value equality filter on an indexed column uses `(column, rowid)` order for seqId without a sort; `IN` uses the index plus a temp B-tree; default case-insensitive `LIKE` cannot use a B-tree index. Composite indexes are the application's choice via `Index.on(...)`: `pnpm --filter mira-benchmarks query-plan` reproduces the plans [repository.ts:RepositoryLive]
- Every operation is wrapped in `withSpanWhenEnabled` with `kind: "client"` and a `table` attribute, so tracing-off requests skip no-op spans [repository.ts:RepositoryLive]
- The repository never decodes booleans or hashes passwords; it stores exactly the values it is handed [repository.ts:Repository]

## Side Effects

- Issues `INSERT`, `SELECT`, `UPDATE` and `DELETE` statements through `SqlClient` [repository.ts:RepositoryLive]
- Reads randomness from `CryptoService.randomBytes` to build ids [repository.ts:RepositoryLive]
- Reads the wall clock (`new Date().toISOString()`) to stamp `created`/`updated` [repository.ts:RepositoryLive]
- Emits `repository.*` trace spans (create, view, update, viewFilter, list, delete, viewWithAccess, deleteExisting) [repository.ts:RepositoryLive]

## Verification

- Run: `pnpm --filter @gettersethya/mira test`
- Typecheck: `pnpm --filter @gettersethya/mira typecheck`

## Dialect boundary (issue #45)

- RepositoryLive requires SqlClient, CryptoService, and Dialect. It no longer assumes .sql-quoted identifiers or falls back to a precheck delete strategy when the dialect is missing [repository.ts:RepositoryLive].
- Pure SQL renderers live in sql.ts: orderFrag, uildSelect, uildJoins, enderView, enderViewFilter, enderList, enderViewWithAccess, enderExists, enderDelete, enderDeleteReturning, and enderRuleCheck [sql.ts:renderView].
- Raw statements with ? fragments are rendered, rewritten with ewritePlaceholders, and executed with sql.unsafe. create and update keep sql.insert/sql.update because they contain no raw ? text [repository.ts:RepositoryLive] [dialect.ts:rewritePlaceholders].
- Every table, column, join alias, selected alias, and returning identifier goes through Dialect.quoteIdentifier. The expand alias is identical in SELECT, JOIN, and ON [sql.ts:buildSelect] [sql.ts:buildJoins].
- update re-reads through enderView; delete and the explicit precheck strategy use enderExists/enderDelete [sql.ts:renderView] [sql.ts:renderExists].
