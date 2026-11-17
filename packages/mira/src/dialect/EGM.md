# SQL Dialects

## Overview

The dialect boundary of the migration engine. A `DialectType` translates abstract
`MigrationStep` values into executable SQL, owns quoting/naming/literal conventions, and
reports whether booleans are stored as 0/1 integers. Because some engines cannot express a
step on its own, translation is plan-scoped: `translatePlan` receives every step plus each
touched table's stored/desired shape and may coalesce work there, so `MigrationStep`,
schema-diff and `Migrator.plan()` stay dialect-agnostic. `sqliteDialect` is the shipped
implementation. libSQL reuses it: only the connection-specific telemetry hooks differ.
The `Dialect` tag is the runtime injection point used by the collection service,
migrator and database preset.

## Interface

- `Dialect` - `Context.Service` tag over a `DialectType`; inject with `Layer.succeed(Dialect, sqliteDialect)` [dialect.ts:Dialect]
- `StoreSqlCapabilities` - the nested `DialectType.store` value used by the internal SQL stores: bootstrap mode, optional bootstrap SQL, zero-or-one-row column probe, request lock timeout, and retry classification [dialect.ts:StoreSqlCapabilities]
- `withStoreBootstrap(sql, store, f)` - runs DDL in plain mode or in one transaction after `store.bootstrapSql`, retrying once for a retryable error [store-sql.ts:withStoreBootstrap]
- `DialectType` (type) - the contract: `translatePlan`, `translate`, `nativeType`, `quoteIdentifier`, `currentTimestamp`, `timestampAdd`, `timestampDiff`, `caseInsensitiveLike`, `castValue`, `quoteLiteral`, `indexName`, `storesBooleanAsInteger`, `deleteResult`, `placeholder`, `upsert`, optional `telemetry` [dialect.ts:DialectType]
- `DeleteResultStrategy` (type) - how a `DELETE` reports an affected row: `returning`, `affectedRows`, or `precheck` [dialect.ts:DeleteResultStrategy]
- `TranslatePlanContext` (type) - `{ tables: ReadonlyMap<string, TableShapes> }` passed to `translatePlan` [dialect.ts:TranslatePlanContext]
- `TranslatedPlan` (type) - `{ statements, cleanup }` returned by `translatePlan` [dialect.ts:TranslatedPlan]
- `translateStep(translate, step)` - renders one step, failing when it yields no SQL [dialect.ts:translateStep]
- `perStepPlan(translate)` - `translatePlan` implementation for dialects that can express every step alone [dialect.ts:perStepPlan]
- `sqliteDialect` - the SQLite implementation of `DialectType` [dialect-sqlite.ts:sqliteDialect]
- `postgresRuleSql` - pure PostgreSQL rule renderer, not a database preset [dialect-postgres.ts:postgresRuleSql]
- `postgresStoreSql` - PostgreSQL store capability for #29 to compose into the full dialect [dialect-postgres.ts:postgresStoreSql]
- `rewritePlaceholders(statement, dialect)` - quote-aware `?` to driver placeholder rewrite [dialect.ts:rewritePlaceholders]
- `libsqlConnectionMode(url)` - pure URL classifier: `:memory:`/`file:` local, `libsql:`/`http(s):`/`ws(s):` remote [dialect-libsql.ts:libsqlConnectionMode]
- `libsqlDialect(mode)` - local returns `sqliteDialect`; remote returns a shallow copy with empty telemetry setup/cleanup and the remote retry classifier [dialect-libsql.ts:libsqlDialect]

## Invariants

