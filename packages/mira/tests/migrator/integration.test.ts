import { SqlClient } from "@effect/sql"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Effect, Layer } from "effect"
import { describe, it } from "@effect/vitest"
import { expect } from "vitest"
import { AuthCollection } from "@gettersethya/mira-client"
import { BaseCollection } from "@gettersethya/mira-client"
import { Field } from "@gettersethya/mira-client"
import { ViewCollection } from "@gettersethya/mira-client"
import { schemaToColumns } from "@/migrator/schema-diff.js"
import { sqliteDialect } from "@/migrator/dialect-sqlite.js"
import { Dialect } from "@/migrator/dialect.js"
import { Migrator, MigratorLive } from "@/migrator/migrator.js"

const Users = AuthCollection.define("users", {
  displayName: Field.text()
})

const Posts = BaseCollection.define("posts", {
  title:     Field.text({ maxLength: 200 }),
  body:      Field.text({ required: false }),
  published: Field.boolean({ default: false }),
  authorId:  Field.relation(Users)
})

const PublishedPosts = ViewCollection.define(
  "published_posts",
  `SELECT
     p.id,
     CAST(ROW_NUMBER() OVER (ORDER BY p.seqId) AS INTEGER) AS seqId,
     p.title,
     u.displayName AS author
   FROM posts p
   JOIN users u ON u.id = p.authorId
   WHERE p.published = 1`,
  {
    id:     Field.text().view(),
    seqId:  Field.integer().view(),
    title:  Field.text().view(),
    author: Field.text().view()
  }
)

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

