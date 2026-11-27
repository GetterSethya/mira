# SQL Dialects

## Overview

The dialect boundary of the migration engine. A `DialectType` translates abstract
`MigrationStep` values into executable SQL, owns quoting/naming/literal conventions, and
reports whether booleans are stored as 0/1 integers. Because some engines cannot express a
step on its own, translation is plan-scoped: `translatePlan` receives every step plus each
touched table's stored/desired shape and may coalesce work there, so `MigrationStep`,
schema-diff and `Migrator.plan()` stay dialect-agnostic. `sqliteDialect` and
`postgresDialect` are the shipped implementations; `postgresDialect` composes
`postgresDdlSql`, `postgresRuleSql`, `postgresFilterSql`, `postgresStoreSql`, and
`postgresTelemetry`. libSQL reuses SQLite: only the connection-specific telemetry
hooks differ. The `Dialect` tag is the runtime injection point used by the
collection service, migrator and database preset.

## Interface

- `Dialect` - `Context.Service` tag over a `DialectType`; inject with `Layer.succeed(Dialect, sqliteDialect)` [dialect.ts:Dialect]
- `StoreSqlCapabilities` - the nested `DialectType.store` value used by the internal SQL stores and the HTTP auth email path: bootstrap mode, optional bootstrap SQL, zero-or-one-row column probe, request lock timeout, retry classification, and duplicate-key classification [dialect.ts:StoreSqlCapabilities]
- `withStoreBootstrap(sql, store, f)` - runs DDL in plain mode or in one transaction after `store.bootstrapSql`, retrying once for a retryable error [store-sql.ts:withStoreBootstrap]
- `DialectType` (type) - the contract: `translatePlan`, `translate`, `nativeType`, `quoteIdentifier`, `currentTimestamp`, `timestampAdd`, `timestampDiff`, `caseInsensitiveLike`, `caseInsensitivePattern`, `castValue`, `quoteLiteral`, `indexName`, `storesBooleanAsInteger`, `deleteResult`, `transactionProbe`, `placeholder`, `upsert`, optional `upsertStatement`, optional `verifyPlan`, required `store`, optional `telemetry`, required `migrationModel`, optional `migrationTransactionSetupSql`, optional `migrationPreviewLockSql`, optional `migrationPreviewUnlockSql`, and optional `normalizesBigintSeqId` [dialect.ts:DialectType]
- `MigrationModel` (type) - `{ kind: "transaction" }` or `{ kind: "statement", systemTableExistsSql, isRetryableConflict, transaction, session?, lock? }`; required so no dialect silently inherits a model [dialect.ts:MigrationModel]
- `MigrationLock` (type) - the optional session-lock capability on a statement model: `databaseNameSql`, lowercase `namePrefix`, `maxNameLength`, `defaultTimeoutSeconds`, parameterized `acquireStatement`/`releaseStatement`/`usedStatement`/`holderStatement`, optional `killSelfStatement`, optional `heartbeatIntervalSeconds`, and optional `openConnection` [dialect.ts:MigrationLock]
- `LockExecutor` (type) - the `run`, `runParameterized`, `query`, `queryParameterized` surface a dedicated lock connection implements [dialect.ts:LockExecutor]
- `LockConnection` (type) - `{ executor, destroy }`; `destroy` is an idempotent forced close, not a graceful `end` [dialect.ts:LockConnection]
- `MigrationDialect` (type) - the narrow migrator-facing pick: plan translation, per-step translation, quoting, upserts, `migrationModel`, and the optional migration hooks [dialect.ts:MigrationDialect]
- `StatementMigrationDialect` (type) - a `MigrationDialect` whose model is `statement` and whose `upsertStatement` and `verifyPlan` are required at compile time [dialect.ts:StatementMigrationDialect]
- `ParameterizedStatement` (type) - `{ sql, params }` returned by `upsertStatement` [dialect.ts:ParameterizedStatement]
- `DialectType.caseInsensitivePattern(left, right)` - complete-pattern match: match `left` against a whole `LIKE` pattern in `right` with no added wildcards. Consumes `right` once, returns SQL, and leaves the pattern a bound parameter. The compiler invokes it as a plain function, so a call site passing a dialect method must bind it with a closure [dialect.ts:DialectType]
- `DialectType.transactionProbe` (required `TransactionProbeStrategy`) - how the mutation batcher decides whether a failed entry ended the batch transaction: `nested-begin` uses `SELECT 1` then `BEGIN` (SQLite family), `select-only` uses just `SELECT 1` (PostgreSQL), and the `{ _tag: "error-classified", isTransactionFatal }` object classifies the entry's own error before the savepoint guard (MySQL/MariaDB). The object form must carry its classifier; string forms have none. SQL Server remains unverified, so a custom dialect must verify its engine; there is no silent default [dialect.ts:DialectType] [dialect.ts:TransactionProbeStrategy]
- `DeleteResultStrategy` (type) - how a `DELETE` reports an affected row: `returning`, `affectedRows`, or `precheck`. Telemetry retention uses `RETURNING 1` for the returning strategy and `affectedRows` for MySQL. MySQL has no `DELETE RETURNING`; MariaDB supports it, and #30 owns the production choice. An `affectedRows` reader returns `Some(n)` for a non-negative safe integer up to the retention batch, or `None` when unreadable; `None` is fatal [dialect.ts:DeleteResultStrategy]
- `TranslatePlanContext` (type) - `{ tables, views }` passed to `translatePlan`; `views` maps view names to stored/desired query shapes [dialect.ts:TranslatePlanContext]
- `TranslatedPlan` (type) - `{ statements, cleanup, notes?, skipped? }` returned by `translatePlan`; `skipped` lists the input step indices the catalog already satisfies [dialect.ts:TranslatedPlan]
- `translateStep(translate, step)` - renders one step, failing when it yields no SQL [dialect.ts:translateStep]
- `perStepPlan(translate)` - `translatePlan` implementation for dialects that can express every step alone [dialect.ts:perStepPlan]
- `sqliteDialect` - the SQLite implementation of `DialectType` [dialect-sqlite.ts:sqliteDialect]
- `postgresDialect` - the composed PostgreSQL `DialectType`; spreads the DDL, rule, and filter capabilities and adds `placeholder`, `upsert`, `deleteResult: returning`, `transactionProbe: select-only`, `store`, `telemetry`, `migrationTransactionSetupSql`, `migrationPreviewLockSql`, and `normalizesBigintSeqId: true` [dialect-postgres.ts:postgresDialect]
- `postgresRuleSql` - pure PostgreSQL rule renderer, not a database preset [dialect-postgres.ts:postgresRuleSql]
- `postgresFilterSql` - pure PostgreSQL user-filter capability, not a database preset; its `caseInsensitivePattern` renders `ILIKE` with `ESCAPE E'\\'` [dialect-postgres.ts:postgresFilterSql]
- `postgresStoreSql` - PostgreSQL store capability composed into `postgresDialect` [dialect-postgres.ts:postgresStoreSql]
- `postgresTelemetry` - PostgreSQL telemetry hooks: empty setup and cleanup, retry predicate reused from `postgresStoreSql` [dialect-postgres.ts:postgresTelemetry]
- `postgresDdlSql` - pure PostgreSQL physical-schema renderer composed into `postgresDialect` [dialect-postgres.ts:postgresDdlSql]
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
- PostgreSQL `postgresStoreSql.isDuplicateKey` is `isPostgresUniqueViolation`: SQLSTATE `23505` or an Effect `UniqueViolation` reason. The shipped `postgresDialect` uses it for auth email duplicate classification [dialect-postgres.ts:isPostgresUniqueViolation].
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

