import { Context, Data, Effect, Layer, Option } from "effect"
import type { SqlError } from "effect/sql"
import { SqlClient } from "effect/sql"

import { CryptoService } from "@/crypto/index.js"
import { Dialect } from "@/dialect/dialect.js"
import { rewritePlaceholders } from "@/dialect/dialect.js"
import type { DeleteResultStrategy } from "@/dialect/dialect.js"
import {
  renderDelete,
  renderDeleteReturning,
  renderExists,
  renderList,
  renderView,
  renderViewFilter,
  renderViewWithAccess
} from "@/repository/sql.js"
import { withSpanWhenEnabled } from "@/telemetry/span.js"

import type { CursorResult, ExpandDef, FilterOptions, ListOptions, RepoRecord } from "./types.js"
import type { AccessPredicate, AccessRow } from "./types.js"

/** The dialect could not decode its own DELETE result shape. */
class DeleteResultUnknownError extends Data.TaggedError("DeleteResultUnknownError")<{
  readonly table: string
  readonly raw: unknown
}> {}

/**
 * Repository tag - schema-agnostic CRUD abstraction above SqlClient.
 *
 * Operates on `RepoRecord` (Record<string, unknown>) - no domain types at this layer.
 * All field validation and type checking happens in `CollectionService` above.
 */
export class Repository extends Context.Service<
  Repository,
  {
    create(table: string, data: RepoRecord): Effect.Effect<RepoRecord, SqlError.SqlError>
    update(table: string, id: string, data: RepoRecord): Effect.Effect<Option.Option<RepoRecord>, SqlError.SqlError>
    view(table: string, id: string): Effect.Effect<Option.Option<RepoRecord>, SqlError.SqlError>
    viewFilter(table: string, filter: FilterOptions): Effect.Effect<ReadonlyArray<RepoRecord>, SqlError.SqlError>
    /** Optional fast path: one SELECT returns the row plus access booleans. */
    viewWithAccess?: (
      table: string,
      id: string,
      predicates: readonly [AccessPredicate, ...Array<AccessPredicate>]
    ) => Effect.Effect<Option.Option<AccessRow>, SqlError.SqlError>
    /** Optional fast path: DELETE without the preceding existence SELECT. */
    deleteExisting?: (table: string, id: string) => Effect.Effect<Option.Option<void>, SqlError.SqlError>
    list(
      table: string,
      limit: number,
      options?: ListOptions
    ): Effect.Effect<CursorResult<RepoRecord>, SqlError.SqlError>
    delete(table: string, id: string): Effect.Effect<Option.Option<void>, SqlError.SqlError>
  }
>()("Repository") {}

function reshapeExpand(row: RepoRecord, expand?: ReadonlyArray<ExpandDef>): RepoRecord {
  if (!expand || expand.length === 0) return row
  const expandObj: Record<string, RepoRecord> = {}
  for (const item of expand) {
    const nested: RepoRecord = {}
    // A left join that does not match yields NULL for every target column; a
    // matched row always has a non-null primary key, so the relation is only
    // materialised when a row actually matched.
    let hasValue = false
    for (const column of item.targetColumns) {
      const flatKey = `__e_${item.localField}__${column}`
      const value = row[flatKey]
      if (value !== undefined) {
        nested[column] = value
        if (value !== null) hasValue = true
      }
      delete row[flatKey]
    }
    if (hasValue) {
      expandObj[item.localField] = nested
    }
  }
  if (Object.keys(expandObj).length > 0) {
    row.expand = expandObj
  }
  return row
}

/**
 * The default `Repository` implementation layer.
 * Requires the active `Dialect` for identifier quoting, placeholder translation,
 * and DELETE result strategy.
 */
