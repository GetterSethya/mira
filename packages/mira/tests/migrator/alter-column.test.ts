import { SqliteClient } from "@effect/sql-sqlite-node"
import { describe, it } from "@effect/vitest"
import type { CollectionSchema } from "@gettersethya/mira-client"
import { Effect, Exit, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { expect } from "vitest"

import { Dialect } from "@/dialect/dialect.js"
import type { DialectType } from "@/dialect/dialect.js"
import { sqliteDialect } from "@/dialect/dialect-sqlite.js"
import { Migrator, MigratorLive } from "@/migrator/migrator.js"

const sqliteLayer = SqliteClient.layer({ filename: ":memory:" })

const testLayer = Layer.mergeAll(
  MigratorLive.pipe(Layer.provide(Layer.mergeAll(Layer.succeed(Dialect, sqliteDialect), sqliteLayer))),
  sqliteLayer
)

/** A dialect that renders a comment instead of SQL — the shape of the original defect. */
const commentOnlyDialect: DialectType = {
  ...sqliteDialect,
  translatePlan: () =>
    Effect.succeed({ statements: ["-- alterColumn requires table recreation"], cleanup: [] })
}

const commentOnlyLayer = Layer.mergeAll(
  MigratorLive.pipe(Layer.provide(Layer.mergeAll(Layer.succeed(Dialect, commentOnlyDialect), sqliteLayer))),
  sqliteLayer
)

type TodosOptions = {
  categoryRequired?: boolean
  categoryDefault?: string
  withExtra?: boolean
  withNote?: boolean
  indexes?: CollectionSchema["x-indexes"]
}

/** A `todos` collection whose shape can be varied to produce a column change. */
function todosSchema(opts: TodosOptions = {}): CollectionSchema {
  const properties: CollectionSchema["properties"] = {
    seqId: { type: "integer", "x-kind": "seqId", "x-system": true },
    id: { type: "string", "x-system": true },
    title: { type: "string" },
    category: opts.categoryDefault === undefined
      ? { type: "string" }
      : { type: "string", default: opts.categoryDefault }
  }
  if (opts.withExtra) properties["extra"] = { type: "string", default: "" }
  if (opts.withNote) properties["note"] = { type: "string" }

  const schema: CollectionSchema = {
    "x-collection-kind": "base",
    type: "object",
    properties,
    required: opts.categoryRequired === true ? ["id", "title", "category"] : ["id", "title"]
  }
  if (opts.indexes !== undefined) schema["x-indexes"] = opts.indexes
  return schema
}

/** A view collection reading from `todos`; unchanged across the migrations below. */
function todosView(): CollectionSchema {
  return {
    "x-collection-kind": "view",
    type: "object",
    properties: {
      id: { type: "string", "x-system": true, "x-view-only": true },
      seqId: { type: "integer", "x-system": true, "x-view-only": true, "x-kind": "seqId" },
      title: { type: "string" }
    },
    required: ["id"],
    "x-view-query": "SELECT id, seqId, title FROM todos"
  }
}

const tableInfo = (sql: SqlClient.SqlClient, table: string) =>
  sql<{ name: string; notnull: number }>`PRAGMA table_info(${sql(table)})`

/** `0` when `todos.category` accepts NULL, `1` when it is NOT NULL. */
const categoryNotNull = (sql: SqlClient.SqlClient) =>
  Effect.map(tableInfo(sql, "todos"), (info) => info.find((c) => c.name === "category")?.notnull)

const indexNames = (sql: SqlClient.SqlClient, table: string) =>
  sql<{ name: string }>`
    SELECT name FROM sqlite_master
    WHERE type = 'index' AND tbl_name = ${table} AND name NOT LIKE 'sqlite_%'
  `

const tableExists = (sql: SqlClient.SqlClient, table: string) =>
  sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${table}`

const sequenceFor = (sql: SqlClient.SqlClient, table: string) =>
  sql<{ seq: number }>`SELECT seq FROM sqlite_sequence WHERE name = ${table}`

const legacyAlterTable = (sql: SqlClient.SqlClient) =>
  sql<{ legacy_alter_table: number }>`SELECT legacy_alter_table FROM pragma_legacy_alter_table`

const insertTodo = (
  sql: SqlClient.SqlClient,
  row: { id: string; title: string; category: string | null }
) => sql`INSERT INTO ${sql("todos")} ${sql.insert(row)}`

const migrateTodos = (schema: CollectionSchema, options?: { allowDestructive?: boolean }) =>
  Effect.gen(function* () {
    const migrator = yield* Migrator
    yield* migrator.migrate([{ name: "todos", schema }], options)
  })

describe("SQLite column changes (table recreation)", () => {
  it.effect("relaxes NOT NULL to nullable without allowDestructive", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* migrateTodos(todosSchema({ categoryRequired: true }))
      yield* insertTodo(sql, { id: "t1", title: "one", category: "c1" })

      const migrator = yield* Migrator
      const plan = yield* migrator.plan([{ name: "todos", schema: todosSchema() }])
      expect(plan.destructive).toBe(false)

      yield* migrateTodos(todosSchema())

      expect(yield* categoryNotNull(sql)).toBe(0)

      const rows = yield* sql<{ id: string; title: string; category: string | null }>`
        SELECT id, title, category FROM ${sql("todos")}
      `
      expect(rows).toEqual([{ id: "t1", title: "one", category: "c1" }])
    }).pipe(Effect.provide(testLayer)))

  it.effect("preserves rows and index definitions across the rebuild", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const indexes: CollectionSchema["x-indexes"] = [
        { fields: ["title"], unique: true },
        { fields: ["category"], unique: false }
      ]
      yield* migrateTodos(todosSchema({ categoryRequired: true, indexes }))
      yield* insertTodo(sql, { id: "t1", title: "one", category: "c1" })
      yield* insertTodo(sql, { id: "t2", title: "two", category: "c2" })

      yield* migrateTodos(todosSchema({ indexes }))
      expect(yield* categoryNotNull(sql)).toBe(0)

      const rows = yield* sql<{ id: string }>`SELECT id FROM ${sql("todos")} ORDER BY id`
      expect(rows.map((r) => r.id)).toEqual(["t1", "t2"])

      const names = (yield* indexNames(sql, "todos")).map((i) => i.name).sort()
      expect(names).toEqual(["idx_todos_category", "idx_todos_title"])

      const duplicate = yield* Effect.exit(insertTodo(sql, { id: "t3", title: "one", category: "c3" }))
      expect(Exit.isFailure(duplicate)).toBe(true)
    }).pipe(Effect.provide(testLayer)))

  it.effect("preserves the AUTOINCREMENT high-water mark", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* migrateTodos(todosSchema({ categoryRequired: true }))
      yield* insertTodo(sql, { id: "t1", title: "one", category: "c1" })
      yield* insertTodo(sql, { id: "t2", title: "two", category: "c2" })
      yield* insertTodo(sql, { id: "t3", title: "three", category: "c3" })
      yield* sql`DELETE FROM ${sql("todos")} WHERE id = ${"t3"}`
      expect((yield* sequenceFor(sql, "todos"))[0].seq).toBe(3)

      yield* migrateTodos(todosSchema())
      expect(yield* categoryNotNull(sql)).toBe(0)

      yield* insertTodo(sql, { id: "t4", title: "four", category: "c4" })
      const rows = yield* sql<{ seqId: number }>`SELECT seqId FROM ${sql("todos")} WHERE id = ${"t4"}`
      expect(rows[0].seqId).toBe(4)
    }).pipe(Effect.provide(testLayer)))

  it.effect("preserves the AUTOINCREMENT high-water mark when the table is emptied", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* migrateTodos(todosSchema({ categoryRequired: true }))
      yield* insertTodo(sql, { id: "t1", title: "one", category: "c1" })
      yield* insertTodo(sql, { id: "t2", title: "two", category: "c2" })
      yield* sql`DELETE FROM ${sql("todos")}`

      yield* migrateTodos(todosSchema())
      expect(yield* categoryNotNull(sql)).toBe(0)

      yield* insertTodo(sql, { id: "t3", title: "three", category: "c3" })
      const rows = yield* sql<{ seqId: number }>`SELECT seqId FROM ${sql("todos")} WHERE id = ${"t3"}`
      expect(rows[0].seqId).toBe(3)
    }).pipe(Effect.provide(testLayer)))

  it.effect("applies several column changes to one table in a single migration", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* migrateTodos(
        todosSchema({
          categoryRequired: true,
          withNote: true,
          indexes: [{ fields: ["title"], unique: true }, { fields: ["note"], unique: false }]
        })
      )
      yield* insertTodo(sql, { id: "t1", title: "one", category: "c1" })
      yield* sql`UPDATE ${sql("todos")} SET note = ${"n1"} WHERE id = ${"t1"}`

      yield* migrateTodos(
        todosSchema({ withExtra: true, indexes: [{ fields: ["title"], unique: true }, { fields: ["extra"], unique: false }] }),
        { allowDestructive: true }
      )

      const info = (yield* tableInfo(sql, "todos")).map((c) => c.name)
      expect(info).toContain("extra")
      expect(info).not.toContain("note")
      expect(yield* categoryNotNull(sql)).toBe(0)

      const rows = yield* sql<{ id: string; category: string | null; extra: string }>`
        SELECT id, category, extra FROM ${sql("todos")}
      `
      expect(rows).toEqual([{ id: "t1", category: "c1", extra: "" }])

      const names = (yield* indexNames(sql, "todos")).map((i) => i.name).sort()
      expect(names).toEqual(["idx_todos_extra", "idx_todos_title"])
    }).pipe(Effect.provide(testLayer)))

  it.effect("fills the default when tightening nullable on existing NULL rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* migrateTodos(todosSchema())
      yield* insertTodo(sql, { id: "t1", title: "one", category: null })
      yield* insertTodo(sql, { id: "t2", title: "two", category: "custom" })

      yield* migrateTodos(todosSchema({ categoryRequired: true, categoryDefault: "fallback" }), {
        allowDestructive: true
      })

      const rows = yield* sql<{ id: string; category: string }>`
        SELECT id, category FROM ${sql("todos")} ORDER BY id
      `
      expect(rows).toEqual([
        { id: "t1", category: "fallback" },
        { id: "t2", category: "custom" }
      ])
      expect(yield* categoryNotNull(sql)).toBe(1)
    }).pipe(Effect.provide(testLayer)))

  it.effect("rolls a failed rebuild back completely and resets connection state", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* migrateTodos(todosSchema())
      yield* insertTodo(sql, { id: "t1", title: "one", category: null })

      const exit = yield* Effect.exit(
        migrateTodos(todosSchema({ categoryRequired: true }), { allowDestructive: true })
      )
      expect(Exit.isFailure(exit)).toBe(true)

      expect(yield* tableExists(sql, "_mira_rebuild_todos")).toEqual([])
      expect(yield* categoryNotNull(sql)).toBe(0)
      expect((yield* legacyAlterTable(sql))[0].legacy_alter_table).toBe(0)

      const rows = yield* sql<{ category: string | null }>`SELECT category FROM ${sql("todos")}`
      expect(rows).toEqual([{ category: null }])

      const migrator = yield* Migrator
      const plan = yield* migrator.plan([
        { name: "todos", schema: todosSchema({ categoryRequired: true }) }
      ])
      expect(plan.steps.map((s) => s.kind)).toContain("alterColumn")
    }).pipe(Effect.provide(testLayer)))

  it.effect("keeps an unchanged view working across a rebuild", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const migrator = yield* Migrator
      yield* migrator.migrate([
        { name: "todos", schema: todosSchema({ categoryRequired: true }) },
        { name: "todos_view", schema: todosView() }
      ])
      yield* insertTodo(sql, { id: "t1", title: "one", category: "c1" })

      yield* migrator.migrate([
        { name: "todos", schema: todosSchema() },
        { name: "todos_view", schema: todosView() }
      ])
      expect(yield* categoryNotNull(sql)).toBe(0)

      const rows = yield* sql<{ id: string; title: string }>`SELECT id, title FROM ${sql("todos_view")}`
      expect(rows).toEqual([{ id: "t1", title: "one" }])
    }).pipe(Effect.provide(testLayer)))
})

describe("migrator statement guard", () => {
  it.effect("refuses to execute a statement that contains no SQL", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const statement = yield* migrateTodos(todosSchema()).pipe(
        Effect.catchTag("InvalidMigrationStatementError", (error) => Effect.succeed(error.statement)),
        Effect.orDie
      )
      expect(statement).toBe("-- alterColumn requires table recreation")
      expect(yield* tableExists(sql, "todos")).toEqual([])
    }).pipe(Effect.provide(commentOnlyLayer)))
})