## Dialect-aware user filter LIKE (issue #55)

- `DialectType.caseInsensitivePattern(left, right)` is required. It matches a
  complete pattern with no added wildcards, consumes `right` once, and leaves the
  pattern a bound parameter [dialect.ts:DialectType].
- SQLite renders `LIKE`, so SQLite behavior is unchanged. PostgreSQL renders
  `ILIKE` through `postgresFilterSql` [dialect-sqlite.ts:sqliteDialect] [dialect-postgres.ts:postgresFilterSql].
- Both production call sites pass a bound `caseInsensitivePattern` closure: the
  collection list and the telemetry `filterParts` helper shared by `listLogs`
  and `listSpans` [collection-service.ts:filterNodeToWhereClause] [sql-store.ts:filterParts].
- `caseInsensitiveLike` is unchanged and stays limited to the `prefix` and
  `contains` modes of the rule DSL. `RuleSqlDialect` keeps its narrow `Pick`, so
  rule SQL and cache keys are untouched [dialect.ts:RuleSqlDialect].
- `libsqlDialect` local mode returns `sqliteDialect` and remote mode spreads it,
  so both inherit the SQLite `LIKE` behavior [dialect-libsql.ts:libsqlDialect].
- Both engines add an `ESCAPE` clause: `ESCAPE E'\\'` on PostgreSQL and
  `ESCAPE '\'` on SQLite. A backslash escapes `%` and `_`, and patterns without a
  backslash are unchanged. The pattern value stays a bound parameter
  [dialect-postgres.ts:postgresFilterSql] [dialect-sqlite.ts:sqliteDialect].
