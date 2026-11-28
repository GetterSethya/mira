import type { TimestampUnit } from "@gettersethya/mira-client"
import type { Option, Scope } from "effect"
import type { SqlError } from "effect/sql"
import { Context, Effect, Predicate } from "effect"

import { UnsupportedMigrationStepError } from "@/migrator/errors.js"
import type { ColumnDef, MigrationStep, TableShapes } from "@/migrator/types.js"
import { transformSqlCode } from "@/sql-text.js"

/** Wraps an identifier in the dialect's quoting characters. */
export type Quote = (name: string) => string

/** A SQL string with bound parameters for a driver connection. */
export type ParameterizedStatement = {
  readonly sql: string
  readonly params: ReadonlyArray<unknown>
}

/** Schema value types used by typed rule comparisons. */
export type FieldValueType = "text" | "integer" | "number" | "boolean" | "bigint"

/**
 * How a dialect reports whether a `DELETE` removed a row.
 *
 * `returning` is the preferred shape: `DELETE ... RETURNING id` returns the
 * removed id, so the repository gets an affected-row signal from the same
 * statement. `affectedRows` is for drivers that expose a row count on the raw
 * result. `precheck` is the portable fallback: `SELECT 1` before the delete.
 *
 * Telemetry retention uses a constant `RETURNING 1` because it only needs a
 * row count. An `affectedRows` reader must return `Some(n)` for a non-negative
 * integer no larger than the retention batch size, or `None` when the raw
 * result is unreadable. `None` is fatal: the telemetry store fails with
 * `TelemetryStoreError`, and the repository dies with `DeleteResultUnknownError`.
 * Readers should return `None` instead of throwing; only the telemetry store
 * wraps a throw in `TelemetryStoreError`.
 */
export type DeleteResultStrategy =
  | { readonly _tag: "returning" }
  | {
      readonly _tag: "affectedRows"
      readonly read: (raw: unknown) => Option.Option<number>
    }
  | { readonly _tag: "precheck" }

/**
 * How the mutation batcher decides whether a failed entry ended the batch
 * transaction.
 *
 * The caller must already be inside the batch's outer transaction; a probe
 * outside one cannot tell a live transaction from a usable autocommit
 * connection.
 *
 * - `"nested-begin"`: the SQLite-family probe. After `SELECT 1` succeeds, the
 *   probe issues `BEGIN`. A failing `BEGIN` is the alive signal, because a
 *   live SQLite transaction rejects a nested `BEGIN`. A succeeding `BEGIN`
 *   means SQLite already rolled the outer transaction back implicitly, so the
 *   probe rolls the throwaway transaction back and reports not-usable.
 * - `"select-only"`: `SELECT 1` is the whole probe. A success reports usable,
 *   and a failure reports not-usable. The probe fails closed: any failure,
 *   including a statement timeout or an admin cancel, aborts the batch. No
 *   transaction control statement is issued, so the probe cannot end the
 *   outer transaction.
 * - `{ _tag: "error-classified" }`: the engine cannot answer "is my
 *   transaction open?" through SQL. The batcher classifies the failed entry's
 *   own error **before** the savepoint guard and before any probe SQL. A
 *   transaction-fatal error aborts the batch without issuing a statement.
 *   A non-fatal error falls through to the guard and then to `SELECT 1` as a
 *   connection-liveness check. This is the MySQL and MariaDB strategy.
 *
 * The string strategies are not usable on MySQL or MariaDB. A `BEGIN` either
 * fails at the prepared-statement protocol layer (`ER_UNSUPPORTED_PS`, 1295)
 * or implicitly commits, and `SELECT 1` succeeds after InnoDB has rolled the
 * whole transaction back, so it cannot distinguish a dead transaction from a
 * fresh one.
 */
