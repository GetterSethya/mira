import type { TimestampUnit } from "@gettersethya/mira-client"
import { Context, Effect, Option } from "effect"

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

/** What a dialect needs to render a plan, beyond the step list itself. */
export type TranslatePlanContext = {
  /** Every physical (non-view) collection the plan may touch, keyed by collection name. */
  tables: ReadonlyMap<string, TableShapes>
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
   * Whether an append failed because the row id already exists. A retry of a
   * committed batch then treats the single duplicate row as success instead of
   * losing it or duplicating the other rows.
   */
  readonly isDuplicateKey: (error: unknown) => boolean
}

/** SQL for a whole plan, plus statements that must run even when the plan fails. */
export type TranslatedPlan = {
  /** Statements to run inside the migration transaction, in order. */
  statements: Array<string>
  /**
   * Statements that restore connection-level state a plan mutated (a pragma, for
   * instance). The migrator runs these after the transaction ends, on success *and*
   * on failure — a rollback would skip anything a plan appended at its own end.
   */
  cleanup: Array<string>
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

/**
 * Finds a `code` or `errno` value inside an error shape, including nested
 * `cause`/`reason` fields. Useful for driver-neutral retry and duplicate
 * predicates without importing a driver.
 */
export function errorHasCode(error: unknown, codes: ReadonlyArray<string | number>): boolean {
  const wanted = new Set(codes.map(String))
  const seen = new Set<unknown>()
  const stack: Array<unknown> = [error]

  while (stack.length > 0) {
    const value = stack.pop()
    if (value === null || typeof value !== "object" || seen.has(value)) continue
    seen.add(value)

    const record = value as Record<string, unknown>
    for (const key of ["code", "errno", "errstr"] as const) {
      const candidate = record[key]
      if (candidate !== undefined && wanted.has(String(candidate))) return true
    }

    for (const key of ["reason", "cause", "error", "details"] as const) {
      const nested = record[key]
      if (nested !== undefined) stack.push(nested)
    }
  }

  return false
}

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
