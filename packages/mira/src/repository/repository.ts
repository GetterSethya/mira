import { SqlClient, SqlError } from "@effect/sql"
import { unsafeFragment } from "@effect/sql/Statement"
import { Context, Effect, Layer, Option } from "effect"
import { CryptoService } from "@/crypto/index.js"
import type { CursorResult, ExpandDef, FilterOptions, ListOptions, RepoRecord, SortOrder } from "./types.js"

/**
 * Repository tag — schema-agnostic CRUD abstraction above SqlClient.
 *
 * Operates on `RepoRecord` (Record<string, unknown>) — no domain types at this layer.
 * All field validation and type checking happens in `CollectionService` above.
 *
 * Provides:
 * - `create(table, record)` — INSERT with generated id/seqId/timestamps
 * - `update(table, id, patch)` — PATCH with updated timestamp
 * - `view(table, id)` — SELECT by id
 * - `viewFilter(table, filter, options?)` — SELECT by arbitrary filter
 * - `list(table, limit, options?)` — cursor-based paginated SELECT (no COUNT(*))
 * - `delete(table, id)` — DELETE by id
 *
 * @example
 * import { Repository } from "@gettersethya/mira"
 *
 * Effect.gen(function* () {
 *   const repo = yield* Repository
 *   const record = yield* repo.create("posts", { title: "Hello" })
 *   const page = yield* repo.list("posts", 20, { where: { sql: 't."published" = ?', params: [true] } })
 * })
 *
 * @see RepositoryLive — the default implementation layer
 * @see CollectionService — the layer above that uses Repository
 */
export class Repository extends Context.Tag("Repository")<
  Repository,
  {
    create(table: string, data: RepoRecord): Effect.Effect<RepoRecord, SqlError.SqlError>
    update(table: string, id: string, data: RepoRecord): Effect.Effect<Option.Option<RepoRecord>, SqlError.SqlError>
    view(table: string, id: string): Effect.Effect<Option.Option<RepoRecord>, SqlError.SqlError>
    viewFilter(table: string, filter: FilterOptions): Effect.Effect<ReadonlyArray<RepoRecord>, SqlError.SqlError>
    list(
      table: string,
      limit: number,
      options?: ListOptions
    ): Effect.Effect<CursorResult<RepoRecord>, SqlError.SqlError>
    delete(table: string, id: string): Effect.Effect<Option.Option<void>, SqlError.SqlError>
  }
>() {}

function orderFrag(sql: SqlClient.SqlClient, sort?: SortOrder) {
  if (!sort) return sql.literal("")
  const dir = sort.direction === "desc" ? "DESC" : "ASC"
  return sql.literal(` ORDER BY t."${sort.field}" ${dir}`)
}

function buildSelect(sql: SqlClient.SqlClient, fields?: ReadonlyArray<string>, expand?: ReadonlyArray<ExpandDef>) {
  if (!fields && !expand) return sql.literal("SELECT *")
  const cols: Array<string> = []
  if (fields) {
    cols.push(...fields.map((f) => `t."${f}"`))
  } else {
    cols.push("t.*")
  }
  if (expand) {
    for (const e of expand) {
      for (const col of e.targetColumns) {
        cols.push(`_e_${e.localField}."${col}" AS "__e_${e.localField}__${col}"`)
      }
    }
  }
  if (cols.length === 0) return sql.literal("SELECT *")
  return sql.literal(`SELECT ${cols.join(", ")}`)
}

function buildJoins(sql: SqlClient.SqlClient, expand?: ReadonlyArray<ExpandDef>) {
  if (!expand || expand.length === 0) return sql.literal("")
  const joins = expand.map(
    (e) => ` LEFT JOIN ${sql(e.targetTable)} _e_${e.localField} ON _e_${e.localField}."id" = t."${e.localField}"`
  )
  return sql.literal(joins.join(""))
}

