import { Predicate } from "effect"

import { errorHasCode } from "./dialect.js"
import type { TransactionProbeStrategy } from "./dialect.js"

/**
 * The deadlock code and its symbolic alias.
 *
 * A deadlock (`ER_LOCK_DEADLOCK`, 1213) is the only MySQL/MariaDB error that
 * always rolls back the whole transaction regardless of server settings. The
 * lock wait timeout (`1205`) is deliberately absent: with the default
 * `innodb_rollback_on_timeout = OFF` it rolls back only the statement, and with
 * the setting `ON` the savepoint finalizer fails with `1305`, so the batcher's
 * wrapper guard already aborts. Hardcoding `1205` as fatal would fail a whole
 * batch on a recoverable timeout.
 *
 * Connection-loss codes are absent for the same reason. The driver's `KILL`
 * error carries no `code` or `errno`, and the non-fatal probe path already runs
 * `SELECT 1`, which fails on the dead connection.
 */
export const MYSQL_DEADLOCK_CODES = [1213, "ER_LOCK_DEADLOCK"] as const

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

/**
 * Find an Effect SQL `DeadlockError` reason on the error or its nested
 * `cause`/`error` chain.
 *
 * This is the primary classifier. `@effect/sql-mysql2` maps a deadlock to
 * `SqlError.reason._tag === "DeadlockError"`, which needs no message parsing
 * and does not walk arbitrary `details` payloads. The numeric fallback below
 * covers a driver version that does not map the reason.
 */
const hasDeadlockReason = (error: unknown): boolean => {
  const seen = new Set<unknown>()
  const stack: Array<unknown> = [error]

  while (stack.length > 0) {
    const value = stack.pop()
    if (!isRecord(value) || seen.has(value)) continue
    seen.add(value)

    if (Predicate.isTagged(value["reason"], "DeadlockError")) return true

    const cause = value["cause"]
    if (cause !== undefined) stack.push(cause)
    const nestedError = value["error"]
    if (nestedError !== undefined) stack.push(nestedError)
  }

  return false
}

/**
 * Whether a failed MySQL/MariaDB entry has already rolled back the whole
 * transaction.
 *
 * The batcher calls this with the failed entry's own error, before the
 * savepoint guard and before any probe SQL. A thrown predicate is treated as
 * fatal by the batcher.
 */
export function isMysqlTransactionFatal(error: unknown): boolean {
  return hasDeadlockReason(error) || errorHasCode(error, MYSQL_DEADLOCK_CODES)
}

/**
 * The MySQL/MariaDB probe strategy for the future `mysqlDialect`.
 *
 * This module is a pure capability: it imports no driver and is not
 * root-exported. #30 composes it into the full dialect. The `satisfies` form
 * keeps the literal `_tag` visible so tests can assert it without a type
 * assertion.
 */
export const mysqlTransactionProbe = {
  _tag: "error-classified",
  isTransactionFatal: isMysqlTransactionFatal
} as const satisfies TransactionProbeStrategy
