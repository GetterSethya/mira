import { SqliteClient } from "@effect/sql-sqlite-node"
import { describe, it } from "@effect/vitest"
import type { CollectionSchema } from "@gettersethya/mira-client"
import { Effect, Layer, Schema } from "effect"
import { SqlClient, SqlError } from "effect/sql"
import { expect } from "vitest"

import type { MigrationLock, ParameterizedStatement } from "@/dialect/dialect.js"
import { Dialect } from "@/dialect/dialect.js"
import { sqliteDialect } from "@/dialect/dialect-sqlite.js"
import {
  MigrationBusyError,
  MigrationLockError,
  MigrationLockReleaseError
} from "@/migrator/errors.js"
import {
  acquireSessionLock,
  assertSameDatabase,
  Migrator,
  MigratorLive,
  readDatabaseName,
  releaseSessionLock
} from "@/migrator/migrator.js"
import type { MigrationExecutor } from "@/migrator/types.js"

const sqliteLayer = SqliteClient.layer({ filename: ":memory:" })

const migratorWithDeps = MigratorLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(Dialect, sqliteDialect),
      sqliteLayer
    )
  )
)

const testLayer = Layer.mergeAll(migratorWithDeps, sqliteLayer)

describe("migrator", () => {
  it("MigrationBusyError carries the tag, operation, and message", () => {
    const busy = new MigrationBusyError({ operation: "plan", message: "A migration is in progress" })
    expect(busy._tag).toBe("MigrationBusyError")
    expect(busy.operation).toBe("plan")
    expect(busy.message).toBe("A migration is in progress")
  })

  it.effect("creates table from collection schema", () =>
    Effect.gen(function* () {
      const migrator = yield* Migrator
      const schema: CollectionSchema = {
        "x-collection-kind": "base",
        type: "object",
        properties: {
          seqId: { type: "integer", "x-kind": "seqId", "x-system": true },
          title: { type: "string" }
        },
        required: ["title"]
      }

      yield* migrator.migrate([{ name: "base", schema }])
      const sql = yield* SqlClient.SqlClient
      const tables = yield* sql`SELECT name FROM sqlite_master WHERE type='table' AND name='base'`
      expect(tables.length).toBe(1)
    }).pipe(Effect.provide(testLayer)))

  it.effect("stored schema in _collections after migrate", () =>
    Effect.gen(function* () {
      const migrator = yield* Migrator
      const schema: CollectionSchema = {
        "x-collection-kind": "base",
        type: "object",
        properties: {
          seqId: { type: "integer", "x-kind": "seqId", "x-system": true },
          title: { type: "string" }
        },
        required: ["title"]
      }

      yield* migrator.migrate([{ name: "base", schema }])

      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql`SELECT name, schema FROM _collections`
      expect(rows.length).toBe(1)
      expect(rows[0].name).toBe("base")
      const parsed = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(Schema.Struct({ properties: Schema.Record(Schema.String, Schema.Unknown) }))
      )(rows[0].schema).pipe(Effect.orDie)
      expect(parsed.properties["title"]).toEqual({ type: "string" })
    }).pipe(Effect.provide(testLayer)))

  it.effect("no-op when schemas match", () =>
    Effect.gen(function* () {
      const migrator = yield* Migrator
      const schema: CollectionSchema = {
        "x-collection-kind": "base",
        type: "object",
        properties: {
          seqId: { type: "integer", "x-kind": "seqId", "x-system": true },
          title: { type: "string" }
        },
        required: ["title"]
      }

      yield* migrator.migrate([{ name: "base", schema }])
      const sql = yield* SqlClient.SqlClient
      const before = yield* sql<{ cnt: number }>`SELECT count(*) as cnt FROM _migrations`

      yield* migrator.migrate([{ name: "base", schema }])
      const after = yield* sql<{ cnt: number }>`SELECT count(*) as cnt FROM _migrations`

      expect(after[0].cnt).toBe(before[0].cnt)
    }).pipe(Effect.provide(testLayer)))

  it.effect("plan returns steps without executing", () =>
    Effect.gen(function* () {
      const migrator = yield* Migrator
      const schema: CollectionSchema = {
        "x-collection-kind": "base",
        type: "object",
        properties: {
          seqId: { type: "integer", "x-kind": "seqId", "x-system": true },
          title: { type: "string" }
        },
        required: ["title"]
      }

      const plan = yield* migrator.plan([{ name: "base", schema }])
      expect(plan.steps.length).toBeGreaterThan(0)
      expect(plan.steps[0].kind).toBe("createTable")

      const sql = yield* SqlClient.SqlClient
      const tables = yield* sql`SELECT name FROM sqlite_master WHERE type='table' AND name='base'`
      expect(tables.length).toBe(0)
    }).pipe(Effect.provide(testLayer)))

  it.effect("migrates view collection as SQL VIEW, not table", () =>
    Effect.gen(function* () {
      const migrator = yield* Migrator
      const baseSchema: CollectionSchema = {
        "x-collection-kind": "base",
        type: "object",
        properties: {
          id:    { type: "string",  "x-system": true },
          seqId: { type: "integer", "x-kind": "seqId", "x-system": true },
          title: { type: "string" }
        },
        required: ["id", "title"]
      }
      const viewSchema: CollectionSchema = {
        "x-collection-kind": "view",
        "x-view-query": "SELECT id, seqId, title FROM base",
        type: "object",
        properties: {
          id:    { type: "string",  "x-view-only": true },
          seqId: { type: "integer", "x-view-only": true },
          title: { type: "string",  "x-view-only": true }
        }
      }
      yield* migrator.migrate([
        { name: "base",      schema: baseSchema },
        { name: "base_view", schema: viewSchema }
      ])
      const sql = yield* SqlClient.SqlClient
      const views = yield* sql<{ name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'view' AND name = 'base_view'
      `
      expect(views).toHaveLength(1)
      const tables = yield* sql<{ name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'base_view'
      `
      expect(tables).toHaveLength(0)
    }).pipe(Effect.provide(testLayer)))

  it.effect("re-migrating unchanged view is a no-op", () =>
    Effect.gen(function* () {
      const migrator = yield* Migrator
      const baseSchema: CollectionSchema = {
        "x-collection-kind": "base",
        type: "object",
        properties: {
          id:    { type: "string",  "x-system": true },
          seqId: { type: "integer", "x-kind": "seqId", "x-system": true },
          title: { type: "string" }
        },
        required: ["id", "title"]
      }
      const viewSchema: CollectionSchema = {
        "x-collection-kind": "view",
        "x-view-query": "SELECT id, seqId, title FROM base",
        type: "object",
        properties: {
          id:    { type: "string",  "x-view-only": true },
          seqId: { type: "integer", "x-view-only": true },
          title: { type: "string",  "x-view-only": true }
        }
      }
      yield* migrator.migrate([
        { name: "base",      schema: baseSchema },
        { name: "base_view", schema: viewSchema }
      ])
      const sql = yield* SqlClient.SqlClient
      const before = yield* sql<{ cnt: number }>`SELECT count(*) as cnt FROM _migrations`
      yield* migrator.migrate([
        { name: "base",      schema: baseSchema },
        { name: "base_view", schema: viewSchema }
      ])
      const after = yield* sql<{ cnt: number }>`SELECT count(*) as cnt FROM _migrations`
      expect(after[0].cnt).toBe(before[0].cnt)
    }).pipe(Effect.provide(testLayer)))

  it.effect("changed view query drops and recreates the SQL VIEW", () =>
    Effect.gen(function* () {
      const migrator = yield* Migrator
      const baseSchema: CollectionSchema = {
        "x-collection-kind": "base",
        type: "object",
        properties: {
          id:    { type: "string",  "x-system": true },
          seqId: { type: "integer", "x-kind": "seqId", "x-system": true },
          title: { type: "string" }
        },
        required: ["id", "title"]
      }
      const viewSchema: CollectionSchema = {
        "x-collection-kind": "view",
        "x-view-query": "SELECT id, seqId, title FROM base",
        type: "object",
        properties: {
          id:    { type: "string",  "x-view-only": true },
          seqId: { type: "integer", "x-view-only": true },
          title: { type: "string",  "x-view-only": true }
        }
      }
      yield* migrator.migrate([
        { name: "base",      schema: baseSchema },
        { name: "base_view", schema: viewSchema }
      ])
      const viewV2: CollectionSchema = {
        ...viewSchema,
        "x-view-query": "SELECT id, seqId, title FROM base WHERE title IS NOT NULL"
      }
      yield* migrator.migrate([
        { name: "base",      schema: baseSchema },
        { name: "base_view", schema: viewV2 }
      ])
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql<{ sql: string }>`
        SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'base_view'
      `
      expect(rows).toHaveLength(1)
      expect(rows[0].sql).toContain("WHERE title IS NOT NULL")
    }).pipe(Effect.provide(testLayer)))

  it.effect("handles add column migration", () =>
    Effect.gen(function* () {
      const migrator = yield* Migrator

      const v1: CollectionSchema = {
        "x-collection-kind": "base",
        type: "object",
        properties: {
          seqId: { type: "integer", "x-kind": "seqId", "x-system": true },
          title: { type: "string" }
        },
        required: ["title"]
      }

      const v2: CollectionSchema = {
        "x-collection-kind": "base",
        type: "object",
        properties: {
          seqId: { type: "integer", "x-kind": "seqId", "x-system": true },
          title: { type: "string" },
          published: { type: "boolean", default: false }
        },
        required: ["title"]
      }

      yield* migrator.migrate([{ name: "base", schema: v1 }])
      yield* migrator.migrate([{ name: "base", schema: v2 }])

      const sql = yield* SqlClient.SqlClient
      yield* sql`INSERT INTO base (title, published) VALUES ('test', 1)`
      const rows = yield* sql<{ title: string; published: number }>`SELECT title, published FROM base`
      expect(rows[0].published).toBe(1)
    }).pipe(Effect.provide(testLayer)))

  it.effect("skips dropColumn without allowDestructive", () =>
    Effect.gen(function* () {
      const migrator = yield* Migrator

      const v1: CollectionSchema = {
        "x-collection-kind": "base",
        type: "object",
        properties: {
          seqId: { type: "integer", "x-kind": "seqId", "x-system": true },
          title: { type: "string" },
          obsolete: { type: "string" }
        },
        required: ["title"]
      }

      const v2: CollectionSchema = {
        "x-collection-kind": "base",
        type: "object",
        properties: {
          seqId: { type: "integer", "x-kind": "seqId", "x-system": true },
          title: { type: "string" }
        },
        required: ["title"]
      }

      yield* migrator.migrate([{ name: "base", schema: v1 }])
      yield* migrator.migrate([{ name: "base", schema: v2 }])

      const sql = yield* SqlClient.SqlClient
      const cols = yield* sql<{ name: string }>`PRAGMA table_info(base)`
      expect(cols.map((c) => c.name)).toContain("obsolete")
    }).pipe(Effect.provide(testLayer)))

  it.effect("drops column with allowDestructive: true", () =>
    Effect.gen(function* () {
      const migrator = yield* Migrator

      const v1: CollectionSchema = {
        "x-collection-kind": "base",
        type: "object",
        properties: {
          seqId: { type: "integer", "x-kind": "seqId", "x-system": true },
          title: { type: "string" },
          obsolete: { type: "string" }
        },
        required: ["title"]
      }

      const v2: CollectionSchema = {
        "x-collection-kind": "base",
        type: "object",
        properties: {
          seqId: { type: "integer", "x-kind": "seqId", "x-system": true },
          title: { type: "string" }
        },
        required: ["title"]
      }

      yield* migrator.migrate([{ name: "base", schema: v1 }])
      yield* migrator.migrate([{ name: "base", schema: v2 }], { allowDestructive: true })

      const sql = yield* SqlClient.SqlClient
      const cols = yield* sql<{ name: string }>`PRAGMA table_info(base)`
      const names = cols.map((c) => c.name)
      expect(names).not.toContain("obsolete")
      expect(names).toContain("title")
    }).pipe(Effect.provide(testLayer)))
})

