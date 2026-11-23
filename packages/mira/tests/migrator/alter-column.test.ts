import { SqliteClient } from "@effect/sql-sqlite-node"
import { describe, it } from "@effect/vitest"
import type { CollectionSchema } from "@gettersethya/mira-client"
import { Effect, Exit, Layer } from "effect"
import { SqlClient, SqlError } from "effect/sql"
import { expect } from "vitest"

import { Dialect } from "@/dialect/dialect.js"
import type { DialectType } from "@/dialect/dialect.js"
import { sqliteDialect } from "@/dialect/dialect-sqlite.js"
import type { MigrationError } from "@/migrator/errors.js"
import { Migrator, MigratorLive } from "@/migrator/migrator.js"

const sqliteLayer = SqliteClient.layer({ filename: ":memory:" })

const testLayerWith = (
  dialect: DialectType,
  sqlLayer: Layer.Layer<SqlClient.SqlClient>
) =>
  Layer.mergeAll(
    MigratorLive.pipe(Layer.provide(Layer.mergeAll(Layer.succeed(Dialect, dialect), sqlLayer))),
    sqlLayer
  )

const testLayer = testLayerWith(sqliteDialect, sqliteLayer)

const recordingLayer = (recorded: Array<string>) =>
  Layer.effect(
    SqlClient.SqlClient,
    Effect.gen(function* () {
      const base = yield* SqlClient.SqlClient
      return new Proxy(base, {
        get(target, property, receiver) {
          if (property === "unsafe") {
            return (statement: string, params?: ReadonlyArray<unknown>) => {
              recorded.push(statement)
              return target.unsafe(statement, params)
            }
          }
          return Reflect.get(target, property, receiver)
        }
      })
    })
  ).pipe(Layer.provide(sqliteLayer))

/** A dialect that renders a comment instead of SQL - the shape of the original defect. */
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

/** A `todos` shape without the `title` column, used to force a dropColumn. */
function todosWithoutTitle(): CollectionSchema {
  const schema = todosSchema({ categoryRequired: true })
  delete schema.properties["title"]
  schema.required = ["id", "category"]
  return schema
}

type ViewOptions = {
  query?: string
  properties?: ReadonlyArray<string>
}

const viewPropertyDefinitions: Record<string, CollectionSchema["properties"][string]> = {
  id: { type: "string", "x-system": true, "x-view-only": true },
  seqId: { type: "integer", "x-system": true, "x-view-only": true, "x-kind": "seqId" },
  title: { type: "string" },
  secret: { type: "string", "x-hidden": true }
}

/** A view collection reading from `todos`. */
function todosView({
  query = "SELECT id, seqId, title FROM todos",
  properties = ["id", "seqId", "title"]
}: ViewOptions = {}): CollectionSchema {
  const viewProperties: CollectionSchema["properties"] = {}
  for (const name of properties) {
    const definition = viewPropertyDefinitions[name]
    if (definition !== undefined) viewProperties[name] = definition
  }
  return {
    "x-collection-kind": "view",
    type: "object",
    properties: viewProperties,
    required: ["id"],
    "x-view-query": query
  }
}

function todosViewWithoutTitle(): CollectionSchema {
  return todosView({
    query: "SELECT id, seqId FROM todos",
    properties: ["id", "seqId"]
  })
}

function todosViewWithStaleProperty(): CollectionSchema {
  return todosView({
    query: "SELECT id, seqId FROM todos",
    properties: ["id", "seqId", "title"]
  })
}

