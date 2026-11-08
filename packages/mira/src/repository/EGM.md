# Repository

## Overview

A schema-agnostic CRUD layer sitting directly above `SqlClient.SqlClient` and
below `CollectionService`. It knows only table names, column names, and
pre-compiled WHERE fragments — it never validates, coerces, or decodes domain
values (that belongs to `CollectionService`), and it never assumes a dialect
beyond `.sql`-quoted identifiers.

`Repository` is a `Context.Service` tag whose operations all return `Effect`s with
`SqlError.SqlError` in the error channel. `RepositoryLive` supplies the
implementation from `SqlClient` + `CryptoService`. `types.ts` holds the shapes:
`RepoRecord` (raw row), `CursorResult` (items-only page), `WhereClause`
(enforcer output), `SortOrder`, `ExpandDef` and the list/filter option bags.

Relation expansion is implemented as a `LEFT JOIN` per `ExpandDef`, emitting
prefixed columns that are reshaped back into a nested `row.expand` object.

## Interface

- `Repository` — `Context.Service` tag with `create`, `update`, `view`, `viewFilter`, `list`, `delete` [repository.ts:Repository]
- `RepositoryLive` — `Layer.effect` implementation; requires `SqlClient` and `CryptoService` [repository.ts:RepositoryLive]
- `generateId` — 15-character unbiased alphanumeric id (`a-z A-Z 0-9`) built from `CryptoService.randomBytes` (exported from the file, **not** re-exported by `index.ts`, and currently unused by `RepositoryLive`) [id.ts:generateId]
- (type) `RepoRecord` — `Record<string, unknown>`, the only row shape this layer sees [types.ts:RepoRecord]
- (type) `CursorResult<A>` — `{ items: ReadonlyArray<A> }`, no total count [types.ts:CursorResult]
- (type) `WhereClause` — `{ sql, params }`, a pre-compiled fragment from `enforcerForAction()` [types.ts:WhereClause]
- (type) `SortOrder` — `{ field, direction: "asc" | "desc" }` [types.ts:SortOrder]
- (type) `ExpandDef` — `{ localField, targetTable, targetColumns, onClause? }` describing one `LEFT JOIN` [types.ts:ExpandDef]
- (type) `ListOptions` — optional `where`, `sort`, `fields`, `expand` [types.ts:ListOptions]
- (type) `FilterOptions` — same as `ListOptions` but `where` is required [types.ts:FilterOptions]

## Invariants

- `create` injects `id`, `created`, `updated` into the caller's record before inserting and returns the merged record [repository.ts:RepositoryLive]
- `update` always overwrites `updated` and excludes `id` and `created` from the `SET` clause via `sql.update(patch, ["id", "created"])`, then re-reads the row [repository.ts:RepositoryLive]
- `update`, `view` and `delete` return `Option.none()` when no row matches; `delete` performs an existence `SELECT 1` before issuing `DELETE` and returns `Option.some(undefined)` only when it actually deleted [repository.ts:RepositoryLive]
- `list` never issues `COUNT(*)`; pagination is carried entirely by `LIMIT` plus a caller-supplied cursor predicate inside `where` [types.ts:CursorResult], [repository.ts:RepositoryLive]
- `where` is optional for `list` (public collections) but required for `viewFilter`; the repository splices it through `Statement.literal`, never `sql.unsafe` [types.ts:ListOptions], [types.ts:FilterOptions], [repository.ts:RepositoryLive]
- Table names, join aliases and join columns are emitted through `sql(...)`; the SELECT column list and `ORDER BY` are composed as quoted fragments inside `sql.literal(...)`, with field names taken from the collection schema rather than raw request input [repository.ts:buildSelect], [repository.ts:buildJoins], [repository.ts:orderFrag]
- When neither `fields` nor `expand` is supplied, the select is `SELECT *`; supplying `fields` alone selects only `t."<field>"` [repository.ts:buildSelect]
- `expand` selects each target column as `__e_<localField>__<col>`; `reshapeExpand` moves those into `row.expand[<localField>]` and deletes the flat keys [repository.ts:reshapeExpand]
- A relation is materialised only when at least one target column is non-`null`; a left-join miss leaves the field absent from `row.expand` [repository.ts:reshapeExpand]
- `onClause` params are interpolated in the JOIN before the WHERE, preserving textual parameter order, and the clause's compile-time `t.` alias is rewritten to the join alias [repository.ts:buildJoins]
- `ORDER BY` is only emitted when a `SortOrder` is supplied, and always as `t."<field>" ASC|DESC` [repository.ts:orderFrag]
- Every operation is wrapped in `Effect.withSpan` with `kind: "client"` and a `table` attribute [repository.ts:RepositoryLive]
- The repository never decodes booleans or hashes passwords; it stores exactly the values it is handed [repository.ts:Repository]

## Side Effects

- Issues `INSERT`, `SELECT`, `UPDATE` and `DELETE` statements through `SqlClient` [repository.ts:RepositoryLive]
- Reads randomness from `CryptoService.randomBytes` to build ids [repository.ts:RepositoryLive]
- Reads the wall clock (`new Date().toISOString()`) to stamp `created`/`updated` [repository.ts:RepositoryLive]
- Emits `repository.*` trace spans (create, view, update, viewFilter, list, delete) [repository.ts:RepositoryLive]

## Verification

- Run: `pnpm --filter @gettersethya/mira test`
- Typecheck: `pnpm --filter @gettersethya/mira typecheck`
