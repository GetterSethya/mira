/**
 * Gated PostgreSQL migration behavior suite.
 *
 * Run with a real PostgreSQL 15+ server:
 *
 *   $env:MIRA_TEST_POSTGRES_URL = "postgres://postgres:mira@127.0.0.1:55432/mira_test"
 *   pnpm --filter @gettersethya/mira exec vitest run tests/databases/postgres-migrator.e2e.test.ts
 *
 * The file self-skips when the URL is absent. Its dedicated metadata pair is
 * e2e_migrator_collections/e2e_migrator_migrations. Every test starts by
 * dropping that pair plus the fixtures it may create. Do not run this file in
 * parallel with another gated PostgreSQL suite: the fixed internal tables
 * would collide.
 */
import { PgClient } from "@effect/sql-pg"
import { describe, it } from "@effect/vitest"
import type { CollectionSchema } from "@gettersethya/mira-client"
import { Context, Effect, Exit, Layer, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { expect } from "vitest"

import { Dialect } from "@/dialect/dialect.js"
import { postgresDialect } from "@/dialect/dialect-postgres.js"
import { Migrator, MigratorLive } from "@/migrator/migrator.js"
import type { MigrateOptions } from "@/migrator/types.js"

const postgresUrl = process.env["MIRA_TEST_POSTGRES_URL"]
const enabled = postgresUrl !== undefined
const describeE2E = enabled ? describe : describe.skip
const url = postgresUrl ?? "postgres://postgres:mira@127.0.0.1:55432/mira_test"

const options: MigrateOptions = {
  schemaTable: "e2e_migrator_collections",
  migrationsTable: "e2e_migrator_migrations",
  logLevel: 0
}

const quoteName = (name: string) => `"${name.replaceAll('"', '""')}"`

const dropTable = (name: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.unsafe(`DROP TABLE IF EXISTS ${quoteName(name)} CASCADE`).pipe(Effect.ignore)
  })

const dropView = (name: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.unsafe(`DROP VIEW IF EXISTS ${quoteName(name)} CASCADE`).pipe(Effect.ignore)
  })

const cleanupMigratorDatabase = Effect.gen(function* () {
  for (const name of [
    "e2e_pg_todos_view",
    "e2e_pg_untracked",
    "e2e_pg_conflict_view"
  ]) {
    yield* dropView(name)
  }
  for (const name of [
    "e2e_migrator_collections",
    "e2e_migrator_migrations",
    "e2e_pg_todos",
    "e2e_pg_conflict_posts",
    "e2e_pg_concurrent",
    "e2e_pg_overlong",
    "e2e_pg_preview",
    "_config",
    "_auth_challenges",
    "_revoked_tokens",
    "_auth_generations",
    "_rate_limits",
    "_telemetry_collections",
    "_telemetry_migrations",
    "logs",
    "spans"
  ]) {
    yield* dropTable(name)
  }
})

const makeMigratorLayer = () => {
  const base = Layer.merge(
    PgClient.layer({ url: Redacted.make(url) }),
    Layer.succeed(Dialect, postgresDialect)
  )
  return Layer.merge(base, MigratorLive.pipe(Layer.provide(base)))
}

const baseProperties: CollectionSchema["properties"] = {
  seqId: { type: "integer", "x-kind": "seqId", "x-system": true },
  id: { type: "string", "x-system": true },
  created: { type: "string", "x-system": true },
  updated: { type: "string", "x-system": true }
}

const todosV1 = (): CollectionSchema => {
  const properties: CollectionSchema["properties"] = {
    ...baseProperties,
    title: { type: "string" },
    category: { type: "string" },
    rank: { type: "string" },
    done: { type: "boolean", default: false },
    score: { type: "number" }
  }
  return {
    "x-collection-kind": "base",
    type: "object",
    properties,
    required: ["id", "title", "category", "rank", "created", "updated"],
    "x-indexes": [{ fields: ["category"], unique: false }]
  }
}

const todosV2 = (): CollectionSchema => {
  const properties: CollectionSchema["properties"] = {
    ...baseProperties,
    title: { type: "string" },
    category: { type: "string" },
    rank: { type: "integer" },
    notes: { type: "string" },
    done: { type: "boolean", default: false },
    score: { type: "number" }
  }
  return {
    "x-collection-kind": "base",
    type: "object",
    properties,
    required: ["id", "title", "category", "rank", "created", "updated"],
    "x-indexes": [{ fields: ["title"], unique: false }]
  }
}

const todosV3 = (): CollectionSchema => {
  const schema = todosV2()
  delete schema.properties["notes"]
  return schema
}