- SQLite folds ASCII only. PostgreSQL `ILIKE` follows the database locale and
  collation, including the ICU or libc provider, so non-ASCII matching can
  differ between engines and between PostgreSQL deployments. Pin a
  deterministic locale for `like`-dependent reads
  [dialect-postgres.ts:postgresFilterSql].
- An environment-gated test keyed on `MIRA_TEST_POSTGRES_URL` covers the real
  PostgreSQL `ILIKE` query and records the locale and collation
  [postgres-shared.test.ts].
## Rule SQL and quote safety (issue #45)

- `DialectType` adds `currentTimestamp`, `timestampAdd`, `timestampDiff`, `caseInsensitiveLike`, and `castValue`. `RuleSqlDialect` is the narrow view used by the compiler and enforcer [dialect.ts:DialectType] [dialect.ts:RuleSqlDialect].
- `quoteIdentifier` must escape its delimiter. SQLite and PostgreSQL double the double quote, so identifiers containing quotes remain invertible [dialect-sqlite.ts:quote] [dialect-postgres.ts:quote].
- `postgresRuleSql` is a pure PostgreSQL rule renderer. It is not a database preset and adds no driver [dialect-postgres.ts:postgresRuleSql].
- `rewritePlaceholders(statement, dialect)` uses `sql-text.ts` and skips quoted identifiers and string literals while numbering `?` [dialect.ts:rewritePlaceholders] [sql-text.ts:transformSqlCode].
- SQLite keeps legacy `datetime('now')`, `datetime(expr, ...)`, `julianday(...)`, and `LIKE` output. `hour` and `minute` dateDiff now scale the day value [dialect-sqlite.ts:timestampDiffSql].

## PostgreSQL DDL capability (issue #49)

- `postgresDdlSql` is a pure `DdlSqlDialect` capability, not a full `DialectType` and not a preset. `postgresDialect` composes it with `postgresRuleSql`, `postgresStoreSql`, and the remaining dialect members [dialect-postgres.ts:postgresDdlSql] [dialect-postgres.ts:postgresDialect].
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
- Untracked views are covered by a read-only `sqlite_master` scan run during plan render, inside the migration transaction before any plan DDL. The dialect issues one static `SELECT` through `TranslatePlanContext.readonlyQuery` whenever the plan contains a step that can invalidate a catalog object, merges catalog view rows into the stored view graph, and fails preflight when a rebuilt or dropped object would leave a dependent view broken [dialect-sqlite.ts:translatePlan] [dialect.ts:TranslatePlanContext].
- `libsqlDialect` local mode returns `sqliteDialect` and remote mode spreads it, so both inherit this behavior [dialect-libsql.ts:libsqlDialect].