function reshapeExpand(row: RepoRecord, expand?: ReadonlyArray<ExpandDef>): RepoRecord {
  if (!expand || expand.length === 0) return row
  const expandObj: Record<string, RepoRecord> = {}
  for (const e of expand) {
    const nested: RepoRecord = {}
    let hasValue = false
    for (const col of e.targetColumns) {
      const flatKey = `__e_${e.localField}__${col}`
      const val = row[flatKey]
      if (val !== undefined) {
        nested[col] = val
        hasValue = true
      }
      delete row[flatKey]
    }
    if (hasValue) {
      expandObj[e.localField] = nested
    }
  }
  if (Object.keys(expandObj).length > 0) {
    row.expand = expandObj
  }
  return row
}

/**
 * The default `Repository` implementation layer.
 * Provides schema-agnostic CRUD using Effect SQL template literals.
 * Generates IDs via `CryptoService.randomBytes`, manages `seqId` via auto-increment.
 *
 * @example
 * Layer.provideMerge(RepositoryLive)
 *
 * @see Repository — the service tag
 */
export const RepositoryLive = Layer.effect(
  Repository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const crypto = yield* CryptoService

    return Repository.of({
      create: (table, data) =>
        Effect.gen(function* () {
          const buf = yield* crypto.randomBytes(12)
          const id = Buffer.from(buf).toString("base64url").slice(0, 15)
          const now = new Date().toISOString()
          const record: RepoRecord = { ...data, id, created: now, updated: now }

          yield* sql`INSERT INTO ${sql(table)} ${sql.insert(record)}`
          return record
        }).pipe(Effect.withSpan("repository.create", { kind: "client", attributes: { table } })),

      view: (table, id) =>
        Effect.gen(function* () {
          const rows = yield* sql<RepoRecord>`SELECT * FROM ${sql(table)} t WHERE t.id = ${id} LIMIT 1`
          return rows.length > 0 ? Option.some(rows[0]) : Option.none()
        }).pipe(Effect.withSpan("repository.view", { kind: "client", attributes: { table } })),

      update: (table, id, data) =>
        Effect.gen(function* () {
          const now = new Date().toISOString()
          const patch: RepoRecord = { ...data, updated: now }

          yield* sql`UPDATE ${sql(table)} SET ${sql.update(patch, ["id", "created"])} WHERE id = ${id}`

          const rows = yield* sql<RepoRecord>`SELECT * FROM ${sql(table)} t WHERE t.id = ${id} LIMIT 1`
          return rows.length > 0 ? Option.some(rows[0]) : Option.none()
        }).pipe(Effect.withSpan("repository.update", { kind: "client", attributes: { table } })),

      viewFilter: (table, filter) =>
        Effect.gen(function* () {
          const where = unsafeFragment(filter.where.sql, filter.where.params)
          const order = orderFrag(sql, filter.sort)
          const select = buildSelect(sql, filter.fields, filter.expand)
          const joins = buildJoins(sql, filter.expand)

          const rows = yield* sql<RepoRecord>`${select} FROM ${sql(table)} t${joins} WHERE ${where}${order}`
          return rows.map((r) => reshapeExpand(r, filter.expand))
        }).pipe(Effect.withSpan("repository.viewFilter", { kind: "client", attributes: { table } })),

      list: (table, limit, options) =>
        Effect.gen(function* () {
          const order = orderFrag(sql, options?.sort)
          const select = buildSelect(sql, options?.fields, options?.expand)
          const joins = buildJoins(sql, options?.expand)

          const items = options?.where
            ? yield* sql<RepoRecord>`${select} FROM ${sql(table)} t${joins} WHERE ${unsafeFragment(options.where.sql, options.where.params)}${order} LIMIT ${limit}`
            : yield* sql<RepoRecord>`${select} FROM ${sql(table)} t${joins}${order} LIMIT ${limit}`

          return { items: items.map((r) => reshapeExpand(r, options?.expand)) }
        }).pipe(Effect.withSpan("repository.list", { kind: "client", attributes: { table } })),

      delete: (table: string, id: string): Effect.Effect<Option.Option<void>, SqlError.SqlError> =>
        Effect.gen(function* () {
          const check = yield* sql`SELECT 1 FROM ${sql(table)} WHERE id = ${id} LIMIT 1`
          if (check.length === 0) return Option.none()
          yield* sql`DELETE FROM ${sql(table)} WHERE id = ${id}`
          return Option.some<void>(undefined)
        }).pipe(Effect.withSpan("repository.delete", { kind: "client", attributes: { table } }))
    })
  })
)
