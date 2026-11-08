# Migrator

## Overview

Turns a set of desired collection schemas (`NamedSchema[]`) into the DDL needed to
bring the database up to date. The components are deliberately layered:

1. `schema-diff.ts` is dialect-agnostic. It converts JSON Schema into physical
   `ColumnDef`/`IndexShape` shapes and diffs stored against desired to produce
   `MigrationStep`s.
2. `types.ts` defines the step vocabulary and the `MigrationStep` variants that map
   1:1 to `DialectType.translate`, plus `TableShapes`, the per-table
   stored/desired context handed to `translatePlan`.
3. `migrator.ts` owns the lifecycle: it bootstraps the `_collections` and
   `_migrations` system tables, reads stored schemas, computes a plan, renders the
   entire plan through the active dialect, and applies it inside a transaction.
   Rendering and validation happen **before** `BEGIN`, so an impossible plan never
   reaches the driver.

The stored schema in `_collections` is the source of truth for "what exists"; the
desired schema passed by the app is "what should exist". The migrator only writes
`_collections` after a plan has actually executed.

## Interface

- `Migrator` — `Context.Service` tag exposing `migrate`, `plan`, `status`; `status`'s error channel is `SqlError.SqlError` only [migrator.ts:Migrator]
- `MigratorLive` — `Layer.effect` implementation requiring `SqlClient` and `Dialect`; applies `References.MinimumLogLevel` from `options.logLevel` per call [migrator.ts:MigratorLive]
- `SYSTEM_TABLE_STEPS` — the `createSystemTable` steps that bootstrap `_collections` (`name`, `schema`, `updated_at`) and `_migrations` (`id`, `name`, `steps`, `applied_at`) [migrator.ts:SYSTEM_TABLE_STEPS]
- `computePlan` — builds the full `MigrationPlan` for a schema set, optionally dropping collections absent from the desired set [schema-diff.ts:computePlan]
- `diffSchemas` — per-collection diff; pass `stored = null` to get a `createTable` plus its `createIndex` steps [schema-diff.ts:diffSchemas]
- `isDestructiveStep` — classifies one step as data-losing/rewriting (not re-exported by the barrel) [schema-diff.ts:isDestructiveStep]
- `propertyToColumnType` — maps a JSON Schema property to `"text" | "integer" | "real" | "boolean"` [schema-diff.ts:propertyToColumnType]
- `schemaToColumns` — flattens `properties` into `ColumnDef[]`, skipping `x-view-only` and marking `id` unique, `x-system`/`x-hidden`, and `seqId` as primary-key auto-increment [schema-diff.ts:schemaToColumns]
- `schemaToIndexEntries` — projects `x-indexes` onto `IndexShape[]` (not re-exported by the barrel) [schema-diff.ts:schemaToIndexEntries]
- `toEffectLogLevel` — maps numeric verbosity (0=none … 4=debug, default info) to an Effect `LogLevel` [types.ts:toEffectLogLevel]
- `UnsupportedMigrationStepError` — tagged error for a step the dialect cannot render (not re-exported by the barrel) [errors.ts:UnsupportedMigrationStepError]
- `InvalidMigrationStatementError` — tagged error for a rendered statement that contains no SQL (not re-exported by the barrel) [errors.ts:InvalidMigrationStatementError]
- (type) `MigrationError` — `SqlError.SqlError | UnsupportedMigrationStepError | InvalidMigrationStatementError` [errors.ts:MigrationError]
- (type) `ColumnType`, `ColumnDef` — physical column type and DDL description [types.ts:ColumnDef]
- (type) `IndexShape`, `TableShape`, `TableShapes` — index identity, table columns+indexes, and the stored/desired pair given to `translatePlan` [types.ts:TableShapes]
- (type) `MigrationStep` — the 12-kind DDL union (`createTable`, `dropTable`, `renameTable`, `addColumn`, `dropColumn`, `renameColumn`, `alterColumn`, `createIndex`, `dropIndex`, `createSystemTable`, `createView`, `dropView`) [types.ts:MigrationStep]
- (type) `MigrationPlan` — `{ steps, destructive }` [types.ts:MigrationPlan]
- (type) `NamedSchema` — collection name paired with its desired `CollectionSchema` [types.ts:NamedSchema]
- (type) `MigrateOptions` — `{ allowDestructive?, logLevel? }` [types.ts:MigrateOptions]

## Invariants

