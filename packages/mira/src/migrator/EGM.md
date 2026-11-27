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
- `MigratorLive` - `Layer.effect` implementation requiring `SqlClient` and `Dialect`; applies `References.MinimumLogLevel` from `options.logLevel` per call [migrator.ts:MigratorLive]
- `makeMigratorLive` - internal test factory for a narrow `MigrationDialect`; not re-exported by the barrel [migrator.ts:makeMigratorLive]
- (type) `MigrationExecutor` - `run`, `runParameterized`, `query`, `queryParameterized`; both modes build one [types.ts:MigrationExecutor]
- (type) `MigrationRunner` - a statement-mode executor with `begin`, `commit`, `rollback` [types.ts:MigrationRunner]
- `SYSTEM_TABLE_STEPS` - the `createSystemTable` steps that bootstrap `_collections` (`name`, `schema`, `updated_at`) and `_migrations` (`id`, `name`, `steps`, `applied_at`) [migrator.ts:SYSTEM_TABLE_STEPS]
- `computePlan` - builds the full `MigrationPlan` for a schema set, optionally dropping collections absent from the desired set; `PlanOptions` adds `compareTextLength` [schema-diff.ts:computePlan]
- `diffSchemas` - per-collection diff; pass `stored = null` to get a `createTable` plus its `createIndex` steps; `SchemaDiffOptions` controls physical text-shape comparison [schema-diff.ts:diffSchemas]
- `keyedFieldNames` - the shared definition of a keyed column: column `unique`/`primaryKey` plus every `x-indexes` field [schema-diff.ts:keyedFieldNames]
- `isDestructiveStep` — classifies one step as data-losing/rewriting (not re-exported by the barrel) [schema-diff.ts:isDestructiveStep]
- `propertyToColumnType` — maps a JSON Schema property to `"text" | "integer" | "real" | "boolean"` [schema-diff.ts:propertyToColumnType]
- `schemaToColumns` — flattens `properties` into `ColumnDef[]`, skipping `x-view-only` and marking `id` unique, `x-system`/`x-hidden`, and `seqId` as primary-key auto-increment [schema-diff.ts:schemaToColumns]
- `schemaToIndexEntries` — projects `x-indexes` onto `IndexShape[]` (not re-exported by the barrel) [schema-diff.ts:schemaToIndexEntries]
- `toEffectLogLevel` — maps numeric verbosity (0=none … 4=debug, default info) to an Effect `LogLevel` [types.ts:toEffectLogLevel]
- `UnsupportedMigrationStepError` — tagged error for a step the dialect cannot render (not re-exported by the barrel) [errors.ts:UnsupportedMigrationStepError]
- `InvalidMigrationStatementError` — tagged error for a rendered statement that contains no SQL (not re-exported by the barrel) [errors.ts:InvalidMigrationStatementError]
- (type) `MigrationError` — `SqlError.SqlError | UnsupportedMigrationStepError | InvalidMigrationStatementError | MigrationBusyError | MigrationLockError` [errors.ts:MigrationError]
- `MigrationBusyError` - tagged error (`operation: "plan" | "status" | "migrate"`) raised when a preview or a bounded `migrate` wait cannot take the migration lock [errors.ts:MigrationBusyError]
- `MigrationLockError` - tagged error for a missing database, a mismatched dedicated lock connection, an invalid timeout, a failed clear or acquire, or an unexpected `GET_LOCK` result; part of `MigrationError` [errors.ts:MigrationLockError]
- `MigrationRollbackError` - tagged defect raised when a statement-mode metadata rollback fails; not part of `MigrationError` [errors.ts:MigrationRollbackError]
- `MigrationLockReleaseError` - tagged defect (`lockName`, `killed`, `destroyed`, `cause`) raised when a successful migration body could not verify that its lock was released; the dedicated lock connection has already been destroyed or the fallback has killed the holder [errors.ts:MigrationLockReleaseError]
- `boundLockName`, `databaseNameFromRows`, `resolveLockTimeoutSeconds`, `classifyAcquire`, `isHeldByThisSession`, `isSessionLoss` - pure lock helpers in a new internal module [lock.ts]
- (type) `ColumnType`, `ColumnDef` - physical column type and DDL description, including `maxLength`, the internal `collation` hint, and `xCollection`/`xField` relation targets [types.ts:ColumnDef]
- (type) `IndexShape`, `TableShape`, `TableShapes` — index identity, table columns+indexes, and the stored/desired pair given to `translatePlan` [types.ts:TableShapes]
- (type) `MigrationStep` — the 12-kind DDL union (`createTable`, `dropTable`, `renameTable`, `addColumn`, `dropColumn`, `renameColumn`, `alterColumn`, `createIndex`, `dropIndex`, `createSystemTable`, `createView`, `dropView`) [types.ts:MigrationStep]
- (type) `MigrationPlan` — `{ steps, destructive, notes? }` [types.ts:MigrationPlan]
- (type) `NamedSchema` — collection name paired with its desired `CollectionSchema` [types.ts:NamedSchema]
- (type) `MigrateOptions` - `{ allowDestructive?, logLevel?, schemaTable?, migrationsTable?, migrationLockTimeoutSeconds?, auditTextShape? }` [types.ts:MigrateOptions]