function todosWithoutTitleCategoryRequired(): CollectionSchema {
  const schema = todosSchema({ categoryRequired: true })
  delete schema.properties["title"]
  schema.required = ["id", "category"]
  return schema
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

const triggerNames = (sql: SqlClient.SqlClient) =>
  sql<{ name: string }>`
    SELECT name FROM sqlite_master
    WHERE type = 'trigger'
  `

const tableExists = (sql: SqlClient.SqlClient, table: string) =>
  sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${table}`

const viewSql = (sql: SqlClient.SqlClient, view: string) =>
  sql<{ name: string; sql: string }>`
    SELECT name, sql FROM sqlite_master WHERE type = 'view' AND name = ${view}
  `

const countRows = (sql: SqlClient.SqlClient, table: string) =>
  sql<{ count: number }>`SELECT COUNT(*) AS count FROM ${sql(table)}`

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

/** Narrows a preflight failure to its detail; any other failure aborts the test. */
const preflightDetail = <A>(effect: Effect.Effect<A, MigrationError>) =>
  effect.pipe(
    Effect.catchTag("UnsupportedMigrationStepError", (error) => Effect.succeed(error.detail)),
    Effect.orDie
  )

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

  it.effect("recreates a view whose desired query and properties drop the removed column", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const migrator = yield* Migrator
      yield* migrator.migrate([
        { name: "todos", schema: todosSchema({ categoryRequired: true }) },
        { name: "todos_view", schema: todosView() }
      ])
      yield* insertTodo(sql, { id: "t1", title: "one", category: "c1" })

      yield* migrator.migrate(
        [
          { name: "todos", schema: todosWithoutTitle() },
          { name: "todos_view", schema: todosViewWithoutTitle() }
        ],
        { allowDestructive: true }
      )

      expect((yield* tableInfo(sql, "todos")).map((c) => c.name)).not.toContain("title")
      const views = yield* viewSql(sql, "todos_view")
      expect(views).toHaveLength(1)
      expect(views[0]?.sql).toContain("SELECT id, seqId FROM todos")
      const rows = yield* sql<{ id: string }>`SELECT id FROM ${sql("todos_view")}`
      expect(rows).toEqual([{ id: "t1" }])
      const base = yield* sql<{ id: string }>`SELECT id FROM ${sql("todos")}`
      expect(base).toEqual([{ id: "t1" }])
    }).pipe(Effect.provide(testLayer)))

  it.effect("rolls back when the view query drops the column but the property remains", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const migrator = yield* Migrator
      const initial = todosSchema({
        categoryRequired: true,
        indexes: [{ fields: ["category"], unique: false }]
      })
      yield* migrator.migrate([
        { name: "todos", schema: initial },
        { name: "todos_view", schema: todosView() }
      ])
      yield* insertTodo(sql, { id: "t1", title: "one", category: "c1" })

      const beforeCollections = yield* countRows(sql, "_collections")
      const beforeMigrations = yield* countRows(sql, "_migrations")
      const beforeIndexes = (yield* indexNames(sql, "todos")).map((i) => i.name).sort()

      const destructive = todosWithoutTitle()
      destructive["x-indexes"] = [{ fields: ["category"], unique: false }]
      const exit = yield* Effect.exit(
        migrator.migrate(
          [
            { name: "todos", schema: destructive },
            { name: "todos_view", schema: todosViewWithStaleProperty() }
          ],
          { allowDestructive: true }
        )
      )

      expect(Exit.isFailure(exit)).toBe(true)
      expect((yield* tableInfo(sql, "todos")).map((c) => c.name)).toContain("title")
      const views = yield* viewSql(sql, "todos_view")
      expect(views).toHaveLength(1)
      expect(views[0]?.sql).toContain("title")
      expect(yield* sql<{ id: string }>`SELECT id FROM ${sql("todos")}`).toEqual([{ id: "t1" }])
      expect(yield* countRows(sql, "_collections")).toEqual(beforeCollections)
      expect(yield* countRows(sql, "_migrations")).toEqual(beforeMigrations)
      expect((yield* indexNames(sql, "todos")).map((i) => i.name).sort()).toEqual(beforeIndexes)
      const storedView = yield* sql<{ schema: string }>`
        SELECT schema FROM "_collections" WHERE name = ${"todos_view"}
      `
      expect(storedView[0]?.schema).toContain("SELECT id, seqId, title FROM todos")
    }).pipe(Effect.provide(testLayer)))

  it.effect("rolls back when the view query still selects the dropped column", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const migrator = yield* Migrator
      yield* migrator.migrate([
        { name: "todos", schema: todosSchema({ categoryRequired: true }) },
        { name: "todos_view", schema: todosView() }
      ])
      yield* insertTodo(sql, { id: "t1", title: "one", category: "c1" })

      const exit = yield* Effect.exit(
        migrator.migrate(
          [
            { name: "todos", schema: todosWithoutTitle() },
            { name: "todos_view", schema: todosView() }
          ],
          { allowDestructive: true }
        )
      )

      expect(Exit.isFailure(exit)).toBe(true)
      expect((yield* tableInfo(sql, "todos")).map((c) => c.name)).toContain("title")
      const views = yield* viewSql(sql, "todos_view")
      expect(views).toHaveLength(1)
      expect(views[0]?.sql).toContain("title")
      expect(yield* sql<{ id: string }>`SELECT id FROM ${sql("todos")}`).toEqual([{ id: "t1" }])
    }).pipe(Effect.provide(testLayer)))

  it.effect("recreates a SELECT * view when the declared properties drop the removed column", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const migrator = yield* Migrator
      yield* migrator.migrate([
        { name: "todos", schema: todosSchema({ categoryRequired: true }) },
        {
          name: "todos_view",
          schema: todosView({ query: "SELECT * FROM todos", properties: ["id", "seqId", "title"] })
        }
      ])
      yield* insertTodo(sql, { id: "t1", title: "one", category: "c1" })

      yield* migrator.migrate(
        [
          { name: "todos", schema: todosWithoutTitle() },
          {
            name: "todos_view",
            schema: todosView({ query: "SELECT * FROM todos", properties: ["id", "seqId"] })
          }
        ],
        { allowDestructive: true }
      )

      const views = yield* viewSql(sql, "todos_view")
      expect(views).toHaveLength(1)
      expect(views[0]?.sql).toContain("SELECT * FROM todos")
      const columns = (yield* tableInfo(sql, "todos_view")).map((c) => c.name)
      expect(columns).toContain("id")
      expect(columns).toContain("seqId")
      expect(columns).not.toContain("title")
      expect(yield* sql<{ id: string }>`SELECT id FROM ${sql("todos_view")}`).toEqual([
        { id: "t1" }
      ])
    }).pipe(Effect.provide(testLayer)))

  it.effect("rolls back when a SELECT * view still declares the removed column", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const migrator = yield* Migrator
      yield* migrator.migrate([
        { name: "todos", schema: todosSchema({ categoryRequired: true }) },
        {
          name: "todos_view",
          schema: todosView({ query: "SELECT * FROM todos", properties: ["id", "seqId", "title"] })
        }
      ])
      yield* insertTodo(sql, { id: "t1", title: "one", category: "c1" })

      const exit = yield* Effect.exit(
        migrator.migrate(
          [
            { name: "todos", schema: todosWithoutTitle() },
            {
              name: "todos_view",
              schema: todosView({ query: "SELECT * FROM todos", properties: ["id", "seqId", "title"] })
            }
          ],
          { allowDestructive: true }
        )
      )

      expect(Exit.isFailure(exit)).toBe(true)
      expect((yield* tableInfo(sql, "todos")).map((c) => c.name)).toContain("title")
      expect(yield* viewSql(sql, "todos_view")).toHaveLength(1)
    }).pipe(Effect.provide(testLayer)))

  it.effect("recreates a transitive view chain so both views remain queryable", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const migrator = yield* Migrator
      yield* migrator.migrate([
        { name: "todos", schema: todosSchema({ categoryRequired: true }) },
        { name: "todos_v1", schema: todosView() },
        {
          name: "todos_v2",
          schema: todosView({
            query: "SELECT id, seqId FROM todos_v1",
            properties: ["id", "seqId"]
          })
        }
      ])
      yield* insertTodo(sql, { id: "t1", title: "one", category: "c1" })

      yield* migrator.migrate(
        [
          { name: "todos", schema: todosWithoutTitle() },
          { name: "todos_v1", schema: todosViewWithoutTitle() },
          {
            name: "todos_v2",
            schema: todosView({
              query: "SELECT id, seqId FROM todos_v1",
              properties: ["id", "seqId"]
            })
          }
        ],
        { allowDestructive: true }
      )

      expect(yield* sql<{ id: string }>`SELECT id FROM ${sql("todos_v1")}`).toEqual([
        { id: "t1" }
      ])
      expect(yield* sql<{ id: string }>`SELECT id FROM ${sql("todos_v2")}`).toEqual([
        { id: "t1" }
      ])
    }).pipe(Effect.provide(testLayer)))

  it.effect("recreates views when a dropColumn is subsumed by a rebuild", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const migrator = yield* Migrator
      yield* migrator.migrate([
        { name: "todos", schema: todosSchema() },
        { name: "todos_view", schema: todosView() }
      ])
      yield* insertTodo(sql, { id: "t1", title: "one", category: "c1" })

      yield* migrator.migrate(
        [
          { name: "todos", schema: todosWithoutTitleCategoryRequired() },
          { name: "todos_view", schema: todosViewWithoutTitle() }
        ],
        { allowDestructive: true }
      )

      expect((yield* tableInfo(sql, "todos")).map((c) => c.name)).not.toContain("title")
      expect(yield* categoryNotNull(sql)).toBe(1)
      expect((yield* viewSql(sql, "todos_view"))[0]?.sql).toContain("SELECT id, seqId FROM todos")
      expect(yield* sql<{ id: string }>`SELECT id FROM ${sql("todos_view")}`).toEqual([
        { id: "t1" }
      ])
    }).pipe(Effect.provide(testLayer)))

  it.effect("rolls back when a rebuild leaves a stale view", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const migrator = yield* Migrator
      yield* migrator.migrate([
        { name: "todos", schema: todosSchema() },
        { name: "todos_view", schema: todosView() }
      ])
      yield* insertTodo(sql, { id: "t1", title: "one", category: "c1" })

      const exit = yield* Effect.exit(
        migrator.migrate(
          [
            { name: "todos", schema: todosWithoutTitleCategoryRequired() },
            { name: "todos_view", schema: todosView() }
          ],
          { allowDestructive: true }
        )
      )

      expect(Exit.isFailure(exit)).toBe(true)
      expect((yield* tableInfo(sql, "todos")).map((c) => c.name)).toContain("title")
      expect(yield* categoryNotNull(sql)).toBe(0)
      expect((yield* viewSql(sql, "todos_view"))[0]?.sql).toContain("title")
      expect(yield* sql<{ id: string }>`SELECT id FROM ${sql("todos")}`).toEqual([{ id: "t1" }])
    }).pipe(Effect.provide(testLayer)))

  it.effect("removes an affected orphan view with an explicit drop", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const migrator = yield* Migrator
      yield* migrator.migrate([
        { name: "todos", schema: todosSchema({ categoryRequired: true }) },
        { name: "todos_view", schema: todosView() }
      ])
      yield* insertTodo(sql, { id: "t1", title: "one", category: "c1" })

      yield* migrator.migrate([{ name: "todos", schema: todosWithoutTitle() }], {
        allowDestructive: true
      })

      expect(yield* viewSql(sql, "todos_view")).toEqual([])
      expect((yield* tableInfo(sql, "todos")).map((c) => c.name)).not.toContain("title")
      expect(yield* sql<{ id: string }>`SELECT id FROM ${sql("todos")}`).toEqual([{ id: "t1" }])
    }).pipe(Effect.provide(testLayer)))

  it.effect("leaves an unaffected view untouched", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const migrator = yield* Migrator
      yield* migrator.migrate([{ name: "todos", schema: todosSchema({ categoryRequired: true }) }])
      yield* sql.unsafe(`CREATE VIEW "other_view" AS SELECT 1 AS "id"`)
      yield* insertTodo(sql, { id: "t1", title: "one", category: "c1" })

      yield* migrator.migrate([{ name: "todos", schema: todosWithoutTitle() }], {
        allowDestructive: true
      })

      expect((yield* viewSql(sql, "other_view"))[0]?.sql).toContain("SELECT 1")
      expect(yield* sql<{ id: number }>`SELECT id FROM ${sql("other_view")}`).toEqual([{ id: 1 }])
    }).pipe(Effect.provide(testLayer)))

  it.effect("untracked view blocks the native drop and rolls back", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const migrator = yield* Migrator
      yield* migrator.migrate([{ name: "todos", schema: todosSchema({ categoryRequired: true }) }])
      yield* sql.unsafe(`CREATE VIEW "raw_view" AS SELECT "id", "title" FROM "todos"`)
      yield* insertTodo(sql, { id: "t1", title: "one", category: "c1" })

      const plan = yield* migrator.plan(
        [{ name: "todos", schema: todosWithoutTitle() }],
        { allowDestructive: true }
      )
      expect(plan.notes ?? []).toContain(
        'untracked view "raw_view" may fail this native drop at execution if it reads the dropped column'
      )

      const exit = yield* Effect.exit(
        migrator.migrate([{ name: "todos", schema: todosWithoutTitle() }], {
          allowDestructive: true
        })
      )

      expect(Exit.isFailure(exit)).toBe(true)
      expect((yield* tableInfo(sql, "todos")).map((c) => c.name)).toContain("title")
      expect(yield* viewSql(sql, "raw_view")).toHaveLength(1)
      expect(yield* sql<{ id: string }>`SELECT id FROM ${sql("todos")}`).toEqual([{ id: "t1" }])
    }).pipe(Effect.provide(testLayer)))

  it.effect("fails preflight instead of leaving an untracked view broken", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const migrator = yield* Migrator
      yield* migrator.migrate([{ name: "todos", schema: todosSchema() }])
      yield* sql.unsafe(`CREATE VIEW "raw_view" AS SELECT "id", "title" FROM "todos"`)
      yield* insertTodo(sql, { id: "t1", title: "one", category: "c1" })

      const beforeMigrations = yield* countRows(sql, "_migrations")

      const exit = yield* Effect.exit(
        migrator.migrate([{ name: "todos", schema: todosWithoutTitleCategoryRequired() }], {
          allowDestructive: true
        })
      )
      expect(Exit.isFailure(exit)).toBe(true)

      const detail = yield* preflightDetail(
        migrator.plan([{ name: "todos", schema: todosWithoutTitleCategoryRequired() }], {
          allowDestructive: true
        })
      )
      expect(detail).toContain('untracked views: "raw_view" depends on rebuilt table "todos"')
      expect(detail).toContain(
        "they would be left broken. Track each view in Mira, or remove or rename it before migrating."
      )

      expect((yield* tableInfo(sql, "todos")).map((c) => c.name)).toContain("title")
      const rawView = yield* viewSql(sql, "raw_view")
      expect(rawView).toHaveLength(1)
      expect(rawView[0]?.sql).toContain("title")
      expect(yield* sql<{ id: string }>`SELECT id FROM ${sql("todos")}`).toEqual([{ id: "t1" }])
      const afterMigrations = yield* countRows(sql, "_migrations")
      expect(Number(afterMigrations[0]?.count)).toBe(Number(beforeMigrations[0]?.count))
    }).pipe(Effect.provide(testLayer)))

  it.effect("rolls back when an affected view query is invalid for another reason", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const migrator = yield* Migrator
      yield* migrator.migrate([
        { name: "todos", schema: todosSchema({ categoryRequired: true }) },
        { name: "todos_view", schema: todosView() }
      ])
      yield* insertTodo(sql, { id: "t1", title: "one", category: "c1" })

      const exit = yield* Effect.exit(
        migrator.migrate(
          [
            { name: "todos", schema: todosWithoutTitle() },
            {
              name: "todos_view",
              schema: todosView({
                query: "SELECT id, missing FROM nowhere",
                properties: ["id", "missing"]
              })
            }
          ],
          { allowDestructive: true }
        )
      )

      expect(Exit.isFailure(exit)).toBe(true)
      expect((yield* tableInfo(sql, "todos")).map((c) => c.name)).toContain("title")
      expect((yield* viewSql(sql, "todos_view"))[0]?.sql).toContain("title")
      expect(yield* sql<{ id: string }>`SELECT id FROM ${sql("todos")}`).toEqual([{ id: "t1" }])
    }).pipe(Effect.provide(testLayer)))

  it.effect("fails plan() preflight with an actionable allowDestructive message", () =>
    Effect.gen(function* () {
      const migrator = yield* Migrator
      yield* migrator.migrate([
        { name: "todos", schema: todosSchema({ categoryRequired: true }) },
        { name: "todos_view", schema: todosView() }
      ])

      const error = yield* Effect.flip(
        migrator.plan([{ name: "todos", schema: todosWithoutTitle() }])
      )
      const detail =
        typeof error === "object" && error !== null && "detail" in error
          ? String(Reflect.get(error, "detail"))
          : String(error)
      expect(detail).toContain("allowDestructive")
    }).pipe(Effect.provide(testLayer)))

  it.effect("records validation queries after the DDL statements", () => {
    const recorded: Array<string> = []
    return Effect.gen(function* () {
      const migrator = yield* Migrator
      yield* migrator.migrate([
        { name: "todos", schema: todosSchema({ categoryRequired: true }) },
        { name: "todos_view", schema: todosView() }
      ])
      recorded.length = 0

      yield* migrator.migrate(
        [
          { name: "todos", schema: todosWithoutTitle() },
          { name: "todos_view", schema: todosViewWithoutTitle() }
        ],
        { allowDestructive: true }
      )

      const ddlIndex = recorded.findIndex(
        (statement) => statement === 'ALTER TABLE "todos" DROP COLUMN "title"'
      )
      const validationIndex = recorded.findIndex((statement) =>
        statement.includes('SELECT "id", "seqId" FROM "todos_view" LIMIT 0')
      )
      expect(ddlIndex).toBeGreaterThanOrEqual(0)
      expect(validationIndex).toBeGreaterThan(ddlIndex)
    }).pipe(Effect.provide(testLayerWith(sqliteDialect, recordingLayer(recorded))))
  })

  it.effect("refuses to overwrite a stale scratch table", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* migrateTodos(todosSchema({ categoryRequired: true }))
      yield* insertTodo(sql, { id: "t1", title: "one", category: "c1" })
      yield* sql.unsafe(`CREATE TABLE "_mira_rebuild_todos" (marker TEXT)`)

      const exit = yield* Effect.exit(migrateTodos(todosSchema()))
      expect(Exit.isFailure(exit)).toBe(true)

      expect(yield* tableExists(sql, "todos")).not.toEqual([])
      expect(yield* tableExists(sql, "_mira_rebuild_todos")).not.toEqual([])
      const rows = yield* sql<{ id: string }>`SELECT id FROM ${sql("todos")}`
      expect(rows).toEqual([{ id: "t1" }])
    }).pipe(Effect.provide(testLayer)))

  it.effect("rolls back the plan when the _collections upsert fails", () => {
    const failingCollections = Layer.effect(
      SqlClient.SqlClient,
      Effect.gen(function* () {
        const base = yield* SqlClient.SqlClient
        return new Proxy(base, {
          get(target, property, receiver) {
            if (property === "unsafe") {
              return (statement: string, params?: ReadonlyArray<unknown>) =>
                statement.includes('INSERT INTO "_collections"')
                  ? Effect.fail(
                      new SqlError.SqlError({
                        reason: new SqlError.UnknownError({
                          cause: undefined,
                          message: "forced _collections failure"
                        })
                      })
                    )
                  : target.unsafe(statement, params)
            }
            const value = Reflect.get(target, property, receiver)
            return typeof value === "function" ? value.bind(target) : value
          }
        })
      })
    ).pipe(Layer.provide(sqliteLayer))

    const layer = Layer.mergeAll(
      MigratorLive.pipe(
        Layer.provide(
          Layer.mergeAll(Layer.succeed(Dialect, sqliteDialect), failingCollections)
        )
      ),
      failingCollections
    )

    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const migrator = yield* Migrator
      const exit = yield* Effect.exit(migrator.migrate([{ name: "todos", schema: todosSchema() }]))
      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* tableExists(sql, "todos")).toEqual([])
      const migrations = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM "_migrations"`
      const collections = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM "_collections"`
      expect(Number(migrations[0]?.count)).toBe(0)
      expect(Number(collections[0]?.count)).toBe(0)
    }).pipe(Effect.provide(layer))
  })
})

describe("SQLite untracked views and view-attached objects", () => {
  it.effect("notes and passes a native drop whose untracked view reads a surviving column", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const migrator = yield* Migrator
      yield* migrator.migrate([{ name: "todos", schema: todosSchema({ categoryRequired: true }) }])
      yield* sql.unsafe(`CREATE VIEW "raw_view" AS SELECT "id", "category" FROM "todos"`)
      yield* insertTodo(sql, { id: "t1", title: "one", category: "c1" })

      const plan = yield* migrator.plan(
        [{ name: "todos", schema: todosWithoutTitle() }],
        { allowDestructive: true }
      )
      expect(plan.notes ?? []).toContain(
        'untracked view "raw_view" may fail this native drop at execution if it reads the dropped column'
      )

      yield* migrator.migrate([{ name: "todos", schema: todosWithoutTitle() }], {
        allowDestructive: true
      })

      expect((yield* tableInfo(sql, "todos")).map((c) => c.name)).not.toContain("title")
      expect(
        yield* sql<{ id: string; category: string }>`SELECT id, category FROM ${sql("raw_view")}`
      ).toEqual([{ id: "t1", category: "c1" }])
    }).pipe(Effect.provide(testLayer)))

  it.effect("fails preflight when a dropped table has an untracked dependent view", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const migrator = yield* Migrator
      yield* migrator.migrate([{ name: "todos", schema: todosSchema({ categoryRequired: true }) }])
      yield* sql.unsafe(`CREATE VIEW "raw_view" AS SELECT "id", "title" FROM "todos"`)
      yield* insertTodo(sql, { id: "t1", title: "one", category: "c1" })

      const beforeMigrations = yield* countRows(sql, "_migrations")

      const exit = yield* Effect.exit(migrator.migrate([], { allowDestructive: true }))
      expect(Exit.isFailure(exit)).toBe(true)

      const detail = yield* preflightDetail(migrator.plan([], { allowDestructive: true }))
      expect(detail).toContain('untracked views: "raw_view" depends on dropped table "todos"')
      expect(detail).toContain(
        "they would be left broken. Track each view in Mira, or remove or rename it before migrating."
      )

      expect(yield* tableExists(sql, "todos")).not.toEqual([])
      expect(yield* sql<{ id: string }>`SELECT id FROM ${sql("todos")}`).toEqual([{ id: "t1" }])
      expect(yield* viewSql(sql, "raw_view")).toHaveLength(1)
      const afterMigrations = yield* countRows(sql, "_migrations")
      expect(Number(afterMigrations[0]?.count)).toBe(Number(beforeMigrations[0]?.count))
    }).pipe(Effect.provide(testLayer)))

  it.effect("fails preflight when a removed view has an untracked dependent", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const migrator = yield* Migrator
      yield* migrator.migrate([
        { name: "todos", schema: todosSchema({ categoryRequired: true }) },
        { name: "todos_view", schema: todosView() }
      ])
      yield* sql.unsafe(`CREATE VIEW "raw_dependent" AS SELECT "id" FROM "todos_view"`)
      yield* insertTodo(sql, { id: "t1", title: "one", category: "c1" })

      const beforeMigrations = yield* countRows(sql, "_migrations")

      const exit = yield* Effect.exit(
        migrator.migrate([{ name: "todos", schema: todosSchema({ categoryRequired: true }) }], {
          allowDestructive: true
        })
      )
      expect(Exit.isFailure(exit)).toBe(true)

      const detail = yield* preflightDetail(
        migrator.plan([{ name: "todos", schema: todosSchema({ categoryRequired: true }) }], {
          allowDestructive: true
        })
      )
      expect(detail).toContain(
        'untracked views: "raw_dependent" depends on dropped view "todos_view"'
      )
      expect(detail).toContain(
        "they would be left broken. Track each view in Mira, or remove or rename it before migrating."
      )

      expect(yield* tableExists(sql, "todos")).not.toEqual([])
      expect(yield* viewSql(sql, "todos_view")).toHaveLength(1)
      expect(yield* sql<{ id: string }>`SELECT id FROM ${sql("raw_dependent")}`).toEqual([
        { id: "t1" }
      ])
      const afterMigrations = yield* countRows(sql, "_migrations")
      expect(Number(afterMigrations[0]?.count)).toBe(Number(beforeMigrations[0]?.count))
    }).pipe(Effect.provide(testLayer)))

  it.effect("fails preflight when a dropped table leaves a tracked dependent view broken", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const migrator = yield* Migrator
      yield* migrator.migrate([
        { name: "todos", schema: todosSchema({ categoryRequired: true }) },
        { name: "todos_view", schema: todosView() }
      ])
      yield* insertTodo(sql, { id: "t1", title: "one", category: "c1" })

      const exit = yield* Effect.exit(
        migrator.migrate([{ name: "todos_view", schema: todosView() }], { allowDestructive: true })
      )
      expect(Exit.isFailure(exit)).toBe(true)

      const detail = yield* preflightDetail(
        migrator.plan([{ name: "todos_view", schema: todosView() }], { allowDestructive: true })
      )
      expect(detail).toContain(
        'tracked view "todos_view" depends on dropped table "todos" and is neither recreated nor dropped'
      )
      expect(detail).toContain(
        "Mira would leave it broken. Remove the view collection, or recreate or drop it in this plan."
      )

      expect(yield* tableExists(sql, "todos")).not.toEqual([])
      expect(yield* sql<{ id: string }>`SELECT id FROM ${sql("todos_view")}`).toEqual([{ id: "t1" }])
    }).pipe(Effect.provide(testLayer)))

  it.effect("notes and probes an untracked dependent of an edited view and proceeds", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const migrator = yield* Migrator
      yield* migrator.migrate([
        { name: "todos", schema: todosSchema({ categoryRequired: true }) },
        { name: "todos_view", schema: todosView() }
      ])
      yield* sql.unsafe(`CREATE VIEW "raw_dependent" AS SELECT "id" FROM "todos_view"`)
      yield* insertTodo(sql, { id: "t1", title: "one", category: "c1" })

      const plan = yield* migrator.plan([
        { name: "todos", schema: todosSchema({ categoryRequired: true }) },
        { name: "todos_view", schema: todosViewWithoutTitle() }
      ])
      expect(plan.steps.map((s) => s.kind)).toEqual(["dropView", "createView"])
      expect(plan.notes ?? []).toContain(
        'untracked view "raw_dependent" depends on recreated view "todos_view"; a probe verifies it inside the migration'
      )

      yield* migrator.migrate([
        { name: "todos", schema: todosSchema({ categoryRequired: true }) },
        { name: "todos_view", schema: todosViewWithoutTitle() }
      ])

      expect((yield* viewSql(sql, "todos_view"))[0]?.sql).toContain("SELECT id, seqId FROM todos")
      expect(yield* sql<{ id: string }>`SELECT id FROM ${sql("raw_dependent")}`).toEqual([
        { id: "t1" }
      ])
    }).pipe(Effect.provide(testLayer)))

  it.effect("fails preflight when an edited view carries a trigger and leaves both untouched", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const migrator = yield* Migrator
      yield* migrator.migrate([
        { name: "todos", schema: todosSchema({ categoryRequired: true }) },
        { name: "todos_view", schema: todosView() }
      ])
      yield* sql.unsafe(`CREATE TRIGGER "t" INSTEAD OF INSERT ON "todos_view" BEGIN SELECT 1; END`)
      yield* insertTodo(sql, { id: "t1", title: "one", category: "c1" })

      const exit = yield* Effect.exit(
        migrator.migrate([
          { name: "todos", schema: todosSchema({ categoryRequired: true }) },
          { name: "todos_view", schema: todosViewWithoutTitle() }
        ])
      )
      expect(Exit.isFailure(exit)).toBe(true)

      const detail = yield* preflightDetail(
        migrator.plan([
          { name: "todos", schema: todosSchema({ categoryRequired: true }) },
          { name: "todos_view", schema: todosViewWithoutTitle() }
        ])
      )
      expect(detail).toContain(
        'view "todos_view" has trigger "t"; SQLite allows only INSTEAD OF triggers on views and Mira cannot recreate them. Remove the trigger or migrate the view by hand.'
      )

      expect((yield* viewSql(sql, "todos_view"))[0]?.sql).toContain(
        "SELECT id, seqId, title FROM todos"
      )
      expect((yield* triggerNames(sql)).map((t) => t.name)).toContain("t")
    }).pipe(Effect.provide(testLayer)))

  it.effect("fails preflight when an edited view carries a trigger stored with mixed case", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const migrator = yield* Migrator
      yield* migrator.migrate([
        { name: "todos", schema: todosSchema({ categoryRequired: true }) },
        { name: "todos_view", schema: todosView() }
      ])
      yield* sql.unsafe(`CREATE TRIGGER "t" INSTEAD OF INSERT ON TODOS_VIEW BEGIN SELECT 1; END`)
      yield* insertTodo(sql, { id: "t1", title: "one", category: "c1" })

      const exit = yield* Effect.exit(
        migrator.migrate([
          { name: "todos", schema: todosSchema({ categoryRequired: true }) },
          { name: "todos_view", schema: todosViewWithoutTitle() }
        ])
      )
      expect(Exit.isFailure(exit)).toBe(true)

      const detail = yield* preflightDetail(
        migrator.plan([
          { name: "todos", schema: todosSchema({ categoryRequired: true }) },
          { name: "todos_view", schema: todosViewWithoutTitle() }
        ])
      )
      expect(detail).toContain(
        'view "todos_view" has trigger "t"; SQLite allows only INSTEAD OF triggers on views and Mira cannot recreate them. Remove the trigger or migrate the view by hand.'
      )

      expect((yield* viewSql(sql, "todos_view"))[0]?.sql).toContain(
        "SELECT id, seqId, title FROM todos"
      )
      expect((yield* triggerNames(sql)).map((t) => t.name)).toContain("t")
    }).pipe(Effect.provide(testLayer)))

  it.effect("fails preflight when a rebuilt table carries a trigger and leaves both untouched", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const migrator = yield* Migrator
      yield* migrator.migrate([{ name: "todos", schema: todosSchema() }])
      yield* sql.unsafe(`CREATE TRIGGER "t" BEFORE INSERT ON "todos" BEGIN SELECT 1; END`)
      yield* insertTodo(sql, { id: "t1", title: "one", category: "c1" })

      const exit = yield* Effect.exit(
        migrator.migrate([{ name: "todos", schema: todosSchema({ categoryRequired: true }) }], {
          allowDestructive: true
        })
      )
      expect(Exit.isFailure(exit)).toBe(true)

      const detail = yield* preflightDetail(
        migrator.plan([{ name: "todos", schema: todosSchema({ categoryRequired: true }) }], {
          allowDestructive: true
        })
      )
      expect(detail).toContain(
        'table "todos" has trigger "t"; the rebuild would drop it. Remove the trigger or migrate by hand.'
      )

      expect(yield* categoryNotNull(sql)).toBe(0)
      expect(yield* sql<{ id: string }>`SELECT id FROM ${sql("todos")}`).toEqual([{ id: "t1" }])
      expect((yield* triggerNames(sql)).map((t) => t.name)).toContain("t")
    }).pipe(Effect.provide(testLayer)))

  it.effect("notes the trigger a dropped table removes and proceeds", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const migrator = yield* Migrator
      yield* migrator.migrate([{ name: "todos", schema: todosSchema({ categoryRequired: true }) }])
      yield* sql.unsafe(`CREATE TRIGGER "t" BEFORE INSERT ON "todos" BEGIN SELECT 1; END`)
      yield* insertTodo(sql, { id: "t1", title: "one", category: "c1" })

      const plan = yield* migrator.plan([], { allowDestructive: true })
      expect(plan.notes ?? []).toContain('dropping table "todos" also removes trigger "t"')

      yield* migrator.migrate([], { allowDestructive: true })

      expect(yield* tableExists(sql, "todos")).toEqual([])
      expect((yield* triggerNames(sql)).map((t) => t.name)).not.toContain("t")
    }).pipe(Effect.provide(testLayer)))

  it.effect("notes the trigger a removed view removes and proceeds", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const migrator = yield* Migrator
      yield* migrator.migrate([
        { name: "todos", schema: todosSchema({ categoryRequired: true }) },
        { name: "todos_view", schema: todosView() }
      ])
      yield* sql.unsafe(`CREATE TRIGGER "t" INSTEAD OF INSERT ON "todos_view" BEGIN SELECT 1; END`)
      yield* insertTodo(sql, { id: "t1", title: "one", category: "c1" })

      const plan = yield* migrator.plan(
        [{ name: "todos", schema: todosSchema({ categoryRequired: true }) }],
        { allowDestructive: true }
      )
      expect(plan.notes ?? []).toContain('dropping view "todos_view" also removes trigger "t"')

      yield* migrator.migrate(
        [{ name: "todos", schema: todosSchema({ categoryRequired: true }) }],
        { allowDestructive: true }
      )

      expect(yield* viewSql(sql, "todos_view")).toEqual([])
      expect((yield* triggerNames(sql)).map((t) => t.name)).not.toContain("t")
    }).pipe(Effect.provide(testLayer)))

  it.effect("fails preflight when a stored view declares an explicit column list", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const migrator = yield* Migrator
      yield* migrator.migrate([
        { name: "todos", schema: todosSchema({ categoryRequired: true }) },
        { name: "todos_view", schema: todosView() }
      ])
      yield* insertTodo(sql, { id: "t1", title: "one", category: "c1" })
      yield* sql.unsafe(`DROP VIEW "todos_view"`)
      yield* sql.unsafe(
        `CREATE VIEW "todos_view" ("id", "title") AS SELECT "id", "title" FROM "todos"`
      )

      const exit = yield* Effect.exit(
        migrator.migrate([
          { name: "todos", schema: todosSchema({ categoryRequired: true }) },
          { name: "todos_view", schema: todosViewWithoutTitle() }
        ])
      )
      expect(Exit.isFailure(exit)).toBe(true)

      const detail = yield* preflightDetail(
        migrator.plan([
          { name: "todos", schema: todosSchema({ categoryRequired: true }) },
          { name: "todos_view", schema: todosViewWithoutTitle() }
        ])
      )
      expect(detail).toContain(
        'stored view "todos_view" declares an explicit column list; Mira recreates views from x-view-query only. Remove the column list or migrate the view by hand.'
      )

      expect((yield* viewSql(sql, "todos_view"))[0]?.sql).toContain('("id", "title")')
      expect(yield* sql<{ id: string }>`SELECT id FROM ${sql("todos_view")}`).toEqual([{ id: "t1" }])
    }).pipe(Effect.provide(testLayer)))

  it.effect("fails preflight when a desired view collides with a hand-created view", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const migrator = yield* Migrator
      yield* migrator.migrate([{ name: "todos", schema: todosSchema({ categoryRequired: true }) }])
      yield* sql.unsafe(`CREATE VIEW "legacy_view" AS SELECT "id", "seqId", "title" FROM "todos"`)
      yield* insertTodo(sql, { id: "t1", title: "one", category: "c1" })

      const exit = yield* Effect.exit(
        migrator.migrate([
          { name: "todos", schema: todosSchema({ categoryRequired: true }) },
          { name: "legacy_view", schema: todosView() }
        ])
      )
      expect(Exit.isFailure(exit)).toBe(true)

      const detail = yield* preflightDetail(
        migrator.plan([
          { name: "todos", schema: todosSchema({ categoryRequired: true }) },
          { name: "legacy_view", schema: todosView() }
        ])
      )
      expect(detail).toContain(
        'an object named "legacy_view" already exists and is not tracked; CREATE VIEW IF NOT EXISTS would not apply the desired query. Remove or rename the object, or track it in Mira.'
      )

      expect((yield* viewSql(sql, "legacy_view"))[0]?.sql).toContain("SELECT")
      expect(yield* tableExists(sql, "todos")).not.toEqual([])
    }).pipe(Effect.provide(testLayer)))

  it.effect("fails preflight when a desired view collides with a hand-created view of another case", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const migrator = yield* Migrator
      yield* migrator.migrate([{ name: "todos", schema: todosSchema({ categoryRequired: true }) }])
      yield* sql.unsafe(`CREATE VIEW "LEGACY_VIEW" AS SELECT "id", "seqId", "title" FROM "todos"`)
      yield* insertTodo(sql, { id: "t1", title: "one", category: "c1" })

      const exit = yield* Effect.exit(
        migrator.migrate([
          { name: "todos", schema: todosSchema({ categoryRequired: true }) },
          { name: "legacy_view", schema: todosView() }
        ])
      )
      expect(Exit.isFailure(exit)).toBe(true)

      const detail = yield* preflightDetail(
        migrator.plan([
          { name: "todos", schema: todosSchema({ categoryRequired: true }) },
          { name: "legacy_view", schema: todosView() }
        ])
      )
      expect(detail).toContain(
        'an object named "legacy_view" already exists and is not tracked; CREATE VIEW IF NOT EXISTS would not apply the desired query. Remove or rename the object, or track it in Mira.'
      )

      expect((yield* viewSql(sql, "LEGACY_VIEW"))[0]?.sql).toContain("SELECT")
      expect(yield* tableExists(sql, "todos")).not.toEqual([])
    }).pipe(Effect.provide(testLayer)))

  it.effect("rolls back when the probe catches an untracked dependent of an edited view", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const migrator = yield* Migrator
      yield* migrator.migrate([
        { name: "todos", schema: todosSchema({ categoryRequired: true }) },
        { name: "todos_view", schema: todosView() }
      ])
      yield* sql.unsafe(`CREATE VIEW "raw_dependent" AS SELECT "title" FROM "todos_view"`)
      yield* insertTodo(sql, { id: "t1", title: "one", category: "c1" })

      const beforeMigrations = yield* countRows(sql, "_migrations")

      const plan = yield* migrator.plan([
        { name: "todos", schema: todosSchema({ categoryRequired: true }) },
        { name: "todos_view", schema: todosViewWithoutTitle() }
      ])
      expect(plan.steps.map((s) => s.kind)).toEqual(["dropView", "createView"])
      expect(plan.notes ?? []).toContain(
        'untracked view "raw_dependent" depends on recreated view "todos_view"; a probe verifies it inside the migration'
      )

      const exit = yield* Effect.exit(
        migrator.migrate([
          { name: "todos", schema: todosSchema({ categoryRequired: true }) },
          { name: "todos_view", schema: todosViewWithoutTitle() }
        ])
      )
      expect(Exit.isFailure(exit)).toBe(true)

      expect((yield* viewSql(sql, "todos_view"))[0]?.sql).toContain(
        "SELECT id, seqId, title FROM todos"
      )
      expect((yield* viewSql(sql, "raw_dependent"))[0]?.sql).toContain("title")
      expect(yield* sql<{ id: string }>`SELECT id FROM ${sql("todos")}`).toEqual([{ id: "t1" }])
      const afterMigrations = yield* countRows(sql, "_migrations")
      expect(Number(afterMigrations[0]?.count)).toBe(Number(beforeMigrations[0]?.count))
    }).pipe(Effect.provide(testLayer)))

  it.effect("rolls back when the probe catches a tracked dependent of an edited view", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const migrator = yield* Migrator
      const todosV2 = todosView({
        query: "SELECT id, seqId, title FROM todos_view",
        properties: ["id", "seqId", "title"]
      })
      yield* migrator.migrate([
        { name: "todos", schema: todosSchema({ categoryRequired: true }) },
        { name: "todos_view", schema: todosView() },
        { name: "todos_v2", schema: todosV2 }
      ])
      yield* insertTodo(sql, { id: "t1", title: "one", category: "c1" })

      const beforeMigrations = yield* countRows(sql, "_migrations")

      const plan = yield* migrator.plan([
        { name: "todos", schema: todosSchema({ categoryRequired: true }) },
        { name: "todos_view", schema: todosViewWithoutTitle() },
        { name: "todos_v2", schema: todosV2 }
      ])
      expect(plan.steps.map((s) => s.kind)).toEqual(["dropView", "createView"])

      const exit = yield* Effect.exit(
        migrator.migrate([
          { name: "todos", schema: todosSchema({ categoryRequired: true }) },
          { name: "todos_view", schema: todosViewWithoutTitle() },
          { name: "todos_v2", schema: todosV2 }
        ])
      )
      expect(Exit.isFailure(exit)).toBe(true)

      expect((yield* viewSql(sql, "todos_view"))[0]?.sql).toContain(
        "SELECT id, seqId, title FROM todos"
      )
      expect((yield* viewSql(sql, "todos_v2"))[0]?.sql).toContain(
        "SELECT id, seqId, title FROM todos_view"
      )
      const afterMigrations = yield* countRows(sql, "_migrations")
      expect(Number(afterMigrations[0]?.count)).toBe(Number(beforeMigrations[0]?.count))
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
