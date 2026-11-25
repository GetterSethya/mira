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
3. `migrator.ts` owns the lifecycle: it opens a transaction, runs the dialect's
   migration setup statements, bootstraps the `_collections` and `_migrations`
   system tables, reads stored schemas, computes a plan, renders and validates the
   entire plan through the active dialect, and applies it. Rendering and
   validation happen **inside** the transaction before any plan DDL, so an
   impossible plan never reaches the driver and a PostgreSQL replica cannot race
   the bootstrap.

The stored schema in `_collections` is the source of truth for "what exists"; the
desired schema passed by the app is "what should exist". The migrator only writes
`_collections` after a plan has actually executed.

## Interface

- `Migrator` — `Context.Service` tag exposing `migrate`, `plan`, `status`; `status`'s error channel is `MigrationError` so the PostgreSQL preview can report `MigrationBusyError` [migrator.ts:Migrator]
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
- (type) `MigrationError` — `SqlError.SqlError | UnsupportedMigrationStepError | InvalidMigrationStatementError | MigrationBusyError` [errors.ts:MigrationError]
- `MigrationBusyError` — tagged error (`operation: "plan" | "status"`) raised when a PostgreSQL preview cannot acquire the non-blocking advisory lock [errors.ts:MigrationBusyError]
- (type) `ColumnType`, `ColumnDef` — physical column type and DDL description [types.ts:ColumnDef]
- (type) `IndexShape`, `TableShape`, `TableShapes` — index identity, table columns+indexes, and the stored/desired pair given to `translatePlan` [types.ts:TableShapes]
- (type) `MigrationStep` — the 12-kind DDL union (`createTable`, `dropTable`, `renameTable`, `addColumn`, `dropColumn`, `renameColumn`, `alterColumn`, `createIndex`, `dropIndex`, `createSystemTable`, `createView`, `dropView`) [types.ts:MigrationStep]
- (type) `MigrationPlan` — `{ steps, destructive, notes? }` [types.ts:MigrationPlan]
- (type) `NamedSchema` — collection name paired with its desired `CollectionSchema` [types.ts:NamedSchema]
- (type) `MigrateOptions` — `{ allowDestructive?, logLevel? }` [types.ts:MigrateOptions]

## Invariants

- `migrate` and `plan` render the **whole** plan via `dialect.translatePlan` and reject every rendered statement that is empty or comment-only, inside the migration transaction and before any plan DDL [migrator.ts:renderPlan]
- A statement is executable only if stripping `--` and `/* */` comments leaves non-whitespace [migrator.ts:isExecutable]
- System tables are created with per-step `dialect.translate` before any read in `migrate`, `plan`, **and** `status` [migrator.ts:migrateImplWith], [migrator.ts:planImplWith], [migrator.ts:statusImplWith]
- Stored schemas are decoded from JSON with Effect Schema; a corrupt stored row surfaces as `SqlError` naming `Invalid stored schema` rather than throwing [migrator.ts:decodeStoredSchema]
- A plan with zero steps returns early and logs "nothing to migrate" — `_collections` is not rewritten [migrator.ts:migrateImplWith]
- When `plan.destructive` is true and `allowDestructive` is falsy, the entire plan is skipped (all-or-nothing, never partially applied) and each destructive step is logged [migrator.ts:migrateImplWith]
- `_migrations` insert, the `_collections` upsert, the plan statements, and the dialect validation queries run inside one `sql.withTransaction`; a failure rolls all of them back [migrator.ts:migrateImplWith]
- Cleanup statements run through `Effect.ensuring`, so they execute on both the committed and rolled-back path; cleanup failures are logged with `Effect.logWarning` and never propagated [migrator.ts:runCleanup]
- The `_collections` upsert happens inside the transaction, after the `_migrations` insert, and only for a plan that was not skipped [migrator.ts:migrateImplWith]
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

- `buildPlanContext` populates `views` from both desired and stored view collections. A desired view has `stored` and `desired` query shapes plus the desired `properties` list; a stored-only orphan has `desired: null`; a view with no `x-view-query` records `{ query: null }` on that side [migrator.ts:buildPlanContext].
- `plan` returns `MigrationPlan.notes` from the translated plan when the dialect supplies notes. Empty notes are omitted; SQLite's `plan()` shape changes only for a `dropColumn` plan with synthesized view operations [migrator.ts:planImplWith].
- `migrate` logs every dialect note at info inside the transaction before the plan statements. Notes describe intended operations, not committed ones; read them with the failure log [migrator.ts:migrateImplWith].
- The migrator runs `TranslatedPlan.validations` after `statements` and before the `_migrations` insert, inside the same transaction. Validation queries are read-only; a failure rolls back the DDL and metadata [migrator.ts:migrateImplWith].
- `_migrations` still records the abstract `plan.steps`, not the synthesized statements. The notes and debug SQL log expose the synthesized operations [migrator.ts:migrateImplWith].

## View synthesis (issues #49 and #58)

