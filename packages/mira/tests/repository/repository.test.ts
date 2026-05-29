import { SqlClient } from "@effect/sql"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Effect, Layer, Option } from "effect"
import { describe, it } from "@effect/vitest"
import { expect } from "vitest"
import { Repository, RepositoryLive } from "@/repository/repository.js"
import { NodeCryptoLayer } from "@/crypto/node.js"

const sqliteLayer = SqliteClient.layer({ filename: ":memory:" })
const testLayer = Layer.mergeAll(RepositoryLive.pipe(Layer.provide(sqliteLayer), Layer.provide(NodeCryptoLayer)), sqliteLayer, NodeCryptoLayer)

const setupTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "posts" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "title" TEXT NOT NULL,
      "published" INTEGER NOT NULL DEFAULT 0,
      "authorId" TEXT,
      "created" TEXT NOT NULL,
      "updated" TEXT NOT NULL
    )
  `)
})

describe("repository", () => {
  describe("create", () => {
    it.effect("inserts a row and returns record with id, created, updated injected", () =>
      Effect.gen(function* () {
        yield* setupTable
        const repo = yield* Repository
        const result = yield* repo.create("posts", { title: "Hello", published: 0 })

        expect(result.title).toBe("Hello")
        expect(result.published).toBe(0)
        expect(typeof result.id).toBe("string")
        expect(typeof result.created).toBe("string")
        expect(typeof result.updated).toBe("string")
      }).pipe(Effect.provide(testLayer)))

    it.effect("returned id is 15 characters", () =>
      Effect.gen(function* () {
        yield* setupTable
        const repo = yield* Repository
        const result = yield* repo.create("posts", { title: "Hi" })
        expect((result.id as string).length).toBe(15)
      }).pipe(Effect.provide(testLayer)))

    it.effect("created and updated are valid ISO date strings", () =>
      Effect.gen(function* () {
        yield* setupTable
        const repo = yield* Repository
        const result = yield* repo.create("posts", { title: "Hi" })
        expect(new Date(result.created as string).toISOString()).toBe(result.created)
        expect(new Date(result.updated as string).toISOString()).toBe(result.updated)
      }).pipe(Effect.provide(testLayer)))
  })

  describe("view", () => {
    it.effect("returns Option.some for an existing id", () =>
      Effect.gen(function* () {
        yield* setupTable
        const repo = yield* Repository
        const created = yield* repo.create("posts", { title: "Test" })
        const result = yield* repo.view("posts", created.id as string)
        expect(Option.isSome(result)).toBe(true)
      }).pipe(Effect.provide(testLayer)))

    it.effect("returns Option.none for an unknown id", () =>
      Effect.gen(function* () {
        yield* setupTable
        const repo = yield* Repository
        const result = yield* repo.view("posts", "nonexistent123")
        expect(Option.isNone(result)).toBe(true)
      }).pipe(Effect.provide(testLayer)))

    it.effect("returned record matches what was created", () =>
      Effect.gen(function* () {
        yield* setupTable
        const repo = yield* Repository
        const created = yield* repo.create("posts", { title: "Match me" })
        const result = yield* repo.view("posts", created.id as string)
        const row = Option.getOrThrow(result)
        expect(row.id).toBe(created.id)
        expect(row.title).toBe("Match me")
        expect(row.created).toBe(created.created)
      }).pipe(Effect.provide(testLayer)))
  })

  describe("update", () => {
    it.effect("returns Option.some with updated record for an existing id", () =>
      Effect.gen(function* () {
        yield* setupTable
        const repo = yield* Repository
        const created = yield* repo.create("posts", { title: "Old" })
        const result = yield* repo.update("posts", created.id as string, { title: "New" })
        expect(Option.isSome(result)).toBe(true)
        expect(Option.getOrThrow(result).title).toBe("New")
      }).pipe(Effect.provide(testLayer)))

    it.effect("only supplied fields are changed; unsupplied fields are unchanged", () =>
      Effect.gen(function* () {
        yield* setupTable
        const repo = yield* Repository
        const created = yield* repo.create("posts", { title: "Keep", authorId: "user1" })
        yield* repo.update("posts", created.id as string, { title: "Changed" })
        const result = yield* repo.view("posts", created.id as string)
        const row = Option.getOrThrow(result)
        expect(row.title).toBe("Changed")
        expect(row.authorId).toBe("user1")
      }).pipe(Effect.provide(testLayer)))

    it.live("updated timestamp is refreshed; created is unchanged", () =>
      Effect.gen(function* () {
        yield* setupTable
        const repo = yield* Repository
        const created = yield* repo.create("posts", { title: "Time" })

        yield* Effect.sleep(5)

        const result = yield* repo.update("posts", created.id as string, { title: "Time2" })
        const row = Option.getOrThrow(result)
        expect(row.created).toBe(created.created)
        expect(row.updated).not.toBe(created.updated)
      }).pipe(Effect.provide(testLayer)))

    it.effect("returns Option.none for an unknown id", () =>
      Effect.gen(function* () {
        yield* setupTable
        const repo = yield* Repository
        const result = yield* repo.update("posts", "nosuchid123456", { title: "X" })
        expect(Option.isNone(result)).toBe(true)
      }).pipe(Effect.provide(testLayer)))

    it.effect("id and created in patch data are stripped (not overwritten)", () =>
      Effect.gen(function* () {
        yield* setupTable
        const repo = yield* Repository
        const created = yield* repo.create("posts", { title: "Guard" })
        const result = yield* repo.update("posts", created.id as string, {
          title: "Guard2",
          id: "fakeid1234567",
          created: "1970-01-01T00:00:00.000Z"
        })
        const row = Option.getOrThrow(result)
        expect(row.id).toBe(created.id)
        expect(row.created).toBe(created.created)
      }).pipe(Effect.provide(testLayer)))
  })

  describe("viewFilter", () => {
    it.effect("returns only rows matching the WHERE clause", () =>
      Effect.gen(function* () {
        yield* setupTable
        const repo = yield* Repository
        yield* repo.create("posts", { title: "A", published: 1 })
        yield* repo.create("posts", { title: "B", published: 0 })
        yield* repo.create("posts", { title: "C", published: 1 })

        const result = yield* repo.viewFilter("posts", {
          where: { sql: "t.published = ?", params: [1] }
        })
        expect(result.length).toBe(2)
        expect(result.every((r) => r.published === 1)).toBe(true)
      }).pipe(Effect.provide(testLayer)))

    it.effect("returns empty array when no rows match", () =>
      Effect.gen(function* () {
        yield* setupTable
        const repo = yield* Repository
        yield* repo.create("posts", { title: "A", published: 0 })

        const result = yield* repo.viewFilter("posts", {
          where: { sql: "t.published = ?", params: [1] }
        })
        expect(result.length).toBe(0)
      }).pipe(Effect.provide(testLayer)))

    it.effect("respects sort order asc", () =>
      Effect.gen(function* () {
        yield* setupTable
        const repo = yield* Repository
        yield* repo.create("posts", { title: "Bravo", published: 1 })
        yield* repo.create("posts", { title: "Alpha", published: 1 })

        const result = yield* repo.viewFilter("posts", {
          where: { sql: "t.published = ?", params: [1] },
          sort: { field: "title", direction: "asc" }
        })
        expect(result[0].title).toBe("Alpha")
        expect(result[1].title).toBe("Bravo")
      }).pipe(Effect.provide(testLayer)))

    it.effect("respects sort order desc", () =>
      Effect.gen(function* () {
        yield* setupTable
        const repo = yield* Repository
        yield* repo.create("posts", { title: "Bravo", published: 1 })
        yield* repo.create("posts", { title: "Alpha", published: 1 })

        const result = yield* repo.viewFilter("posts", {
          where: { sql: "t.published = ?", params: [1] },
          sort: { field: "title", direction: "desc" }
        })
        expect(result[0].title).toBe("Bravo")
        expect(result[1].title).toBe("Alpha")
      }).pipe(Effect.provide(testLayer)))
  })

  describe("list", () => {
    it.effect("returns all rows with limit", () =>
      Effect.gen(function* () {
        yield* setupTable
        const repo = yield* Repository
        yield* repo.create("posts", { title: "A" })
        yield* repo.create("posts", { title: "B" })
        yield* repo.create("posts", { title: "C" })

        const result = yield* repo.list("posts", 10)
        expect(result.items.length).toBe(3)
      }).pipe(Effect.provide(testLayer)))

    it.effect("respects WHERE clause", () =>
      Effect.gen(function* () {
        yield* setupTable
        const repo = yield* Repository
        yield* repo.create("posts", { title: "A", published: 1 })
        yield* repo.create("posts", { title: "B", published: 1 })
        yield* repo.create("posts", { title: "C", published: 1 })
        yield* repo.create("posts", { title: "D", published: 0 })

        const result = yield* repo.list("posts", 2, {
          where: { sql: "t.published = ?", params: [1] }
        })
        expect(result.items.length).toBe(2)
      }).pipe(Effect.provide(testLayer)))

    it.effect("limit caps the number of returned rows", () =>
      Effect.gen(function* () {
        yield* setupTable
        const repo = yield* Repository
        yield* repo.create("posts", { title: "A" })
        yield* repo.create("posts", { title: "B" })
        yield* repo.create("posts", { title: "C" })
        yield* repo.create("posts", { title: "D" })

        const result = yield* repo.list("posts", 2)
        expect(result.items.length).toBe(2)
      }).pipe(Effect.provide(testLayer)))

    it.effect("without where, lists all rows up to limit", () =>
      Effect.gen(function* () {
        yield* setupTable
        const repo = yield* Repository
        yield* repo.create("posts", { title: "X" })
        yield* repo.create("posts", { title: "Y" })

        const result = yield* repo.list("posts", 100)
        expect(result.items.length).toBe(2)
      }).pipe(Effect.provide(testLayer)))

    it.effect("empty table returns items:[]", () =>
      Effect.gen(function* () {
        yield* setupTable
        const repo = yield* Repository
        const result = yield* repo.list("posts", 10)
        expect(result.items).toEqual([])
      }).pipe(Effect.provide(testLayer)))
  })

  describe("delete", () => {
    it.effect("returns Option.some(void) when row is found and deleted", () =>
      Effect.gen(function* () {
        yield* setupTable
        const repo = yield* Repository
        const created = yield* repo.create("posts", { title: "Gone" })
        const result = yield* repo.delete("posts", created.id as string)
        expect(Option.isSome(result)).toBe(true)
      }).pipe(Effect.provide(testLayer)))

    it.effect("row is actually gone after delete", () =>
      Effect.gen(function* () {
        yield* setupTable
        const repo = yield* Repository
        const created = yield* repo.create("posts", { title: "Gone" })
        yield* repo.delete("posts", created.id as string)
        const result = yield* repo.view("posts", created.id as string)
        expect(Option.isNone(result)).toBe(true)
      }).pipe(Effect.provide(testLayer)))

    it.effect("returns Option.none for an unknown id", () =>
      Effect.gen(function* () {
        yield* setupTable
        const repo = yield* Repository
        const result = yield* repo.delete("posts", "nosuchid123456")
        expect(Option.isNone(result)).toBe(true)
      }).pipe(Effect.provide(testLayer)))
  })

  describe("Option contract (negative paths)", () => {
    it.effect("SqlError is raised for genuinely bad SQL (non-existent table)", () =>
      Effect.gen(function* () {
        const repo = yield* Repository
        const result = yield* repo.view("no_such_table", "abc").pipe(Effect.either)
        expect(result._tag).toBe("Left")
      }).pipe(Effect.provide(testLayer)))

    it.effect("not found is always Option.none, never SqlError", () =>
      Effect.gen(function* () {
        yield* setupTable
        const repo = yield* Repository
        const view = yield* repo.view("posts", "missing123456").pipe(Effect.either)
        expect(view._tag).toBe("Right")
        expect(Option.isNone((view as { _tag: "Right"; right: Option.Option<unknown> }).right)).toBe(true)
      }).pipe(Effect.provide(testLayer)))
  })
})
