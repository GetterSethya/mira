import { Data } from "effect"
import type { SqlError } from "effect/sql"

import type { MigrationStep } from "./types.js"

/**
 * A migration step the active dialect cannot render safely, or the database
 * holds an object the plan would silently damage.
 *
 * Raised inside the migration transaction, because a plan is now rendered after
 * the stored-schema read. An impossible step fails with a readable reason
 * instead of surfacing a driver-level error mid-plan.
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

/**
 * A `plan`, `status`, or `migrate` call could not take the migration lock
 * because a migration or another preview holds it.
 *
 * SQLite and libSQL omit the lock and never raise this.
 */
export class MigrationBusyError extends Data.TaggedError("MigrationBusyError")<{
  /** Which operation could not run. */
  readonly operation: "plan" | "status" | "migrate"
  /** A short explanation for logs and CLI output. */
  readonly message: string
}> {}

/**
 * The migration lock could not be configured, resolved, cleared, or acquired.
 *
 * Raised for a missing database, a lock connection pointed at another
 * database, an invalid `migrationLockTimeoutSeconds`, an engine that rejects
 * the lock statements, or an unexpected `GET_LOCK` result.
 */
export class MigrationLockError extends Data.TaggedError("MigrationLockError")<{
  /** Which lock, on which target, and why it failed. */
  readonly detail: string
}> {}

/**
 * A migration lock could not be verified as released.
 *
 * This is a defect, not part of {@link MigrationError}: the connection may still
 * hold the lock, and the boot must fail instead of continuing after an
 * unverified release. The dedicated path destroys the lock connection before
 * dying; the fallback path kills the holder session.
 */
export class MigrationLockReleaseError extends Data.TaggedError("MigrationLockReleaseError")<{
  readonly lockName: string
  /** True when the same-session kill statement was issued. */
  readonly killed: boolean
  /** True when a dedicated lock connection was explicitly destroyed. */
  readonly destroyed: boolean
  readonly cause: unknown
}> {}

/**
 * A statement-mode metadata transaction could not be rolled back.
 *
 * This is a defect, not part of {@link MigrationError}: the connection may still
 * hold an open transaction, and Effect SQL has no discard API. The migrator
 * dies with this error so the boot fails and the pool closes.
 */
export class MigrationRollbackError extends Data.TaggedError("MigrationRollbackError")<{
  readonly cause: unknown
}> {}

/** Everything a migration can fail with. */
export type MigrationError =
  | SqlError.SqlError
  | UnsupportedMigrationStepError
  | InvalidMigrationStatementError
  | MigrationBusyError
  | MigrationLockError