## Untracked views and view-attached objects (issue #59)

- `TranslatePlanContext.readonlyQuery` is a required read-only catalog `SELECT` capability the dialect uses during render, inside the migration transaction before any plan DDL. The migrator builds it from the `SqlClient` and guards it mechanically: the statement is trimmed, its first token must be `SELECT`, and any semicolon is rejected. `WITH` is rejected because a CTE can lead into DML, and a semicolon lets a second statement ride along. The dialect interpolates no user data; its one scan statement is fully static [dialect.ts:TranslatePlanContext] [migrator.ts:makeReadonlyQueryGuard].
- `translatePlan`'s error channel includes `SqlError.SqlError`, so a failed catalog read fails the render with the driver's own error inside the transaction and before any plan DDL. Narrower dialect implementations remain assignable because Effect is covariant in the error channel [dialect.ts:DialectType].
- The scan is gated on the plan surface: it runs only when the plan contains `dropColumn`, `dropTable`, `dropView`, `createView`, or `alterColumn`; on any other plan `readonlyQuery` is never called. One static `SELECT "name", "sql", "tbl_name", "type" FROM "sqlite_master"` reads every catalog row type, and a typed reader accepts a row only when `name`, `tbl_name`, and `type` are strings and `sql` is a string or `null` [dialect-sqlite.ts:translatePlan].
- The plan surface computes rebuilt tables from `alterColumn` steps, rebuild-subsumed drops from tables carrying both `dropColumn` and `alterColumn`, native drops from `dropColumn`-only tables, dropped tables, removed views (`dropView` without a matching `createView`), the recreate set (synthesis creates that are also dropped plus explicit `dropView`+`createView` pairs), and new `createView` names. Every catalog-to-plan name comparison uses `normalizeIdentifier`. An `alterColumn`-only rebuild never seeds the untracked check: it keeps every column name, so views survive it, even though attached triggers do not [dialect-sqlite.ts:translatePlan].
- The untracked check merges catalog view rows into the stored `ViewShape` map (each untracked row contributes `{ stored: { query: sql }, desired: null }`) and computes one `affectedViews` closure over the union, seeded with the breaking tables and every `dropView` step's view, removed or recreated. The closure is classified before tracked names are subtracted, so tracked dependents are checked too, and transitive untracked chains are covered by the same #58 machinery [dialect-sqlite.ts:translatePlan] [view-dependencies.ts:affectedViews].
- Each affected view is classified by its own references with `matchedReferenceOf(query, surface)`, a local helper over the same `fromJoinReferences` output that returns the first matched object and its class in priority order: rebuild-subsumed drop tables, dropped tables, removed views, native drop tables, then the recreate set. The boolean `referencesTouched` predicate cannot answer these branches and stays where it is [dialect-sqlite.ts:translatePlan] [view-dependencies.ts:fromJoinReferences].
- Classification matrix; failures are `UnsupportedMigrationStepError` values, and the first error wins in the order untracked manifest, tracked dependents, triggers, column lists, then createView conflicts:
  - Fail: an untracked dependent of a rebuild-subsumed drop, a dropped table, or a removed view, with one manifest clause per view naming the view and the object, and the remediation "Track each view in Mira, or remove or rename it before migrating."
  - Fail: a tracked dependent of a dropped table or removed view that is neither in the recreate set nor explicitly dropped, naming the view and the object.
  - Fail: a trigger on a recreated view, synthesized or explicit, naming the trigger and the view; SQLite allows only `INSTEAD OF` triggers on views and Mira cannot recreate them.
  - Fail: a stored view in the recreate set whose text declares an explicit column list, naming the view.
  - Fail: a `createView` whose name already exists in the catalog as any row type, because `CREATE VIEW IF NOT EXISTS` would not apply the desired query.
  - Fail: a trigger on a rebuilt table, naming the trigger and the table; the rebuild would drop it.
  - Note: native drops, where an untracked dependent may fail the statement at execution if it reads the dropped column; the existing execution-time failure and rollback are unchanged.
  - Note: triggers on dropped tables and removed views, because the removal is explicit and the trigger cannot survive it.
