import { SqliteClient } from "@effect/sql-sqlite-node"
import { describe, it } from "@effect/vitest"
import type { CollectionSchema } from "@gettersethya/mira-client"
import { Rule } from "@gettersethya/mira-client"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { expect } from "vitest"

import { sqliteDialect } from "@/dialect/dialect-sqlite.js"
import { postgresRuleSql } from "@/dialect/dialect-postgres.js"
import type { RuleSqlDialect } from "@/dialect/dialect.js"
import type { CompileCtx } from "@/rule/compiler.js"
import { compileOperand as compileOperandRaw } from "@/rule/compiler.js"
import { enforcerForAction as enforcerForActionRaw, enforceRule as enforceRuleRaw } from "@/rule/enforcer.js"

const legacyDialect: RuleSqlDialect = {
  ...sqliteDialect,
  quoteIdentifier: (name) => name
}

const enforceRule = (rule: Parameters<typeof enforceRuleRaw>[0]) =>
  enforceRuleRaw(rule, legacyDialect)

const enforcerForAction = (
  schema: Parameters<typeof enforcerForActionRaw>[0],
  action: Parameters<typeof enforcerForActionRaw>[1]
) => enforcerForActionRaw(schema, action, legacyDialect)

function requireValue<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected a present value")
  return value
}

function enforcerOrThrow(
  schema: Parameters<typeof enforcerForAction>[0],
  action: Parameters<typeof enforcerForAction>[1]
) {
  const enforcer = enforcerForAction(schema, action)
  if (enforcer === null) throw new Error(`Expected an enforcer for action "${action}"`)
  return enforcer
}

