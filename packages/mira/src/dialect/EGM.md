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
- `StoreSqlCapabilities` - the nested `DialectType.store` value used by the internal SQL stores and the HTTP auth email path: bootstrap mode, optional bootstrap SQL, zero-or-one-row column probe, request lock timeout, retry classification, and duplicate-key classification [dialect.ts:StoreSqlCapabilities]
- `withStoreBootstrap(sql, store, f)` - runs DDL in plain mode or in one transaction after `store.bootstrapSql`, retrying once for a retryable error [store-sql.ts:withStoreBootstrap]
- `DialectType` (type) - the contract: `translatePlan`, `translate`, `nativeType`, `quoteIdentifier`, `currentTimestamp`, `timestampAdd`, `timestampDiff`, `caseInsensitiveLike`, `castValue`, `quoteLiteral`, `indexName`, `storesBooleanAsInteger`, `deleteResult`, `placeholder`, `upsert`, required `store`, optional `telemetry` [dialect.ts:DialectType]
- `DeleteResultStrategy` (type) - how a `DELETE` reports an affected row: `returning`, `affectedRows`, or `precheck` [dialect.ts:DeleteResultStrategy]
- `TranslatePlanContext` (type) - `{ tables, views }` passed to `translatePlan`; `views` maps view names to stored/desired query shapes [dialect.ts:TranslatePlanContext]
- `TranslatedPlan` (type) - `{ statements, cleanup, notes? }` returned by `translatePlan` [dialect.ts:TranslatedPlan]
- `translateStep(translate, step)` - renders one step, failing when it yields no SQL [dialect.ts:translateStep]
- `perStepPlan(translate)` - `translatePlan` implementation for dialects that can express every step alone [dialect.ts:perStepPlan]
- `sqliteDialect` - the SQLite implementation of `DialectType` [dialect-sqlite.ts:sqliteDialect]
- `postgresRuleSql` - pure PostgreSQL rule renderer, not a database preset [dialect-postgres.ts:postgresRuleSql]
- `postgresStoreSql` - PostgreSQL store capability for #29 to compose into the full dialect [dialect-postgres.ts:postgresStoreSql]
- `postgresDdlSql` - pure PostgreSQL physical-schema renderer; #29 composes it [dialect-postgres.ts:postgresDdlSql]
- `DdlSqlDialect` (type) - the narrow PostgreSQL DDL capability [dialect.ts:DdlSqlDialect]
- `ViewShape` (type) - stored/desired query shape for one view collection [dialect.ts:ViewShape]
- `fromJoinReferences(query)` - conservative `FROM`/`JOIN` table-reference scan [view-dependencies.ts:fromJoinReferences]
- `viewDependencies(views, source)` - stored or desired view-to-view graph [view-dependencies.ts:viewDependencies]
- `affectedViews(views, droppedViews, changedTables)` - transitive dependent-view closure [view-dependencies.ts:affectedViews]
- `topologicalViewOrder(names, dependencies)` - dependency-first view create order [view-dependencies.ts:topologicalViewOrder]
- `rewritePlaceholders(statement, dialect)` - quote-aware `?` to driver placeholder rewrite [dialect.ts:rewritePlaceholders]
- `libsqlConnectionMode(url)` - pure URL classifier: `:memory:`/`file:` local, `libsql:`/`http(s):`/`ws(s):` remote [dialect-libsql.ts:libsqlConnectionMode]
- `libsqlDialect(mode)` - local returns `sqliteDialect`; remote returns a shallow copy with empty telemetry setup/cleanup, the remote retry classifier, and the SQLite store duplicate classifier. Remote sqld exposes only generic `SQLITE_CONSTRAINT`, so remote duplicate races still return 503 [dialect-libsql.ts:libsqlDialect]

## Invariants