- `viewDeclaresColumnList` is a self-contained front-matter scanner over stored `CREATE VIEW` text: it skips `CREATE [TEMP] VIEW [IF NOT EXISTS]`, consumes one plain, quoted, or schema-qualified name, and reports whether `(` precedes `AS`. Unparsable front matter reports no column list [view-dependencies.ts:viewDeclaresColumnList].
- For every affected view the plan neither drops nor recreates, tracked or untracked, the dialect appends `SELECT 1 FROM <quoted view> LIMIT 0` to `TranslatedPlan.validations`. The probes run inside the migration transaction after the statements, join the #58 validation channel, and cover the note-class branches plus a catalog change between the render and the DDL. The probe set is the closure minus the recreate set and explicit drops, because recreated views already receive the #58 validation [dialect-sqlite.ts:translatePlan] [migrator.ts:migrateImplWith].
- The probe set comes from the same `affectedViews` closure as the static scan, so both inherit the reference extractor's blind spots: a construct the tokenizer cannot understand escapes both. The probes narrow but do not eliminate that residual risk, which is accepted and shared with #58 [view-dependencies.ts:fromJoinReferences].
- `libsqlDialect` local mode returns `sqliteDialect` and remote mode spreads it, so both inherit the scan, the checks, and the probes [dialect-libsql.ts:libsqlDialect].

## Transaction liveness probing (issue #54)

