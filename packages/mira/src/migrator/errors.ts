import { Data } from "effect"
import type { SqlError } from "effect/sql"

import type { MigrationStep } from "./types.js"

/**
 * A migration step the active dialect cannot render as SQL.
 *
 * Raised before the migration transaction opens, so an impossible step fails with
 * a readable reason instead of surfacing a driver-level error mid-plan.
 */
export class UnsupportedMigrationStepError extends Data.TaggedError("UnsupportedMigrationStepError")<{
  /** The step kind that could not be rendered. */
  readonly step: MigrationStep["kind"]
  /** Which step, on which table, and why it cannot be rendered. */
  readonly detail: string
}> {}

/**
 * A dialect rendered a statement that contains no SQL — an empty string or only
 * comments. Such a statement cannot be prepared, so it must never be executed.
 */
export class InvalidMigrationStatementError extends Data.TaggedError("InvalidMigrationStatementError")<{
  /** The statement exactly as the dialect rendered it. */
  readonly statement: string
}> {}

/** Everything a migration can fail with. */
export type MigrationError =
  | SqlError.SqlError
  | UnsupportedMigrationStepError
  | InvalidMigrationStatementError
