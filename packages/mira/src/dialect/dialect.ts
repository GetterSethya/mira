import { Context, Effect } from "effect"

import { UnsupportedMigrationStepError } from "@/migrator/errors.js"
import type { ColumnDef, IndexShape, MigrationStep, TableShapes } from "@/migrator/types.js"

/** What a dialect needs to render a plan, beyond the step list itself. */
export type TranslatePlanContext = {
  /** Every physical (non-view) collection the plan may touch, keyed by collection name. */
  tables: ReadonlyMap<string, TableShapes>
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
  quoteIdentifier: (name: string) => string
  /** Serializes a literal value to a SQL-safe string. */
  quoteLiteral: (value: unknown) => string
  /** Produces a deterministic index name from a table name and field list. */
  indexName: (table: string, fields: Array<string>) => string
  /** Whether this dialect stores boolean columns as 0/1 integers (true for SQLite; false for dialects with a native boolean type, e.g. Postgres). */
  storesBooleanAsInteger: boolean
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
