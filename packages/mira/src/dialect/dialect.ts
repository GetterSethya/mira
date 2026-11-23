import type { TimestampUnit } from "@gettersethya/mira-client"
import type { Option } from "effect"
import { Context, Effect, Predicate } from "effect"

import { UnsupportedMigrationStepError } from "@/migrator/errors.js"
import type { ColumnDef, MigrationStep, TableShapes } from "@/migrator/types.js"
import { transformSqlCode } from "@/sql-text.js"

/** Wraps an identifier in the dialect's quoting characters. */
export type Quote = (name: string) => string

/** Schema value types used by typed rule comparisons. */
export type FieldValueType = "text" | "integer" | "number" | "boolean"

/**
 * How a dialect reports whether a `DELETE` removed a row.
 *
 * `returning` is the preferred shape: `DELETE ... RETURNING id` returns the
 * removed id, so the repository gets an affected-row signal from the same
 * statement. `affectedRows` is for drivers that expose a row count on the raw
 * result. `precheck` is the portable fallback: `SELECT 1` before the delete.
 */
export type DeleteResultStrategy =
  | { readonly _tag: "returning" }
  | {
      readonly _tag: "affectedRows"
      readonly read: (raw: unknown) => Option.Option<number>
    }
  | { readonly _tag: "precheck" }

/**
 * How the mutation batcher probes transaction liveness after a failed entry.
 *
 * The caller must already be inside the batch's outer transaction; a probe
 * outside one cannot tell a live transaction from a usable autocommit
 * connection. Both strategies run `SELECT 1` first and treat its failure as
 * not-usable.
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
 *
 * MySQL and SQL Server must verify either strategy against their engine before
 * choosing one. A nested `BEGIN` implicitly commits in MySQL and nests in SQL
 * Server, so `"nested-begin"` is known-unsafe there, and the applicability of
 * `"select-only"` is unverified.
 */
export type TransactionProbeStrategy = "nested-begin" | "select-only"

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
export type StoreSqlCapabilities = {
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
   */
  translatePlan: (
    steps: ReadonlyArray<MigrationStep>,
    ctx: TranslatePlanContext
  ) => Effect.Effect<TranslatedPlan, UnsupportedMigrationStepError>
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
  caseInsensitiveLike: (
    left: string,
    right: string,
    mode: "prefix" | "contains"
  ) => string
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
   * How the mutation batcher probes transaction liveness after a failed entry
   * in a multi-entry batch.
   *
   * The batcher reads this once at layer build and runs the probe only while
   * the outer transaction is open. Omission is a compile error because no
   * strategy is safe to inherit on an engine that has not verified it. See
   * {@link TransactionProbeStrategy} for both strategies and their failure
   * rules.
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
  upsert: (
    table: string,
    record: Readonly<Record<string, unknown>>,
    conflictKeys: ReadonlyArray<string>
  ) => string
  /** Capabilities used by the internal SQL stores. */
  readonly store: StoreSqlCapabilities
  /** Optional telemetry connection and error-classification hooks. */
  readonly telemetry?: TelemetryDialectHooks
}

/** Narrow dialect view used by rule compilation, caching, and cache tags. */
export type RuleSqlDialect = Pick<
  DialectType,
  | "quoteIdentifier"
  | "currentTimestamp"
  | "timestampAdd"
  | "timestampDiff"
  | "caseInsensitiveLike"
  | "castValue"
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
export function rewritePlaceholders(
  statement: string,
  dialect: Pick<DialectType, "placeholder">
): string {
  let index = 0
  return transformSqlCode(statement, (code) =>
    code.replace(/\?/g, () => dialect.placeholder(++index))
  )
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

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
      if (candidate !== undefined && wanted.has(String(candidate))) return true
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
export function perStepPlan(
  translate: (step: MigrationStep) => Array<string>
): DialectType["translatePlan"] {
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