describe("Rule enforcer integration", () => {
  const testLayer = SqliteClient.layer({ filename: ":memory:" })

  it.effect("list rule filters rows correctly", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      yield* sql.unsafe(`CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        title TEXT,
        owner_id TEXT,
        is_public INTEGER DEFAULT 0,
        status TEXT DEFAULT 'active'
      )`)

      yield* sql.unsafe(`INSERT INTO projects (id, title, owner_id, is_public, status) VALUES
        ('p1', 'Public Project',  'user1', 1, 'active'),
        ('p2', 'Private Project', 'user1', 0, 'active'),
        ('p3', 'Archived Public', 'user2', 1, 'archived'),
        ('p4', 'Other Private',   'user2', 0, 'active')`)

      const rule = Rule.or(
        Rule.field("is_public").eq(Rule.literal(1)),
        Rule.field("owner_id").eq(Rule.literal("user1"))
      )
      const { params, sql: compiledSql } = enforceRule(rule)

      const rows = yield* sql.unsafe<{ id: string }>(`SELECT id, title FROM projects t WHERE ${compiledSql}`, params)

      expect(rows.length).toBe(3)
      expect(rows.map((r) => r.id)).toEqual(expect.arrayContaining(["p1", "p2", "p3"]))
      expect(rows.map((r) => r.id)).not.toContain("p4")
    }).pipe(Effect.provide(testLayer)))

  it.effect("complex boolean rule filters correctly", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      yield* sql.unsafe(`CREATE TABLE articles (
        id TEXT PRIMARY KEY,
        title TEXT,
        author_id TEXT,
        published INTEGER DEFAULT 0,
        status TEXT DEFAULT 'draft',
        score INTEGER DEFAULT 0
      )`)

      yield* sql.unsafe(`INSERT INTO articles (id, title, author_id, published, status, score) VALUES
        ('a1', 'Published High',  'user1', 1, 'published', 90),
        ('a2', 'Published Low',   'user2', 1, 'published', 10),
        ('a3', 'Draft High',     'user1', 0, 'draft',     85),
        ('a4', 'Archived High',  'user2', 1, 'archived',  95),
        ('a5', 'Draft Low',      'user2', 0, 'draft',     20)`)

      const rule = Rule.and(
        Rule.or(Rule.field("published").eq(Rule.literal(1)), Rule.field("author_id").eq(Rule.literal("user1"))),
        Rule.field("score").gte(Rule.literal(50)),
        Rule.field("status").neq(Rule.literal("archived"))
      )
      const { params, sql: compiledSql } = enforceRule(rule)

      const rows = yield* sql.unsafe<{ id: string }>(`SELECT id, title FROM articles t WHERE ${compiledSql} ORDER BY id`, params)

      expect(rows.map((r) => r.id)).toEqual(["a1", "a3"])
    }).pipe(Effect.provide(testLayer)))

  it.effect("date-based rule filters correctly", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      yield* sql.unsafe(`CREATE TABLE events (
        id TEXT PRIMARY KEY,
        title TEXT,
        event_date TEXT,
        owner_id TEXT
      )`)

      yield* sql.unsafe(`INSERT INTO events (id, title, event_date, owner_id) VALUES
        ('e1', 'Past Event',   '2023-01-01', 'user1'),
        ('e2', 'Future Event', '2026-06-15', 'user1'),
        ('e3', 'Other Past',   '2023-03-01', 'user2')`)

      const rule = Rule.and(
        Rule.field("event_date").gte(Rule.literal("2024-01-01")),
        Rule.field("owner_id").eq(Rule.literal("user1"))
      )
      const { params, sql: compiledSql } = enforceRule(rule)

      const rows = yield* sql.unsafe<{ id: string }>(`SELECT id, title FROM events t WHERE ${compiledSql} ORDER BY id`, params)

      expect(rows.map((r) => r.id)).toEqual(["e2"])
    }).pipe(Effect.provide(testLayer)))

  it.effect("rule with gt/lt range filters correctly", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      yield* sql.unsafe(`CREATE TABLE products (
        id TEXT PRIMARY KEY,
        name TEXT,
        price REAL,
        stock INTEGER
      )`)

      yield* sql.unsafe(`INSERT INTO products (id, name, price, stock) VALUES
        ('pr1', 'Cheap',     5.99,   100),
        ('pr2', 'Mid Range', 25.00,   50),
        ('pr3', 'Expensive', 100.00,  10),
        ('pr4', 'Overstock', 15.00,  500)`)

      const rule = Rule.and(
        Rule.field("price").gte(Rule.literal(10)),
        Rule.field("price").lte(Rule.literal(50)),
        Rule.field("stock").lt(Rule.literal(200))
      )
      const { params, sql: compiledSql } = enforceRule(rule)

      const rows = yield* sql.unsafe<{ id: string }>(`SELECT id, name FROM products t WHERE ${compiledSql} ORDER BY id`, params)

      expect(rows.map((r) => r.id)).toEqual(["pr2"])
    }).pipe(Effect.provide(testLayer)))

  it.effect("rule with in and startsWith", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      yield* sql.unsafe(`CREATE TABLE files (
        id TEXT PRIMARY KEY,
        name TEXT,
        category TEXT,
        size INTEGER
      )`)

      yield* sql.unsafe(`INSERT INTO files (id, name, category, size) VALUES
        ('f1', 'report.pdf',  'doc',    1000),
        ('f2', 'image.png',   'media',  5000),
        ('f3', 'video.mp4',   'media', 50000),
        ('f4', 'notes.txt',   'doc',    500),
        ('f5', 'archive.zip', 'backup', 2000)`)

      const rule = Rule.and(
        Rule.field("category").in(Rule.literal(["doc", "media"])),
        Rule.field("name").startsWith(Rule.literal("r"))
      )
      const { params, sql: compiledSql } = enforceRule(rule)

      const rows = yield* sql.unsafe<{ id: string }>(`SELECT id, name FROM files t WHERE ${compiledSql} ORDER BY id`, params)

      expect(rows.map((r) => r.id)).toEqual(["f1"])
    }).pipe(Effect.provide(testLayer)))

  it.effect("rule with contains and neq", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      yield* sql.unsafe(`CREATE TABLE comments (
        id TEXT PRIMARY KEY,
        body TEXT,
        author_id TEXT,
        moderated INTEGER DEFAULT 0
      )`)

      yield* sql.unsafe(`INSERT INTO comments (id, body, author_id, moderated) VALUES
        ('c1', 'Great post!',    'user1',   0),
        ('c2', 'Spam message',   'spammer', 1),
        ('c3', 'Nice work',      'user2',   0),
        ('c4', 'Check this out', 'user1',   0)`)

      const rule = Rule.and(
        Rule.field("body").contains(Rule.literal("post")),
        Rule.field("moderated").eq(Rule.literal(0))
      )
      const { params, sql: compiledSql } = enforceRule(rule)

      const rows = yield* sql.unsafe<{ id: string }>(`SELECT id, body FROM comments t WHERE ${compiledSql} ORDER BY id`, params)

      expect(rows.map((r) => r.id)).toEqual(["c1"])
    }).pipe(Effect.provide(testLayer)))
})

