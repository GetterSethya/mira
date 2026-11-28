import type { FilterNode, ValidationError } from "@gettersethya/mira-client"
import { filterNodeToWhereClause } from "@gettersethya/mira-client"
import { Context, Effect, Layer, Option, Schedule, Schema } from "effect"
import { SqlClient } from "effect/sql"

import { Dialect, rewritePlaceholders, type DialectType } from "@/dialect/dialect.js"
import { Migrator, MigratorLive } from "@/migrator/migrator.js"

import { LogsCollection, SpansCollection } from "./collections.js"
import {
  type TelemetryDeleteResult,
  type TelemetryLogEntry,
  type TelemetryLogPage,
  type TelemetryLogRow,
  type TelemetryReadShape,
  type TelemetrySpanEntry,
  type TelemetrySpanPage,
  type TelemetrySpanRow,
  TelemetryStore,
  TelemetryStoreError,
  type TelemetryStoreShape
} from "./store.js"

const RETENTION_BATCH_SIZE = 1_000
const MAX_RETENTION_BATCHES = 1_000
const SPAN_ATTRIBUTE_VALUE = Schema.Union([Schema.String, Schema.Number, Schema.Boolean])
const SpanAttributesSchema = Schema.fromJsonString(
  Schema.Record(Schema.String, SPAN_ATTRIBUTE_VALUE)
)
const parseAttributes = Schema.decodeUnknownEffect(SpanAttributesSchema)
const encodeAttributes = Schema.encodeSync(SpanAttributesSchema)

const decodeAttributes = (raw: string) =>
  parseAttributes(raw).pipe(
    Effect.orElseSucceed((): Record<string, string | number | boolean> => ({}))
  )

const migrationRetrySchedule = Schedule.exponential("100 millis").pipe(
  Schedule.upTo({ times: 4 })
)

type RawSpanRow = {
  readonly seqId: number | string
  readonly id: string
  readonly name: string
  readonly traceId: string
  readonly spanId: string
  readonly parentSpanId: string | null
  readonly kind: string
  readonly durationMs: number | string
  readonly status: string
  readonly error: string | null
  readonly attributes: string
  readonly created: string
}

const asNumber = (value: unknown) => Number(value ?? 0)

const asSpanStatus = (value: string): "ok" | "error" => (value === "error" ? "error" : "ok")

const mapStoreError = (operation: string, cause: unknown) =>
  new TelemetryStoreError({ operation, cause })

const run = <A extends object>(
  sql: SqlClient.SqlClient,
  dialect: DialectType,
  statement: string,
  params: ReadonlyArray<unknown> = []
) => sql.unsafe<A>(rewritePlaceholders(statement, dialect), params)

const retryPredicate = (dialect: DialectType) =>
  dialect.telemetry?.isRetryable ?? (() => false)

const dmlRetry = (dialect: DialectType) =>
  Effect.retry({
    while: (error: unknown) =>
      dialect.telemetry?.retryDml === true &&
      dialect.telemetry.isDmlRetryable?.(error) === true,
    schedule: migrationRetrySchedule,
    times: 1
  })

const resolveConflictClause = (dialect: DialectType) => {
  const quotedId = dialect.quoteIdentifier("id")
  return (
    dialect.telemetry?.insertConflictClause?.(quotedId) ??
    `ON CONFLICT (${quotedId}) DO NOTHING`
  )
}

/**
 * Builds the telemetry batch insert with the dialect's duplicate-ignoring
 * clause. Exported so tests can compile the exact statement without a driver.
 *
 * The caller must pass at least one row; `appendRows` guards empty input.
 */
export const makeInsertStatement = <
  A extends { readonly id: string } & Record<string, unknown>
>(
  sql: SqlClient.SqlClient,
  dialect: DialectType,
  table: string,
  rows: ReadonlyArray<A>
) =>
  sql`INSERT INTO ${sql(table)} ${sql.insert(rows)} ${sql.literal(
    resolveConflictClause(dialect)
  )}`

const inList = (values: ReadonlyArray<unknown>) =>
  values.length === 0 ? "NULL" : values.map(() => "?").join(", ")

const appendRows = <A extends { readonly id: string } & Record<string, unknown>>(
  sql: SqlClient.SqlClient,
  dialect: DialectType,
  table: string,
  operation: string,
  rows: ReadonlyArray<A>
): Effect.Effect<void, TelemetryStoreError> =>
  Effect.gen(function* () {
    if (rows.length === 0) return

    yield* makeInsertStatement(sql, dialect, table, rows).pipe(
      dmlRetry(dialect),
      Effect.asVoid,
      Effect.mapError((error) => mapStoreError(operation, error))
    )
  })