- A step that renders zero statements fails with `UnsupportedMigrationStepError`; no step may silently render as nothing [dialect.ts:translateStep]
- `perStepPlan` concatenates per-step statements in step order and always returns an empty `cleanup` [dialect.ts:perStepPlan]
- `cleanup` runs after the transaction on both commit and rollback, so it must restore connection-level state the plan mutated [dialect.ts:TranslatedPlan]
- SQLite `translatePlan` rebuilds a table whenever an `alterColumn` step targets it, and fails with `UnsupportedMigrationStepError` if the plan carries no stored shape for that table [dialect-sqlite.ts:translatePlan]
- A rebuild subsumes `addColumn`, `alterColumn`, `dropColumn`, `createIndex` and `dropIndex` for its table; each rebuilt table is emitted exactly once [dialect-sqlite.ts:SUBSUMED_BY_REBUILD] [dialect-sqlite.ts:translatePlan]
- Rebuild order is fixed: create scratch table (never drop a pre-existing one), copy stored columns, move the `sqlite_sequence` row, drop the original, create the desired original, copy back, move the sequence row back, drop the scratch, then recreate the desired indexes [dialect-sqlite.ts:rebuildStatements]
- A new `NOT NULL` column without a default gets the same synthetic `DEFAULT ''`/`0` as `ADD COLUMN`, in both the scratch and final DDL [dialect-sqlite.ts:columnSql]
- A column changing from nullable to `NOT NULL` with a default is copied through `COALESCE(col, default)`, since `SELECT` of an explicit `NULL` bypasses the default [dialect-sqlite.ts:rebuildStatements]
- The unique preflight rejects a new column, a nullable-to-`NOT NULL` default, or a type change on a single-field unique index before any table copy. Composite indexes are allowed and fail at index creation inside the transaction if they actually collapse [dialect-sqlite.ts:validateUniqueChanges]
- `sqliteDialect.translate("alterColumn")` returns `[]`; that arm is unreachable through `translatePlan`, which rebuilds instead [dialect-sqlite.ts:sqliteDialect]
- SQLite stores booleans as integers (`storesBooleanAsInteger: true`) [dialect-sqlite.ts:sqliteDialect]
- SQLite uses `bootstrapMode: "plain"` for store DDL. The column probe uses `pragma_table_info`, and `store.isRetryable` is the same `isSqliteBusy` predicate as telemetry [dialect-sqlite.ts:sqliteStoreSql].
- `postgresStoreSql` uses `bootstrapMode: "transaction"`, `SET LOCAL lock_timeout = '5s'`, and `pg_advisory_xact_lock(hashtextextended('mira.system-tables', 0))`. Its probe is schema-qualified and returns one row; its retry predicate covers `40001`, `40P01`, and `55P03` [dialect-postgres.ts:postgresStoreSql].
- SQLite reports `DELETE` results with `returning`; Node 24 and Bun 1.4 both return the deleted id from `DELETE ... RETURNING id` [dialect-sqlite.ts:sqliteDialect]
- A dialect without `RETURNING` chooses `affectedRows` when its driver exposes an affected count, or `precheck` for the portable `SELECT 1` + `DELETE` fallback [dialect.ts:DeleteResultStrategy]
- Identifiers are double-quoted and index names are `idx_<table>_<fields joined by _>` [dialect-sqlite.ts:quote] [dialect-sqlite.ts:indexNameOf]
- `quoteLiteral` renders `NULL`, `1`/`0` for booleans, bare numbers, and single-quoted strings with embedded quotes doubled [dialect-sqlite.ts:quoteLiteral]
- `ADD COLUMN NOT NULL` without a default gets a fallback default (`""` for text, `0` otherwise) because SQLite rejects it on non-empty tables [dialect-sqlite.ts:sqliteDialect]
- `createSystemTable` uses `CREATE TABLE IF NOT EXISTS`; `createView`/`dropView` use `CREATE VIEW IF NOT EXISTS` / `DROP VIEW IF EXISTS` with the raw `query` appended [dialect-sqlite.ts:createTableSql] [dialect-sqlite.ts:sqliteDialect]
- Type mapping is boolean to INTEGER, integer to INTEGER, real to REAL, text to TEXT [dialect-sqlite.ts:nativeTypeOf]
- `autoIncrement` columns render as `INTEGER PRIMARY KEY AUTOINCREMENT` regardless of other flags [dialect-sqlite.ts:columnSql]
- libSQL reuses every SQL-generation behavior above. Remote libSQL has `telemetry.setup: []` and `cleanup: []` because sqld rejects writable pragmas; local libSQL returns the SQLite dialect unchanged [dialect-libsql.ts:libsqlDialect]
- The libSQL remote retry classifier uses `SqlError.isRetryable` plus nested network codes, not message substrings [dialect-libsql.ts:isLibsqlRetryable]

## Side Effects

- No I/O at import time: the dialect only builds SQL strings [dialect-sqlite.ts:sqliteDialect] [dialect-libsql.ts:libsqlDialect]
- The emitted rebuild statements create and drop the scratch table, rewrite the table's `sqlite_sequence` row, and recreate the desired indexes when executed by the migrator [dialect-sqlite.ts:rebuildStatements]
- The rebuild does not emit `PRAGMA legacy_alter_table`; it recreates the table in place so the same sequence works on local SQLite and remote libSQL [dialect-sqlite.ts:translatePlan]

## Verification

- Run: `pnpm --filter @gettersethya/mira test`
- Typecheck: `pnpm --filter @gettersethya/mira typecheck`
## Rule SQL and quote safety (issue #45)

- `DialectType` adds `currentTimestamp`, `timestampAdd`, `timestampDiff`, `caseInsensitiveLike`, and `castValue`. `RuleSqlDialect` is the narrow view used by the compiler and enforcer [dialect.ts:DialectType] [dialect.ts:RuleSqlDialect].
- `quoteIdentifier` must escape its delimiter. SQLite and PostgreSQL double the double quote, so identifiers containing quotes remain invertible [dialect-sqlite.ts:quote] [dialect-postgres.ts:quote].
- `postgresRuleSql` is a pure PostgreSQL rule renderer. It is not a database preset and adds no driver [dialect-postgres.ts:postgresRuleSql].
- `rewritePlaceholders(statement, dialect)` uses `sql-text.ts` and skips quoted identifiers and string literals while numbering `?` [dialect.ts:rewritePlaceholders] [sql-text.ts:transformSqlCode].
- SQLite keeps legacy `datetime('now')`, `datetime(expr, ...)`, `julianday(...)`, and `LIKE` output. `hour` and `minute` dateDiff now scale the day value [dialect-sqlite.ts:timestampDiffSql].