export type TransactionProbeStrategy =
  | "nested-begin"
  | "select-only"
  | {
      readonly _tag: "error-classified"
      /**
       * True when the engine has already rolled back the whole transaction
       * because of this error. The batcher calls this with the failed entry's
       * own error, not the savepoint wrapper's error. A thrown predicate is
       * treated as fatal.
       */
      readonly isTransactionFatal: (error: unknown) => boolean
    }

/**
 * The stable outcome label for one transaction probe.
 *
 * - `"alive"`: the transaction is usable.
 * - `"probe-failed"`: `SELECT 1` failed; the connection or transaction is not
 *   usable.
 * - `"nested-begin-committed"`: the nested `BEGIN` succeeded, so the engine had
 *   already ended the outer transaction.
 * - `"classified-fatal"`: the dialect's error classifier decided the engine
 *   already ended the transaction. No probe SQL was issued. The batch aborts
 *   and the abort is exempt from the three-strike degradation counter.
 * - `"classifier-failed"`: the classifier threw. The batch still aborts (fail
 *   closed), but the abort is a batcher defect and counts toward the
 *   three-strike close.
 */
export type TransactionProbeVerdict =
  | "alive"
  | "probe-failed"
  | "nested-begin-committed"
  | "classified-fatal"
  | "classifier-failed"

/**
 * The stored and desired query for one view collection.
 *
 * `null` on a side means the view is absent from that side. `{ query: null }`
 * means the view is present in the schema but has no usable query.
 */
export type ViewShape = {
  readonly stored: { readonly query: string | null } | null
  readonly desired: {
    readonly query: string | null
    /**
     * Declared view property names, in insertion order. SQLite uses them to
     * validate a recreated view against the admin read path. PostgreSQL ignores
     * this field. `undefined` means the caller did not provide the list.
     */
    readonly properties?: ReadonlyArray<string>
  } | null
}

/** What a dialect needs to render a plan, beyond the step list itself. */
export type TranslatePlanContext = {
  /** Every physical (non-view) collection the plan may touch, keyed by collection name. */
  tables: ReadonlyMap<string, TableShapes>
  /** Every view collection the plan may touch, keyed by collection name. */
  views: ReadonlyMap<string, ViewShape>
  /**
   * Guarded read-only catalog `SELECT` capability, issued by the dialect during
   * render, inside the migration transaction.
   *
   * The migrator's implementation requires a `SELECT` first token and rejects
   * semicolons, so a dialect cannot turn a render into a hidden mutation path.
   * Dialects interpolate no user data into the statement.
   */
  readonly readonlyQuery: (
    statement: string
  ) => Effect.Effect<ReadonlyArray<Record<string, unknown>>, SqlError.SqlError>
  /**
   * Skip the dialect's data-reading preflight layer. `status` sets this so a
   * cheap metadata probe does not run full table scans. The pure preflight
   * still runs. `plan` and `migrate` leave it false.
   */
  readonly skipDataPreflight?: boolean
}

/**
 * Optional telemetry capability supplied by a dialect.
 *
 * The SQL telemetry store reads these hooks; the SQL-free telemetry core never
 * imports `Dialect` and never branches on a dialect name.
 */
export type TelemetryDialectHooks = {
  /** Statements that configure a connection the store owns. */
  readonly setup: ReadonlyArray<string>
  /** Statements that run after retention cleanup on a connection the store owns. */
  readonly cleanup: ReadonlyArray<string>
  /** Whether a failed setup or migration should be retried. */
  readonly isRetryable: (error: unknown) => boolean
  /**
   * Whether the store should retry a failed append or retention delete.
   * Defaults to false. MySQL sets it and provides `isDmlRetryable`.
   */
  readonly retryDml?: boolean
  /**
   * Retry classifier for append and retention deletes. It must exclude errors
   * that already ended the caller's transaction, such as a MySQL deadlock.
   */
  readonly isDmlRetryable?: (error: unknown) => boolean
  /**
   * Suffix appended to a telemetry batch insert so a duplicate row id becomes a
   * no-op instead of a constraint error.
   *
   * The store passes the dialect-quoted id column, for example `"id"`. Absent
   * means `ON CONFLICT (<quoted id>) DO NOTHING`. A dialect that needs another
   * form overrides this hook; the returned clause is trusted SQL and must not
   * contain user input.
   */
  readonly insertConflictClause?: (quotedId: string) => string
}