describe("integration: .view() with :memory: SQLite", () => {

  describe("base collection — posts", () => {
    it.effect("migrator creates correct physical columns", () =>
      Effect.gen(function* () {
        const migrator = yield* Migrator
        yield* migrator.migrate([{ name: "posts", schema: Posts.schema }])

        const sql = yield* SqlClient.SqlClient
        const cols = yield* sql<{ name: string }>`PRAGMA table_info(posts)`
        const names = cols.map((c) => c.name)

        expect(names).toContain("id")
        expect(names).toContain("seqId")
        expect(names).toContain("created")
        expect(names).toContain("updated")
        expect(names).toContain("title")
        expect(names).toContain("body")
        expect(names).toContain("published")
        expect(names).toContain("authorId")
      }).pipe(Effect.provide(testLayer)))

    it.effect("inserted row round-trips with correct types", () =>
      Effect.gen(function* () {
        const migrator = yield* Migrator
        yield* migrator.migrate([{ name: "posts", schema: Posts.schema }])

        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO ${sql("posts")} ${sql.insert({
          id: "p1",
          title: "Hello World",
          body: null,
          published: 1,
          authorId: "u1",
          created: "2026-01-01",
          updated: "2026-01-01"
        })}`
        const rows = yield* sql<{
          id: string; seqId: number; title: string; published: number
        }>`SELECT id, seqId, title, published FROM posts`

        expect(rows).toHaveLength(1)
        expect(rows[0].id).toBe("p1")
        expect(typeof rows[0].seqId).toBe("number")
        expect(rows[0].title).toBe("Hello World")
        expect(rows[0].published).toBe(1)
      }).pipe(Effect.provide(testLayer)))
  })

  describe("auth collection — users", () => {
    it.effect("migrator creates system + extra field columns", () =>
      Effect.gen(function* () {
        const migrator = yield* Migrator
        yield* migrator.migrate([{ name: "users", schema: Users.schema }])

        const sql = yield* SqlClient.SqlClient
        const cols = yield* sql<{ name: string }>`PRAGMA table_info(users)`
        const names = cols.map((c) => c.name)

        expect(names).toContain("id")
        expect(names).toContain("seqId")
        expect(names).toContain("email")
        expect(names).toContain("password")
        expect(names).toContain("emailVerified")
        expect(names).toContain("created")
        expect(names).toContain("updated")
        expect(names).toContain("displayName")
      }).pipe(Effect.provide(testLayer)))

    it.effect("system email unique index is created", () =>
      Effect.gen(function* () {
        const migrator = yield* Migrator
        yield* migrator.migrate([{ name: "users", schema: Users.schema }])

        const sql = yield* SqlClient.SqlClient
        const indexes = yield* sql<{ name: string }>`PRAGMA index_list(users)`
        expect(indexes.some((i) => i.name.includes("email"))).toBe(true)
      }).pipe(Effect.provide(testLayer)))

    it.effect("inserted user round-trips with correct field values", () =>
      Effect.gen(function* () {
        const migrator = yield* Migrator
        yield* migrator.migrate([{ name: "users", schema: Users.schema }])

        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO ${sql("users")} ${sql.insert({
          id: "u1",
          email: "alice@example.com",
          password: "hash",
          emailVerified: 0,
          displayName: "Alice",
          created: "2026-01-01",
          updated: "2026-01-01"
        })}`
        const rows = yield* sql<{
          id: string; email: string; emailVerified: number; displayName: string
        }>`SELECT id, email, emailVerified, displayName FROM users`

        expect(rows).toHaveLength(1)
        expect(rows[0].id).toBe("u1")
        expect(rows[0].email).toBe("alice@example.com")
        expect(rows[0].emailVerified).toBe(0)
        expect(rows[0].displayName).toBe("Alice")
      }).pipe(Effect.provide(testLayer)))
  })

  describe("view collection — published_posts", () => {
    it("schemaToColumns returns empty — all fields are x-view-only, no DDL generated", () => {
      const columns = schemaToColumns(PublishedPosts.schema)
      expect(columns).toEqual([])
    })

    it("every schema property carries x-view-only: true", () => {
      for (const prop of Object.values(PublishedPosts.schema.properties)) {
        expect(prop["x-view-only"]).toBe(true)
      }
    })

    it("system id/seqId are absent — only the 4 declared fields appear", () => {
      expect(Object.keys(PublishedPosts.schema.properties)).toEqual(["id", "seqId", "title", "author"])
    })

    it.effect("SQL VIEW with JOIN + window function returns rows matching the field map", () =>
      Effect.gen(function* () {
        const migrator = yield* Migrator
        yield* migrator.migrate([
          { name: "users", schema: Users.schema },
          { name: "posts", schema: Posts.schema }
        ])

        const sql = yield* SqlClient.SqlClient

        yield* sql`INSERT INTO ${sql("users")} ${sql.insert({
          id: "u1",
          email: "alice@example.com",
          password: "hash",
          emailVerified: 0,
          displayName: "Alice",
          created: "2026-01-01",
          updated: "2026-01-01"
        })}`
        yield* sql`INSERT INTO ${sql("posts")} ${sql.insert({
          id: "p1",
          title: "Hello World",
          body: null,
          published: 1,
          authorId: "u1",
          created: "2026-01-01",
          updated: "2026-01-01"
        })}`
        yield* sql`INSERT INTO ${sql("posts")} ${sql.insert({
          id: "p2",
          title: "Draft Post",
          body: null,
          published: 0,
          authorId: "u1",
          created: "2026-01-01",
          updated: "2026-01-01"
        })}`

        const viewQuery = PublishedPosts.schema["x-view-query"]!
        yield* sql.unsafe(`CREATE VIEW published_posts AS ${viewQuery}`)

        const rows = yield* sql<{
          id: string; seqId: number; title: string; author: string
        }>`SELECT * FROM published_posts`

        expect(rows).toHaveLength(1)
        expect(rows[0].id).toBe("p1")
        expect(rows[0].title).toBe("Hello World")
        expect(rows[0].author).toBe("Alice")
        expect(typeof rows[0].seqId).toBe("number")

        expect(Object.keys(rows[0]).sort()).toEqual(
          Object.keys(PublishedPosts.fields).sort()
        )
      }).pipe(Effect.provide(testLayer)))
  })
})