const mapLogEntry = (
  entry: TelemetryLogEntry
): { readonly id: string } & Record<string, unknown> => ({
  id: entry.id,
  level: entry.level,
  message: entry.message,
  created: entry.created,
  updated: entry.updated,
  traceId: entry.traceId,
  spanId: entry.spanId
})

const mapSpanEntry = (
  entry: TelemetrySpanEntry
): { readonly id: string } & Record<string, unknown> => ({
  id: entry.id,
  name: entry.name,
  traceId: entry.traceId,
  spanId: entry.spanId,
  parentSpanId: entry.parentSpanId,
  kind: entry.kind,
  durationMs: entry.durationMs,
  status: entry.status,
  error: entry.error,
  attributes: encodeAttributes(entry.attributes),
  created: entry.created,
  updated: entry.updated
})

const parseSpanRow = (raw: RawSpanRow): Effect.Effect<TelemetrySpanRow> =>
  decodeAttributes(raw.attributes).pipe(
    Effect.map((attributes) => ({
      id: raw.id,
      name: raw.name,
      traceId: raw.traceId,
      spanId: raw.spanId,
      parentSpanId: raw.parentSpanId,
      kind: raw.kind,
      durationMs: asNumber(raw.durationMs),
      status: asSpanStatus(raw.status),
      error: raw.error,
      attributes,
      created: raw.created
    }))
  )

type QueryParts = {
  readonly where: string
  readonly params: ReadonlyArray<unknown>
}

const filterParts = (
  filter: FilterNode | null,
  schema: typeof LogsCollection.schema | typeof SpansCollection.schema,
  collection: string,
  dialect: DialectType
): Effect.Effect<QueryParts, ValidationError> =>
  Effect.gen(function* () {
    if (filter === null) return { where: "", params: [] }
    const compiled = yield* filterNodeToWhereClause(filter, schema, collection, {
      quoteIdentifier: dialect.quoteIdentifier,
      caseInsensitivePattern: (left, right) =>
        dialect.caseInsensitivePattern(left, right),
      castValue: dialect.castValue,
      encodeValue: (_field, value) => value
    })
    return { where: compiled.sql, params: compiled.params }
  })