## Invariants

- `migrate` and `plan` render the **whole** plan via `dialect.translatePlan` and reject every rendered statement that is empty or comment-only, inside the migration transaction and before any plan DDL [migrator.ts:renderPlan]
- A statement is executable only if stripping `--` and `/* */` comments leaves non-whitespace [migrator.ts:isExecutable]
- System tables are created with per-step `dialect.translate` before any read in `migrate`, `plan`, **and** `status` [migrator.ts:migrateImplWith], [migrator.ts:planImplWith], [migrator.ts:statusImplWith]
- Stored schemas are decoded from JSON with Effect Schema; a corrupt stored row surfaces as `SqlError` naming `Invalid stored schema` rather than throwing [migrator.ts:decodeStoredSchema]
- A plan with zero steps returns early and logs "nothing to migrate" — `_collections` is not rewritten [migrator.ts:migrateImplWith]
- When `plan.destructive` is true and `allowDestructive` is falsy, the entire plan is skipped (all-or-nothing, never partially applied) and each destructive step is logged [migrator.ts:migrateImplWith]
- In transactional mode, the `_migrations` insert, the `_collections` upsert, the plan statements, and the dialect validation queries run inside one `sql.withTransaction`; a failure rolls all of them back. Statement mode keeps only the metadata writes in one short transaction after the DDL [migrator.ts:migrateTransactional] [migrator.ts:writeStatementMetadata]
- Cleanup statements run through `Effect.ensuring`, so they execute on both the committed and rolled-back path; cleanup failures are logged with `Effect.logWarning` and never propagated [migrator.ts:runCleanup]
- In transactional mode, the `_collections` upsert happens inside the transaction, after the `_migrations` insert, and only for a plan that was not skipped. Statement mode writes both with `upsertStatement` in one parameterized transaction [migrator.ts:migrateTransactional] [migrator.ts:writeStatementMetadata]
- Steps are ordered globally by `STEP_PRIORITY` — `dropView` → `dropIndex` → table changes → `createIndex` → `createView` — so plan ordering never depends on collection declaration order [schema-diff.ts:STEP_PRIORITY]
- A column is considered changed when its `type`, `nullable`, or `default` differs; when `compareTextLength` is on, a keyed-status change or a keyed `maxLength` change also emits a single `alterColumn` carrying both `from` and `to` [schema-diff.ts:diffSchemas]
- `x-system` columns present in stored but absent from desired are never dropped [schema-diff.ts:diffSchemas]
- `seqId` (`x-kind: "seqId"`) is always `integer` and becomes the primary key with auto-increment; `id` is marked `unique` [schema-diff.ts:schemaToColumns]
- Properties flagged `x-view-only` never produce physical columns [schema-diff.ts:schemaToColumns]
- A view collection diffs only `x-view-query`: created when absent, recreated as `dropView` + `createView` when the query text changes, and untouched otherwise [schema-diff.ts:diffViewSchemas]
- Index identity is `(unique?, fields joined)` — dialects derive the SQL name from the same two inputs, so the differ never depends on a dialect's naming scheme [schema-diff.ts:indexKey]
- Destructiveness is per change: `dropTable`/`dropColumn` always, `alterColumn` only on a type change or `nullable → NOT NULL`; nullable relaxation and default changes are non-destructive [schema-diff.ts:isDestructiveStep]
- Collections present in stored but absent from desired are dropped only when `allowDestructive` is set, and the step kind matches the collection kind (`dropView` vs `dropTable`) [schema-diff.ts:computePlan]
- `status` reports `"behind"` for any collection missing from stored or any diff containing an add/create step (mixed add+drop included) or, when `compareTextLength` is on, a keyed text length increase; `"ahead"` for any other non-empty diff, including drop-only, keyed length decreases, and other `alterColumn`-only changes; `"current"` for an empty diff. `status`, `plan`, and `migrate` report current/no-op for an untouched legacy shape unless `auditTextShape` is set [migrator.ts:classifyStatus] [migrator.ts:statusImplWith]

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