/**
 * Capabilities the internal auth, session, rate-limit, and cron stores need.
 *
 * The HTTP auth email flow also reads `isDuplicateKey` when a confirmation
 * update loses a race for a unique email address.
 */

/** One assignment in a dialect-rendered upsert clause. */
export type StoreUpsertAssignment =
  | { readonly column: string; readonly kind: "excluded" }
  | { readonly column: string; readonly kind: "increment-by-one" }

/**
 * How the auth challenge store keeps one live row per
 * `(collection, user_id, purpose)`.
 *
 * `partial` is the SQLite and PostgreSQL partial unique index. `generated` is
 * the MySQL generated column plus a unique index, because MySQL cannot express
 * a partial index. The statements are dialect-rendered and fully quoted.
 */
export type StoreChallengeLive =
  | {
      readonly mode: "partial"
      readonly indexName: string
      readonly indexStatement: string
    }
  | {
      readonly mode: "generated"
      readonly column: string
      readonly addColumnStatement: string
      readonly indexName: string
      readonly indexStatement: string
    }

/**
 * How a store reads an UPDATE result.
 *
 * `returning` means the statement may use a RETURNING clause.
 * `affectedRows` means the store reads `.raw` through the supplied reader.
 * The rate-limit and challenge-attempt paths additionally use the tag to
 * choose the locked-transaction strategy, because MySQL has neither a
 * guarded conditional upsert nor UPDATE RETURNING. A simple UPDATE (for
 * example consume-by-id) only needs the reader, not a transaction.
 */
export type StoreMutationResult = Exclude<DeleteResultStrategy, { readonly _tag: "precheck" }>

export type StoreSqlCapabilities = {
  /** Text type for any indexed text column. */
  readonly keyColumnType: string
  /** Text type for non-keyed text columns. */
  readonly textColumnType: string
  /** Text type for the rate-limit bucket column. */
  readonly bucketColumnType: string
  /** Maximum code points allowed in a rate-limit bucket. */
  readonly bucketMaxLength: number
  /** Renders a complete index statement for this dialect. */
  readonly createIndexIfNotExists: (
    name: string,
    table: string,
    columns: ReadonlyArray<string>,
    unique: boolean
  ) => string
  /** Whether a duplicate column/index bootstrap error can be ignored. */
  readonly isIgnorableBootstrapError: (error: unknown) => boolean
  /** Renders the conflict clause that ignores a duplicate key. */
  readonly insertIgnoreClause: (conflictKeys: ReadonlyArray<string>) => string
  /** Renders the conflict clause for an upsert. */
  readonly upsertClause: (
    conflictKeys: ReadonlyArray<string>,
    assignments: ReadonlyArray<StoreUpsertAssignment>
  ) => string
  /** How UPDATE results are reported. */
  readonly mutationResult: StoreMutationResult
  /** How the challenge store enforces one live row. */
  readonly challengeLive: StoreChallengeLive
  /**
   * Returns a complete SQL query with one row when the column exists and zero
   * rows when it does not. The caller executes it with `sql.unsafe(query)` and
   * checks the row count.
   */
  readonly columnExistsSql: (table: string, column: string) => string
  /** Whether a failed SQL statement is safe to retry by the caller. */
  readonly isRetryable: (error: unknown) => boolean
  /**
   * Whether a failed write was rejected because a primary-key or unique-index
   * value already exists. Classify by structured driver values, not message
   * text.
   */
  readonly isDuplicateKey: (error: unknown) => boolean
  /**
   * Session statements for the bootstrap transaction, such as a metadata-lock
   * timeout. Only the transaction arm uses them.
   */
  readonly bootstrapSetupSql?: ReadonlyArray<string>
  /**
   * Statements that restore the bootstrap connection before it returns to the
   * pool. Run on the same connection after the callback, on success or failure.
   */
  readonly bootstrapRestoreSql?: ReadonlyArray<string>
  /**
   * Optional transaction-local lock timeout for request-path write
   * transactions. SQLite omits it. PostgreSQL uses
   * `SET LOCAL lock_timeout = '2s'`.
   */
  readonly transactionLockTimeoutSql?: string
} & (
  | {
      /** The DDL runs outside a transaction, matching SQLite and libSQL today. */
      readonly bootstrapMode: "plain"
    }
  | {
      /** The DDL runs inside one transaction after these statements. */
      readonly bootstrapMode: "transaction"
      readonly bootstrapSql: ReadonlyArray<string>
    }
)