const lockConfig: MigrationLock = {
  databaseNameSql: "SELECT DATABASE() AS database_name",
  namePrefix: "mira.migrations",
  maxNameLength: 64,
  defaultTimeoutSeconds: 60,
  acquireStatement: (name, timeoutSeconds) => ({
    sql: "GET_LOCK",
    params: [name, timeoutSeconds]
  }),
  releaseStatement: (name) => ({ sql: "RELEASE_LOCK", params: [name] }),
  usedStatement: (name) => ({ sql: "IS_USED_LOCK", params: [name] }),
  holderStatement: (name) => ({ sql: "HOLDER", params: [name] }),
  killSelfStatement: { sql: "KILL", params: [] }
}

type StubHandlers = {
  readonly query?: (sql: string) => Effect.Effect<ReadonlyArray<Record<string, unknown>>, SqlError.SqlError>
  readonly queryParameterized?: (
    statement: ParameterizedStatement
  ) => Effect.Effect<ReadonlyArray<Record<string, unknown>>, SqlError.SqlError>
}

const stubExecutor = (handlers: StubHandlers): MigrationExecutor => ({
  run: () => Effect.void,
  runParameterized: () => Effect.void,
  query: (sql) =>
    handlers.query?.(sql) ?? Effect.succeed<ReadonlyArray<Record<string, unknown>>>([]),
  queryParameterized: (statement) =>
    handlers.queryParameterized?.(statement) ??
    Effect.succeed<ReadonlyArray<Record<string, unknown>>>([])
})