const todosBase = (withTitle: boolean): CollectionSchema => {
  const properties: CollectionSchema["properties"] = {
    ...baseProperties,
    ...(withTitle ? { title: { type: "string" } } : {}),
    category: { type: "string" }
  }
  return {
    "x-collection-kind": "base",
    type: "object",
    properties,
    required: withTitle
      ? ["id", "title", "category", "created", "updated"]
      : ["id", "category", "created", "updated"]
  }
}

const todosView = (
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
    title: { type: "string" }
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

const conflictBase = (withNotes: boolean): CollectionSchema => {
  const properties: CollectionSchema["properties"] = {
    ...baseProperties,
    title: { type: "string" },
    ...(withNotes ? { notes: { type: "string" } } : {})
  }
  return {
    "x-collection-kind": "base",
    type: "object",
    properties,
    required: ["id", "title", "created", "updated"]
  }
}

const simpleTable = (): CollectionSchema => {
  const properties: CollectionSchema["properties"] = {
    ...baseProperties,
    title: { type: "string" }
  }
  return {
    "x-collection-kind": "base",
    type: "object",
    properties,
    required: ["id", "title", "created", "updated"]
  }
}

const longColumnName = "x".repeat(64)

const overlongTable = (): CollectionSchema => {
  const properties: CollectionSchema["properties"] = {
    ...baseProperties,
    [longColumnName]: { type: "string" }
  }
  return {
    "x-collection-kind": "base",
    type: "object",
    properties,
    required: ["id", longColumnName, "created", "updated"]
  }
}

const insertTodo = (
  sql: SqlClient.SqlClient,
  record: Record<string, unknown>
) =>
  sql`INSERT INTO ${sql("e2e_pg_todos")} ${sql.insert(record)}`

const tableNames = (names: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ table_name: string }>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = current_schema()
    `
    return rows
      .map((row) => row.table_name)
      .filter((name) => names.includes(name))
  })

const columnRows = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql<{
      column_name: string
      data_type: string
      is_identity: string
    }>`
      SELECT column_name, data_type, is_identity
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = ${table}
      ORDER BY ordinal_position
    `
  })

const indexDefs = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql<{ indexdef: string }>`
      SELECT indexdef
      FROM pg_indexes
      WHERE schemaname = current_schema()
        AND tablename = ${table}
    `
  })

describeE2E("PostgreSQL migrations", () => {
  it.effect(
    "creates, alters, and drops columns, indexes, and native types",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const cleanupCtx = yield* Layer.build(
            PgClient.layer({ url: Redacted.make(url), maxConnections: 1 })
          )
          yield* cleanupMigratorDatabase.pipe(Effect.provide(cleanupCtx))

          const migratorCtx = yield* Layer.build(makeMigratorLayer())
          yield* Effect.gen(function* () {
            const migrator = yield* Migrator
            const sql = yield* SqlClient.SqlClient

            yield* migrator.migrate(
              [{ name: "e2e_pg_todos", schema: todosV1() }],
              options
            )

            yield* insertTodo(sql, {
              id: "t1",
              title: "one",
              category: "c1",
              rank: "1",
              done: true,
              score: 1.5,
              created: "2026-01-01",
              updated: "2026-01-01"
            })
            yield* insertTodo(sql, {
              id: "t2",
              title: "two",
              category: "c2",
              rank: "2",
              done: false,
              score: 2.5,
              created: "2026-01-01",
              updated: "2026-01-01"
            })

            const initialColumns = yield* columnRows("e2e_pg_todos")
            const initialByName = new Map(
              initialColumns.map((column) => [column.column_name, column])
            )
            expect(initialByName.get("rank")?.data_type).toBe("text")
            expect(initialByName.get("done")?.data_type).toBe("boolean")
            expect(initialByName.get("score")?.data_type).toBe(
              "double precision"
            )
            expect(initialByName.get("seqId")?.data_type).toBe("bigint")
            expect(initialByName.get("seqId")?.is_identity).toBe("YES")

            const nativeValues = yield* sql<{
              done: boolean
              score: number
            }>`
              SELECT done, score
              FROM ${sql("e2e_pg_todos")}
              WHERE id = ${"t1"}
            `
            expect(nativeValues[0]?.done).toBe(true)
            expect(nativeValues[0]?.score).toBe(1.5)

            const initialIndexes = yield* indexDefs("e2e_pg_todos")
            expect(
              initialIndexes.some((entry) =>
                entry.indexdef.includes("(category)")
              )
            ).toBe(true)

            yield* migrator.migrate(
              [{ name: "e2e_pg_todos", schema: todosV2() }],
              { ...options, allowDestructive: true }
            )

            const alteredColumns = yield* columnRows("e2e_pg_todos")
            const alteredByName = new Map(
              alteredColumns.map((column) => [column.column_name, column])
            )
            expect(alteredByName.get("rank")?.data_type).toBe("integer")
            expect(alteredByName.get("notes")?.data_type).toBe("text")
            expect(alteredByName.get("score")?.data_type).toBe(
              "double precision"
            )

            const ranks = yield* sql<{ id: string; rank: number }>`
              SELECT id, rank
              FROM ${sql("e2e_pg_todos")}
              ORDER BY id
            `
            expect(ranks).toEqual([
              { id: "t1", rank: 1 },
              { id: "t2", rank: 2 }
            ])

            const alteredIndexes = yield* indexDefs("e2e_pg_todos")
            expect(
              alteredIndexes.some((entry) => entry.indexdef.includes("(title)"))
            ).toBe(true)
            expect(
              alteredIndexes.some((entry) =>
                entry.indexdef.includes("(category)")
              )
            ).toBe(false)

            yield* migrator.migrate(
              [{ name: "e2e_pg_todos", schema: todosV3() }],
              { ...options, allowDestructive: true }
            )

            const droppedColumns = yield* columnRows("e2e_pg_todos")
            expect(
              droppedColumns.map((column) => column.column_name)
            ).not.toContain("notes")

            yield* sql.unsafe(
              `ALTER TABLE "e2e_pg_todos" ALTER COLUMN "seqId" RESTART WITH 100`
            )
            yield* insertTodo(sql, {
              id: "t3",
              title: "three",
              category: "c3",
              rank: 3,
              done: true,
              score: 3.5,
              created: "2026-01-01",
              updated: "2026-01-01"
            })
            const restarted = yield* sql<{ seqId: bigint }>`
              SELECT "seqId" FROM ${sql("e2e_pg_todos")} WHERE id = ${"t3"}
            `
            expect(String(restarted[0]?.seqId)).toBe("100")
          }).pipe(Effect.provide(migratorCtx))
        })
      ),
    120_000
  )

  it.effect(
    "recreates a tracked view around dropColumn",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const cleanupCtx = yield* Layer.build(
            PgClient.layer({ url: Redacted.make(url), maxConnections: 1 })
          )
          yield* cleanupMigratorDatabase.pipe(Effect.provide(cleanupCtx))

          const migratorCtx = yield* Layer.build(makeMigratorLayer())
          yield* Effect.gen(function* () {
            const migrator = yield* Migrator
            const sql = yield* SqlClient.SqlClient

            yield* migrator.migrate(
              [
                { name: "e2e_pg_todos", schema: todosBase(true) },
                {
                  name: "e2e_pg_todos_view",
                  schema: todosView(
                    'SELECT id, "seqId", title FROM e2e_pg_todos',
                    ["id", "seqId", "title"]
                  )
                }
              ],
              options
            )
            yield* insertTodo(sql, {
              id: "t1",
              title: "one",
              category: "c1",
              created: "2026-01-01",
              updated: "2026-01-01"
            })

            yield* migrator.migrate(
              [
                { name: "e2e_pg_todos", schema: todosBase(false) },
                {
                  name: "e2e_pg_todos_view",
                  schema: todosView(
                    'SELECT id, "seqId" FROM e2e_pg_todos',
                    ["id", "seqId"]
                  )
                }
              ],
              { ...options, allowDestructive: true }
            )

            const columns = yield* columnRows("e2e_pg_todos")
            expect(columns.map((column) => column.column_name)).not.toContain(
              "title"
            )
            const viewRows = yield* sql<{ id: string }>`
              SELECT id FROM ${sql("e2e_pg_todos_view")}
            `
            expect(viewRows).toEqual([{ id: "t1" }])

            yield* migrator.migrate(
              [{ name: "e2e_pg_todos", schema: todosBase(false) }],
              { ...options, allowDestructive: true }
            )
            const viewTables = yield* tableNames(["e2e_pg_todos_view"])
            expect(viewTables).toEqual([])
          }).pipe(Effect.provide(migratorCtx))
        })
      ),
    120_000
  )

  it.effect(
    "rolls back a stale tracked view around dropColumn",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const cleanupCtx = yield* Layer.build(
            PgClient.layer({ url: Redacted.make(url), maxConnections: 1 })
          )
          yield* cleanupMigratorDatabase.pipe(Effect.provide(cleanupCtx))

          const migratorCtx = yield* Layer.build(makeMigratorLayer())
          yield* Effect.gen(function* () {
            const migrator = yield* Migrator
            const sql = yield* SqlClient.SqlClient

            yield* migrator.migrate(
              [
                { name: "e2e_pg_todos", schema: todosBase(true) },
                {
                  name: "e2e_pg_todos_view",
                  schema: todosView(
                    'SELECT id, "seqId", title FROM e2e_pg_todos',
                    ["id", "seqId", "title"]
                  )
                }
              ],
              options
            )
            yield* insertTodo(sql, {
              id: "t1",
              title: "one",
              category: "c1",
              created: "2026-01-01",
              updated: "2026-01-01"
            })

            const exit = yield* Effect.exit(
              migrator.migrate(
                [
                  { name: "e2e_pg_todos", schema: todosBase(false) },
                  {
                    name: "e2e_pg_todos_view",
                    schema: todosView(
                      'SELECT id, "seqId", title FROM e2e_pg_todos',
                      ["id", "seqId", "title"]
                    )
                  }
                ],
                { ...options, allowDestructive: true }
              )
            )

            expect(Exit.isFailure(exit)).toBe(true)
            const columns = yield* columnRows("e2e_pg_todos")
            expect(columns.map((column) => column.column_name)).toContain(
              "title"
            )
            const viewTables = yield* tableNames(["e2e_pg_todos_view"])
            expect(viewTables).toEqual(["e2e_pg_todos_view"])
            const rows = yield* sql<{ id: string }>`
              SELECT id FROM ${sql("e2e_pg_todos")}
            `
            expect(rows).toEqual([{ id: "t1" }])
          }).pipe(Effect.provide(migratorCtx))
        })
      ),
    120_000
  )

  it.effect(
    "fails an untracked view at the statement and rolls back",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const cleanupCtx = yield* Layer.build(
            PgClient.layer({ url: Redacted.make(url), maxConnections: 1 })
          )
          yield* cleanupMigratorDatabase.pipe(Effect.provide(cleanupCtx))

          const migratorCtx = yield* Layer.build(makeMigratorLayer())
          yield* Effect.gen(function* () {
            const migrator = yield* Migrator
            const sql = yield* SqlClient.SqlClient

            yield* migrator.migrate(
              [{ name: "e2e_pg_todos", schema: todosBase(true) }],
              options
            )
            yield* insertTodo(sql, {
              id: "t1",
              title: "one",
              category: "c1",
              created: "2026-01-01",
              updated: "2026-01-01"
            })
            yield* sql.unsafe(
              `CREATE VIEW ${quoteName("e2e_pg_untracked")} AS SELECT "id", "title" FROM ${quoteName("e2e_pg_todos")}`
            )

            const exit = yield* Effect.exit(
              migrator.migrate(
                [{ name: "e2e_pg_todos", schema: todosBase(false) }],
                { ...options, allowDestructive: true }
              )
            )

            expect(Exit.isFailure(exit)).toBe(true)
            const columns = yield* columnRows("e2e_pg_todos")
            expect(columns.map((column) => column.column_name)).toContain(
              "title"
            )
            const viewTables = yield* tableNames(["e2e_pg_untracked"])
            expect(viewTables).toEqual(["e2e_pg_untracked"])
          }).pipe(Effect.provide(migratorCtx))
        })
      ),
    120_000
  )

  it.effect(
    "fails a createView name conflict at the statement and rolls back",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const cleanupCtx = yield* Layer.build(
            PgClient.layer({ url: Redacted.make(url), maxConnections: 1 })
          )
          yield* cleanupMigratorDatabase.pipe(Effect.provide(cleanupCtx))

          const migratorCtx = yield* Layer.build(makeMigratorLayer())
          yield* Effect.gen(function* () {
            const migrator = yield* Migrator
            const sql = yield* SqlClient.SqlClient

            yield* migrator.migrate(
              [{ name: "e2e_pg_conflict_posts", schema: conflictBase(false) }],
              options
            )
            yield* sql.unsafe(
              `CREATE VIEW ${quoteName("e2e_pg_conflict_view")} AS SELECT "id", "title" FROM ${quoteName("e2e_pg_conflict_posts")}`
            )

            const exit = yield* Effect.exit(
              migrator.migrate(
                [
                  {
                    name: "e2e_pg_conflict_posts",
                    schema: conflictBase(true)
                  },
                  {
                    name: "e2e_pg_conflict_view",
                    schema: todosView(
                      'SELECT id, "seqId", title FROM e2e_pg_conflict_posts',
                      ["id", "seqId", "title"]
                    )
                  }
                ],
                options
              )
            )

            expect(Exit.isFailure(exit)).toBe(true)
            const columns = yield* columnRows("e2e_pg_conflict_posts")
            expect(columns.map((column) => column.column_name)).not.toContain(
              "notes"
            )
            const viewTables = yield* tableNames(["e2e_pg_conflict_view"])
            expect(viewTables).toEqual(["e2e_pg_conflict_view"])
          }).pipe(Effect.provide(migratorCtx))
        })
      ),
    120_000
  )

  it.effect(
    "rejects an overlong identifier in preflight",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const cleanupCtx = yield* Layer.build(
            PgClient.layer({ url: Redacted.make(url), maxConnections: 1 })
          )
          yield* cleanupMigratorDatabase.pipe(Effect.provide(cleanupCtx))

          const migratorCtx = yield* Layer.build(makeMigratorLayer())
          yield* Effect.gen(function* () {
            const migrator = yield* Migrator
            const failure = yield* migrator
              .migrate(
                [{ name: "e2e_pg_overlong", schema: overlongTable() }],
                options
              )
              .pipe(
                Effect.as(undefined),
                Effect.catchTag("UnsupportedMigrationStepError", (error) =>
                  Effect.succeed(error.detail)
                )
              )

            expect(failure).toBeDefined()
            if (failure !== undefined) {
              expect(failure).toContain("63 bytes")
            }
            const tables = yield* tableNames(["e2e_pg_overlong"])
            expect(tables).toEqual([])
          }).pipe(Effect.provide(migratorCtx))
        })
      ),
    120_000
  )

  it.effect(
    "serializes two concurrent migrations",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const cleanupCtx = yield* Layer.build(
            PgClient.layer({ url: Redacted.make(url), maxConnections: 1 })
          )
          yield* cleanupMigratorDatabase.pipe(Effect.provide(cleanupCtx))

          const migratorCtx = yield* Layer.build(makeMigratorLayer())
          yield* Effect.gen(function* () {
            const migrator = yield* Migrator
            const sql = yield* SqlClient.SqlClient
            const schemas = [
              { name: "e2e_pg_concurrent", schema: simpleTable() }
            ]

            const results = yield* Effect.all(
              [
                migrator.migrate(schemas, options),
                migrator.migrate(schemas, options)
              ],
              { concurrency: "unbounded" }
            )
            expect(results).toHaveLength(2)

            const migrationRows = yield* sql<{ count: number }>`
              SELECT COUNT(*)::int AS count
              FROM ${sql("e2e_migrator_migrations")}
            `
            expect(migrationRows[0]?.count).toBe(1)

            const tableRows = yield* sql<{ count: number }>`
              SELECT COUNT(*)::int AS count
              FROM pg_class c
              JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = current_schema()
                AND c.relname = ${"e2e_pg_concurrent"}
                AND c.relkind = 'r'
            `
            expect(tableRows[0]?.count).toBe(1)
          }).pipe(Effect.provide(migratorCtx))
        })
      ),
    120_000
  )

  it.effect(
    "fails plan and status with MigrationBusyError while a migration holds the lock",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const cleanupCtx = yield* Layer.build(
            PgClient.layer({ url: Redacted.make(url), maxConnections: 1 })
          )
          yield* cleanupMigratorDatabase.pipe(Effect.provide(cleanupCtx))

          const lockCtx = yield* Layer.build(
            PgClient.layer({ url: Redacted.make(url), maxConnections: 1 })
          )
          const migratorCtx = yield* Layer.build(makeMigratorLayer())
          const lockSql = Context.get(lockCtx, SqlClient.SqlClient)
          const migrator = Context.get(migratorCtx, Migrator)
          const schemas = [
            { name: "e2e_pg_preview", schema: simpleTable() }
          ]

          yield* migrator.migrate(schemas, options)

          yield* lockSql.withTransaction(
            Effect.gen(function* () {
              yield* lockSql`SELECT pg_advisory_xact_lock(hashtextextended('mira.migrations', 0))`

              const planResult = yield* migrator.plan(schemas, options).pipe(
                Effect.as("ok"),
                Effect.catchTag("MigrationBusyError", (error) =>
                  Effect.succeed(error.operation)
                )
              )
              expect(planResult).toBe("plan")

              const statusResult = yield* migrator
                .status(schemas, options)
                .pipe(
                  Effect.as("ok"),
                  Effect.catchTag("MigrationBusyError", (error) =>
                    Effect.succeed(error.operation)
                  )
                )
              expect(statusResult).toBe("status")
            })
          )

          const plan = yield* migrator.plan(schemas, options)
          expect(plan.steps).toHaveLength(0)
          const status = yield* migrator.status(schemas, options)
          expect(status).toEqual([
            { name: "e2e_pg_preview", status: "current" }
          ])
        })
      ),
    120_000
  )
})