/** SQL for a whole plan, plus statements that must run even when the plan fails. */
export type TranslatedPlan = {
  /** Statements to run inside the migration transaction, in order. */
  statements: Array<string>
  /**
   * Read-only statements that validate the result of the DDL, such as SQLite's
   * view probes. The migrator runs these after `statements` inside the same
   * transaction. They return no rows and must not mutate state.
   */
  readonly validations?: ReadonlyArray<string>
  /**
   * Statements that restore connection-level state a plan mutated (a pragma, for
   * instance). The migrator runs these after the transaction ends, on success *and*
   * on failure — a rollback would skip anything a plan appended at its own end.
   */
  cleanup: Array<string>
  /**
   * Optional statement-level notes for operations the dialect synthesized but
   * the abstract plan does not list, such as dependent-view drops and creates.
   */
  readonly notes?: ReadonlyArray<string>
  /**
   * Indices into the input steps that the catalog already satisfies. A
   * statement-mode dialect must supply it so the migrator can evaluate the
   * destructive gate against pending steps only.
   */
  readonly skipped?: ReadonlyArray<number>
}

/**
 * The statement/query surface a migration lock needs.
 *
 * It mirrors `MigrationExecutor` but is declared here so an external statement
 * dialect can implement a dedicated lock connection without importing the
 * migrator internals.
 */
export type LockExecutor = {
  readonly run: (statement: string) => Effect.Effect<void, SqlError.SqlError>
  readonly runParameterized: (statement: ParameterizedStatement) => Effect.Effect<void, SqlError.SqlError>
  readonly query: (statement: string) => Effect.Effect<ReadonlyArray<Record<string, unknown>>, SqlError.SqlError>
  readonly queryParameterized: (
    statement: ParameterizedStatement
  ) => Effect.Effect<ReadonlyArray<Record<string, unknown>>, SqlError.SqlError>
}

/** A dedicated lock connection and the idempotent close the migrator calls. */
export type LockConnection = {
  readonly executor: LockExecutor
  /** Force-close the underlying session. Must be idempotent. */
  readonly destroy: Effect.Effect<void>
}

/**
 * A session-scoped migration lock capability.
 *
 * Only statement-mode dialects declare it, because only engines that commit DDL
 * implicitly need mutual exclusion outside a transaction. Every statement and
 * column alias is part of the contract; the migrator reads exactly the named
 * aliases.
 */