- `DialectType` has a required flat member `transactionProbe: TransactionProbeStrategy`, re-exported from the package root alongside `DialectType`. The type is `"nested-begin" | "select-only" | { _tag: "error-classified", isTransactionFatal }`. There is no silent default: omission is a compile error for a custom dialect [dialect.ts:TransactionProbeStrategy].
- `nested-begin` is the SQLite behavior: `SELECT 1` fails on a dead connection, then `BEGIN` fails while the outer transaction is alive and succeeds once SQLite has implicitly rolled it back, at which point the probe rolls the throwaway transaction back. `sqliteDialect` declares it [dialect-sqlite.ts:sqliteDialect] [mutation-batcher.ts:probeTransactionAlive].
- `select-only` is the PostgreSQL behavior: `SELECT 1` is the whole probe. Inside the flusher's outer transaction a successful `SELECT` means the transaction is usable and a failed `SELECT` means it is not; no transaction control statement is issued, so the probe cannot abort the outer transaction [mutation-batcher.ts:probeTransactionAlive].
- libSQL inherits the SQLite declaration: local mode returns `sqliteDialect` and remote mode spreads it, so both use `nested-begin` [dialect-libsql.ts:libsqlDialect].
- `error-classified` is the MySQL/MariaDB behavior (issue #72). The batcher runs the strategy's `isTransactionFatal` on the failed entry's own error **before** the savepoint wrapper guard and before any probe SQL. A fatal verdict records `verdict: "classified-fatal"`, fails every entry, and skips `COMMIT` without issuing a statement. A non-fatal verdict falls through to the guard and then to `SELECT 1`, which the object strategy treats as the whole liveness probe. The object branch is checked with `typeof strategy !== "string"` before any string comparison so it can never fall through to `BEGIN` [mutation-batcher.ts:classifyTransactionFailure] [mutation-batcher.ts:probeTransactionAlive].
- `TransactionProbeResult.verdict` is one of `"alive"`, `"probe-failed"`, `"nested-begin-committed"`, or `"classified-fatal"`. `batch.probeStrategy` stays a string (`probeStrategyName` returns the string member or the object's `_tag`), and the span uses `batch.probeVerdict` instead of the old boolean mapping [mutation-batcher.ts:probeStrategyName].
- A classified fatal abort is an engine conflict, not a batcher defect. The flusher loop classifies the flush cause before `degraded`, so three consecutive deadlocks do not increment `consecutiveDefects` or close the batcher. A constraint abort keeps its existing exemption; every other failure keeps the three-strike behavior [mutation-batcher.ts:loop].
- Neither string strategy is verified for SQL Server. `BEGIN` nests in SQL Server, so `nested-begin` is known-unsafe there and the applicability of `select-only` is unverified; a custom dialect must verify its engine before choosing either. On MySQL, prepared `BEGIN` fails with `ER_UNSUPPORTED_PS` (`1295`), and over the text protocol it implicitly commits; on MariaDB it succeeds and implicitly commits. `select-only` cannot detect a deadlock rollback because `SELECT 1` succeeds after InnoDB restarts the session's transaction [dialect.ts:TransactionProbeStrategy].
- The PostgreSQL transaction contract is verified by the environment-gated `tests/collection-service/postgres-batch.test.ts`, which self-skips unless `MIRA_TEST_POSTGRES_URL` is set. The MySQL/MariaDB contract is verified by `tests/databases/mysql-batch.e2e.test.ts` on both engines.

## PostgreSQL dialect (issue #29)

- `postgresDialect` is one composed `DialectType`. It spreads `postgresDdlSql`, `postgresRuleSql`, and `postgresFilterSql`, and adds `placeholder(index) => "$" + index`, an `ON CONFLICT` upsert with a `DO NOTHING` fallback when every column is a conflict key, `deleteResult: returning`, `transactionProbe: select-only`, `store: postgresStoreSql`, `telemetry: postgresTelemetry`, and `normalizesBigintSeqId: true` [dialect-postgres.ts:postgresDialect].
- `postgresTelemetry` has empty setup and cleanup lists because PostgreSQL has no PRAGMAs and no WAL checkpoint. Its `isRetryable` reuses `postgresStoreSql.isRetryable`, so `40001`, `40P01`, and `55P03` live in one predicate [dialect-postgres.ts:postgresTelemetry].
- `migrationTransactionSetupSql` is `SET LOCAL transaction_isolation = 'read committed'`, then `SELECT pg_advisory_xact_lock(hashtextextended('mira.migrations', 0))`, then `SET LOCAL lock_timeout = '5s'`. The isolation level makes the post-wait re-read see the committed schema; the lock serializes replicas; the timeout is set after the lock, so it bounds the DDL table locks but not the advisory wait [dialect-postgres.ts:postgresDialect].
- `migrationPreviewLockSql` is the non-blocking `pg_try_advisory_xact_lock` query returning one `acquired` column. `Migrator.plan` and `Migrator.status` fail with `MigrationBusyError` when it returns false instead of waiting for a running migration [dialect-postgres.ts:postgresDialect] [migrator.ts:planImplWith].
- `normalizesBigintSeqId` tells the collection decoder to convert a driver `bigint` `seqId` to the canonical decimal cursor string. SQLite and libSQL omit it and keep the identity fast path [dialect-postgres.ts:postgresDialect] [decode.ts:normalizeSeqId].
- `postgresDdlSql.quoteLiteral` renders text as `E'...'` with backslashes and single quotes escaped, independent of `standard_conforming_strings`. The `_collections` schema JSON is written through this path [dialect-postgres.ts:quoteLiteral].
- `postgresRuleSql.castValue` handles `"bigint"` as `::bigint`. The rule compiler casts a string literal to the known column type and leaves the column uncast, so `age >= "18"` compares numerically instead of lexicographically [dialect-postgres.ts:postgresRuleSql] [rule/compiler.ts:hintForComparison].
- The PostgreSQL DDL still performs the 63-byte identifier preflight for table, column, view, and index-field names, and truncates generated index names with a deterministic FNV-1a suffix. Untracked views and `CREATE VIEW` name conflicts fail at the statement and roll back; PostgreSQL has no `sqlite_master` scan and no `CREATE VIEW IF NOT EXISTS` [dialect-postgres.ts:postgresDdlSql].

## MySQL migration capability (issue #68)

- `mysqlMigrationDialect` is a `StatementMigrationDialect` in `dialect-mysql-migrations.ts`. It is not root-exported and imports no MySQL driver. #30 composes it with the rule, store, telemetry, and preset work; #71 owns the declared text length, collation, preflight, and physical reconciliation [dialect-mysql-migrations.ts:mysqlMigrationDialect].
- `migrationModel.kind` is `statement`. It supplies `systemTableExistsSql`, `isRetryableConflict` for 1050/1060/1061/1091/1205/1213, `transaction` (`START TRANSACTION`/`COMMIT`/`ROLLBACK`), and `session` (fixed strict `sql_mode`, `lock_wait_timeout = 5`, `wait_timeout = 600`, a preview lock wait, and restore statements) [dialect-mysql-migrations.ts:mysqlMigrationDialect].
- The model also declares `lock` for #69: `SELECT DATABASE()`, `namePrefix: "mira.migrations"`, `maxNameLength: 64`, `defaultTimeoutSeconds: 60`, parameterized `GET_LOCK`/`RELEASE_LOCK`/`IS_USED_LOCK = CONNECTION_ID()`/`IS_USED_LOCK` statements, `KILL CONNECTION_ID()`, and `heartbeatIntervalSeconds: 60`. It leaves `openConnection` undefined; #30's preset supplies the dedicated lock connection [dialect-mysql-migrations.ts:mysqlMigrationDialect].
- The lock name is database-scoped and always hashed (`mira.migrations:<16 hex>`), so no database or table name reaches the SQL text and the MySQL 3057 charset and 4163 length limits cannot fire. The lock statements still bind the name and timeout as parameters [migrator/lock.ts:boundLockName].
- `translatePlan` reads `information_schema.tables`, `columns`, `statistics`, and (for a destructive step) `views`. It skips steps the catalog already satisfies, returns their indices in `skipped`, and fails drift before any plan DDL [dialect-mysql-migrations.ts:translatePlan].
- A non-null `addColumn` without a default renders add-nullable, backfill, then `MODIFY NOT NULL`; the nullable intermediate shape is pending and renders only the remaining statements. A non-null column in a desired unique index is rejected in preflight [dialect-mysql-migrations.ts:translatePlan].
- Dependent views are detected with `affectedViews`/`viewDependencies` from `view-dependencies.ts`. Creates use `topologicalViewOrder`; drops run in reverse. The scan is current-schema and table-level; cross-schema views are outside it [dialect-mysql-migrations.ts:translatePlan] [view-dependencies.ts:affectedViews].
- `upsertStatement` binds metadata values with `?`; `upsert` renders the same SQL as literals. `verifyPlan` re-reads the catalog after the apply and rejects a pending step [dialect-mysql-migrations.ts:upsertStatement] [dialect-mysql-migrations.ts:verifyPlan].
- Text mapping follows issue #71: keyed or indexed text becomes `VARCHAR(n)` using `ColumnDef.maxLength`, other text stays `LONGTEXT`, and every text column gets `CHARACTER SET utf8mb4 COLLATE <effective collation>`. Indexed text without a length, over 768 characters, or over the 3072-byte composite budget fails preflight [dialect-mysql-migrations.ts:translatePlan].
- Identifier preflight is 64 Unicode code points; generated index names over 64 code points are truncated with a deterministic FNV-1a suffix. All identifiers, including `_collections.schema`, are backtick-quoted [dialect-mysql-migrations.ts:quoteIdentifier].

## MySQL text strategy (issue #71)

- ColumnDef carries maxLength and an internal collation hint, plus xCollection/xField for relation targets. schemaToColumns fills the lengths Mira controls: id/system/file 255, email/relation 320, date 64, literal text as the longest code-point literal, JSON none [schema-diff.ts:schemaToColumns].
- Ordinary text uses utf8mb4_0900_bin; the email identity uses utf8mb4_0900_as_ci so Admin@x.com and dmin@x.com remain the same account. DialectType.reconcilesTextLength makes the shared differ treat the length and keyed status as physical [dialect.ts:DialectType].
- preflightPlan runs before the metadata bootstrap. It uses the stored plan when _collections exists and the desired-only plan only when it does not, so a latent shape in an already-applied collection does not block an unrelated migration. It also runs a collation sanity SELECT over both collations [dialect-mysql-migrations.ts:preflightPlan].
- The pure text preflight rejects a keyed text column without a length, a length outside 1..768, a default longer than the length, an over-3072-byte composite index, a relation narrower than its target, and a JSON index. It runs over every table named by a step, including a table touched only by an index or drop step [dialect-mysql-migrations.ts:textPreflightError].
- The data preflight reads only objects already in the catalog: a combined MAX(CHAR_LENGTH(...)) narrowing probe, a unique duplicate GROUP BY with CONVERT(... USING utf8mb4) and the desired collation, and a LIMIT 2 unique-add existence probe. ctx.skipDataPreflight skips the layer for status [dialect-mysql-migrations.ts:textDataPreflight].
- A touched table's text columns are reconciled in one batched ALTER TABLE ... MODIFY COLUMN ..., ALGORITHM=COPY, LOCK=SHARED per table. It preserves catalog nullability and literal defaults, drops stale catalog indexes before LONGTEXT, and adds a size note [dialect-mysql-migrations.ts:reconcileTextColumns].
- The migration and preview sessions set max_sort_length = 8192, so a 768-character utf8mb4 group key is not truncated. The retry classifier still treats 1406/1062 as non-retryable [dialect-mysql-migrations.ts:mysqlMigrationDialect].
- uditTextShape is a read-only information_schema.columns scan over every desired collection. It never repairs; status uses it to report ehind and plan/migrate turn it into a warning note. #30 uses it as a release gate [dialect-mysql-migrations.ts:auditTextShape].
- dialect-mysql-text.ts exports mysqlTextCollation, mysqlEmailCollation, mysqlMaxIndexedTextLength, mysqlMaxIndexKeyBytes, mysqlCaseInsensitiveLike, and mysqlFilterSql. The LIKE renderers use LOWER and CONCAT; #30 composes them into the full dialect [dialect-mysql-text.ts].

## MySQL transaction probe (issue #72)

- `mysqlTransactionProbe` in `dialect-mysql-transactions.ts` is the ready-made `error-classified` strategy for #30. It is not root-exported, imports no MySQL driver, and is declared with `as const satisfies TransactionProbeStrategy` so its literal `_tag` stays visible to tests [dialect-mysql-transactions.ts:mysqlTransactionProbe].
- `isMysqlTransactionFatal` is deadlock-only. The primary path finds an Effect SQL `DeadlockError` reason on the error and its nested `cause`/`error` chain. The fallback is `errorHasCode(error, [1213, "ER_LOCK_DEADLOCK"])`, which the spike proved matches the outer `SqlError`, its reason, and the `mysql2` cause [dialect-mysql-transactions.ts:isMysqlTransactionFatal].
- `1205` is deliberately non-fatal. With the default `innodb_rollback_on_timeout = OFF` only the statement rolls back; with `ON`, the savepoint finalizer fails with `1305` and the wrapper guard aborts the batch. Hardcoding `1205` as fatal would fail a whole batch on a recoverable timeout [dialect-mysql-transactions.ts:MYSQL_DEADLOCK_CODES].
- Connection-loss codes are deliberately absent. The spike's `KILL` error has no `code` or `errno`, and the non-fatal path already runs `SELECT 1`, which fails on the dead connection. The batcher classifies the failed entry before the guard, so a deadlock reaches the classifier on both the multi-entry and single-entry paths.
- The real-engine coverage is `tests/databases/mysql-batch.e2e.test.ts`: multi-entry deadlock, single-entry deadlock, duplicate key, and killed connection on MySQL 8.4 and MariaDB 11.4. It uses `it.live` and a recording predicate so the test proves the classifier ran, not just that the batch failed [mysql-batch.e2e.test.ts].