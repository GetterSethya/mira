import { Effect, Schedule } from "effect"
import type { SqlClient } from "effect/sql"

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
        store.bootstrapSql,
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