export type MigrationLock = {
  /** Returns one row with `database_name`, which may be NULL. */
  readonly databaseNameSql: string
  /** Lowercase ASCII prefix without a trailing colon, for example `mira.migrations`. */
  readonly namePrefix: string
  /** Maximum characters Mira will emit. */
  readonly maxNameLength: number
  /** Wait used by `migrate` when the caller does not override it. */
  readonly defaultTimeoutSeconds: number
  /** Blocking up to timeoutSeconds; 0 is non-blocking. Returns one `acquired` column. */
  readonly acquireStatement: (name: string, timeoutSeconds: number) => ParameterizedStatement
  /** Returns one `released` column, which may be NULL. */
  readonly releaseStatement: (name: string) => ParameterizedStatement
  /** Returns one `held_by_me` column: whether this connection still owns the name. */
  readonly usedStatement: (name: string) => ParameterizedStatement
  /** Returns one `holder` column: the holder connection id or NULL, for busy diagnostics. */
  readonly holderStatement: (name: string) => ParameterizedStatement
  /** Kills the holder session as a last resort. Optional. */
  readonly killSelfStatement?: ParameterizedStatement
  /** Heartbeat interval for a dedicated lock connection. Defaults to 60. */
  readonly heartbeatIntervalSeconds?: number
  /**
   * Optional dedicated lock connection. The returned `destroy` force-closes the
   * underlying session and is idempotent. When present, the migrator uses this
   * executor for the lock and the reserved connection only for DDL.
   */
  readonly openConnection?: Effect.Effect<LockConnection, SqlError.SqlError, Scope.Scope>
}

/**
 * How the migrator applies a plan.
 *
 * `transaction` is the existing single-transaction path. `statement` is for
 * engines that commit DDL implicitly: it reserves one connection, applies
 * statements outside a transaction, verifies the catalog, and writes metadata
 * last.
 */
export type MigrationModel =
  | { readonly kind: "transaction" }
  | {
      readonly kind: "statement"
      /** Returns one row when the table exists. */
      readonly systemTableExistsSql: (table: string) => string
      /** Classifies a failed statement as safe to retry after a fresh render. */
      readonly isRetryableConflict: (error: unknown) => boolean
      /** Transaction control statements for the reserved connection. */
      readonly transaction: {
        readonly beginSql: string
        readonly commitSql: string
        readonly rollbackSql: string
      }
      /**
       * Session settings for the reserved migration connection. The migrator
       * reads the previous values, applies `setupSql`, and runs `restoreSql` on
       * the same connection in the cleanup path.
       */
      readonly session?: {
        readonly readSql: string
        readonly setupSql: ReadonlyArray<string>
        /** Session settings for a read-only preview. */
        readonly previewSetupSql?: ReadonlyArray<string>
        readonly restoreSql: (previous: Readonly<Record<string, unknown>>) => ReadonlyArray<string>
      }
      /**
       * Session-scoped migration lock. Omitted when the engine needs none.
       * Declaring it serializes `migrate` and makes `plan`/`status` fail busy
       * while a migration or another preview holds the database lock.
       */
      readonly lock?: MigrationLock
    }

/**
 * Interface a SQL dialect must implement to translate abstract `MigrationStep` values
 * into executable SQL strings and to handle quoting/naming conventions.
 */