export const RepositoryLive = Layer.effect(
  Repository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const crypto = yield* CryptoService
    const dialect = yield* Dialect
    const quote = dialect.quoteIdentifier
    const deleteResultStrategy: DeleteResultStrategy = dialect.deleteResult

    const run = <A extends object>(statement: string, params: ReadonlyArray<unknown>) =>
      sql.unsafe<A>(rewritePlaceholders(statement, dialect), params)

    const view = (table: string, id: string) =>
      Effect.gen(function* () {
        const rendered = renderView(quote, table, id)
        const rows = yield* run<RepoRecord>(rendered.sql, rendered.params)
        return rows.length > 0 ? Option.some(rows[0]!) : Option.none()
      })

    return Repository.of({
      create: (table, data) =>
        Effect.gen(function* () {
          const buf = yield* crypto.randomBytes(12)
          const id = Buffer.from(buf).toString("base64url").slice(0, 15)
          const now = new Date().toISOString()
          const record: RepoRecord = { ...data, id, created: now, updated: now }

          yield* sql`INSERT INTO ${sql.literal(quote(table))} ${sql.insert(record)}`
          return record
        }).pipe(
          withSpanWhenEnabled("repository.create", { kind: "client", attributes: { table } }, { captureStackTrace: false })
        ),

      view: (table, id) =>
        view(table, id).pipe(
          withSpanWhenEnabled("repository.view", { kind: "client", attributes: { table } }, { captureStackTrace: false })
        ),

      update: (table, id, data) =>
        Effect.gen(function* () {
          const now = new Date().toISOString()
          const patch: RepoRecord = { ...data, updated: now }

          yield* sql`UPDATE ${sql.literal(quote(table))} SET ${sql.update(patch, ["id", "created"])} WHERE ${sql.literal(quote("id"))} = ${id}`
          return yield* view(table, id)
        }).pipe(
          withSpanWhenEnabled("repository.update", { kind: "client", attributes: { table } }, { captureStackTrace: false })
        ),

      viewFilter: (table, filter) =>
        Effect.gen(function* () {
          const rendered = renderViewFilter(quote, table, filter)
          const rows = yield* run<RepoRecord>(rendered.sql, rendered.params)
          return rows.map((row) => reshapeExpand(row, filter.expand))
        }).pipe(
          withSpanWhenEnabled(
            "repository.viewFilter",
            { kind: "client", attributes: { table } },
            { captureStackTrace: false }
          )
        ),

      viewWithAccess: (table, id, predicates) =>
        Effect.gen(function* () {
          const rendered = renderViewWithAccess(quote, table, id, predicates)
          const rows = yield* run<RepoRecord>(rendered.sql, rendered.params)
          if (rows.length === 0) return Option.none()
          const row = rows[0]
          if (row === undefined) return Option.none()
          const access: Partial<Record<"rule" | "manage", boolean>> = {}
          const record: RepoRecord = {}
          for (const [key, value] of Object.entries(row)) {
            if (key === "__mira_access_rule") {
              access.rule = Number(value) === 1
            } else if (key === "__mira_access_manage") {
              access.manage = Number(value) === 1
            } else {
              record[key] = value
            }
          }
          return Option.some({ record, access })
        }).pipe(
          withSpanWhenEnabled(
            "repository.viewWithAccess",
            { kind: "client", attributes: { table } },
            { captureStackTrace: false }
          )
        ),

      deleteExisting: (table, id) =>
        Effect.gen(function* () {
          switch (deleteResultStrategy._tag) {
            case "returning": {
              const rendered = renderDeleteReturning(quote, table, id)
              const rows = yield* run<{ id: string }>(rendered.sql, rendered.params)
              return rows.length > 0 ? Option.some<void>(undefined) : Option.none()
            }
            case "affectedRows": {
              const rendered = renderDelete(quote, table, id)
              const raw = yield* sql.unsafe(rewritePlaceholders(rendered.sql, dialect), rendered.params).raw
              const affected = deleteResultStrategy.read(raw)
              if (Option.isNone(affected)) {
                return yield* Effect.die(new DeleteResultUnknownError({ table, raw }))
              }
              return affected.value > 0 ? Option.some<void>(undefined) : Option.none()
            }
            case "precheck": {
              const exists = renderExists(quote, table, id)
              const check = yield* run<Record<string, unknown>>(exists.sql, exists.params)
              if (check.length === 0) return Option.none()
              const remove = renderDelete(quote, table, id)
              yield* run<Record<string, unknown>>(remove.sql, remove.params)
              return Option.some<void>(undefined)
            }
          }
        }).pipe(
          withSpanWhenEnabled(
            "repository.deleteExisting",
            { kind: "client", attributes: { table } },
            { captureStackTrace: false }
          )
        ),

      list: (table, limit, options) =>
        Effect.gen(function* () {
          const rendered = renderList(quote, table, limit, options)
          const items = yield* run<RepoRecord>(rendered.sql, rendered.params)
          return { items: items.map((row) => reshapeExpand(row, options?.expand)) }
        }).pipe(
          withSpanWhenEnabled("repository.list", { kind: "client", attributes: { table } }, { captureStackTrace: false })
        ),

      delete: (table: string, id: string): Effect.Effect<Option.Option<void>, SqlError.SqlError> =>
        Effect.gen(function* () {
          const exists = renderExists(quote, table, id)
          const check = yield* run<Record<string, unknown>>(exists.sql, exists.params)
          if (check.length === 0) return Option.none()
          const remove = renderDelete(quote, table, id)
          yield* run<Record<string, unknown>>(remove.sql, remove.params)
          return Option.some<void>(undefined)
        }).pipe(
          withSpanWhenEnabled("repository.delete", { kind: "client", attributes: { table } }, { captureStackTrace: false })
        )
    })
  })
)