const sqlFailure = new SqlError.SqlError({
  reason: new SqlError.UnknownError({ cause: undefined, message: "boom" })
})

describe("migration lock helpers", () => {
  it("carries the lock error fields", () => {
    const lockError = new MigrationLockError({ detail: "missing database" })
    expect(lockError._tag).toBe("MigrationLockError")
    expect(lockError.detail).toBe("missing database")

    const releaseError = new MigrationLockReleaseError({
      lockName: "mira.migrations:abc",
      killed: true,
      destroyed: false,
      cause: "release could not be verified"
    })
    expect(releaseError._tag).toBe("MigrationLockReleaseError")
    expect(releaseError.lockName).toBe("mira.migrations:abc")
    expect(releaseError.killed).toBe(true)
    expect(releaseError.destroyed).toBe(false)
  })

  it.effect("reads a database name and rejects NULL or empty", () =>
    Effect.gen(function* () {
      const ok = stubExecutor({ query: () => Effect.succeed([{ database_name: "mira_test" }]) })
      expect(yield* readDatabaseName(ok, lockConfig)).toBe("mira_test")

      const missing = stubExecutor({ query: () => Effect.succeed([{ database_name: null }]) })
      const missingExit = yield* Effect.exit(readDatabaseName(missing, lockConfig))
      expect(missingExit._tag).toBe("Failure")

      const empty = stubExecutor({ query: () => Effect.succeed([{ database_name: "   " }]) })
      const emptyError = yield* readDatabaseName(empty, lockConfig).pipe(Effect.flip)
      expect(emptyError._tag).toBe("MigrationLockError")
      expect(emptyError.detail).toBe(
        "No database is selected on the connection; include a database in the URL"
      )
    })
  )

  it.effect("rejects a dedicated lock connection on a different database", () =>
    Effect.gen(function* () {
      const lock = stubExecutor({ query: () => Effect.succeed([{ database_name: "app" }]) })
      const ddl = stubExecutor({ query: () => Effect.succeed([{ database_name: "other" }]) })
      const error = yield* assertSameDatabase(lock, ddl, lockConfig).pipe(Effect.flip)
      expect(error._tag).toBe("MigrationLockError")
      expect(error.detail).toContain("targets database 'app'")
      expect(error.detail).toContain("targets 'other'")
    })
  )

  it.effect("acquires on 1 and reports busy with the holder id on 0", () =>
    Effect.gen(function* () {
      const acquired = stubExecutor({
        queryParameterized: (statement) =>
          statement.sql === "GET_LOCK"
            ? Effect.succeed([{ acquired: 1 }])
            : Effect.succeed([])
      })
      yield* acquireSessionLock(acquired, lockConfig, "mira.migrations:abc", 0, "plan")

      const busy = stubExecutor({
        queryParameterized: (statement) => {
          if (statement.sql === "GET_LOCK") return Effect.succeed([{ acquired: 0 }])
          if (statement.sql === "HOLDER") return Effect.succeed([{ holder: 42 }])
          return Effect.succeed([])
        }
      })
      const error = yield* acquireSessionLock(
        busy,
        lockConfig,
        "mira.migrations:abc",
        1,
        "migrate"
      ).pipe(Effect.flip)
      expect(error._tag).toBe("MigrationBusyError")
      if (error._tag !== "MigrationBusyError") return
      expect(error.operation).toBe("migrate")
      expect(error.message).toContain("mira.migrations:abc")
      expect(error.message).toContain("within 1s")
      expect(error.message).toContain("holder 42")
    })
  )

  it.effect("surfaces an unexpected acquire value as a lock error", () =>
    Effect.gen(function* () {
      const executor = stubExecutor({
        queryParameterized: (statement) =>
          statement.sql === "GET_LOCK" ? Effect.succeed([{ acquired: null }]) : Effect.succeed([])
      })
      const error = yield* acquireSessionLock(
        executor,
        lockConfig,
        "mira.migrations:abc",
        0,
        "plan"
      ).pipe(Effect.flip)
      expect(error._tag).toBe("MigrationLockError")
      if (error._tag !== "MigrationLockError") return
      expect(error.detail).toContain("unexpected result")
      expect(error.detail).toContain("null")
    })
  )

  it.effect("wraps an acquire SQL error with an engine-support hint", () =>
    Effect.gen(function* () {
      const executor = stubExecutor({
        queryParameterized: (statement) =>
          statement.sql === "GET_LOCK" ? Effect.fail(sqlFailure) : Effect.succeed([])
      })
      const error = yield* acquireSessionLock(
        executor,
        lockConfig,
        "mira.migrations:abc",
        0,
        "plan"
      ).pipe(Effect.flip)
      expect(error._tag).toBe("MigrationLockError")
      if (error._tag !== "MigrationLockError") return
      expect(error.detail).toContain("could not be acquired")
      expect(error.detail).toContain("GET_LOCK")
    })
  )

  it.effect("verifies a release and kills the holder when the name is still held", () =>
    Effect.gen(function* () {
      const released = stubExecutor({
        queryParameterized: (statement) => {
          if (statement.sql === "RELEASE_LOCK") return Effect.succeed([{ released: 1 }])
          if (statement.sql === "IS_USED_LOCK") return Effect.succeed([{ held_by_me: 0 }])
          return Effect.succeed([])
        }
      })
      expect(yield* releaseSessionLock(released, lockConfig, "mira.migrations:abc")).toEqual({
        released: true,
        killed: false
      })

      const held = stubExecutor({
        queryParameterized: (statement) => {
          if (statement.sql === "RELEASE_LOCK") return Effect.succeed([{ released: 0 }])
          if (statement.sql === "IS_USED_LOCK") return Effect.succeed([{ held_by_me: 1 }])
          if (statement.sql === "KILL") return Effect.succeed([])
          return Effect.succeed([])
        }
      })
      expect(yield* releaseSessionLock(held, lockConfig, "mira.migrations:abc")).toEqual({
        released: false,
        killed: true
      })
    })
  )

  it.effect("treats a connection-loss release error as released", () =>
    Effect.gen(function* () {
      const lost = stubExecutor({
        queryParameterized: (statement) =>
          statement.sql === "RELEASE_LOCK"
            ? Effect.fail(
                new SqlError.SqlError({
                  reason: new SqlError.UnknownError({
                    cause: undefined,
                    message: "PROTOCOL_CONNECTION_LOST"
                  })
                })
              )
            : Effect.succeed([])
      })
      expect(yield* releaseSessionLock(lost, lockConfig, "mira.migrations:abc")).toEqual({
        released: true,
        killed: false
      })
    })
  )
})