export type DialectType = {
  /**
   * Renders a whole plan as SQL.
   *
   * A dialect that can express every step on its own implements this with
   * {@link perStepPlan}. A dialect that cannot — SQLite has no `ALTER COLUMN`, so
   * changing a column means rebuilding the table — coalesces the steps of the
   * affected tables here. Keeping that at this boundary leaves `MigrationStep`, the
   * schema differ and `Migrator.plan()` free of any dialect-specific notion.
   *
   * The error channel includes `SqlError.SqlError` for a failed catalog read
   * through `ctx.readonlyQuery`. Implementations with a narrower channel remain
   * assignable, because Effect is covariant in the error channel.
   */
  translatePlan: (
    steps: ReadonlyArray<MigrationStep>,
    ctx: TranslatePlanContext
  ) => Effect.Effect<TranslatedPlan, UnsupportedMigrationStepError | SqlError.SqlError>
  /** Translates a single `MigrationStep` into one or more SQL statements. */
  translate: (step: MigrationStep) => Array<string>
  /** Returns the dialect's native SQL type keyword for a given `ColumnDef`. */
  nativeType: (col: ColumnDef) => string
  /** Wraps an identifier (table or column name) in dialect-appropriate quotes. */
  quoteIdentifier: Quote
  /** Current time in a value comparable to this dialect's stored timestamp text. */
  currentTimestamp: () => string
  /** Adds a signed amount of a unit to a timestamp expression. */
  timestampAdd: (expr: string, amount: number, unit: TimestampUnit) => string
  /** Difference between two timestamp expressions in the requested unit. */
  timestampDiff: (left: string, right: string, unit: TimestampUnit) => string
  /** Case-insensitive prefix or infix match. */
  caseInsensitiveLike: (left: string, right: string, mode: "prefix" | "contains") => string
  /**
   * Renders a case-insensitive match of `left` against a complete pattern
   * expression `right`.
   *
   * The renderer adds no wildcards, consumes `right` exactly once, returns a SQL
   * string, and does not transform the pattern value: the value stays a bound
   * parameter supplied by the caller. The filter compiler invokes it as a plain
   * function, so a call site that passes a dialect method must bind it with a
   * closure, `(left, right) => dialect.caseInsensitivePattern(left, right)`, to
   * keep the method's receiver.
   */
  caseInsensitivePattern: (left: string, right: string) => string
  /** Casts a value expression for a typed rule comparison. */
  castValue: (expr: string, type: FieldValueType) => string
  /** Serializes a literal value to a SQL-safe string. */
  quoteLiteral: (value: unknown) => string
  /** Produces a deterministic index name from a table name and field list. */
  indexName: (table: string, fields: Array<string>) => string
  /** Whether this dialect stores boolean columns as 0/1 integers (true for SQLite; false for dialects with a native boolean type, e.g. Postgres). */
  storesBooleanAsInteger: boolean
  /** How `DELETE` reports whether it removed a row. */
  deleteResult: DeleteResultStrategy
  /**
   * Numbered placeholder for a statement parameter. SQLite and MySQL return
   * `"?"`; PostgreSQL returns `"$" + index`.
   */
  placeholder: (index: number) => string
  /**
   * How the mutation batcher decides whether a failed entry ended the batch
   * transaction.
   *
   * The batcher reads this once at layer build. For the `error-classified`
   * object it runs `isTransactionFatal` on the failed entry's own error before
   * the savepoint guard and before any probe SQL; a non-fatal verdict, and
   * every string strategy, then runs the liveness probe while the outer
   * transaction is open. Omission is a compile error because no strategy is
   * safe to inherit on an engine that has not verified it. See
   * {@link TransactionProbeStrategy} for the three strategies, their failure
   * rules, and the classify-before-guard order.
   */
  readonly transactionProbe: TransactionProbeStrategy
  /**
   * Portable upsert used by the migrator for schema metadata. SQLite and
   * PostgreSQL use `ON CONFLICT`; MySQL uses `ON DUPLICATE KEY UPDATE`.
   *
   * Every identifier goes through {@link quoteIdentifier} and every value
   * through {@link quoteLiteral}. Schema JSON can contain quotes and
   * backslashes.
   */
  upsert: (table: string, record: Readonly<Record<string, unknown>>, conflictKeys: ReadonlyArray<string>) => string
  /**
   * Parameterized form of {@link upsert}. A statement-mode dialect must supply
   * it so metadata JSON is bound instead of escaped.
   */
  readonly upsertStatement?: (
    table: string,
    record: Readonly<Record<string, unknown>>,
    conflictKeys: ReadonlyArray<string>
  ) => ParameterizedStatement
  /**
   * Verifies the physical catalog after a statement-mode apply. A statement
   * dialect must supply it; transactional dialects omit it.
   */
  readonly verifyPlan?: (
    steps: ReadonlyArray<MigrationStep>,
    ctx: TranslatePlanContext
  ) => Effect.Effect<void, UnsupportedMigrationStepError | SqlError.SqlError>
  /** Capabilities used by the internal SQL stores. */
  readonly store: StoreSqlCapabilities
  /** Optional telemetry connection and error-classification hooks. */
  readonly telemetry?: TelemetryDialectHooks
  /** How the migrator applies a plan. Required so no dialect inherits a model. */
  readonly migrationModel: MigrationModel
  /**
   * Statements the migrator runs first inside the migration transaction,
   * before it creates the system tables, reads the stored schemas, and renders
   * the plan.
   *
   * A dialect uses these to pin an isolation level, take a transaction-scoped
   * lock, or set a transaction-local timeout for the DDL that follows. SQLite
   * and libSQL omit it because their write transaction already serializes the
   * DDL it contains.
   */
  readonly migrationTransactionSetupSql?: ReadonlyArray<string>
  /**
   * A statement that acquires a non-blocking lock for `Migrator.plan` and
   * `Migrator.status`.
   *
   * It must return one boolean column named `acquired`, and a false result
   * fails with `MigrationBusyError` instead of waiting behind a running
   * migration. SQLite and libSQL omit it.
   */
  readonly migrationPreviewLockSql?: string
  /**
   * Release statement for a session-scoped preview lock. A statement-mode
   * dialect that supplies {@link migrationPreviewLockSql} must supply this so
   * the preview can release the lock on the same connection.
   */
  readonly migrationPreviewUnlockSql?: string
  /**
   * Whether the collection decoder normalizes a `bigint` `seqId` to a
   * canonical decimal string.
   *
   * A dialect that decodes `BIGINT` identity columns as JavaScript `bigint`
   * sets this to true. SQLite and libSQL omit it, keeping the identity decode
   * fast path.
   */
  readonly normalizesBigintSeqId?: boolean
  /**
   * Whether a declared text length is a physical DDL property that the
   * migrator must compare and reconcile. SQLite and PostgreSQL omit it.
   */
  readonly reconcilesTextLength?: boolean
  /**
   * Pure preflight that runs before the metadata bootstrap. A statement-mode
   * dialect can reject a shape before any DDL exists. Optional; transactional
   * dialects omit it because their plan rolls back.
   */
  readonly preflightPlan?: (
    steps: ReadonlyArray<MigrationStep>,
    ctx: TranslatePlanContext
  ) => Effect.Effect<void, UnsupportedMigrationStepError | SqlError.SqlError>
  /**
   * Read-only catalog audit of every desired collection's text shape. Returns
   * human-readable drift strings. The audit never repairs.
   */
  readonly auditTextShape?: (ctx: TranslatePlanContext) => Effect.Effect<ReadonlyArray<string>, SqlError.SqlError>
}

