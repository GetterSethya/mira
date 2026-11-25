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
- `DialectType` (type) - the contract: `translatePlan`, `translate`, `nativeType`, `quoteIdentifier`, `currentTimestamp`, `timestampAdd`, `timestampDiff`, `caseInsensitiveLike`, `caseInsensitivePattern`, `castValue`, `quoteLiteral`, `indexName`, `storesBooleanAsInteger`, `deleteResult`, `transactionProbe`, `placeholder`, `upsert`, required `store`, optional `telemetry`, optional `migrationTransactionSetupSql`, optional `migrationPreviewLockSql`, and optional `normalizesBigintSeqId` [dialect.ts:DialectType]
- `DialectType.caseInsensitivePattern(left, right)` - complete-pattern match: match `left` against a whole `LIKE` pattern in `right` with no added wildcards. Consumes `right` once, returns SQL, and leaves the pattern a bound parameter. The compiler invokes it as a plain function, so a call site passing a dialect method must bind it with a closure [dialect.ts:DialectType]
- `DialectType.transactionProbe` (required `TransactionProbeStrategy`) - how the mutation batcher probes transaction liveness after a failed entry: `nested-begin` uses `SELECT 1` then `BEGIN` (SQLite family), `select-only` uses just `SELECT 1` (PostgreSQL). Neither strategy is verified for MySQL or SQL Server, so a custom dialect must verify its engine before choosing either; there is no silent default [dialect.ts:DialectType] [dialect.ts:TransactionProbeStrategy]
- `DeleteResultStrategy` (type) - how a `DELETE` reports an affected row: `returning`, `affectedRows`, or `precheck` [dialect.ts:DeleteResultStrategy]
- `TranslatePlanContext` (type) - `{ tables, views }` passed to `translatePlan`; `views` maps view names to stored/desired query shapes [dialect.ts:TranslatePlanContext]
- `TranslatedPlan` (type) - `{ statements, cleanup, notes? }` returned by `translatePlan` [dialect.ts:TranslatedPlan]
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

- `DialectType` gains a required flat member `transactionProbe: TransactionProbeStrategy`, with `TransactionProbeStrategy = "nested-begin" | "select-only"` re-exported from the package root alongside `DialectType`. There is no silent default: omission is a compile error for a custom dialect [dialect.ts:TransactionProbeStrategy].
- `nested-begin` is the SQLite behavior: `SELECT 1` fails on a dead connection, then `BEGIN` fails while the outer transaction is alive and succeeds once SQLite has implicitly rolled it back, at which point the probe rolls the throwaway transaction back. `sqliteDialect` declares it [dialect-sqlite.ts:sqliteDialect] [mutation-batcher.ts:probeTransactionAlive].
- `select-only` is the PostgreSQL behavior: `SELECT 1` is the whole probe. Inside the flusher's outer transaction a successful `SELECT` means the transaction is usable and a failed `SELECT` means it is not; no transaction control statement is issued, so the probe cannot abort the outer transaction [mutation-batcher.ts:probeTransactionAlive].
- libSQL inherits the SQLite declaration: local mode returns `sqliteDialect` and remote mode spreads it, so both use `nested-begin` [dialect-libsql.ts:libsqlDialect].
- Neither strategy is verified for MySQL or SQL Server. `BEGIN` inside an open transaction implicitly commits in MySQL and nests in SQL Server, so `nested-begin` is known-unsafe there and the applicability of `select-only` is unverified; a custom dialect must verify its engine before choosing either [dialect.ts:TransactionProbeStrategy].
- The PostgreSQL transaction contract is verified by the environment-gated `tests/collection-service/postgres-batch.test.ts`, which self-skips unless `MIRA_TEST_POSTGRES_URL` is set. The PostgreSQL preset ships in this change.

## PostgreSQL dialect (issue #29)

- `postgresDialect` is one composed `DialectType`. It spreads `postgresDdlSql`, `postgresRuleSql`, and `postgresFilterSql`, and adds `placeholder(index) => "$" + index`, an `ON CONFLICT` upsert with a `DO NOTHING` fallback when every column is a conflict key, `deleteResult: returning`, `transactionProbe: select-only`, `store: postgresStoreSql`, `telemetry: postgresTelemetry`, and `normalizesBigintSeqId: true` [dialect-postgres.ts:postgresDialect].
- `postgresTelemetry` has empty setup and cleanup lists because PostgreSQL has no PRAGMAs and no WAL checkpoint. Its `isRetryable` reuses `postgresStoreSql.isRetryable`, so `40001`, `40P01`, and `55P03` live in one predicate [dialect-postgres.ts:postgresTelemetry].
- `migrationTransactionSetupSql` is `SET LOCAL transaction_isolation = 'read committed'`, then `SELECT pg_advisory_xact_lock(hashtextextended('mira.migrations', 0))`, then `SET LOCAL lock_timeout = '5s'`. The isolation level makes the post-wait re-read see the committed schema; the lock serializes replicas; the timeout is set after the lock, so it bounds the DDL table locks but not the advisory wait [dialect-postgres.ts:postgresDialect].
- `migrationPreviewLockSql` is the non-blocking `pg_try_advisory_xact_lock` query returning one `acquired` column. `Migrator.plan` and `Migrator.status` fail with `MigrationBusyError` when it returns false instead of waiting for a running migration [dialect-postgres.ts:postgresDialect] [migrator.ts:planImplWith].
- `normalizesBigintSeqId` tells the collection decoder to convert a driver `bigint` `seqId` to the canonical decimal cursor string. SQLite and libSQL omit it and keep the identity fast path [dialect-postgres.ts:postgresDialect] [decode.ts:normalizeSeqId].
- `postgresDdlSql.quoteLiteral` renders text as `E'...'` with backslashes and single quotes escaped, independent of `standard_conforming_strings`. The `_collections` schema JSON is written through this path [dialect-postgres.ts:quoteLiteral].
- `postgresRuleSql.castValue` handles `"bigint"` as `::bigint`. The rule compiler casts a string literal to the known column type and leaves the column uncast, so `age >= "18"` compares numerically instead of lexicographically [dialect-postgres.ts:postgresRuleSql] [rule/compiler.ts:hintForComparison].
- The PostgreSQL DDL still performs the 63-byte identifier preflight for table, column, view, and index-field names, and truncates generated index names with a deterministic FNV-1a suffix. Untracked views and `CREATE VIEW` name conflicts fail at the statement and roll back; PostgreSQL has no `sqlite_master` scan and no `CREATE VIEW IF NOT EXISTS` [dialect-postgres.ts:postgresDdlSql].