- A step that renders zero statements fails with `UnsupportedMigrationStepError`; no step may silently render as nothing [dialect.ts:translateStep]
- `perStepPlan` concatenates per-step statements in step order and always returns an empty `cleanup` [dialect.ts:perStepPlan]
- `cleanup` runs after the transaction on both commit and rollback, so it must restore connection-level state the plan mutated [dialect.ts:TranslatedPlan]
- SQLite `translatePlan` rebuilds a table whenever an `alterColumn` step targets it, and fails with `UnsupportedMigrationStepError` if the plan carries no stored shape for that table [dialect-sqlite.ts:translatePlan]
- A rebuild is triggered by `alterColumn` and subsumes `addColumn`, `dropColumn`, `createIndex` and `dropIndex` for its table; each rebuilt table is emitted exactly once [dialect-sqlite.ts:SUBSUMED_BY_REBUILD] [dialect-sqlite.ts:translatePlan]
- Rebuild order is fixed: create scratch table (never drop a pre-existing one), copy stored columns, move the `sqlite_sequence` row, drop the original, create the desired original, copy back, move the sequence row back, drop the scratch, then recreate the desired indexes [dialect-sqlite.ts:rebuildStatements]
- A new `NOT NULL` column without a default gets the same synthetic `DEFAULT ''`/`0` as `ADD COLUMN`, in both the scratch and final DDL [dialect-sqlite.ts:columnSql]
- A column changing from nullable to `NOT NULL` with a default is copied through `COALESCE(col, default)`, since `SELECT` of an explicit `NULL` bypasses the default [dialect-sqlite.ts:rebuildStatements]
- The unique preflight rejects a new column, a nullable-to-`NOT NULL` default, or a type change on a single-field unique index before any table copy. Composite indexes are allowed and fail at index creation inside the transaction if they actually collapse [dialect-sqlite.ts:validateUniqueChanges]
- `sqliteDialect.translate("alterColumn")` returns `[]`; that arm is unreachable through `translatePlan`, which rebuilds instead [dialect-sqlite.ts:sqliteDialect]
- SQLite stores booleans as integers (`storesBooleanAsInteger: true`) [dialect-sqlite.ts:sqliteDialect]
- SQLite uses `bootstrapMode: "plain"` for store DDL. The column probe uses `pragma_table_info`, and `store.isRetryable` is the same `isSqliteBusy` predicate as telemetry [dialect-sqlite.ts:sqliteStoreSql].
- SQLite's `store.isDuplicateKey` is `isSqliteStoreDuplicateKey`: it accepts the symbolic constraint codes `1555`/`2067`, the extended code fields `errcode`/`extendedCode`/`rawCode`, and an Effect `UniqueViolation` reason. Telemetry keeps the narrower `isSqliteUniqueViolation` predicate. The store classifier treats any unique violation on the confirmation update as `email_taken`; the update only writes `email` and `emailVerified` [dialect-sqlite.ts:isSqliteStoreDuplicateKey].
- PostgreSQL `postgresStoreSql.isDuplicateKey` is `isPostgresUniqueViolation`: SQLSTATE `23505` or an Effect `UniqueViolation` reason. It is internal capability work for #29, not a shipped PostgreSQL route [dialect-postgres.ts:isPostgresUniqueViolation].
- A custom dialect must supply `store.isDuplicateKey`. A SQLite-like dialect can spread `sqliteDialect.store`; a new engine must provide its own structured classifier [dialect.ts:StoreSqlCapabilities].
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

## PostgreSQL DDL capability (issue #49)