/** The dialect surface the migrator needs. */
export type MigrationDialect = Pick<
  DialectType,
  | "translatePlan"
  | "translate"
  | "quoteIdentifier"
  | "upsert"
  | "upsertStatement"
  | "verifyPlan"
  | "migrationModel"
  | "migrationTransactionSetupSql"
  | "migrationPreviewLockSql"
  | "migrationPreviewUnlockSql"
  | "reconcilesTextLength"
  | "preflightPlan"
  | "auditTextShape"
>

/** A statement-mode dialect with the capabilities that mode requires. */
export type StatementMigrationDialect = MigrationDialect & {
  readonly migrationModel: Extract<MigrationModel, { kind: "statement" }>
  readonly upsertStatement: NonNullable<DialectType["upsertStatement"]>
  readonly verifyPlan: NonNullable<DialectType["verifyPlan"]>
}

/** Narrow dialect view used by rule compilation, caching, and cache tags. */
export type RuleSqlDialect = Pick<
  DialectType,
  "quoteIdentifier" | "currentTimestamp" | "timestampAdd" | "timestampDiff" | "caseInsensitiveLike" | "castValue"
>

/**
 * Narrow dialect view used by physical schema rendering.
 *
 * Despite the name, it also carries literal encoding and the boolean-storage
 * flag because DDL rendering and row decoding must agree on those conventions.
 */
