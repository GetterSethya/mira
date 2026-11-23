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
        dialect.caseInsensitivePattern(left, right)
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

const deleteBatch = (
  sql: SqlClient.SqlClient,
  dialect: DialectType,
  table: string,
  cutoff: string
): Effect.Effect<number, TelemetryStoreError> => {
  const q = dialect.quoteIdentifier
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

    let deleted = 0
    for (;;) {
      const ids = yield* run<{ seqId: number | string }>(
        sql,
        dialect,
        `SELECT ${q("seqId")} FROM ${q(table)} WHERE ${q("created")} < ? ORDER BY ${q("seqId")} LIMIT ${RETENTION_BATCH_SIZE}`,
        [cutoff]
      ).pipe(Effect.mapError((error) => mapStoreError("deleteOlderThan", error)))

      if (ids.length === 0) break

      const batchIds = ids.map((row) => asNumber(row.seqId))
      const returning = strategy._tag === "returning" ? ` RETURNING ${q("seqId")}` : ""
      const rows = yield* run<Record<string, unknown>>(
        sql,
        dialect,
        `DELETE FROM ${q(table)} WHERE ${q("seqId")} IN (${inList(batchIds)})${returning}`,
        batchIds
      ).pipe(Effect.mapError((error) => mapStoreError("deleteOlderThan", error)))

      const count =
        strategy._tag === "returning"
          ? rows.length
          : Option.getOrElse(strategy.read(rows), () => 0)

      deleted += count

      if (count === 0) {
        yield* Effect.logWarning(
          `[telemetry] ${table} retention made no progress at cutoff ${cutoff}`
        )
        break
      }

      yield* Effect.yieldNow
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