describe("enforcerForAction", () => {
  it("returns null when no x-rules", () => {
    const schema: CollectionSchema = {
      "x-collection-kind": "base",
      type: "object",
      properties: {}
    }
    expect(enforcerForAction(schema, "list")).toBeNull()
  })

  it("returns null when action has no rule", () => {
    const schema: CollectionSchema = {
      "x-collection-kind": "base",
      type: "object",
      properties: {},
      "x-rules": {
        list: { op: "public" }
      }
    }
    expect(enforcerForAction(schema, "view")).toBeNull()
    expect(enforcerForAction(schema, "list")).not.toBeNull()
  })

  it("returns rule SQL for each action", () => {
    const schema: CollectionSchema = {
      "x-collection-kind": "base",
      type: "object",
      properties: {},
      "x-rules": {
        list: Rule.public(),
        view: Rule.field("ownerId").eq(Rule.literal("user1")),
        create: Rule.field("ownerId").eq(Rule.literal("user1")),
        update: Rule.not(Rule.field("status").eq(Rule.literal("archived"))),
        delete: Rule.field("ownerId").eq(Rule.literal("user1"))
      }
    }
    expect(enforcerOrThrow(schema, "list").sql).toBe("1 = 1")
    expect(enforcerOrThrow(schema, "view").sql).toBe("t.ownerId = ?")
    expect(enforcerOrThrow(schema, "create").sql).toBe("t.ownerId = ?")
    expect(enforcerOrThrow(schema, "update").sql).toBe("NOT (t.status = ?)")
    expect(enforcerOrThrow(schema, "delete").sql).toBe("t.ownerId = ?")
  })

  it("maps seqId to a bigint value type and integer columns to integer", () => {
    const schema: CollectionSchema = {
      "x-collection-kind": "base",
      type: "object",
      properties: {
        seqId: { type: "integer", "x-kind": "seqId" },
        count: { type: "integer" }
      },
      "x-rules": {
        list: Rule.and(
          Rule.field("seqId").gt(Rule.literal("9007199254740993")),
          Rule.field("count").gte(Rule.literal("5"))
        )
      }
    }
    const result = requireValue(enforcerForActionRaw(schema, "list", postgresRuleSql))
    expect(result.sql).toBe('(t."seqId" > ?::bigint) AND (t."count" >= ?::integer)')
    expect(result.params).toEqual(["9007199254740993", "5"])
  })

  it("params are extracted as array", () => {
    const schema: CollectionSchema = {
      "x-collection-kind": "base",
      type: "object",
      properties: {},
      "x-rules": {
        list: Rule.field("a").eq(Rule.literal("x"))
      }
    }
    const result = enforcerOrThrow(schema, "list")
    expect(result.params).toEqual(["x"])
  })

  it("params maintain order with multiple literals", () => {
    const schema: CollectionSchema = {
      "x-collection-kind": "base",
      type: "object",
      properties: {},
      "x-rules": {
        list: Rule.and(
          Rule.and(Rule.field("a").eq(Rule.literal(1)), Rule.field("b").eq(Rule.literal("hello"))),
          Rule.field("c").eq(Rule.literal(true))
        )
      }
    }
    const result = enforcerOrThrow(schema, "list")
    expect(result.params).toEqual([1, "hello", true])
  })

  it("memoizes per schema and action: same schema/action returns the same object", () => {
    const schema: CollectionSchema = {
      "x-collection-kind": "base",
      type: "object",
      properties: {},
      "x-rules": {
        list: Rule.public(),
        view: Rule.field("ownerId").eq(Rule.literal("user1"))
      }
    }

    const first = enforcerForAction(schema, "list")
    const second = enforcerForAction(schema, "list")
    expect(second).toBe(first)
    expect(first?.sql).toBe("1 = 1")

    // Different action on the same schema is a different cached entry.
    expect(enforcerForAction(schema, "view")).not.toBe(first)
    expect(enforcerForAction(schema, "view")).toBe(enforcerForAction(schema, "view"))
  })

  it("memoizes the absent-rule (null) result too", () => {
    const schema: CollectionSchema = {
      "x-collection-kind": "base",
      type: "object",
      properties: {},
      "x-rules": { list: Rule.public() }
    }
    expect(enforcerForAction(schema, "view")).toBeNull()
    expect(enforcerForAction(schema, "view")).toBeNull()
  })

  it("does not share cache entries across distinct schema objects", () => {
    const rules = { list: Rule.public() }
    const a: CollectionSchema = {
      "x-collection-kind": "base",
      type: "object",
      properties: {},
      "x-rules": rules
    }
    const b: CollectionSchema = {
      "x-collection-kind": "base",
      type: "object",
      properties: {},
      "x-rules": rules
    }

    const first = enforcerForAction(a, "list")
    const second = enforcerForAction(b, "list")
    expect(second).not.toBe(first)
    expect(second).toEqual(first)
  })
})

