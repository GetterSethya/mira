# SQL Dialects

## Overview

The dialect boundary of the migration engine. A `DialectType` translates abstract
`MigrationStep` values into executable SQL, owns quoting/naming/literal conventions, and
reports whether booleans are stored as 0/1 integers. Because some engines cannot express a
step on its own, translation is plan-scoped: `translatePlan` receives every step plus each
touched table's stored/desired shape and may coalesce work there, so `MigrationStep`,
schema-diff and `Migrator.plan()` stay dialect-agnostic. `sqliteDialect` is the shipped
implementation; it rebuilds any table whose column changes and defers a pragma reset to
`cleanup`. The `Dialect` tag is the runtime injection point used by the collection service,
migrator and database preset.

## Interface

- `Dialect` — `Context.Service` tag over a `DialectType`; inject with `Layer.succeed(Dialect, sqliteDialect)` [dialect.ts:Dialect]
- `DialectType` (type) — the contract: `translatePlan`, `translate`, `nativeType`, `quoteIdentifier`, `quoteLiteral`, `indexName`, `storesBooleanAsInteger` [dialect.ts:DialectType]
- `TranslatePlanContext` (type) — `{ tables: ReadonlyMap<string, TableShapes> }` passed to `translatePlan` [dialect.ts:TranslatePlanContext]
- `TranslatedPlan` (type) — `{ statements, cleanup }` returned by `translatePlan` [dialect.ts:TranslatedPlan]
- `translateStep(translate, step)` — renders one step, failing when it yields no SQL [dialect.ts:translateStep]
- `perStepPlan(translate)` — `translatePlan` implementation for dialects that can express every step alone [dialect.ts:perStepPlan]
- `sqliteDialect` — the SQLite implementation of `DialectType` [dialect-sqlite.ts:sqliteDialect]

## Invariants

- A step that renders zero statements fails with `UnsupportedMigrationStepError`; no step may silently render as nothing [dialect.ts:translateStep]
- `perStepPlan` concatenates per-step statements in step order and always returns an empty `cleanup` [dialect.ts:perStepPlan]
- `cleanup` runs after the transaction on both commit and rollback, so it must restore connection-level state the plan mutated [dialect.ts:TranslatedPlan]
- SQLite `translatePlan` rebuilds a table whenever an `alterColumn` step targets it, and fails with `UnsupportedMigrationStepError` if the plan carries no stored shape for that table [dialect-sqlite.ts:translatePlan]
- A rebuild subsumes `addColumn`, `alterColumn`, `dropColumn`, `createIndex` and `dropIndex` for its table; each rebuilt table is emitted exactly once [dialect-sqlite.ts:SUBSUMED_BY_REBUILD] [dialect-sqlite.ts:translatePlan]
- Rebuild order is fixed: drop/create scratch table, `INSERT … SELECT` (only columns present before), autoincrement `sqlite_sequence` transfer, `DROP TABLE`, `RENAME`, then recreate the desired indexes [dialect-sqlite.ts:rebuildStatements]
- A column changing from nullable to `NOT NULL` with a default is copied through `COALESCE(col, default)`, since `SELECT` of an explicit `NULL` bypasses the default [dialect-sqlite.ts:rebuildStatements]
- `PRAGMA legacy_alter_table = ON` is emitted before any rebuild and `… = OFF` in `cleanup` [dialect-sqlite.ts:translatePlan]
- `sqliteDialect.translate("alterColumn")` returns `[]`; that arm is unreachable through `translatePlan`, which rebuilds instead [dialect-sqlite.ts:sqliteDialect]
- SQLite stores booleans as integers (`storesBooleanAsInteger: true`) [dialect-sqlite.ts:sqliteDialect]
- Identifiers are double-quoted and index names are `idx_<table>_<fields joined by _>` [dialect-sqlite.ts:quote] [dialect-sqlite.ts:indexNameOf]
- `quoteLiteral` renders `NULL`, `1`/`0` for booleans, bare numbers, and single-quoted strings with embedded quotes doubled [dialect-sqlite.ts:quoteLiteral]
- `ADD COLUMN NOT NULL` without a default gets a fallback default (`""` for text, `0` otherwise) because SQLite rejects it on non-empty tables [dialect-sqlite.ts:sqliteDialect]
- `createSystemTable` uses `CREATE TABLE IF NOT EXISTS`; `createView`/`dropView` use `CREATE VIEW IF NOT EXISTS` / `DROP VIEW IF EXISTS` with the raw `query` appended [dialect-sqlite.ts:createTableSql] [dialect-sqlite.ts:sqliteDialect]
- Type mapping is boolean→INTEGER, integer→INTEGER, real→REAL, text→TEXT [dialect-sqlite.ts:nativeTypeOf]
- `autoIncrement` columns render as `INTEGER PRIMARY KEY AUTOINCREMENT` regardless of other flags [dialect-sqlite.ts:columnSql]

## Side Effects

- No I/O at import time: the dialect only builds SQL strings [dialect-sqlite.ts:sqliteDialect]
- The emitted `PRAGMA legacy_alter_table` mutates SQLite connection state; the returned `cleanup` restores it [dialect-sqlite.ts:translatePlan] [dialect-sqlite.ts:sqliteDialect]
- The emitted rebuild statements delete and rewrite the table's `sqlite_sequence` row and drop/recreate the physical table and its indexes when executed by the migrator [dialect-sqlite.ts:rebuildStatements]

## Verification

- Run: `pnpm --filter @gettersethya/mira test`
- Typecheck: `pnpm --filter @gettersethya/mira typecheck`
