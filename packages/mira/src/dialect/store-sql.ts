import { Effect, Schedule } from "effect"
import type { SqlClient, SqlError } from "effect/sql"

import type { StoreSqlCapabilities } from "./dialect.js"

const bootstrapRetrySchedule = Schedule.spaced("10 millis")

/**
 * Runs internal system-table DDL.
 *
 * Plain dialects keep the existing non-transactional DDL path. Transaction
 * dialects run their bootstrap statements and the callback in one transaction,
 * then retry once for a retryable SQL error such as `55P03`.
 *
 * The callback must only perform DDL. It must not return or capture the client;
 * stores build their service after the bootstrap completes.
 */
export const withStoreBootstrap = <E, R>(
  sql: SqlClient.SqlClient,
  store: StoreSqlCapabilities,
  f: (sql: SqlClient.SqlClient) => Effect.Effect<void, E, R>
) => {
  if (store.bootstrapMode === "plain") {
    return f(sql)
  }

  return sql
    .withTransaction(
      Effect.forEach(
        [...store.bootstrapSql, ...(store.bootstrapSetupSql ?? [])],
        (statement) => sql.unsafe(statement).pipe(Effect.asVoid),
        { discard: true }
      ).pipe(Effect.flatMap(() => f(sql)))
    )
    .pipe(
      Effect.retry({
        while: store.isRetryable,
        schedule: bootstrapRetrySchedule,
        times: 1
      })
    )
}

/**
 * Runs a dialect-rendered index statement, ignoring only the dialect's
 * duplicate-index code. A permission or syntax error still fails the boot.
 */
export const ensureStoreIndex = (
  sql: SqlClient.SqlClient,
  store: StoreSqlCapabilities,
  statement: string
): Effect.Effect<void, SqlError.SqlError> =>
  sql.unsafe(statement).pipe(
    Effect.asVoid,
    Effect.catch((error) =>
      store.isIgnorableBootstrapError(error) ? Effect.void : Effect.fail(error)
    )
  )

/**
 * Adds a column when it is absent and returns whether it was added. The
 * caller runs any backfill only when the result is true. A duplicate-column
 * error from a concurrent boot is ignored.
 */
export const ensureStoreColumn = (
  sql: SqlClient.SqlClient,
  store: StoreSqlCapabilities,
  table: string,
  column: string,
  addStatement: string
): Effect.Effect<boolean, SqlError.SqlError> =>
  Effect.gen(function* () {
    const rows = yield* sql.unsafe<Record<string, unknown>>(
      store.columnExistsSql(table, column)
    )
    if (rows.length > 0) return false

    yield* sql.unsafe(addStatement).pipe(
      Effect.asVoid,
      Effect.catch((error) =>
        store.isIgnorableBootstrapError(error) ? Effect.void : Effect.fail(error)
      )
    )
    return true
  })