describe("enforcer dialect cache and date units", () => {
  const schema: CollectionSchema = {
    "x-collection-kind": "base",
    type: "object",
    properties: {
      name: { type: "string" },
      created: { type: "string" }
    },
    "x-rules": {
      list: Rule.and(
        Rule.field("name").startsWith(Rule.literal("a")),
        Rule.field("created").gte(Rule.dateAdd(Rule.now(), -7, "day"))
      )
    }
  }

  it("caches per dialect and produces dialect-specific SQL", () => {
    const sqlite = enforcerForActionRaw(schema, "list", sqliteDialect)
    const pg = enforcerForActionRaw(schema, "list", postgresRuleSql)
    expect(sqlite).not.toBeNull()
    expect(pg).not.toBeNull()
    expect(sqlite).not.toBe(pg)
    expect(requireValue(sqlite).sql).not.toBe(requireValue(pg).sql)
    expect(requireValue(sqlite).sql).toContain("LIKE")
    expect(requireValue(pg).sql).toContain("ILIKE")
    expect(enforcerForActionRaw(schema, "list", sqliteDialect)).toBe(sqlite)
  })

  it.effect("returns dateDiff in day, hour, and minute units", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql.unsafe(`CREATE TABLE events (id TEXT, start TEXT, finish TEXT)`)
      yield* sql.unsafe(
        `INSERT INTO events VALUES ('e1', '2026-01-01T00:00:00.000Z', '2026-01-02T06:00:00.000Z')`
      )

      const ctx: CompileCtx = {
        tableAlias: "t",
        nextParam: () => "@p0",
        params: {},
        columnOfField: (field) => field,
        collectionSchemas: {}
      }
      const run = (unit: "day" | "hour" | "minute") => {
        const expression = compileOperandRaw(
          Rule.dateDiff(Rule.field("finish"), Rule.field("start"), unit),
          ctx,
          sqliteDialect
        )
        return sql
          .unsafe<{ value: number }>(`SELECT ${expression} AS value FROM events t`)
          .pipe(Effect.map((rows) => requireValue(rows[0]).value))
      }

      expect(yield* run("day")).toBe(1.25)
      expect(yield* run("hour")).toBe(30)
      expect(yield* run("minute")).toBe(1800)
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))))
})