- `postgresDdlSql` is a pure `DdlSqlDialect` capability, not a full `DialectType` and not a preset. #29 composes it with `postgresRuleSql`, `postgresStoreSql`, and the remaining dialect members [dialect-postgres.ts:postgresDdlSql].
- `seqId` renders as `BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY`. Normal integer columns still render as `INTEGER`; the signed 32-bit limit is a documented trade-off [dialect-postgres.ts:columnSql].
- `real` renders as `DOUBLE PRECISION`, `boolean` as `BOOLEAN`, and `quoteLiteral` renders `TRUE`/`FALSE`. `storesBooleanAsInteger` is `false` [dialect-postgres.ts:nativeTypeOf] [dialect-postgres.ts:quoteLiteral].
- `defaultLiteral` is the single default validation and coercion path. It range-checks integer defaults to signed 32-bit, coerces boolean `0`/`1` and numeric strings, and is used by `CREATE TABLE`, `ADD COLUMN`, `SET DEFAULT`, and the nullable-to-NOT NULL backfill [dialect-postgres.ts:defaultLiteral].
- `ADD COLUMN ... NOT NULL` without a default gets a synthetic `FALSE`, `0`, or `''`, matching SQLite [dialect-postgres.ts:columnSql].
- A type change always `DROP DEFAULT` first, then `TYPE ... USING ...`, then re-sets `to.default` when present. This also removes a synthetic default the stored schema does not record [dialect-postgres.ts:alterColumnSql].
- The `USING` table covers all twelve ordered type pairs. Boolean-to-real routes through integer because PostgreSQL rejects a direct boolean-to-double cast [dialect-postgres.ts:usingExpression].
- `indexName` hashes names over 63 UTF-8 bytes with a 64-bit FNV-1a suffix and truncates on a code-point boundary. `CREATE INDEX` and `DROP INDEX` use the same name [dialect-postgres.ts:indexNameOf].
- `translatePlan` drops dependent views in one `DROP VIEW IF EXISTS` list, then creates them in desired-graph dependency order. Explicit `createView`/`dropView` steps survive an empty `views` map [dialect-postgres.ts:translatePlan].
- `ViewShape.stored` is `{ query: string | null } | null`. `ViewShape.desired` is `{ query: string | null; properties?: ReadonlyArray<string> } | null`. The optional `properties` list carries the declared view property names for SQLite validation; PostgreSQL ignores it [dialect.ts:ViewShape].
- Null or blank queries fail preflight, except that an explicit `dropView` may repair a stored view [dialect-postgres.ts:collectPreflightErrors].
- `TranslatePlanContext.views` is required. PostgreSQL and SQLite use it for dependent-view synthesis; libSQL inherits the SQLite behavior [dialect-postgres.ts:translatePlan] [dialect-sqlite.ts:translatePlan].
- `translatePlan` returns optional `notes` naming synthesized view drops, creates, and validations. The migrator logs them at info and returns them on `MigrationPlan.notes` [dialect-postgres.ts:translatePlan] [dialect-sqlite.ts:translatePlan].

## SQLite dependent-view DDL (issue #58)

- `sqliteDialect.translatePlan` synthesizes view statements only when the plan contains a `dropColumn` step. Plans without a `dropColumn` keep their previous SQL [dialect-sqlite.ts:translatePlan].
- The changed table set includes every `dropColumn` table, including a drop subsumed by an `alterColumn` rebuild. A rebuild can silently break a tracked view because SQLite does not validate views during the table recreation [dialect-sqlite.ts:analyzeViewPlan].
- `analyzeViewPlan` normalizes table and view names, collects explicit `dropView`/`createView` steps, and computes the affected views with `affectedViews` over the stored graph. An explicit drop of an untracked view adds a sentinel node so tracked dependents enter the closure [dialect-sqlite.ts:analyzeViewPlan] [view-dependencies.ts:affectedViews].
- Drops use reverse stored-graph order (dependents first). Creates use the effective desired graph, which includes explicit create queries, in dependency order. Every create is emitted before any validation query [dialect-sqlite.ts:buildViewSynthesis].
- `TranslatedPlan.validations` carries the read-only probes. The migrator runs them after `statements` and before the `_migrations` insert. A probe selects every declared property plus `seqId` when absent, or `seqId` alone when no properties are declared. A stale property or a view body that still names the dropped column fails and rolls back [dialect-sqlite.ts:validationQuery] [migrator.ts:migrateImplWith].
- Explicit view steps are deduplicated by normalized name. The desired query wins over an explicit create query; the explicit step is a fallback for views absent from `ctx.views`. Synthesized creates use `CREATE VIEW IF NOT EXISTS` [dialect-sqlite.ts:buildViewSynthesis].
- Preflight rejects case-colliding view names, duplicate explicit creates with different queries, unanalyzable stored views in a rebuild-subsumed plan, unanalyzable create candidates, blank explicit creates, and affected orphans without an explicit `dropView` [dialect-sqlite.ts:collectViewPreflightErrors].
- Untracked views are not covered. A native drop fails immediately if an untracked view names the column; a rebuild-subsumed drop can leave one broken. Follow-up #59 covers detection [dialect-sqlite.ts:analyzeViewPlan].
- `libsqlDialect` local mode returns `sqliteDialect` and remote mode spreads it, so both inherit this behavior [dialect-libsql.ts:libsqlDialect].