- `migrateTransactional` wraps the migration setup, system-table bootstrap, stored-schema read, plan computation, plan render, statements, validations, `_migrations` insert, and `_collections` upsert in one `sql.withTransaction`. A failure rolls all of it back [migrator.ts:migrateTransactional].
- The setup statements come from `dialect.migrationTransactionSetupSql`. PostgreSQL pins `READ COMMITTED`, takes `pg_advisory_xact_lock(hashtextextended('mira.migrations', 0))`, then sets a five-second transaction-local `lock_timeout` for the DDL. The advisory lock wait is intentional and is not bounded by that timeout; a URL or role `lock_timeout` or `statement_timeout` can cancel it with `55P03` or `57014` [dialect-postgres.ts:postgresDialect] [migrator.ts:migrateImplWith].
- Two replicas can call `migrate` concurrently. The first takes the lock and applies the plan; the second waits, re-reads `_collections` inside its own transaction, computes no steps, and returns without a `createTable` collision. The lock releases when the transaction commits or rolls back [migrator.ts:migrateImplWith].
- `planImplWith` and `statusImplWith` run in a transaction and take `dialect.migrationPreviewLockSql` first. A false `acquired` result fails with `MigrationBusyError`; neither preview applies plan steps. SQLite and libSQL omit the preview lock and keep their existing behavior [migrator.ts:planImplWith] [migrator.ts:statusImplWith].
- `TranslatedPlan.cleanup` still runs after the transaction on both the committed and failed paths. PostgreSQL supplies no cleanup statements [migrator.ts:runCleanup] [dialect-postgres.ts:postgresDialect].
- `PostgresDatabase.migrateAtStartup: false` disables collection migrations only. The internal stores and shared telemetry run their own idempotent bootstrap DDL on every boot, serialized by the dialect's store advisory lock [app.ts:buildServiceLayer] [dialect-postgres.ts:postgresStoreSql].

## Statement mode (issue #68)