const makeRead = (
  sql: SqlClient.SqlClient,
  dialect: DialectType
): TelemetryReadShape => {
  const q = dialect.quoteIdentifier
  const quoteTable = (table: string) => q(table)

  const listLogs = (query: Parameters<TelemetryReadShape["listLogs"]>[0]) =>
    Effect.gen(function* () {
      const parts = yield* filterParts(query.filter, LogsCollection.schema, "logs", dialect)
      const where: Array<string> = []
      const params: Array<unknown> = []

      if (parts.where.length > 0) {
        where.push(`(${parts.where})`)
        params.push(...parts.params)
      }
      if (query.after !== null) {
        where.push(`${q("seqId")} < ?`)
        params.push(query.after)
      }

      const whereSql = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""
      const rows = yield* run<TelemetryLogRow>(
        sql,
        dialect,
        `SELECT ${q("seqId")}, ${q("id")}, ${q("level")}, ${q("message")}, ${q("created")}, ${q("updated")}, ${q("traceId")}, ${q("spanId")} FROM ${quoteTable("logs")} t${whereSql} ORDER BY t.${q("seqId")} DESC LIMIT ?`,
        [...params, query.limit + 1]
      ).pipe(Effect.mapError((error) => mapStoreError("listLogs", error)))

      const countParams = query.filter === null ? [] : parts.params
      const totalRows = yield* run<{ cnt: number | string }>(
        sql,
        dialect,
        `SELECT COUNT(*) AS ${q("cnt")} FROM ${quoteTable("logs")} t${
          query.filter === null ? "" : ` WHERE (${parts.where})`
        }`,
        countParams
      ).pipe(Effect.mapError((error) => mapStoreError("listLogs", error)))

      const hasMore = rows.length > query.limit
      const items = (hasMore ? rows.slice(0, query.limit) : rows).map((row) => ({
        ...row,
        seqId: asNumber(row.seqId)
      }))
      const nextCursor = hasMore ? (items.at(-1)?.seqId ?? null) : null

      return {
        items,
        total: asNumber(totalRows[0]?.cnt),
        nextCursor
      } satisfies TelemetryLogPage
    })

  const listSpans = (query: Parameters<TelemetryReadShape["listSpans"]>[0]) =>
    Effect.gen(function* () {
      if (query.traceId !== null) {
        const raw = yield* run<RawSpanRow>(
          sql,
          dialect,
          `SELECT ${q("seqId")}, ${q("id")}, ${q("name")}, ${q("traceId")}, ${q("spanId")}, ${q("parentSpanId")}, ${q("kind")}, ${q("durationMs")}, ${q("status")}, ${q("error")}, ${q("attributes")}, ${q("created")} FROM ${quoteTable("spans")} WHERE ${q("traceId")} = ? ORDER BY ${q("created")} ASC`,
          [query.traceId]
        ).pipe(Effect.mapError((error) => mapStoreError("listSpans", error)))
        const items = yield* Effect.forEach(raw, parseSpanRow, { concurrency: "unbounded" })
        return { items, total: items.length, nextCursor: null } satisfies TelemetrySpanPage
      }

      const parts = yield* filterParts(query.filter, SpansCollection.schema, "spans", dialect)

      if (parts.where.length > 0) {
        const where: Array<string> = [`(${parts.where})`]
        const params: Array<unknown> = [...parts.params]
        if (query.after !== null) {
          where.push(`${q("seqId")} < ?`)
          params.push(query.after)
        }

        const raw = yield* run<RawSpanRow>(
          sql,
          dialect,
          `SELECT ${q("seqId")}, ${q("id")}, ${q("name")}, ${q("traceId")}, ${q("spanId")}, ${q("parentSpanId")}, ${q("kind")}, ${q("durationMs")}, ${q("status")}, ${q("error")}, ${q("attributes")}, ${q("created")} FROM ${quoteTable("spans")} t WHERE ${where.join(" AND ")} ORDER BY t.${q("seqId")} DESC LIMIT ?`,
          [...params, query.limit + 1]
        ).pipe(Effect.mapError((error) => mapStoreError("listSpans", error)))

        const totalRows = yield* run<{ cnt: number | string }>(
          sql,
          dialect,
          `SELECT COUNT(*) AS ${q("cnt")} FROM ${quoteTable("spans")} t WHERE (${parts.where})`,
          parts.params
        ).pipe(Effect.mapError((error) => mapStoreError("listSpans", error)))

        const hasMore = raw.length > query.limit
        const selected = hasMore ? raw.slice(0, query.limit) : raw
        const items = yield* Effect.forEach(selected, parseSpanRow, { concurrency: "unbounded" })
        const lastSelected = selected.at(-1)
        const nextCursor =
          hasMore && lastSelected !== undefined ? asNumber(lastSelected.seqId) : null

        return {
          items,
          total: asNumber(totalRows[0]?.cnt),
          nextCursor
        } satisfies TelemetrySpanPage
      }

      const traceRows = yield* run<{ traceId: string; maxSeqId: number | string }>(
        sql,
        dialect,
        `SELECT ${q("traceId")}, MAX(${q("seqId")}) AS ${q("maxSeqId")} FROM ${quoteTable("spans")} t GROUP BY ${q("traceId")}${
          query.after !== null ? ` HAVING MAX(${q("seqId")}) < ?` : ""
        } ORDER BY ${q("maxSeqId")} DESC LIMIT ?`,
        query.after !== null ? [query.after, query.limit + 1] : [query.limit + 1]
      ).pipe(Effect.mapError((error) => mapStoreError("listSpans", error)))

      const totalRows = yield* run<{ cnt: number | string }>(
        sql,
        dialect,
        `SELECT COUNT(DISTINCT ${q("traceId")}) AS ${q("cnt")} FROM ${quoteTable("spans")} t`
      ).pipe(Effect.mapError((error) => mapStoreError("listSpans", error)))

      const hasMore = traceRows.length > query.limit
      const paged = hasMore ? traceRows.slice(0, query.limit) : traceRows
      const lastPaged = paged.at(-1)
      const nextCursor =
        hasMore && lastPaged !== undefined ? asNumber(lastPaged.maxSeqId) : null
      const total = asNumber(totalRows[0]?.cnt)

      if (paged.length === 0) {
        return { items: [], total, nextCursor: null } satisfies TelemetrySpanPage
      }

      const traceIds = paged.map((row) => row.traceId)
      const raw = yield* run<RawSpanRow>(
        sql,
        dialect,
        `SELECT ${q("seqId")}, ${q("id")}, ${q("name")}, ${q("traceId")}, ${q("spanId")}, ${q("parentSpanId")}, ${q("kind")}, ${q("durationMs")}, ${q("status")}, ${q("error")}, ${q("attributes")}, ${q("created")} FROM ${quoteTable("spans")} WHERE ${q("traceId")} IN (${inList(traceIds)}) ORDER BY ${q("created")} ASC`,
        traceIds
      ).pipe(Effect.mapError((error) => mapStoreError("listSpans", error)))

      const items = yield* Effect.forEach(raw, parseSpanRow, { concurrency: "unbounded" })
      return { items, total, nextCursor } satisfies TelemetrySpanPage
    })

  return { listLogs, listSpans }
}

