/**
 * Gated MySQL and MariaDB migration behavior suite (issue #68).
 *
 * Run against real engines:
 *
 *   $env:MIRA_TEST_MYSQL_URL = "mysql://root:mira@127.0.0.1:53307/mira_test"
 *   $env:MIRA_TEST_MARIADB_URL = "mysql://root:mira@127.0.0.1:53306/mira_test"
 *   pnpm --filter @gettersethya/mira exec vitest run tests/databases/mysql-migrator.e2e.test.ts --no-file-parallelism
 *
 * Each engine suite self-skips when its URL is absent. MySQL uses
 * e2e_mysql_collections/e2e_mysql_migrations; MariaDB uses
 * e2e_mariadb_collections/e2e_mariadb_migrations. Every test starts with
 * resetEngine, so the two suites never share a physical metadata pair, but do
 * not run this file in parallel with itself: the fixed internal tables would
 * collide.
 */
import { MysqlClient } from "@effect/sql-mysql2"
import { describe, it } from "@effect/vitest"
import type { CollectionSchema } from "@gettersethya/mira-client"
import { Context, Effect, Exit, Layer, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { expect } from "vitest"

import type { MigrationDialect, TranslatePlanContext } from "@/dialect/dialect.js"
import { mysqlMigrationDialect } from "@/dialect/dialect-mysql-migrations.js"
import type { MigrationError } from "@/migrator/errors.js"
import { Migrator, makeMigratorLive } from "@/migrator/migrator.js"
import type { MigrateOptions, MigrationStep } from "@/migrator/types.js"

type EngineConfig = {
  readonly label: string
  readonly envUrl: string | undefined
  readonly fallbackUrl: string
  readonly prefix: string
}

const quoteName = (name: string) => `\`${name.replaceAll("`", "``")}\``

const baseProperties = (): CollectionSchema["properties"] => ({
  seqId: { type: "integer", "x-kind": "seqId", "x-system": true },
  id: { type: "string", "x-system": true },
  created: { type: "string", "x-system": true },
  updated: { type: "string", "x-system": true }
})

const todosV1 = (): CollectionSchema => {
  const properties: CollectionSchema["properties"] = {
    ...baseProperties(),
    title: { type: "string" },
    grade: { type: "string" },
    done: { type: "boolean" },
    score: { type: "number" },
    priority: { type: "integer" }
  }
  return {
    "x-collection-kind": "base",
    type: "object",
    properties,
    required: ["id", "title", "done", "priority", "created", "updated"],
    "x-indexes": [{ fields: ["priority"], unique: false }]
  }
}

const todosV2 = (): CollectionSchema => {
  const properties: CollectionSchema["properties"] = {
    ...baseProperties(),
    title: { type: "string" },
    notes: { type: "string" },
    grade: { type: "integer" },
    done: { type: "boolean" },
    score: { type: "number" },
    priority: { type: "integer" }
  }
  return {
    "x-collection-kind": "base",
    type: "object",
    properties,
    required: ["id", "title", "done", "priority", "created", "updated"],
    "x-indexes": [{ fields: ["score"], unique: false }]
  }
}

const todosV2WithTitleIndex = (): CollectionSchema => {
  const schema = todosV2()
  return { ...schema, "x-indexes": [{ fields: ["title"], unique: false }] }
}

const requiredV1 = (): CollectionSchema => {
  const properties: CollectionSchema["properties"] = {
    ...baseProperties(),
    title: { type: "string" }
  }
  return {
    "x-collection-kind": "base",
    type: "object",
    properties,
    required: ["id", "title", "created", "updated"]
  }
}

const requiredV2 = (): CollectionSchema => {
  const properties: CollectionSchema["properties"] = {
    ...baseProperties(),
    title: { type: "string" },
    code: { type: "string" }
  }
  return {
    "x-collection-kind": "base",
    type: "object",
    properties,
    required: ["id", "title", "code", "created", "updated"]
  }
}

const simpleTable = (): CollectionSchema => {
  const properties: CollectionSchema["properties"] = {
    ...baseProperties(),
    title: { type: "string" }
  }
  return {
    "x-collection-kind": "base",
    type: "object",
    properties,
    required: ["id", "title", "created", "updated"]
  }
}

const todoView = (
  query: string,
  properties: ReadonlyArray<string>
): CollectionSchema => {
  const definitions: CollectionSchema["properties"] = {
    id: { type: "string", "x-system": true, "x-view-only": true },
    seqId: {
      type: "integer",
      "x-system": true,
      "x-view-only": true,
      "x-kind": "seqId"
    },
    title: { type: "string" },
    notes: { type: "string" }
  }
  const viewProperties: CollectionSchema["properties"] = {}
  for (const name of properties) {
    const definition = definitions[name]
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

const withoutProperty = (
  schema: CollectionSchema,
  name: string
): CollectionSchema => {
  const properties = { ...schema.properties }
  delete properties[name]
  return { ...schema, properties }
}

const insertRow = (table: string, record: Record<string, unknown>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`INSERT INTO ${sql(table)} ${sql.insert(record)}`
  })

type ColumnRow = {
  readonly column_name: string
  readonly column_type: string
  readonly is_nullable: string
}

type IndexRow = {
  readonly index_name: string
  readonly non_unique: number
  readonly column_name: string | null
  readonly seq_in_index: number
}

const defineSuite = (config: EngineConfig) => {
  const enabled = config.envUrl !== undefined
  const describeSuite = enabled ? describe : describe.skip
  const url = config.envUrl ?? config.fallbackUrl

  const schemaTable = `${config.prefix}collections`
  const migrationsTable = `${config.prefix}migrations`
  const todosTable = `${config.prefix}todos`
  const todosView = `${config.prefix}todos_view`
  const requiredTable = `${config.prefix}required`
  const driftTable = `${config.prefix}drift`
  const freshTable = `${config.prefix}fresh`
  const untrackedView = `${config.prefix}untracked`

  const options: MigrateOptions = {
    schemaTable,
    migrationsTable,
    logLevel: 0
  }

  const v1ViewQuery = `SELECT ${quoteName("id")}, ${quoteName("seqId")}, ${quoteName("title")} FROM ${quoteName(todosTable)}`
  const v2ViewQuery = `SELECT ${quoteName("id")}, ${quoteName("seqId")}, ${quoteName("title")}, ${quoteName("notes")} FROM ${quoteName(todosTable)}`

  const v1Schemas = () => [
    { name: todosTable, schema: todosV1() },
    { name: todosView, schema: todoView(v1ViewQuery, ["id", "seqId", "title"]) }
  ]

  const v2Schemas = () => [
    { name: todosTable, schema: todosV2() },
    {
      name: todosView,
      schema: todoView(v2ViewQuery, ["id", "seqId", "title", "notes"])
    }
  ]

  const dropView = (name: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql.unsafe(`DROP VIEW IF EXISTS ${quoteName(name)}`).pipe(Effect.ignore)
    })

  const dropTable = (name: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql.unsafe(`DROP TABLE IF EXISTS ${quoteName(name)}`).pipe(Effect.ignore)
    })

  const resetEngine = Effect.gen(function* () {
    yield* dropView(todosView)
    yield* dropView(untrackedView)
    yield* dropTable(todosTable)
    yield* dropTable(requiredTable)
    yield* dropTable(driftTable)
    yield* dropTable(freshTable)
    yield* dropTable(schemaTable)
    yield* dropTable(migrationsTable)
  })

  const columnRows = (table: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      return yield* sql<ColumnRow>`
        SELECT COLUMN_NAME AS column_name,
               COLUMN_TYPE AS column_type,
               IS_NULLABLE AS is_nullable
        FROM information_schema.columns
        WHERE table_schema = DATABASE()
          AND table_name = ${table}
        ORDER BY ORDINAL_POSITION
      `
    })

  const indexRows = (table: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      return yield* sql<IndexRow>`
        SELECT INDEX_NAME AS index_name,
               NON_UNIQUE AS non_unique,
               COLUMN_NAME AS column_name,
               SEQ_IN_INDEX AS seq_in_index
        FROM information_schema.statistics
        WHERE table_schema = DATABASE()
          AND table_name = ${table}
        ORDER BY INDEX_NAME, SEQ_IN_INDEX
      `
    })

  const tablesNamed = (names: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql<{ table_name: string; table_type: string }>`
        SELECT TABLE_NAME AS table_name, TABLE_TYPE AS table_type
        FROM information_schema.tables
        WHERE table_schema = DATABASE()
      `
      return rows.filter((row) => names.includes(row.table_name))
    })

  const countRows = (table: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql<{ total: number | string }>`
        SELECT COUNT(*) AS total FROM ${sql(table)}
      `
      const row = rows[0]
      return row === undefined ? 0 : Number(row.total)
    })

  const countSchemaRows = (name: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql<{ total: number | string }>`
        SELECT COUNT(*) AS total FROM ${sql(schemaTable)}
        WHERE ${sql("name")} = ${name}
      `
      const row = rows[0]
      return row === undefined ? 0 : Number(row.total)
    })

  const normalizeType = (value: string) => {
    const lower = value.toLowerCase()
    const match = /^(tinyint|smallint|mediumint|int|bigint)\((\d+)\)$/.exec(lower)
    if (match === null) return lower
    if (match[1] === "tinyint" && match[2] === "1") return "tinyint(1)"
    return match[1] ?? lower
  }

  const storedSchema = (name: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql<{ schema_json: string }>`
        SELECT ${sql("schema")} AS schema_json
        FROM ${sql(schemaTable)}
        WHERE ${sql("name")} = ${name}
      `
      return rows[0]?.schema_json
    })

  const sessionValues = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{
      sql_mode: string
      lock_wait_timeout: number | string
    }>`
      SELECT
        @@SESSION.sql_mode AS sql_mode,
        @@SESSION.lock_wait_timeout AS lock_wait_timeout
    `
    return rows[0]
  })

  const insertTodo = (grade: string) =>
    insertRow(todosTable, {
      id: "t1",
      title: "one",
      grade,
      done: true,
      score: 1.5,
      priority: 1,
      created: "2026-01-01",
      updated: "2026-01-01"
    })

  const expectV2Physical = Effect.gen(function* () {
    const columns = yield* columnRows(todosTable)
    const typeByName = new Map(
      columns.map((column) => [column.column_name, normalizeType(column.column_type)])
    )
    expect(typeByName.get("notes")).toBe("longtext")
    expect(typeByName.get("grade")).toBe("int")
    expect(typeByName.get("priority")).toBe("int")

    const indexNames = new Set(
      (yield* indexRows(todosTable)).map((index) => index.index_name)
    )
    expect(indexNames.has(`idx_${todosTable}_score`)).toBe(true)
    expect(indexNames.has(`idx_${todosTable}_priority`)).toBe(false)

    const viewColumns = (yield* columnRows(todosView)).map(
      (column) => column.column_name
    )
    expect(viewColumns).toEqual(["id", "seqId", "title", "notes"])
  })

  const expectTodoRow = (grade: number) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql<{ id: string; grade: number }>`
        SELECT ${sql("id")} AS id, ${sql("grade")} AS grade
        FROM ${sql(todosTable)}
        WHERE ${sql("id")} = ${"t1"}
      `
      expect(rows).toEqual([{ id: "t1", grade }])
    })

  const makeLayer = (
    dialect: MigrationDialect,
    maxConnections: number
  ) => {
    const base = MysqlClient.layer({
      url: Redacted.make(url),
      maxConnections
    })
    return Layer.merge(
      base,
      makeMigratorLive(dialect).pipe(Layer.provide(base))
    )
  }

  const runWithEngine = <A, E>(
    maxConnections: number,
    dialect: MigrationDialect,
    body: Effect.Effect<A, E, Migrator | SqlClient.SqlClient>
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const ctx = yield* Layer.build(makeLayer(dialect, maxConnections))
        yield* resetEngine.pipe(Effect.provide(ctx))
        return yield* body.pipe(Effect.provide(ctx))
      })
    )

  const failingMetadataDialect = (targetTable: string): MigrationDialect => {
    let seen = 0
    return {
      ...mysqlMigrationDialect,
      upsertStatement: (
        table: string,
        record: Readonly<Record<string, unknown>>,
        keys: ReadonlyArray<string>
      ) => {
        if (table === targetTable) {
          seen += 1
          if (seen === 1) {
            return { sql: "THIS IS NOT SQL", params: [] }
          }
        }
        return mysqlMigrationDialect.upsertStatement(table, record, keys)
      }
    }
  }

  const interruptedAddDialect = (
    table: string,
    column: string
  ): MigrationDialect => {
    let intercepted = false
    return {
      ...mysqlMigrationDialect,
      translatePlan: (
        steps: ReadonlyArray<MigrationStep>,
        ctx: TranslatePlanContext
      ) =>
        mysqlMigrationDialect.translatePlan(steps, ctx).pipe(
          Effect.map((translated) => {
            if (intercepted) return translated
            const start = translated.statements.findIndex(
              (statement) =>
                statement.startsWith(`ALTER TABLE ${quoteName(table)} `) &&
                statement.includes(`ADD COLUMN ${quoteName(column)}`)
            )
            if (start < 0) return translated

            intercepted = true
            const statements = translated.statements.filter(
              (statement, index) => {
                if (index <= start) return true
                if (
                  index === start + 1 &&
                  statement.startsWith("UPDATE ") &&
                  statement.includes(quoteName(column))
                ) {
                  return false
                }
                if (
                  index === start + 2 &&
                  statement.includes(`MODIFY COLUMN ${quoteName(column)}`)
                ) {
                  return false
                }
                return true
              }
            )
            return { ...translated, statements }
          })
        )
    }
  }

  const catchUnsupported = <A>(
    effect: Effect.Effect<A, MigrationError, never>
  ) =>
    effect.pipe(
      Effect.as(undefined),
      Effect.catchTag("UnsupportedMigrationStepError", (error) =>
        Effect.succeed(error)
      )
    )

  describeSuite(`${config.label} migrations`, () => {
    it.effect(
      "creates a fresh V1 schema and inserts a row",
      () =>
        runWithEngine(
          2,
          mysqlMigrationDialect,
          Effect.gen(function* () {
            const migrator = yield* Migrator
            const sql = yield* SqlClient.SqlClient

            yield* migrator.migrate(v1Schemas(), options)
            yield* insertTodo("1")

            const columns = yield* columnRows(todosTable)
            const typeByName = new Map(
              columns.map((column) => [
                column.column_name,
                normalizeType(column.column_type)
              ])
            )
            expect(typeByName.get("seqId")).toBe("bigint")
            expect(typeByName.get("id")).toBe("varchar(255)")
            expect(typeByName.get("title")).toBe("longtext")
            expect(typeByName.get("grade")).toBe("longtext")
            expect(typeByName.get("done")).toBe("tinyint(1)")
            expect(typeByName.get("score")).toBe("double")
            expect(typeByName.get("priority")).toBe("int")

            const indexes = yield* indexRows(todosTable)
            expect(
              indexes.some(
                (index) =>
                  index.column_name === "id" &&
                  Number(index.non_unique) === 0
              )
            ).toBe(true)
            expect(
              indexes.some(
                (index) =>
                  index.index_name === `idx_${todosTable}_priority` &&
                  Number(index.non_unique) === 1
              )
            ).toBe(true)

            const viewRows = yield* sql<{ id: string; title: string }>`
              SELECT ${sql("id")} AS id, ${sql("title")} AS title
              FROM ${sql(todosView)}
            `
            expect(viewRows).toEqual([{ id: "t1", title: "one" }])

            expect(yield* countSchemaRows(todosTable)).toBe(1)
            expect(yield* countRows(migrationsTable)).toBe(1)
          })
        ),
      120_000
    )

    it.effect(
      "applies V2 changes and keeps the row",
      () =>
        runWithEngine(
          2,
          mysqlMigrationDialect,
          Effect.gen(function* () {
            const migrator = yield* Migrator

            yield* migrator.migrate(v1Schemas(), options)
            yield* insertTodo("1")

            yield* migrator.migrate(v2Schemas(), {
              ...options,
              allowDestructive: true
            })

            yield* expectV2Physical
            yield* expectTodoRow(1)
            expect(yield* storedSchema(todosTable)).toContain('"notes"')
            expect(yield* countSchemaRows(todosTable)).toBe(1)
          })
        ),
      120_000
    )

    it.effect(
      "recovers from a partially applied V2 plan",
      () =>
        runWithEngine(
          2,
          mysqlMigrationDialect,
          Effect.gen(function* () {
            const migrator = yield* Migrator
            const sql = yield* SqlClient.SqlClient

            yield* migrator.migrate(v1Schemas(), options)
            yield* insertTodo("abc")

            const exit = yield* Effect.exit(
              migrator.migrate(v2Schemas(), {
                ...options,
                allowDestructive: true
              })
            )
            expect(Exit.isFailure(exit)).toBe(true)

            expect(yield* storedSchema(todosTable)).not.toContain('"notes"')
            const columns = yield* columnRows(todosTable)
            expect(columns.map((column) => column.column_name)).toContain(
              "notes"
            )
            const indexNames = new Set(
              (yield* indexRows(todosTable)).map((index) => index.index_name)
            )
            expect(indexNames.has(`idx_${todosTable}_priority`)).toBe(false)
            expect(indexNames.has(`idx_${todosTable}_score`)).toBe(false)
            expect(yield* tablesNamed([todosView])).toEqual([])

            yield* sql`DELETE FROM ${sql(todosTable)} WHERE ${sql("id")} = ${"t1"}`

            yield* migrator.migrate(v2Schemas(), {
              ...options,
              allowDestructive: true
            })

            yield* expectV2Physical
            expect(yield* storedSchema(todosTable)).toContain('"notes"')
          })
        ),
      120_000
    )

    it.effect(
      "fails the metadata write and retries without destructive permission",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const normalCtx = yield* Layer.build(
              makeLayer(mysqlMigrationDialect, 2)
            )
            yield* resetEngine.pipe(Effect.provide(normalCtx))

            yield* Effect.gen(function* () {
              const migrator = yield* Migrator
              const sql = yield* SqlClient.SqlClient

              yield* migrator.migrate(v1Schemas(), options)
              yield* insertTodo("1")
              yield* sql`DELETE FROM ${sql(migrationsTable)}`
            }).pipe(Effect.provide(normalCtx))

            const failingCtx = yield* Layer.build(
              makeLayer(failingMetadataDialect(migrationsTable), 2)
            )
            yield* Effect.gen(function* () {
              const migrator = yield* Migrator

              const exit = yield* Effect.exit(
                migrator.migrate(v2Schemas(), {
                  ...options,
                  allowDestructive: true
                })
              )
              expect(Exit.isFailure(exit)).toBe(true)

              expect(yield* countRows(migrationsTable)).toBe(0)
              expect(yield* storedSchema(todosTable)).not.toContain('"notes"')
              yield* expectV2Physical
            }).pipe(Effect.provide(failingCtx))

            yield* Effect.gen(function* () {
              const migrator = yield* Migrator

              yield* migrator.migrate(v2Schemas(), {
                ...options,
                allowDestructive: false
              })

              yield* expectV2Physical
              yield* expectTodoRow(1)
              expect(yield* storedSchema(todosTable)).toContain('"notes"')
              expect(yield* countRows(migrationsTable)).toBe(1)
            }).pipe(Effect.provide(normalCtx))
          })
        ),
      120_000
    )

    it.effect(
      "rolls back the metadata transaction when the collections upsert fails",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const normalCtx = yield* Layer.build(
              makeLayer(mysqlMigrationDialect, 2)
            )
            yield* resetEngine.pipe(Effect.provide(normalCtx))

            yield* Effect.gen(function* () {
              const migrator = yield* Migrator
              const sql = yield* SqlClient.SqlClient

              yield* migrator.migrate(v1Schemas(), options)
              yield* insertTodo("1")
              yield* sql`DELETE FROM ${sql(migrationsTable)}`
            }).pipe(Effect.provide(normalCtx))

            const failingCtx = yield* Layer.build(
              makeLayer(failingMetadataDialect(schemaTable), 2)
            )
            yield* Effect.gen(function* () {
              const migrator = yield* Migrator

              const exit = yield* Effect.exit(
                migrator.migrate(v2Schemas(), {
                  ...options,
                  allowDestructive: true
                })
              )
              expect(Exit.isFailure(exit)).toBe(true)

              expect(yield* countRows(migrationsTable)).toBe(0)
              expect(yield* storedSchema(todosTable)).not.toContain('"notes"')
              yield* expectV2Physical
            }).pipe(Effect.provide(failingCtx))
          })
        ),
      120_000
    )

    // Live time, not TestClock: the conflict backoff must really elapse so the
    // competing boot can finish its statement before the loser re-renders.
    it.live(
      "converges two concurrent V1 boots",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const first = yield* Layer.build(
              makeLayer(mysqlMigrationDialect, 2)
            )
            const second = yield* Layer.build(
              makeLayer(mysqlMigrationDialect, 2)
            )
            yield* resetEngine.pipe(Effect.provide(first))

            const firstMigrator = Context.get(first, Migrator)
            const secondMigrator = Context.get(second, Migrator)
            const results = yield* Effect.all(
              [
                firstMigrator.migrate(v1Schemas(), options),
                secondMigrator.migrate(v1Schemas(), options)
              ],
              { concurrency: "unbounded" }
            )
            expect(results).toHaveLength(2)

            yield* Effect.gen(function* () {
              expect(yield* tablesNamed([todosTable])).toHaveLength(1)
              expect(yield* countSchemaRows(todosTable)).toBe(1)
              expect(yield* countRows(migrationsTable)).toBeGreaterThanOrEqual(1)
            }).pipe(Effect.provide(first))
          })
        ),
      120_000
    )

    it.effect(
      "previews an empty database without creating metadata",
      () =>
        runWithEngine(
          2,
          mysqlMigrationDialect,
          Effect.gen(function* () {
            const migrator = yield* Migrator
            const schemas = [{ name: todosTable, schema: todosV1() }]

            const plan = yield* migrator.plan(schemas, options)
            expect(plan.steps.length).toBeGreaterThan(0)

            const status = yield* migrator.status(schemas, options)
            expect(status).toEqual([{ name: todosTable, status: "behind" }])

            expect(yield* tablesNamed([schemaTable, migrationsTable])).toEqual(
              []
            )
            expect(yield* tablesNamed([todosTable])).toEqual([])
          })
        ),
      120_000
    )

    it.effect(
      "refuses a destructive plan and applies it when allowed",
      () =>
        runWithEngine(
          2,
          mysqlMigrationDialect,
          Effect.gen(function* () {
            const migrator = yield* Migrator

            yield* migrator.migrate(v1Schemas(), options)
            yield* insertTodo("1")
            const before = yield* storedSchema(todosTable)

            yield* migrator.migrate([], options)
            expect(yield* tablesNamed([todosTable])).toHaveLength(1)
            expect(yield* tablesNamed([todosView])).toHaveLength(1)
            expect(yield* storedSchema(todosTable)).toBe(before)

            yield* migrator.migrate([], {
              ...options,
              allowDestructive: true
            })
            expect(yield* tablesNamed([todosTable])).toEqual([])
            expect(yield* tablesNamed([todosView])).toEqual([])
            expect(yield* countSchemaRows(todosTable)).toBe(1)
            expect(yield* storedSchema(todosTable)).toBe(before)
          })
        ),
      120_000
    )

    it.effect(
      "fails drift before any plan DDL",
      () =>
        runWithEngine(
          2,
          mysqlMigrationDialect,
          Effect.gen(function* () {
            const migrator = yield* Migrator
            const sql = yield* SqlClient.SqlClient

            yield* sql.unsafe(
              `CREATE TABLE ${quoteName(driftTable)} (${quoteName("id")} INT PRIMARY KEY)`
            )

            const failure = yield* catchUnsupported(
              migrator.migrate(
                [
                  { name: driftTable, schema: simpleTable() },
                  { name: freshTable, schema: simpleTable() }
                ],
                options
              )
            )
            expect(failure).toBeDefined()
            if (failure !== undefined) {
              expect(failure.detail).toContain(driftTable)
            }

            const columns = yield* columnRows(driftTable)
            expect(columns.map((column) => column.column_name)).toEqual(["id"])
            expect(yield* tablesNamed([freshTable])).toEqual([])
          })
        ),
      120_000
    )

    it.effect(
      "fails a malformed system table before the stored read",
      () =>
        runWithEngine(
          2,
          mysqlMigrationDialect,
          Effect.gen(function* () {
            const migrator = yield* Migrator
            const sql = yield* SqlClient.SqlClient

            yield* sql.unsafe(
              `CREATE TABLE ${quoteName(schemaTable)} (${quoteName("name")} VARCHAR(255) PRIMARY KEY)`
            )

            const failure = yield* catchUnsupported(
              migrator.migrate(
                [{ name: todosTable, schema: todosV1() }],
                options
              )
            )
            expect(failure).toBeDefined()
            if (failure !== undefined) {
              expect(failure.detail).toContain(schemaTable)
            }
            expect(yield* tablesNamed([migrationsTable])).toEqual([])
          })
        ),
      120_000
    )

    it.effect(
      "migrates on a single connection and restores the session",
      () =>
        runWithEngine(
          1,
          mysqlMigrationDialect,
          Effect.gen(function* () {
            const migrator = yield* Migrator

            const before = yield* sessionValues
            yield* migrator.migrate(v1Schemas(), options)
            const after = yield* sessionValues

            expect(after?.sql_mode).toBe(before?.sql_mode)
            expect(Number(after?.lock_wait_timeout)).toBe(
              Number(before?.lock_wait_timeout)
            )
            const columns = yield* columnRows(todosTable)
            expect(columns.map((column) => column.column_name)).toContain(
              "seqId"
            )
          })
        ),
      120_000
    )

    it.effect(
      "rejects an index on an unbounded text column",
      () =>
        runWithEngine(
          2,
          mysqlMigrationDialect,
          Effect.gen(function* () {
            const migrator = yield* Migrator

            yield* migrator.migrate(
              [{ name: todosTable, schema: todosV1() }],
              options
            )
            yield* insertTodo("1")

            const failure = yield* catchUnsupported(
              migrator.migrate(
                [{ name: todosTable, schema: todosV2WithTitleIndex() }],
                { ...options, allowDestructive: true }
              )
            )
            expect(failure).toBeDefined()
            if (failure !== undefined) {
              expect(failure.detail).toContain("#71")
            }

            const columns = yield* columnRows(todosTable)
            expect(columns.map((column) => column.column_name)).not.toContain(
              "notes"
            )
            const typeByName = new Map(
              columns.map((column) => [
                column.column_name,
                normalizeType(column.column_type)
              ])
            )
            expect(typeByName.get("grade")).toBe("longtext")

            const indexNames = new Set(
              (yield* indexRows(todosTable)).map((index) => index.index_name)
            )
            expect(indexNames.has(`idx_${todosTable}_title`)).toBe(false)
            expect(indexNames.has(`idx_${todosTable}_priority`)).toBe(true)
            expect(yield* storedSchema(todosTable)).not.toContain('"notes"')
          })
        ),
      120_000
    )

    it.effect(
      "fails an untracked dependent view before DDL",
      () =>
        runWithEngine(
          2,
          mysqlMigrationDialect,
          Effect.gen(function* () {
            const migrator = yield* Migrator
            const sql = yield* SqlClient.SqlClient

            yield* migrator.migrate(v1Schemas(), options)
            yield* insertTodo("1")
            yield* sql.unsafe(
              `CREATE VIEW ${quoteName(untrackedView)} AS SELECT ${quoteName("grade")} FROM ${quoteName(todosTable)}`
            )

            const droppedGrade = withoutProperty(todosV1(), "grade")
            const failure = yield* catchUnsupported(
              migrator.migrate(
                [{ name: todosTable, schema: droppedGrade }],
                { ...options, allowDestructive: true }
              )
            )
            expect(failure).toBeDefined()
            if (failure !== undefined) {
              expect(failure.detail).toContain(untrackedView)
            }
            expect(
              (yield* columnRows(todosTable)).map(
                (column) => column.column_name
              )
            ).toContain("grade")
            expect(yield* tablesNamed([untrackedView])).toHaveLength(1)

            yield* sql.unsafe(`DROP VIEW ${quoteName(untrackedView)}`)

            yield* migrator.migrate(
              [
                { name: todosTable, schema: droppedGrade },
                {
                  name: todosView,
                  schema: todoView(`${v1ViewQuery} WHERE 1 = 1`, [
                    "id",
                    "seqId",
                    "title"
                  ])
                }
              ],
              { ...options, allowDestructive: true }
            )

            const columns = yield* columnRows(todosTable)
            expect(columns.map((column) => column.column_name)).not.toContain(
              "grade"
            )
            const viewColumns = (yield* columnRows(todosView)).map(
              (column) => column.column_name
            )
            expect(viewColumns).toEqual(["id", "seqId", "title"])
            expect(yield* tablesNamed([todosView])).toHaveLength(1)
          })
        ),
      120_000
    )

    it.live(
      "converges two concurrent V2 migrations",
      () =>
        runWithEngine(
          4,
          mysqlMigrationDialect,
          Effect.gen(function* () {
            const migrator = yield* Migrator

            yield* migrator.migrate(v1Schemas(), options)
            yield* insertTodo("1")

            const results = yield* Effect.all(
              [
                migrator.migrate(v2Schemas(), {
                  ...options,
                  allowDestructive: true
                }),
                migrator.migrate(v2Schemas(), {
                  ...options,
                  allowDestructive: true
                })
              ],
              { concurrency: "unbounded" }
            )
            expect(results).toHaveLength(2)

            yield* expectV2Physical
            yield* expectTodoRow(1)
            expect(yield* countSchemaRows(todosTable)).toBe(1)
            expect(yield* countRows(migrationsTable)).toBeGreaterThanOrEqual(1)
          })
        ),
      120_000
    )

    it.effect(
      "restores the preview session on one connection",
      () =>
        runWithEngine(
          1,
          mysqlMigrationDialect,
          Effect.gen(function* () {
            const migrator = yield* Migrator
            const schemas = [{ name: todosTable, schema: todosV1() }]

            const before = yield* sessionValues
            const plan = yield* migrator.plan(schemas, options)
            expect(plan.steps.length).toBeGreaterThan(0)
            const status = yield* migrator.status(schemas, options)
            expect(status).toEqual([{ name: todosTable, status: "behind" }])
            const after = yield* sessionValues

            expect(Number(after?.lock_wait_timeout)).toBe(
              Number(before?.lock_wait_timeout)
            )
            expect(after?.sql_mode).toBe(before?.sql_mode)
            expect(yield* tablesNamed([schemaTable, migrationsTable])).toEqual(
              []
            )
          })
        ),
      120_000
    )

    it.effect(
      "resumes an interrupted non-null add",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const interruptedCtx = yield* Layer.build(
              makeLayer(interruptedAddDialect(requiredTable, "code"), 1)
            )
            yield* resetEngine.pipe(Effect.provide(interruptedCtx))

            yield* Effect.gen(function* () {
              const migrator = yield* Migrator

              yield* migrator.migrate(
                [{ name: requiredTable, schema: requiredV1() }],
                options
              )
              yield* insertRow(requiredTable, {
                id: "t1",
                title: "one",
                created: "2026-01-01",
                updated: "2026-01-01"
              })

              const exit = yield* Effect.exit(
                migrator.migrate(
                  [{ name: requiredTable, schema: requiredV2() }],
                  options
                )
              )
              expect(Exit.isFailure(exit)).toBe(true)

              const columns = yield* columnRows(requiredTable)
              const byName = new Map(
                columns.map((column) => [column.column_name, column])
              )
              expect(byName.get("code")?.is_nullable).toBe("YES")
              expect(yield* storedSchema(requiredTable)).not.toContain('"code"')
            }).pipe(Effect.provide(interruptedCtx))

            const normalCtx = yield* Layer.build(
              makeLayer(mysqlMigrationDialect, 1)
            )
            yield* Effect.gen(function* () {
              const migrator = yield* Migrator
              const sql = yield* SqlClient.SqlClient

              yield* migrator.migrate(
                [{ name: requiredTable, schema: requiredV2() }],
                options
              )

              const columns = yield* columnRows(requiredTable)
              const byName = new Map(
                columns.map((column) => [column.column_name, column])
              )
              expect(byName.get("code")?.is_nullable).toBe("NO")

              const rows = yield* sql<{ code: string }>`
                SELECT ${sql("code")} AS code
                FROM ${sql(requiredTable)}
                WHERE ${sql("id")} = ${"t1"}
              `
              expect(rows).toEqual([{ code: "" }])
              expect(yield* storedSchema(requiredTable)).toContain('"code"')
            }).pipe(Effect.provide(normalCtx))
          })
        ),
      120_000
    )
  })
}

defineSuite({
  label: "MySQL",
  envUrl: process.env["MIRA_TEST_MYSQL_URL"],
  fallbackUrl: "mysql://root:mira@127.0.0.1:53307/mira_test",
  prefix: "e2e_mysql_"
})

defineSuite({
  label: "MariaDB",
  envUrl: process.env["MIRA_TEST_MARIADB_URL"],
  fallbackUrl: "mysql://root:mira@127.0.0.1:53306/mira_test",
  prefix: "e2e_mariadb_"
})