- `migrateImplWith` dispatches on `DialectType.migrationModel.kind`. Transactional dialects keep the existing path; `"statement"` dialects use `migrateStatement` [migrator.ts:migrateImplWith].
- `migrateStatement` reserves one `SqlClient.reserve` connection for the whole migration, reads the previous session values, applies `session.setupSql`, takes the migration lock (dedicated connection when `migrationModel.lock.openConnection` is present, otherwise the reserved connection), and runs every query, DDL statement, transaction control statement, and cleanup statement through a `MigrationRunner` built from that connection [migrator.ts:migrateStatement] [migrator.ts:connectionExecutor] [migrator.ts:makeRunner].
- The system table bootstrap is rendered through `dialect.translatePlan` with an empty table and view map, so the catalog guard validates `_collections` and `_migrations` before the read [migrator.ts:migrateStatement].
- The apply loop renders the plan up to six total times. A step whose catalog shape already matches is skipped and its index appears in `TranslatedPlan.skipped`. The destructive gate runs on the pending steps only, so an already-applied destructive step does not block a stale-metadata boot [migrator.ts:migrateStatement].
- On a typed `SqlError`, the loop calls `dialect.migrationModel.isRetryableConflict`. A retry backs off 200 ms, 400 ms, 800 ms, 1.6 s, then 2 s, and re-renders. The growing gap lets a competing boot settle one more statement per attempt, because a retry converges at most one conflicting statement. A non-retryable error is surfaced [migrator.ts:migrateStatement] [migrator.ts:statementRetryBackoff].
- After the loop, `dialect.verifyPlan` re-reads the catalog and rejects any pending step. `TranslatedPlan.validations` from the final render then run. Only after both does `writeStatementMetadata` open one parameterized `_migrations` + `_collections` transaction on the reserved connection [migrator.ts:writeStatementMetadata].
- A failed metadata write always attempts `ROLLBACK`. A failed rollback dies with `MigrationRollbackError`; Effect SQL has no discard API, so the boot must fail and the pool must close [migrator.ts:writeStatementMetadata] [errors.ts:MigrationRollbackError].
- Cleanup, lock release, and `session.restoreSql` run in one `Effect.uninterruptibleMask` finalizer inside the reserved scope. Each step is time-boxed at two seconds and errors are logged; a release that still cannot be verified dies with `MigrationLockReleaseError` only when the body succeeded, and a failed body keeps its original cause [migrator.ts:migrateStatement] [migrator.ts:releaseSessionLock] [migrator.ts:runSessionRestore] [migrator.ts:runCleanup].
- `plan` and `status` reserve a connection, read `session.readSql`, apply `session.previewSetupSql`, take the migration lock with timeout `0`, and never bootstrap `_collections` or `_migrations`. A busy lock fails with `MigrationBusyError` naming the operation and the lock; the finalizer restores the preview session even on that path. `status` catches a preview render failure and still returns the `diffSchemas` status [migrator.ts:withStatementPreview] [migrator.ts:planStatement] [migrator.ts:statusStatement].
- `makeMigratorLive(dialect)` is the internal test seam for a narrow `MigrationDialect`; the barrel exports `MigratorLive` only [migrator.ts:makeMigratorLive].
- #69 owns the session lock and the preview lock values. #71 owns the final text mapping and its physical reconciliation. #72 owns the runtime transaction probe.

## Session lock (issue #69)

- A statement dialect may declare `migrationModel.lock`. `migrate` then serializes across processes and across concurrent boots; a dialect that omits it keeps the unguarded behavior [dialect.ts:MigrationLock] [migrator.ts:migrateStatement].
- The lock name is always `namePrefix:<16 lowercase hex>` from FNV-1a 64-bit over the trimmed, lowercased database name, truncated to `maxNameLength` (64 for MySQL). It is ASCII, deterministic, and avoids the MySQL 4163 length and 3057 charset failures [lock.ts:boundLockName].
- `openConnection` is the preferred path: a dedicated lock connection supplied by the database preset, held for the whole migration and destroyed on scope exit. The reserved connection is the fallback. A dedicated connection pointed at a different database than the DDL connection fails before acquire [migrator.ts:assertSameDatabase] [migrator.ts:openLockHandle].
- Before acquire, the migrator clears only the Mira name, repeating `RELEASE_LOCK` while `held_by_me` is true, up to eight times. Other user locks on the session are never touched [migrator.ts:clearReservedName].
- `migrate` waits up to `MigrateOptions.migrationLockTimeoutSeconds` (default 60; `0` fails immediately; an invalid supplied value fails `MigrationLockError`). A `0` result from `GET_LOCK` is `MigrationBusyError` naming the lock, timeout, holder id, and `migrate`; any other result is `MigrationLockError` [migrator.ts:acquireSessionLock] [lock.ts:resolveLockTimeoutSeconds].
- On the dedicated path a heartbeat (`SELECT 1` every `heartbeatIntervalSeconds`, default 60) keeps the idle lock session alive during a long body. A failed heartbeat sets a flag; the statement loop checks it and `held_by_me` after each plan statement and stops before the next one, and a retention check runs before metadata. A lost lock fails with `MigrationLockError` and writes no metadata; the current statement is never interrupted [migrator.ts:startLockHeartbeat] [migrator.ts:runStatementsWithLockCheck] [migrator.ts:assertLockHeld].
- Release is verified with `IS_USED_LOCK(name) = CONNECTION_ID()`. A held name on a reachable fallback connection triggers `KILL CONNECTION_ID()`; a lost session counts as released. A successful body whose release still cannot be verified destroys the dedicated connection or kills the holder and dies with `MigrationLockReleaseError`, so the boot fails instead of leaking the lock [migrator.ts:releaseSessionLock].
- A half-open socket can block both the release and the kill. The migration session sets `wait_timeout = 600`, so the server reclaims an idle session in about ten minutes rather than eight hours; a live, querying holder must be killed by the operator. MySQL/MariaDB session setup and restore now include `wait_timeout` [dialect-mysql-migrations.ts:mysqlMigrationDialect].
- `plan` and `status` take the same exclusive lock with timeout `0`; two concurrent previews exclude each other, and a preview during a migration fails busy. A preview on a one-connection pool can still wait for the pool before the lock attempt [migrator.ts:withStatementPreview].
- Mixed-version ordering is out of scope. The lock serializes execution but does not decide which build's schema wins; run migrations as a separate step and stop older migrators before scaling a newer build. Shared telemetry uses the same database lock and the default 60-second wait.