- `migrate` and `plan` render the **whole** plan via `dialect.translatePlan` and reject every rendered statement that is empty or comment-only, both before a transaction is opened [migrator.ts:renderPlan]
- A statement is executable only if stripping `--` and `/* */` comments leaves non-whitespace [migrator.ts:isExecutable]
- System tables are created with per-step `dialect.translate` before any read in `migrate`, `plan`, **and** `status` [migrator.ts:migrateImplWith], [migrator.ts:planImplWith], [migrator.ts:statusImplWith]
- Stored schemas are decoded from JSON with Effect Schema; a corrupt stored row surfaces as `SqlError` naming `Invalid stored schema` rather than throwing [migrator.ts:decodeStoredSchema]
- A plan with zero steps returns early and logs "nothing to migrate" — `_collections` is not rewritten [migrator.ts:migrateImplWith]
- When `plan.destructive` is true and `allowDestructive` is falsy, the entire plan is skipped (all-or-nothing, never partially applied) and each destructive step is logged [migrator.ts:migrateImplWith]
- `_migrations` insert and `COMMIT` happen inside the same transaction; a `SqlError` triggers `ROLLBACK` and is re-failed [migrator.ts:migrateImplWith]
- Cleanup statements run through `Effect.ensuring`, so they execute on both the committed and rolled-back path; cleanup failures are logged with `Effect.logWarning` and never propagated [migrator.ts:runCleanup]
- `_collections` upsert (INSERT OR REPLACE) happens only **after** the transaction scope completes, and only for a plan that was not skipped [migrator.ts:migrateImplWith]
- Steps are ordered globally by `STEP_PRIORITY` — `dropView` → `dropIndex` → table changes → `createIndex` → `createView` — so plan ordering never depends on collection declaration order [schema-diff.ts:STEP_PRIORITY]
- A column is considered changed when its `type`, `nullable`, or `default` differs; such a change emits a single `alterColumn` carrying both `from` and `to` [schema-diff.ts:diffSchemas]
- `x-system` columns present in stored but absent from desired are never dropped [schema-diff.ts:diffSchemas]
- `seqId` (`x-kind: "seqId"`) is always `integer` and becomes the primary key with auto-increment; `id` is marked `unique` [schema-diff.ts:schemaToColumns]
- Properties flagged `x-view-only` never produce physical columns [schema-diff.ts:schemaToColumns]
- A view collection diffs only `x-view-query`: created when absent, recreated as `dropView` + `createView` when the query text changes, and untouched otherwise [schema-diff.ts:diffViewSchemas]
- Index identity is `(unique?, fields joined)` — dialects derive the SQL name from the same two inputs, so the differ never depends on a dialect's naming scheme [schema-diff.ts:indexKey]
- Destructiveness is per change: `dropTable`/`dropColumn` always, `alterColumn` only on a type change or `nullable → NOT NULL`; nullable relaxation and default changes are non-destructive [schema-diff.ts:isDestructiveStep]
- Collections present in stored but absent from desired are dropped only when `allowDestructive` is set, and the step kind matches the collection kind (`dropView` vs `dropTable`) [schema-diff.ts:computePlan]
- `status` reports `"behind"` for any collection missing from stored or any diff containing an add/create step (mixed add+drop included); `"ahead"` for any other non-empty diff, including drop-only and `alterColumn`-only changes; `"current"` for an empty diff [migrator.ts:statusImplWith]

## Side Effects

- Executes each rendered DDL statement with `sql.unsafe`, logging `SQL:` at debug and the failing statement at error [migrator.ts:runStatements]
- Emits `BEGIN TRANSACTION`, `COMMIT` and `ROLLBACK` against the SQL connection [migrator.ts:migrateImplWith]
- Inserts a row into `_migrations` (`id`, `name`, `steps` JSON, `applied_at`) per applied plan [migrator.ts:migrateImplWith]
- Upserts every desired schema into `_collections` (`name`, `schema` JSON, `updated_at`) after a successful apply [migrator.ts:migrateImplWith]
- Reads `SELECT name, schema FROM _collections` in `migrate`, `plan` and `status` [migrator.ts:migrateImplWith], [migrator.ts:planImplWith], [migrator.ts:statusImplWith]
- `plan` and `status` are read-only with respect to collections but still execute `createSystemTable` DDL, so they mutate the database schema on first use [migrator.ts:planImplWith], [migrator.ts:statusImplWith]
- Runs dialect-declared cleanup statements (e.g. SQLite `PRAGMA legacy_alter_table = OFF`) after the transaction [migrator.ts:runCleanup]
- Writes structured log lines at debug/info/warn/error through `Effect.log*` [migrator.ts:migrateImplWith]

## Verification

- Run: `pnpm --filter @gettersethya/mira test`
- Typecheck: `pnpm --filter @gettersethya/mira typecheck`