const cleanup = (
  sql: SqlClient.SqlClient,
  dialect: DialectType
): Effect.Effect<void> =>
  Effect.forEach(
    dialect.telemetry?.cleanup ?? [],
    (statement) =>
      sql.unsafe(statement).pipe(
        Effect.asVoid,
        Effect.catchCause(() => Effect.logWarning(`[telemetry] cleanup failed: ${statement}`))
      ),
    { discard: true }
  )

/** The SQL and bound values for one retention batch. */
export type RetentionDeleteStatement = {
  readonly sql: string
  readonly params: ReadonlyArray<unknown>
}

/**
 * Builds the portable retention delete.
 *
 * The derived table is required because MySQL and MariaDB reject a `LIMIT`
 * directly inside an `IN` subquery. The returning form uses `RETURNING 1`
 * because the store only needs a row count; libSQL cannot decode a returned
 * `seqId` above 2^53.
 */
export const makeRetentionDeleteStatement = (
  dialect: Pick<DialectType, "quoteIdentifier">,
  table: string,
  returning: boolean,
  cutoff: string
): RetentionDeleteStatement => {
  const q = dialect.quoteIdentifier
  const sql =
    `DELETE FROM ${q(table)} WHERE ${q("seqId")} IN (` +
    `SELECT ${q("seqId")} FROM (` +
    `SELECT ${q("seqId")} FROM ${q(table)} WHERE ${q("created")} < ? ` +
    `ORDER BY ${q("seqId")} LIMIT ?) AS ${q("doomed")})` +
    (returning ? " RETURNING 1" : "")
  return { sql, params: [cutoff, RETENTION_BATCH_SIZE] }
}

const deleteBatch = (
  sql: SqlClient.SqlClient,
  dialect: DialectType,
  table: string,
  cutoff: string
): Effect.Effect<number, TelemetryStoreError> => {
  return Effect.gen(function* () {
    const strategy = dialect.deleteResult
    if (strategy._tag === "precheck") {
      return yield* Effect.fail(
        new TelemetryStoreError({
          operation: "deleteOlderThan",
          cause: "the active dialect does not expose an affected-row count"
        })
      )
    }

    const statement = makeRetentionDeleteStatement(
      dialect,
      table,
      strategy._tag === "returning",
      cutoff
    )

    let deleted = 0
    for (let batch = 1; batch <= MAX_RETENTION_BATCHES; batch++) {
      let count = 0
      if (strategy._tag === "returning") {
        const rows = yield* run<Record<string, unknown>>(
          sql,
          dialect,
          statement.sql,
          statement.params
        ).pipe(
          dmlRetry(dialect),
          Effect.mapError((error) => mapStoreError("deleteOlderThan", error))
        )
        count = rows.length
      } else {
        const raw = yield* sql
          .unsafe(rewritePlaceholders(statement.sql, dialect), [...statement.params])
          .raw.pipe(
            dmlRetry(dialect),
            Effect.mapError((error) => mapStoreError("deleteOlderThan", error))
          )

        const context = `table=${table} deleted_before=${deleted} batch=${batch}`
        const read = yield* Effect.try({
          try: () => strategy.read(raw),
          catch: (cause) =>
            mapStoreError(
              "deleteOlderThan",
              `${context}: the affected-row reader threw; the current batch may already be committed: ${String(cause)}`
            )
        })
        if (Option.isNone(read)) {
          return yield* Effect.fail(
            new TelemetryStoreError({
              operation: "deleteOlderThan",
              cause: `${context}: the affected-row count was unreadable; the current batch may already be committed`
            })
          )
        }

        const value = read.value
        if (
          !Number.isSafeInteger(value) ||
          value < 0 ||
          value > RETENTION_BATCH_SIZE
        ) {
          return yield* Effect.fail(
            new TelemetryStoreError({
              operation: "deleteOlderThan",
              cause: `${context}: the affected-row count was ${String(value)}; the current batch may already have committed`
            })
          )
        }
        count = value
      }

      if (count === 0) {
        yield* Effect.logWarning(
          `[telemetry] ${table} retention made no progress at cutoff ${cutoff}`
        )
        return deleted
      }

      deleted += count
      yield* Effect.yieldNow

      if (batch === MAX_RETENTION_BATCHES) {
        yield* Effect.logWarning(
          `[telemetry] ${table} retention stopped after ${MAX_RETENTION_BATCHES} batches at cutoff ${cutoff} with ${deleted} rows deleted; the run is partial. Rerun to continue, or inspect the affected-row count.`
        )
      }
    }

    return deleted
  })
}

