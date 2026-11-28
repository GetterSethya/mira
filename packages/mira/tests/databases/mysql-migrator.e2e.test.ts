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
import { Cause, Context, Effect, Exit, Layer, Redacted, Result } from "effect"
import { SqlClient, SqlError } from "effect/sql"
import mysql from "mysql2/promise"
import type { RowDataPacket } from "mysql2"
import { expect } from "vitest"

import type { LockConnection, LockExecutor, MigrationDialect, TranslatePlanContext } from "@/dialect/dialect.js"
import { mysqlMigrationDialect } from "@/dialect/dialect-mysql-migrations.js"
import type { MigrationError } from "@/migrator/errors.js"
import { boundLockName } from "@/migrator/lock.js"
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

const todosV2WithTitleIndex = (maxLength?: number): CollectionSchema => {
  const schema = todosV2()
  const title = maxLength === undefined ? { type: "string" as const } : { type: "string" as const, maxLength }
  return {
    ...schema,
    properties: { ...schema.properties, title },
    "x-indexes": [{ fields: ["title"], unique: false }]
  }
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

const textTableSchema = (maxLength: number): CollectionSchema => ({
  "x-collection-kind": "base",
  type: "object",
  properties: {
    ...baseProperties(),
    name: { type: "string", maxLength },
    note: { type: "string", maxLength: 100, default: "" }
  },
  required: ["id", "name", "created", "updated"],
  "x-indexes": [{ fields: ["name"], unique: true }]
})

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

const todoView = (query: string, properties: ReadonlyArray<string>): CollectionSchema => {
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

const withoutProperty = (schema: CollectionSchema, name: string): CollectionSchema => {
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
  readonly collation_name: string | null
  readonly column_default: string | null
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
  const textTable = `${config.prefix}text`

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
    yield* dropTable(textTable)
    yield* dropTable(schemaTable)
    yield* dropTable(migrationsTable)
  })

  const columnRows = (table: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      return yield* sql<ColumnRow>`
        SELECT COLUMN_NAME AS column_name,
               COLUMN_TYPE AS column_type,
               IS_NULLABLE AS is_nullable,
               COLLATION_NAME AS collation_name,
               COLUMN_DEFAULT AS column_default
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
      wait_timeout: number | string
    }>`
      SELECT
        @@SESSION.sql_mode AS sql_mode,
        @@SESSION.lock_wait_timeout AS lock_wait_timeout,
        @@SESSION.wait_timeout AS wait_timeout
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
    const typeByName = new Map(columns.map((column) => [column.column_name, normalizeType(column.column_type)]))
    expect(typeByName.get("notes")).toBe("longtext")
    expect(typeByName.get("grade")).toBe("int")
    expect(typeByName.get("priority")).toBe("int")

    const indexNames = new Set((yield* indexRows(todosTable)).map((index) => index.index_name))
    expect(indexNames.has(`idx_${todosTable}_score`)).toBe(true)
    expect(indexNames.has(`idx_${todosTable}_priority`)).toBe(false)

    const viewColumns = (yield* columnRows(todosView)).map((column) => column.column_name)
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

  const makeLayer = (dialect: MigrationDialect, maxConnections: number) => {
    const base = MysqlClient.layer({
      url: Redacted.make(url),
      maxConnections
    })
    return Layer.merge(base, makeMigratorLive(dialect).pipe(Layer.provide(base)))
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

  const lockConfig = mysqlMigrationDialect.migrationModel.lock
  if (lockConfig === undefined) {
    throw new Error("mysqlMigrationDialect must declare a migration lock")
  }

  const toSqlError = (cause: unknown) =>
    new SqlError.SqlError({
      reason: new SqlError.UnknownError({
        cause,
        message: cause instanceof Error ? cause.message : String(cause)
      })
    })

  const databaseName = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ db: string | null }>`SELECT DATABASE() AS db`
    return rows[0]?.db ?? null
  })

  const expectedLockName = Effect.gen(function* () {
    const db = yield* databaseName
    return boundLockName(lockConfig, db ?? "")
  })

  const isUsedLock = (name: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql<{ holder: number | string | null }>`
        SELECT IS_USED_LOCK(${name}) AS holder
      `
      return rows[0]?.holder ?? null
    })

  const rawIsUsedLock = (name: string) =>
    Effect.promise(async () => {
      const conn = await mysql.createConnection(url)
      try {
        const [rows] = await conn.query("SELECT IS_USED_LOCK(?) AS holder", [name])
        const first = Array.isArray(rows) ? rows[0] : undefined
        if (typeof first === "object" && first !== null && "holder" in first) {
          return first.holder ?? null
        }
        return null
      } finally {
        conn.destroy()
      }
    })

  const withHeldLock = <A, E>(name: string, body: Effect.Effect<A, E, Migrator | SqlClient.SqlClient>) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const conn = yield* sql.reserve
          yield* conn.executeUnprepared("SELECT GET_LOCK(?, 0) AS acquired", [name], undefined)
          const result = yield* body
          yield* conn.executeUnprepared("SELECT RELEASE_LOCK(?) AS released", [name], undefined).pipe(Effect.ignore)
          return result
        })
      )
    })

  const dedicatedLockDialect = (settings?: {
    readonly urlOverride?: string
    readonly omitKill?: boolean
    readonly releaseReturnsZero?: boolean
    readonly heartbeatIntervalSeconds?: number
    readonly lockWaitTimeoutSeconds?: number
    readonly failHeartbeatAfter?: number
  }): MigrationDialect => {
    const baseModel = mysqlMigrationDialect.migrationModel
    const targetUrl = settings?.urlOverride ?? url
    const baseLock = baseModel.lock
    if (baseLock === undefined) throw new Error("base dialect must declare a lock")

    const openConnection = Effect.acquireRelease(
      Effect.gen(function* () {
        const conn = yield* Effect.tryPromise({
          try: () => mysql.createConnection(targetUrl),
          catch: toSqlError
        })
        yield* Effect.tryPromise({
          try: async () => {
            await conn.query("SET SESSION wait_timeout = ?", [settings?.lockWaitTimeoutSeconds ?? 600])
          },
          catch: toSqlError
        })

        let destroyed = false
        let heartbeatCalls = 0
        const destroy = Effect.sync(() => {
          if (!destroyed) {
            destroyed = true
            conn.destroy()
          }
        })
        const executor: LockExecutor = {
          run: (statement) =>
            Effect.tryPromise({
              try: async () => {
                await conn.query(statement)
              },
              catch: toSqlError
            }).pipe(Effect.asVoid),
          runParameterized: (statement) =>
            Effect.tryPromise({
              try: async () => {
                await conn.query(statement.sql, [...statement.params])
              },
              catch: toSqlError
            }).pipe(Effect.asVoid),
          query: (statement) =>
            Effect.gen(function* () {
              if (statement.includes("SELECT 1 AS ok")) {
                heartbeatCalls++
                if (settings?.failHeartbeatAfter !== undefined && heartbeatCalls > settings.failHeartbeatAfter) {
                  return yield* toSqlError(new Error("heartbeat failed"))
                }
              }
              const [rows] = yield* Effect.tryPromise({
                try: () => conn.query<Array<RowDataPacket>>(statement),
                catch: toSqlError
              })
              return rows
            }),
          queryParameterized: (statement) =>
            Effect.gen(function* () {
              const [rows] = yield* Effect.tryPromise({
                try: () => conn.query<Array<RowDataPacket>>(statement.sql, [...statement.params]),
                catch: toSqlError
              })
              return rows
            })
        }
        const connection: LockConnection = { executor, destroy }
        return connection
      }),
      (connection) => connection.destroy
    )

    const { killSelfStatement, ...lockWithoutKill } = baseLock
    let releaseCalls = 0
    const lock = {
      ...lockWithoutKill,
      ...(settings?.omitKill || killSelfStatement === undefined ? {} : { killSelfStatement }),
      ...(settings?.releaseReturnsZero
        ? {
            releaseStatement: (name: string) => {
              releaseCalls++
              return releaseCalls === 1 ? { sql: "SELECT 0 AS released", params: [] } : baseLock.releaseStatement(name)
            }
          }
        : {}),
      ...(settings?.heartbeatIntervalSeconds === undefined
        ? {}
        : { heartbeatIntervalSeconds: settings.heartbeatIntervalSeconds }),
      openConnection
    }

    return {
      ...mysqlMigrationDialect,
      migrationModel: { ...baseModel, lock }
    }
  }

  const slowPlanDialect = (base: MigrationDialect): MigrationDialect => ({
    ...base,
    translatePlan: (steps, ctx) =>
      Effect.gen(function* () {
        yield* Effect.sleep("3 seconds")
        return yield* base.translatePlan(steps, ctx)
      })
  })

  const releaseZeroDialect = (): MigrationDialect => {
    const baseModel = mysqlMigrationDialect.migrationModel
    const baseLock = baseModel.lock
    if (baseLock === undefined) throw new Error("base dialect must declare a lock")
    let releaseCalls = 0
    return {
      ...mysqlMigrationDialect,
      migrationModel: {
        ...baseModel,
        lock: {
          ...baseLock,
          releaseStatement: (name) => {
            releaseCalls++
            return releaseCalls === 1 ? { sql: "SELECT 0 AS released", params: [] } : baseLock.releaseStatement(name)
          }
        }
      }
    }
  }

  const failingMetadataDialect = (targetTable: string): MigrationDialect => {
    let seen = 0
    return {
      ...mysqlMigrationDialect,
      upsertStatement: (table: string, record: Readonly<Record<string, unknown>>, keys: ReadonlyArray<string>) => {
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

  const interruptedAddDialect = (table: string, column: string): MigrationDialect => {
    let intercepted = false
    return {
      ...mysqlMigrationDialect,
      translatePlan: (steps: ReadonlyArray<MigrationStep>, ctx: TranslatePlanContext) =>
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
            const statements = translated.statements.filter((statement, index) => {
              if (index <= start) return true
              if (index === start + 1 && statement.startsWith("UPDATE ") && statement.includes(quoteName(column))) {
                return false
              }
              if (index === start + 2 && statement.includes(`MODIFY COLUMN ${quoteName(column)}`)) {
                return false
              }
              return true
            })
            return { ...translated, statements }
          })
        )
    }
  }

  const catchUnsupported = <A>(effect: Effect.Effect<A, MigrationError, never>) =>
    effect.pipe(
      Effect.as(undefined),
      Effect.catchTag("UnsupportedMigrationStepError", (error) => Effect.succeed(error))
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
            const typeByName = new Map(columns.map((column) => [column.column_name, normalizeType(column.column_type)]))
            expect(typeByName.get("seqId")).toBe("bigint")
            expect(typeByName.get("id")).toBe("varchar(255)")
            expect(typeByName.get("title")).toBe("longtext")
            expect(typeByName.get("grade")).toBe("longtext")
            expect(typeByName.get("done")).toBe("tinyint(1)")
            expect(typeByName.get("score")).toBe("double")
            expect(typeByName.get("priority")).toBe("int")

            const indexes = yield* indexRows(todosTable)
            expect(indexes.some((index) => index.column_name === "id" && Number(index.non_unique) === 0)).toBe(true)
            expect(
              indexes.some(
                (index) => index.index_name === `idx_${todosTable}_priority` && Number(index.non_unique) === 1
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
            expect(columns.map((column) => column.column_name)).toContain("notes")
            const indexNames = new Set((yield* indexRows(todosTable)).map((index) => index.index_name))
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
            const normalCtx = yield* Layer.build(makeLayer(mysqlMigrationDialect, 2))
            yield* resetEngine.pipe(Effect.provide(normalCtx))

            yield* Effect.gen(function* () {
              const migrator = yield* Migrator
              const sql = yield* SqlClient.SqlClient

              yield* migrator.migrate(v1Schemas(), options)
              yield* insertTodo("1")
              yield* sql`DELETE FROM ${sql(migrationsTable)}`
            }).pipe(Effect.provide(normalCtx))

            const failingCtx = yield* Layer.build(makeLayer(failingMetadataDialect(migrationsTable), 2))
            yield* Effect.gen(function* () {
              const migrator = yield* Migrator

              const exit = yield* Effect.exit(
                migrator.migrate(v2Schemas(), {
                  ...options,
                  allowDestructive: true
                })
              )
              expect(Exit.isFailure(exit)).toBe(true)

              const name = yield* expectedLockName
              expect(yield* isUsedLock(name)).toBeNull()
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
            const normalCtx = yield* Layer.build(makeLayer(mysqlMigrationDialect, 2))
            yield* resetEngine.pipe(Effect.provide(normalCtx))

            yield* Effect.gen(function* () {
              const migrator = yield* Migrator
              const sql = yield* SqlClient.SqlClient

              yield* migrator.migrate(v1Schemas(), options)
              yield* insertTodo("1")
              yield* sql`DELETE FROM ${sql(migrationsTable)}`
            }).pipe(Effect.provide(normalCtx))

            const failingCtx = yield* Layer.build(makeLayer(failingMetadataDialect(schemaTable), 2))
            yield* Effect.gen(function* () {
              const migrator = yield* Migrator

              const exit = yield* Effect.exit(
                migrator.migrate(v2Schemas(), {
                  ...options,
                  allowDestructive: true
                })
              )
              expect(Exit.isFailure(exit)).toBe(true)

              const name = yield* expectedLockName
              expect(yield* isUsedLock(name)).toBeNull()
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
            const first = yield* Layer.build(makeLayer(mysqlMigrationDialect, 2))
            const second = yield* Layer.build(makeLayer(mysqlMigrationDialect, 2))
            yield* resetEngine.pipe(Effect.provide(first))

            const firstMigrator = Context.get(first, Migrator)
            const secondMigrator = Context.get(second, Migrator)
            const results = yield* Effect.all(
              [firstMigrator.migrate(v1Schemas(), options), secondMigrator.migrate(v1Schemas(), options)],
              { concurrency: "unbounded" }
            )
            expect(results).toHaveLength(2)

            yield* Effect.gen(function* () {
              expect(yield* tablesNamed([todosTable])).toHaveLength(1)
              expect(yield* countSchemaRows(todosTable)).toBe(1)
              expect(yield* countRows(migrationsTable)).toBe(1)
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

            expect(yield* tablesNamed([schemaTable, migrationsTable])).toEqual([])
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

            yield* sql.unsafe(`CREATE TABLE ${quoteName(driftTable)} (${quoteName("id")} INT PRIMARY KEY)`)

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

            yield* sql.unsafe(`CREATE TABLE ${quoteName(schemaTable)} (${quoteName("name")} VARCHAR(255) PRIMARY KEY)`)

            const failure = yield* catchUnsupported(
              migrator.migrate([{ name: todosTable, schema: todosV1() }], options)
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
            expect(Number(after?.lock_wait_timeout)).toBe(Number(before?.lock_wait_timeout))
            expect(Number(after?.wait_timeout)).toBe(Number(before?.wait_timeout))
            const columns = yield* columnRows(todosTable)
            expect(columns.map((column) => column.column_name)).toContain("seqId")
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

            yield* migrator.migrate([{ name: todosTable, schema: todosV1() }], options)
            yield* insertTodo("1")

            const failure = yield* catchUnsupported(
              migrator.migrate([{ name: todosTable, schema: todosV2WithTitleIndex() }], {
                ...options,
                allowDestructive: true
              })
            )
            expect(failure).toBeDefined()
            if (failure !== undefined) {
              expect(failure.detail).toContain("has no maxLength")
              expect(failure.detail).toContain("768")
            }

            const columns = yield* columnRows(todosTable)
            expect(columns.map((column) => column.column_name)).not.toContain("notes")
            const typeByName = new Map(columns.map((column) => [column.column_name, normalizeType(column.column_type)]))
            expect(typeByName.get("grade")).toBe("longtext")

            const indexNames = new Set((yield* indexRows(todosTable)).map((index) => index.index_name))
            expect(indexNames.has(`idx_${todosTable}_title`)).toBe(false)
            expect(indexNames.has(`idx_${todosTable}_priority`)).toBe(true)
            expect(yield* storedSchema(todosTable)).not.toContain('"notes"')
          })
        ),
      120_000
    )

    it.effect(
      "migrates indexed text with a declared length and binary collation",
      () =>
        runWithEngine(
          2,
          mysqlMigrationDialect,
          Effect.gen(function* () {
            const migrator = yield* Migrator

            yield* migrator.migrate([{ name: todosTable, schema: todosV1() }], options)
            yield* insertTodo("1")

            yield* migrator.migrate([{ name: todosTable, schema: todosV2WithTitleIndex(200) }], {
              ...options,
              allowDestructive: true
            })

            const columns = yield* columnRows(todosTable)
            const title = columns.find((column) => column.column_name === "title")
            expect(title?.column_type).toBe("varchar(200)")
            expect(title?.collation_name).toBe("utf8mb4_0900_bin")

            const indexNames = new Set((yield* indexRows(todosTable)).map((index) => index.index_name))
            expect(indexNames.has(`idx_${todosTable}_title`)).toBe(true)
          })
        ),
      120_000
    )

    it.effect(
      "keeps long unique values distinct and rejects an unsafe narrowing",
      () =>
        runWithEngine(
          2,
          mysqlMigrationDialect,
          Effect.gen(function* () {
            const migrator = yield* Migrator
            const sql = yield* SqlClient.SqlClient

            yield* migrator.migrate([{ name: textTable, schema: textTableSchema(768) }], options)

            const row = (id: string, name: string) => ({
              id,
              name,
              created: "2026-01-01",
              updated: "2026-01-01"
            })
            yield* insertRow(textTable, row("1", "Admin"))
            yield* insertRow(textTable, row("2", "admin"))
            yield* insertRow(textTable, row("3", "a"))
            yield* insertRow(textTable, row("4", "a "))
            expect(yield* countRows(textTable)).toBe(4)

            const duplicate = yield* sql`
              INSERT INTO ${sql(textTable)} ${sql.insert(row("5", "Admin"))}
            `.pipe(Effect.result)
            expect(Result.isFailure(duplicate)).toBe(true)

            const prefix = "x".repeat(767)
            yield* insertRow(textTable, row("6", prefix + "a"))
            yield* insertRow(textTable, row("7", prefix + "b"))
            expect(yield* countRows(textTable)).toBe(6)

            const failure = yield* catchUnsupported(
              migrator.migrate([{ name: textTable, schema: textTableSchema(100) }], {
                ...options,
                allowDestructive: true
              })
            )
            expect(failure?.detail).toContain("cannot narrow")

            const name = (yield* columnRows(textTable)).find((column) => column.column_name === "name")
            expect(name?.column_type).toBe("varchar(768)")
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
              migrator.migrate([{ name: todosTable, schema: droppedGrade }], { ...options, allowDestructive: true })
            )
            expect(failure).toBeDefined()
            if (failure !== undefined) {
              expect(failure.detail).toContain(untrackedView)
            }
            expect((yield* columnRows(todosTable)).map((column) => column.column_name)).toContain("grade")
            expect(yield* tablesNamed([untrackedView])).toHaveLength(1)

            yield* sql.unsafe(`DROP VIEW ${quoteName(untrackedView)}`)

            yield* migrator.migrate(
              [
                { name: todosTable, schema: droppedGrade },
                {
                  name: todosView,
                  schema: todoView(`${v1ViewQuery} WHERE 1 = 1`, ["id", "seqId", "title"])
                }
              ],
              { ...options, allowDestructive: true }
            )

            const columns = yield* columnRows(todosTable)
            expect(columns.map((column) => column.column_name)).not.toContain("grade")
            const viewColumns = (yield* columnRows(todosView)).map((column) => column.column_name)
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
            expect(yield* countRows(migrationsTable)).toBe(2)
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

            expect(Number(after?.lock_wait_timeout)).toBe(Number(before?.lock_wait_timeout))
            expect(Number(after?.wait_timeout)).toBe(Number(before?.wait_timeout))
            expect(after?.sql_mode).toBe(before?.sql_mode)
            expect(yield* tablesNamed([schemaTable, migrationsTable])).toEqual([])
          })
        ),
      120_000
    )

    it.effect(
      "resumes an interrupted non-null add",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const interruptedCtx = yield* Layer.build(makeLayer(interruptedAddDialect(requiredTable, "code"), 1))
            yield* resetEngine.pipe(Effect.provide(interruptedCtx))

            yield* Effect.gen(function* () {
              const migrator = yield* Migrator

              yield* migrator.migrate([{ name: requiredTable, schema: requiredV1() }], options)
              yield* insertRow(requiredTable, {
                id: "t1",
                title: "one",
                created: "2026-01-01",
                updated: "2026-01-01"
              })

              const exit = yield* Effect.exit(
                migrator.migrate([{ name: requiredTable, schema: requiredV2() }], options)
              )
              expect(Exit.isFailure(exit)).toBe(true)

              const columns = yield* columnRows(requiredTable)
              const byName = new Map(columns.map((column) => [column.column_name, column]))
              expect(byName.get("code")?.is_nullable).toBe("YES")
              expect(yield* storedSchema(requiredTable)).not.toContain('"code"')
            }).pipe(Effect.provide(interruptedCtx))

            const normalCtx = yield* Layer.build(makeLayer(mysqlMigrationDialect, 1))
            yield* Effect.gen(function* () {
              const migrator = yield* Migrator
              const sql = yield* SqlClient.SqlClient

              yield* migrator.migrate([{ name: requiredTable, schema: requiredV2() }], options)

              const columns = yield* columnRows(requiredTable)
              const byName = new Map(columns.map((column) => [column.column_name, column]))
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
    it.effect(
      "releases the lock after a successful migrate",
      () =>
        runWithEngine(
          2,
          mysqlMigrationDialect,
          Effect.gen(function* () {
            const migrator = yield* Migrator
            const name = yield* expectedLockName

            yield* migrator.migrate(v1Schemas(), options)
            expect(yield* isUsedLock(name)).toBeNull()
          })
        ),
      120_000
    )

    it.effect(
      "releases the lock after a failed render",
      () =>
        runWithEngine(
          2,
          mysqlMigrationDialect,
          Effect.gen(function* () {
            const migrator = yield* Migrator
            const sql = yield* SqlClient.SqlClient
            const name = yield* expectedLockName

            yield* sql.unsafe(`CREATE TABLE ${quoteName(driftTable)} (${quoteName("id")} INT PRIMARY KEY)`)
            const failure = yield* catchUnsupported(
              migrator.migrate([{ name: driftTable, schema: simpleTable() }], options)
            )
            expect(failure).toBeDefined()
            expect(yield* isUsedLock(name)).toBeNull()
          })
        ),
      120_000
    )

    it.effect(
      "fails plan and status busy while the lock is held",
      () =>
        runWithEngine(
          2,
          mysqlMigrationDialect,
          Effect.gen(function* () {
            const migrator = yield* Migrator
            const name = yield* expectedLockName
            const schemas = [{ name: todosTable, schema: todosV1() }]

            yield* withHeldLock(
              name,
              Effect.gen(function* () {
                const planResult = yield* migrator.plan(schemas, options).pipe(
                  Effect.as("ok" as const),
                  Effect.catchTag("MigrationBusyError", (error) => Effect.succeed(error))
                )
                expect(planResult).not.toBe("ok")
                if (planResult !== "ok") expect(planResult.operation).toBe("plan")

                const statusResult = yield* migrator.status(schemas, options).pipe(
                  Effect.as("ok" as const),
                  Effect.catchTag("MigrationBusyError", (error) => Effect.succeed(error))
                )
                expect(statusResult).not.toBe("ok")
                if (statusResult !== "ok") expect(statusResult.operation).toBe("status")
              })
            )

            const plan = yield* migrator.plan(schemas, options)
            expect(plan.steps.length).toBeGreaterThan(0)
          })
        ),
      120_000
    )

    it.live(
      "waits and times out with a message naming the lock and timeout",
      () =>
        runWithEngine(
          2,
          mysqlMigrationDialect,
          Effect.gen(function* () {
            const migrator = yield* Migrator
            const name = yield* expectedLockName
            const started = Date.now()

            yield* withHeldLock(
              name,
              Effect.gen(function* () {
                const result = yield* migrator
                  .migrate(v1Schemas(), {
                    ...options,
                    migrationLockTimeoutSeconds: 1
                  })
                  .pipe(
                    Effect.as("ok" as const),
                    Effect.catchTag("MigrationBusyError", (error) => Effect.succeed(error))
                  )
                expect(result).not.toBe("ok")
                if (result !== "ok") {
                  expect(result.operation).toBe("migrate")
                  expect(result.message).toContain(name)
                  expect(result.message).toContain("1s")
                }
              })
            )

            expect(Date.now() - started).toBeGreaterThanOrEqual(900)
            expect(yield* tablesNamed([todosTable])).toEqual([])
            yield* migrator.migrate(v1Schemas(), options)
            expect(yield* isUsedLock(name)).toBeNull()
          })
        ),
      120_000
    )

    it.effect(
      "clears a recursive stale instance before acquiring",
      () =>
        runWithEngine(
          1,
          mysqlMigrationDialect,
          Effect.gen(function* () {
            const migrator = yield* Migrator
            const sql = yield* SqlClient.SqlClient
            const name = yield* expectedLockName

            yield* Effect.scoped(
              Effect.gen(function* () {
                const conn = yield* sql.reserve
                yield* conn.executeUnprepared("SELECT GET_LOCK(?, 0)", [name], undefined)
                yield* conn.executeUnprepared("SELECT GET_LOCK(?, 0)", [name], undefined)
              })
            )

            yield* migrator.migrate(v1Schemas(), options)
            expect(yield* isUsedLock(name)).toBeNull()
          })
        ),
      120_000
    )

    it.effect(
      "dedicated lock connection releases on success",
      () =>
        runWithEngine(
          2,
          dedicatedLockDialect(),
          Effect.gen(function* () {
            const migrator = yield* Migrator
            const name = yield* expectedLockName

            yield* migrator.migrate(v1Schemas(), options)
            expect(yield* isUsedLock(name)).toBeNull()
            yield* migrator.migrate(v1Schemas(), options)
          })
        ),
      120_000
    )

    it.effect(
      "dedicated lock connection destroys on release failure",
      () =>
        runWithEngine(
          2,
          dedicatedLockDialect({ omitKill: true, releaseReturnsZero: true }),
          Effect.gen(function* () {
            const migrator = yield* Migrator
            const name = yield* expectedLockName

            const exit = yield* Effect.exit(migrator.migrate(v1Schemas(), options))
            expect(Exit.isFailure(exit)).toBe(true)
            expect(yield* isUsedLock(name)).toBeNull()

            yield* migrator.migrate(v1Schemas(), options)
          })
        ),
      120_000
    )

    it.effect(
      "rejects a dedicated lock connection on a different database",
      () => {
        const mismatchUrl = new URL(url)
        mismatchUrl.pathname = "/mysql"
        return runWithEngine(
          2,
          dedicatedLockDialect({ urlOverride: mismatchUrl.toString() }),
          Effect.gen(function* () {
            const migrator = yield* Migrator
            const result = yield* migrator.migrate(v1Schemas(), options).pipe(
              Effect.as("ok" as const),
              Effect.catchTag("MigrationLockError", (error) => Effect.succeed(error))
            )
            expect(result).not.toBe("ok")
            if (result !== "ok") {
              expect(result.detail).toContain("targets database")
            }
            expect(yield* tablesNamed([todosTable])).toEqual([])
          })
        )
      },
      120_000
    )

    it.live(
      "heartbeat keeps a long migration's lock alive",
      () =>
        runWithEngine(
          2,
          slowPlanDialect(dedicatedLockDialect({ heartbeatIntervalSeconds: 1, lockWaitTimeoutSeconds: 2 })),
          Effect.gen(function* () {
            const migrator = yield* Migrator
            const name = yield* expectedLockName

            yield* migrator.migrate(v1Schemas(), options)
            expect(yield* countRows(migrationsTable)).toBe(1)
            expect(yield* isUsedLock(name)).toBeNull()
          })
        ),
      120_000
    )

    it.live(
      "stops before metadata when the heartbeat fails",
      () =>
        runWithEngine(
          2,
          slowPlanDialect(
            dedicatedLockDialect({
              heartbeatIntervalSeconds: 1,
              failHeartbeatAfter: 1
            })
          ),
          Effect.gen(function* () {
            const migrator = yield* Migrator
            const name = yield* expectedLockName

            const exit = yield* Effect.exit(migrator.migrate(v1Schemas(), options))
            expect(Exit.isFailure(exit)).toBe(true)
            expect(yield* countRows(migrationsTable)).toBe(0)
            expect(yield* isUsedLock(name)).toBeNull()
          })
        ),
      120_000
    )

    it.live(
      "releases the lock when interrupted after acquire",
      () =>
        runWithEngine(
          2,
          slowPlanDialect(mysqlMigrationDialect),
          Effect.gen(function* () {
            const migrator = yield* Migrator
            const name = yield* expectedLockName

            const exit = yield* Effect.exit(migrator.migrate(v1Schemas(), options).pipe(Effect.timeout("1 second")))
            expect(Exit.isFailure(exit)).toBe(true)
            expect(yield* isUsedLock(name)).toBeNull()
          })
        ),
      120_000
    )

    it.live(
      "preview fails when the lock session is lost",
      () =>
        runWithEngine(
          2,
          slowPlanDialect(
            dedicatedLockDialect({
              heartbeatIntervalSeconds: 1,
              failHeartbeatAfter: 1
            })
          ),
          Effect.gen(function* () {
            const migrator = yield* Migrator
            const schemas = [{ name: todosTable, schema: todosV1() }]

            const result = yield* migrator.plan(schemas, options).pipe(
              Effect.as("ok" as const),
              Effect.catchTag("MigrationLockError", (error) => Effect.succeed(error))
            )
            expect(result).not.toBe("ok")
            if (result !== "ok") {
              expect(result.detail).toContain("was lost")
            }
          })
        ),
      120_000
    )

    it.effect(
      "kills the holder when the fallback release cannot be verified",
      () =>
        runWithEngine(
          2,
          releaseZeroDialect(),
          Effect.gen(function* () {
            const migrator = yield* Migrator
            const name = yield* expectedLockName

            const exit = yield* Effect.exit(migrator.migrate(v1Schemas(), options))
            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit)) {
              expect(Cause.pretty(exit.cause)).toContain("MigrationLockReleaseError")
            }
            expect(yield* rawIsUsedLock(name)).toBeNull()
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