- PostgreSQL and SQLite can synthesize `DROP VIEW` and `CREATE VIEW` statements around a destructive table change. The migrator passes stored and desired view queries through `TranslatePlanContext.views` [dialect.ts:TranslatePlanContext].
- The abstract plan still contains the schema differ's view steps. The dialect adds dependent-view statements that the differ does not emit, and returns their names in `TranslatedPlan.notes` [dialect-postgres.ts:translatePlan] [dialect-sqlite.ts:translatePlan].
- SQLite synthesizes views only for a `dropColumn` plan. It drops affected tracked views in reverse dependency order, recreates desired views in dependency order, and validates declared properties plus `seqId` through `TranslatedPlan.validations`. A stale query or property fails and rolls back [dialect-sqlite.ts:translatePlan].
- SQLite now detects untracked objects through a read-only `sqlite_master` scan during plan render, inside the migration transaction before any plan DDL. A rebuilt or dropped object with an untracked dependent view fails preflight naming the views, and so do a recreated view carrying a trigger or an explicit column list, a rebuilt table with a trigger, and a `createView` whose name already exists. A native drop only adds a note naming the untracked dependent: SQLite still fails the statement at execution if the view reads the dropped column and rolls back, and succeeds when it does not. Every connected surviving view, tracked or untracked, is probed inside the transaction through `TranslatedPlan.validations`, so a view broken by the plan or by a catalog change rolls the migration back [dialect-sqlite.ts:translatePlan] [migrator.ts:migrateImplWith].
- A collection kind change (base table to view or view to base table) is pre-existing and unhandled. The PostgreSQL preflight and the differ fail loudly rather than silently reclassifying [schema-diff.ts:diffViewSchemas].

## PostgreSQL migration transaction (issue #29)

- `migrateImplWith` wraps the migration setup, system-table bootstrap, stored-schema read, plan computation, plan render, statements, validations, `_migrations` insert, and `_collections` upsert in one `sql.withTransaction`. A failure rolls all of it back [migrator.ts:migrateImplWith].
- The setup statements come from `dialect.migrationTransactionSetupSql`. PostgreSQL pins `READ COMMITTED`, takes `pg_advisory_xact_lock(hashtextextended('mira.migrations', 0))`, then sets a five-second transaction-local `lock_timeout` for the DDL. The advisory lock wait is intentional and is not bounded by that timeout; a URL or role `lock_timeout` or `statement_timeout` can cancel it with `55P03` or `57014` [dialect-postgres.ts:postgresDialect] [migrator.ts:migrateImplWith].
- Two replicas can call `migrate` concurrently. The first takes the lock and applies the plan; the second waits, re-reads `_collections` inside its own transaction, computes no steps, and returns without a `createTable` collision. The lock releases when the transaction commits or rolls back [migrator.ts:migrateImplWith].
- `planImplWith` and `statusImplWith` run in a transaction and take `dialect.migrationPreviewLockSql` first. A false `acquired` result fails with `MigrationBusyError`; neither preview applies plan steps. SQLite and libSQL omit the preview lock and keep their existing behavior [migrator.ts:planImplWith] [migrator.ts:statusImplWith].
- `TranslatedPlan.cleanup` still runs after the transaction on both the committed and failed paths. PostgreSQL supplies no cleanup statements [migrator.ts:runCleanup] [dialect-postgres.ts:postgresDialect].
- `PostgresDatabase.migrateAtStartup: false` disables collection migrations only. The internal stores and shared telemetry run their own idempotent bootstrap DDL on every boot, serialized by the dialect's store advisory lock [app.ts:buildServiceLayer] [dialect-postgres.ts:postgresStoreSql].

## Side Effects

- Executes each rendered DDL statement with `sql.unsafe`, logging `SQL:` at debug and the failing statement at error [migrator.ts:runStatements]
- Uses `sql.withTransaction`; the migrator no longer issues raw `BEGIN`, `COMMIT`, or `ROLLBACK` statements [migrator.ts:migrateImplWith]
- Inserts a row into `_migrations` (`id`, `name`, `steps` JSON, `applied_at`) per applied plan [migrator.ts:migrateImplWith]
- Upserts every desired schema into `_collections` (`name`, `schema` JSON, `updated_at`) inside the same transaction [migrator.ts:migrateImplWith]
- Reads `SELECT name, schema FROM _collections` in `migrate`, `plan` and `status` [migrator.ts:migrateImplWith], [migrator.ts:planImplWith], [migrator.ts:statusImplWith]
- `plan` and `status` are read-only with respect to collections but still execute `createSystemTable` DDL inside a transaction, so they mutate the database schema on first use. On PostgreSQL they first take the non-blocking `migrationPreviewLockSql`; a false `acquired` result fails with `MigrationBusyError` instead of waiting behind a running migration, and neither preview applies plan steps [migrator.ts:planImplWith], [migrator.ts:statusImplWith]
- Runs dialect-declared cleanup statements after the transaction; SQLite now returns an empty cleanup list [migrator.ts:runCleanup]
- Writes structured log lines at debug/info/warn/error through `Effect.log*` [migrator.ts:migrateImplWith]

## Verification

- Run: `pnpm --filter @gettersethya/mira test`
- Typecheck: `pnpm --filter @gettersethya/mira typecheck`