const makeStore = (
  sql: SqlClient.SqlClient,
  dialect: DialectType,
  manageConnection: boolean
): TelemetryStoreShape => ({
  appendLogs: (rows) =>
    appendRows(sql, dialect, "logs", "appendLogs", rows.map(mapLogEntry)),
  appendSpans: (rows) =>
    appendRows(sql, dialect, "spans", "appendSpans", rows.map(mapSpanEntry)),
  deleteOlderThan: (cutoff) =>
    Effect.gen(function* () {
      const logs = yield* deleteBatch(sql, dialect, "logs", cutoff)
      const spans = yield* deleteBatch(sql, dialect, "spans", cutoff)
      if (manageConnection) yield* cleanup(sql, dialect)
      return { logs, spans } satisfies TelemetryDeleteResult
    }),
  read: makeRead(sql, dialect)
})

/** Configuration for the SQL telemetry store. */
export type SqlTelemetryStoreConfig =
  | {
      readonly dedicated: true
      readonly manageConnection?: boolean
      /** Defaults to true. False skips table creation, for replica presets. */
      readonly migrate?: boolean
    }
  | {
      readonly dedicated: false
      readonly manageConnection?: false
      /** Defaults to true. False skips table creation, for replica presets. */
      readonly migrate?: boolean
    }

/**
 * SQL implementation of `TelemetryStore`.
 *
 * Both modes build a local `Migrator` over the resolved `SqlClient` and
 * `Dialect`; the ambient app-bound `Migrator` is deliberately not required,
 * because it is built after the telemetry foundation.
 */
export const makeSqlTelemetryStoreLayer = (
  config: SqlTelemetryStoreConfig
): Layer.Layer<TelemetryStore, TelemetryStoreError, SqlClient.SqlClient | Dialect> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const dialect = yield* Dialect
      const manageConnection = config.dedicated && config.manageConnection !== false
      const schemaTable = config.dedicated ? "_collections" : "_telemetry_collections"
      const migrationsTable = config.dedicated ? "_migrations" : "_telemetry_migrations"

      if (manageConnection) {
        yield* Effect.forEach(
          dialect.telemetry?.setup ?? [],
          (statement) => sql.unsafe(statement).pipe(Effect.asVoid),
          { discard: true }
        ).pipe(
          Effect.retry({ while: retryPredicate(dialect), schedule: migrationRetrySchedule }),
          Effect.catchCause((cause) =>
            Effect.fail(mapStoreError("setup", cause))
          )
        )
      }

      const migrator = yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(
            MigratorLive.pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(SqlClient.SqlClient, sql),
                  Layer.succeed(Dialect, dialect)
                )
              )
            )
          )
          return Context.get(context, Migrator)
        })
      )

      if (config.migrate !== false) {
        yield* migrator
          .migrate(
            [
              { name: "logs", schema: LogsCollection.schema },
              { name: "spans", schema: SpansCollection.schema }
            ],
            { schemaTable, migrationsTable }
          )
          .pipe(
            Effect.retry({ while: retryPredicate(dialect), schedule: migrationRetrySchedule }),
            Effect.catchCause((cause) => Effect.fail(mapStoreError("migrate", cause)))
          )
      }

      return Layer.succeed(TelemetryStore, makeStore(sql, dialect, manageConnection))
    })
  )

/** Dedicated-mode convenience layer. */
export const SqlTelemetryStoreLive = makeSqlTelemetryStoreLayer({
  dedicated: true,
  manageConnection: true
}).pipe(Layer.orDie)