export type DdlSqlDialect = Pick<
  DialectType,
  | "translatePlan"
  | "translate"
  | "nativeType"
  | "quoteIdentifier"
  | "quoteLiteral"
  | "indexName"
  | "storesBooleanAsInteger"
>

/**
 * Rewrites anonymous `?` tokens to the dialect's placeholders. Quoted
 * identifiers and string literals are left untouched.
 */
export function rewritePlaceholders(statement: string, dialect: Pick<DialectType, "placeholder">): string {
  let index = 0
  return transformSqlCode(statement, (code) => code.replace(/\?/g, () => dialect.placeholder(++index)))
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

const DEFAULT_ERROR_CODE_KEYS = ["code", "errno", "errstr"] as const

/**
 * Finds an error code value inside an error shape, including nested
 * `cause`/`reason` fields. Useful for driver-neutral retry and duplicate
 * predicates without importing a driver.
 *
 * The default keys are `code`, `errno`, and `errstr`. A caller can pass a wider
 * key list for a driver that stores codes under `errcode`, `extendedCode`, or
 * `rawCode`. Matching is on exact values; this does not inspect message text.
 */
export function errorHasCode(
  error: unknown,
  codes: ReadonlyArray<string | number>,
  keys: ReadonlyArray<string> = DEFAULT_ERROR_CODE_KEYS
): boolean {
  const wanted = new Set(codes.map(String))
  const seen = new Set<unknown>()
  const stack: Array<unknown> = [error]

  while (stack.length > 0) {
    const value = stack.pop()
    if (!isRecord(value) || seen.has(value)) continue
    seen.add(value)

    for (const key of keys) {
      const candidate = value[key]
      const text =
        typeof candidate === "string"
          ? candidate
          : typeof candidate === "number" || typeof candidate === "bigint"
            ? String(candidate)
            : undefined
      if (text !== undefined && wanted.has(text)) return true
    }

    for (const key of ["reason", "cause", "error", "details"] as const) {
      const nested = value[key]
      if (nested !== undefined) stack.push(nested)
    }
  }

  return false
}

/**
 * Whether an Effect SQL error carries a structured `UniqueViolation` reason.
 * This is a fallback for a driver that classifies the error but stores its code
 * under a field the caller does not know.
 */
export const hasUniqueViolationReason = (error: unknown): boolean =>
  Predicate.isObject(error) &&
  Predicate.hasProperty(error, "reason") &&
  Predicate.isTagged(error.reason, "UniqueViolation")

/** Builds a retry predicate from one or more driver error codes. */
export function retryableByCauseCode(codes: ReadonlyArray<string | number>) {
  return (error: unknown) => errorHasCode(error, codes)
}

/**
 * Renders one step, failing when the dialect produces no SQL for it.
 *
 * Every step has to become at least one executable statement: a step that silently
 * renders as nothing would leave the schema half-migrated.
 */
export function translateStep(
  translate: (step: MigrationStep) => Array<string>,
  step: MigrationStep
): Effect.Effect<Array<string>, UnsupportedMigrationStepError> {
  const statements = translate(step)
  if (statements.length === 0) {
    return Effect.fail(
      new UnsupportedMigrationStepError({
        step: step.kind,
        detail: "the dialect produced no SQL for this step"
      })
    )
  }
  return Effect.succeed(statements)
}

/** `translatePlan` for dialects that can express every step on its own. */
export function perStepPlan(translate: (step: MigrationStep) => Array<string>): DialectType["translatePlan"] {
  return (steps) =>
    Effect.gen(function* () {
      const statements: Array<string> = []
      for (const step of steps) {
        statements.push(...(yield* translateStep(translate, step)))
      }
      return { statements, cleanup: [] }
    })
}

/** Effect `Context.Tag` for the active SQL dialect. Inject via `Layer.succeed(Dialect, sqliteDialect)`. */
export class Dialect extends Context.Service<Dialect, DialectType>()("Dialect") {}