## Side Effects

- Executes each rendered DDL statement through the migration executor (`sql.unsafe` in transactional mode, the reserved connection in statement mode), logging `SQL:` at debug and the failing statement at error [migrator.ts:runStatements]
- Uses `sql.withTransaction`; the migrator no longer issues raw `BEGIN`, `COMMIT`, or `ROLLBACK` statements [migrator.ts:migrateImplWith]
- Inserts a row into `_migrations` (`id`, `name`, `steps` JSON, `applied_at`) per applied plan [migrator.ts:migrateImplWith]
- Upserts every desired schema into `_collections` (`name`, `schema` JSON, `updated_at`) inside the same transaction [migrator.ts:migrateImplWith]
- Reads `SELECT name, schema FROM _collections` in `migrate`, `plan` and `status` [migrator.ts:migrateImplWith], [migrator.ts:planImplWith], [migrator.ts:statusImplWith]
- In transactional mode, `plan` and `status` are read-only with respect to collections but still execute `createSystemTable` DDL inside a transaction, so they mutate the database schema on first use. In statement mode they reserve a connection, probe `_collections`, and never run DDL. On PostgreSQL they first take the non-blocking `migrationPreviewLockSql`; a false `acquired` result fails with `MigrationBusyError` instead of waiting behind a running migration, and neither preview applies plan steps [migrator.ts:planImplWith], [migrator.ts:statusImplWith]
- Runs dialect-declared cleanup statements after the transaction; SQLite now returns an empty cleanup list [migrator.ts:runCleanup]
- Writes structured log lines at debug/info/warn/error through `Effect.log*` [migrator.ts:migrateImplWith]

## Verification

- Run: `pnpm --filter @gettersethya/mira test`
- Typecheck: `pnpm --filter @gettersethya/mira typecheck`

## Text shape preflight and reconciliation (issue #71)

- uildPlanContext accepts skipDataPreflight and puts it on TranslatePlanContext. status sets it; plan and migrate leave it false. uildPlanContext is exported for the context test [migrator.ts:buildPlanContext].
- In statement mode, migrate calls dialect.preflightPlan before the metadata bootstrap. It reads _collections when it exists and uses the desired-only plan only when it does not, so an already-applied latent shape does not block an unrelated migration. A malformed metadata table skips the preflight and is diagnosed by the system-table bootstrap [migrator.ts:migrateStatement].
- computePlan and statusTransactional pass compareTextLength from dialect.reconcilesTextLength. SQLite and PostgreSQL leave the flag off and keep their existing plans [migrator.ts:planOptionsFor] [migrator.ts:statusTransactional].
- classifyStatus is the shared status rule for statement and transactional paths. The new keyed text length increase is the only extra ehind condition; a decrease is head [migrator.ts:classifyStatus].
- MigrateOptions.auditTextShape calls dialect.auditTextShape from statusStatement and planStatement. The scan is read-only: status reports ehind, plan adds a note, and neither synthesizes a repair. #30 uses it as the release gate for untouched legacy tables [migrator.ts:statusStatement] [migrator.ts:planStatement].
- The metadata tables declare maxLength: 255 on their text primary keys. The MySQL bootstrap renders them through 	ranslatePlan with skipDataPreflight, so a legacy _collections/_migrations pair is reconciled before the stored read [migrator.ts:collectionsColumns] [migrator.ts:migrateStatement].