import { SqlClient } from "@effect/sql"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Effect, Layer, Schema } from "effect"
import { describe, it } from "@effect/vitest"
import { expect } from "vitest"
import type { CollectionSchema } from "@gettersethya/mira-client"
import { sqliteDialect } from "@/dialect/dialect-sqlite.js"
import { Dialect } from "@/dialect/dialect.js"
import { Migrator, MigratorLive } from "@/migrator/migrator.js"

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
      const parsed = yield* Schema.decodeUnknown(Schema.parseJson())(rows[0].schema).pipe(
        Effect.map((v) => v as CollectionSchema)
      )
      expect(parsed.properties.title).toEqual({ type: "string" })
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
})
