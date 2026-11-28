import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { NodeHttpServer } from "@effect/platform-node"
import { describe, it } from "@effect/vitest"
import { AuthCollection, BaseCollection, type CollectionSchema, Field } from "@gettersethya/mira-client"
import { Effect, Exit, Layer, Redacted, Result, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/http"
import { SqlClient } from "effect/sql"
import { afterAll, expect } from "vitest"

import { applyRulesToCollections, defineRule, Mira } from "@/app/index.js"
import { LibsqlDatabase, LibsqlConfigError, TursoDatabase } from "@/databases/libsql.js"
import { libsqlDialect } from "@/dialect/dialect-libsql.js"
import { makeCollectionRouter } from "@/http/router.js"
import { Migrator, MigratorLive } from "@/migrator/migrator.js"
import { NodePlatform } from "@/platforms/node.js"
import { LocalFileStorage } from "@/storage/local-preset.js"
import { makeTelemetryLayer } from "@/telemetry/layer.js"
import { TelemetryStore } from "@/telemetry/store.js"

function closeEffect<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, never> {
  // The built app layer is closed at runtime; the test graph widens R through
  // plugin/cron config, so this helper restores the closed run type. The cast is
  // the only way to drop an `any` requirement channel that TypeScript rejects
  // assigning to `never` directly.
  // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion, typescript/consistent-type-assertions
  return effect as Effect.Effect<A, E, never>
}

const fileUrl = (filename: string) => `file:${filename.replaceAll("\\", "/")}`

const dirs: Array<string> = []
const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    } catch {
      // Windows can keep the native libSQL handle briefly; the OS temp cleanup
      // is still safe.
    }
  }
})

const delay = (millis: number) => Effect.promise(() => new Promise((resolve) => setTimeout(resolve, millis)))

const PostsDef = BaseCollection.define("posts", {
  title: Field.text({ required: true }),
  published: Field.boolean({ default: false })
})
const postsRules = defineRule(PostsDef, (R) => ({
  list: R.public(),
  view: R.public(),
  create: R.public(),
  update: R.public(),
  delete: R.public()
}))

const LockedDef = BaseCollection.define("locked", {
  title: Field.text({ required: true })
})
const lockedRules = defineRule(LockedDef, (R) => ({
  list: R.public(),
  view: R.public()
}))

const UsersDef = AuthCollection.define("users", {})
const usersRules = defineRule(UsersDef, (R) => ({
  list: R.public(),
  view: R.public(),
  create: R.public(),
  update: R.field("id").eq(R.selfId()),
  delete: R.field("id").eq(R.selfId())
}))

const [Posts, Locked, Users] = applyRulesToCollections(
  [PostsDef, LockedDef, UsersDef],
  [postsRules, lockedRules, usersRules]
)

const IdItemSchema = Schema.Struct({ id: Schema.String })
const TitleItemSchema = Schema.Struct({ title: Schema.String })
const IdItemsSchema = Schema.Struct({ items: Schema.Array(IdItemSchema) })
const TitleItemsSchema = Schema.Struct({ items: Schema.Array(TitleItemSchema) })

const json = <A>(res: { json: Effect.Effect<unknown, unknown> }, schema: Schema.Schema<A>) =>
  res.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(schema)))

const encodeFilter = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ op: Schema.String, field: Schema.String, value: Schema.Unknown }))
)

describe("LibsqlDatabase preset", () => {
  it("exports TursoDatabase as the same preset", () => {
    expect(TursoDatabase).toBe(LibsqlDatabase)
  })

  it("marks a replica preset as no-auto-migration", () => {
    const replica = LibsqlDatabase({
      url: "file:./replica.db",
      syncUrl: "libsql://example.turso.io",
      authToken: Redacted.make("token")
    })
    expect(replica.migrateAtStartup).toBe(false)
    expect(LibsqlDatabase({ url: "file:./plain.db" }).migrateAtStartup).toBe(true)
  })

  it("rejects unknown URL schemes and invalid option combinations", () => {
    expect(() => LibsqlDatabase({ url: "postgres://example" })).toThrow(LibsqlConfigError)
    expect(() => LibsqlDatabase({ url: "http://127.0.0.1:1", synchronous: "NORMAL" })).toThrow(/synchronous/)
    expect(() => LibsqlDatabase({ url: "file:./x.db", authToken: Redacted.make("token") })).toThrow(/authToken/)
    expect(() => LibsqlDatabase({ url: "http://127.0.0.1:1", syncUrl: "http://127.0.0.1:2" })).toThrow(/syncUrl/)
    expect(() => LibsqlDatabase({ url: ":memory:", syncUrl: "libsql://example" })).toThrow(/in-memory/)
    expect(() => LibsqlDatabase({ url: "file:./x.db", syncInterval: 1 })).toThrow(/syncInterval/)
  })

  it.effect("applies the local pragma set and disables foreign keys", () => {
    const dir = tempDir("mira-libsql-pragmas-")
    const filename = join(dir, "app.db")
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const journal = yield* sql<{ journal_mode: string }>`PRAGMA journal_mode`
      const synchronous = yield* sql<{ synchronous: number }>`PRAGMA synchronous`
      const busy = yield* sql<{ timeout: number }>`PRAGMA busy_timeout`
      const foreignKeys = yield* sql<{ foreign_keys: number }>`PRAGMA foreign_keys`

      expect(journal[0]?.journal_mode).toBe("wal")
      expect(synchronous[0]?.synchronous).toBe(1)
      expect(busy[0]?.timeout).toBe(5000)
      expect(foreignKeys[0]?.foreign_keys).toBe(0)
    }).pipe(Effect.provide(LibsqlDatabase({ url: fileUrl(filename), synchronous: "NORMAL" }).layer))
  })
})

const todosSchema = (categoryRequired: boolean): CollectionSchema => {
  const properties: CollectionSchema["properties"] = {
    seqId: { type: "integer", "x-kind": "seqId", "x-system": true },
    id: { type: "string", "x-system": true },
    title: { type: "string" },
    category: { type: "string" },
    created: { type: "string", "x-system": true },
    updated: { type: "string", "x-system": true }
  }
  return {
    "x-collection-kind": "base",
    type: "object",
    properties,
    required: categoryRequired
      ? ["id", "title", "category", "created", "updated"]
      : ["id", "title", "created", "updated"]
  }
}

const todosWithoutTitle = (categoryRequired: boolean): CollectionSchema => {
  const schema = todosSchema(categoryRequired)
  delete schema.properties["title"]
  schema.required = categoryRequired ? ["id", "category", "created", "updated"] : ["id", "created", "updated"]
  return schema
}

const todosView = (query: string, properties: ReadonlyArray<string>): CollectionSchema => {
  const definitions: CollectionSchema["properties"] = {
    id: { type: "string", "x-system": true, "x-view-only": true },
    seqId: { type: "integer", "x-system": true, "x-view-only": true, "x-kind": "seqId" },
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

const insertTodo = (id: string, title: string, category: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`INSERT INTO ${sql("todos")} ${sql.insert({
      id,
      title,
      category,
      created: "2026-01-01",
      updated: "2026-01-01"
    })}`
  })

describe("libSQL SQL behavior", () => {
  it.effect("migrates, rebuilds with a view, and preserves the high-water mark", () => {
    const dir = tempDir("mira-libsql-rebuild-")
    const database = LibsqlDatabase({ url: fileUrl(join(dir, "app.db")) })
    const layer = Layer.mergeAll(MigratorLive.pipe(Layer.provide(database.layer)), database.layer)

    return Effect.gen(function* () {
      const migrator = yield* Migrator
      const sql = yield* SqlClient.SqlClient

      yield* migrator.migrate([{ name: "todos", schema: todosSchema(true) }])
      yield* sql`INSERT INTO ${sql("todos")} ${sql.insert({
        id: "t1",
        title: "one",
        category: "c1",
        created: "2026-01-01",
        updated: "2026-01-01"
      })}`
      yield* sql`INSERT INTO ${sql("todos")} ${sql.insert({
        id: "t2",
        title: "two",
        category: "c2",
        created: "2026-01-01",
        updated: "2026-01-01"
      })}`
      yield* sql`INSERT INTO ${sql("todos")} ${sql.insert({
        id: "t3",
        title: "three",
        category: "c3",
        created: "2026-01-01",
        updated: "2026-01-01"
      })}`
      yield* sql`DELETE FROM ${sql("todos")} WHERE id = ${"t3"}`
      yield* sql.unsafe(`CREATE VIEW todos_view AS SELECT id, title FROM todos`)

      yield* migrator.migrate([{ name: "todos", schema: todosSchema(false) }])

      const rows = yield* sql<{ id: string; title: string }>`SELECT id, title FROM todos_view ORDER BY id`
      expect(rows).toEqual([
        { id: "t1", title: "one" },
        { id: "t2", title: "two" }
      ])
      const seq = yield* sql<{ seq: number }>`SELECT seq FROM sqlite_sequence WHERE name = 'todos'`
      expect(seq[0]?.seq).toBe(3)

      yield* sql`INSERT INTO ${sql("todos")} ${sql.insert({
        id: "t4",
        title: "four",
        category: "c4",
        created: "2026-01-01",
        updated: "2026-01-01"
      })}`
      const inserted = yield* sql<{ seqId: number }>`SELECT seqId FROM ${sql("todos")} WHERE id = ${"t4"}`
      expect(inserted[0]?.seqId).toBe(4)
    }).pipe(Effect.provide(layer))
  })
})

describe("libSQL dependent-view handling", () => {
  it.effect("dropColumn with a tracked dependent view recreates and validates it", () => {
    const dir = tempDir("mira-libsql-drop-view-")
    const database = LibsqlDatabase({ url: fileUrl(join(dir, "app.db")) })
    const layer = Layer.mergeAll(MigratorLive.pipe(Layer.provide(database.layer)), database.layer)

    return Effect.gen(function* () {
      const migrator = yield* Migrator
      const sql = yield* SqlClient.SqlClient

      yield* migrator.migrate([
        { name: "todos", schema: todosSchema(true) },
        { name: "todos_view", schema: todosView("SELECT id, seqId, title FROM todos", ["id", "seqId", "title"]) }
      ])
      yield* insertTodo("t1", "one", "c1")

      yield* migrator.migrate(
        [
          { name: "todos", schema: todosWithoutTitle(true) },
          { name: "todos_view", schema: todosView("SELECT id, seqId FROM todos", ["id", "seqId"]) }
        ],
        { allowDestructive: true }
      )

      const columns = yield* sql<{ name: string }>`PRAGMA table_info(todos)`
      expect(columns.map((c) => c.name)).not.toContain("title")
      const rows = yield* sql<{ id: string }>`SELECT id FROM ${sql("todos_view")}`
      expect(rows).toEqual([{ id: "t1" }])
    }).pipe(Effect.provide(layer))
  })

  it.effect("dropColumn with a stale tracked view rolls back", () => {
    const dir = tempDir("mira-libsql-drop-view-stale-")
    const database = LibsqlDatabase({ url: fileUrl(join(dir, "app.db")) })
    const layer = Layer.mergeAll(MigratorLive.pipe(Layer.provide(database.layer)), database.layer)

    return Effect.gen(function* () {
      const migrator = yield* Migrator
      const sql = yield* SqlClient.SqlClient

      yield* migrator.migrate([
        { name: "todos", schema: todosSchema(true) },
        { name: "todos_view", schema: todosView("SELECT id, seqId, title FROM todos", ["id", "seqId", "title"]) }
      ])
      yield* insertTodo("t1", "one", "c1")

      const exit = yield* Effect.exit(
        migrator.migrate(
          [
            { name: "todos", schema: todosWithoutTitle(true) },
            { name: "todos_view", schema: todosView("SELECT id, seqId, title FROM todos", ["id", "seqId", "title"]) }
          ],
          { allowDestructive: true }
        )
      )

      expect(Exit.isFailure(exit)).toBe(true)
      const columns = yield* sql<{ name: string }>`PRAGMA table_info(todos)`
      expect(columns.map((c) => c.name)).toContain("title")
      const views = yield* sql<{ name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'view' AND name = 'todos_view'
      `
      expect(views).toHaveLength(1)
      const rows = yield* sql<{ id: string }>`SELECT id FROM ${sql("todos")}`
      expect(rows).toEqual([{ id: "t1" }])
    }).pipe(Effect.provide(layer))
  })
})

describe("libSQL app and HTTP behavior", () => {
  it.effect(
    "runs CRUD, list/filter/sort/cursor, rules, auth, and bulk over HTTP",
    () => {
      const dir = tempDir("mira-libsql-http-")
      const app = Mira.builder()
        .platform(NodePlatform)
        .database(LibsqlDatabase({ url: fileUrl(join(dir, "app.db")) }))
        .storage(LocalFileStorage({ directory: join(dir, "uploads") }))
        .collections([Posts, Locked, Users])
        .build()

      const router = makeCollectionRouter([Posts, Locked, Users])
      const serveRouter = Effect.flatMap(HttpRouter.toHttpEffect(HttpRouter.addAll(router)), HttpServer.serveEffect())

      return closeEffect(Effect.gen(function* () {
        yield* serveRouter

        const empty = yield* HttpClient.get("/api/collections/posts")
        expect(empty.status).toBe(200)
        expect((yield* json(empty, Schema.Struct({ items: Schema.Array(Schema.Unknown) }))).items).toEqual([])

        const created = yield* HttpClient.execute(
          HttpClientRequest.post("/api/collections/posts").pipe(
            HttpClientRequest.bodyJsonUnsafe({ title: "one", published: true })
          )
        )
        expect(created.status).toBe(201)
        const first = yield* json(created, Schema.Struct({ id: Schema.String, title: Schema.String }))
        expect(first.title).toBe("one")

        const second = yield* HttpClient.execute(
          HttpClientRequest.post("/api/collections/posts").pipe(HttpClientRequest.bodyJsonUnsafe({ title: "two" }))
        )
        expect(second.status).toBe(201)

        const filtered = yield* HttpClient.get(
          `/api/collections/posts?filter=${encodeURIComponent(
            encodeFilter({ op: "eq", field: "title", value: "two" })
          )}`
        )
        expect(filtered.status).toBe(200)
        const filteredBody = yield* json(filtered, TitleItemsSchema)
        expect(filteredBody.items).toHaveLength(1)
        expect(filteredBody.items[0]?.title).toBe("two")

        const sorted = yield* HttpClient.get("/api/collections/posts?sort=title&order=asc")
        expect(sorted.status).toBe(200)
        const sortedBody = yield* json(sorted, TitleItemsSchema)
        expect(sortedBody.items.map((row) => row.title)).toEqual(["one", "two"])

        const page = yield* HttpClient.get("/api/collections/posts?limit=1&sort=title&order=asc")
        const pageBody = yield* json(
          page,
          Schema.Struct({ items: Schema.Array(IdItemSchema), nextCursor: Schema.NullOr(Schema.Finite) })
        )
        expect(pageBody.items).toHaveLength(1)
        expect(pageBody.nextCursor).not.toBeNull()
        const next = yield* HttpClient.get(
          `/api/collections/posts?limit=1&sort=title&order=asc&after=${pageBody.nextCursor}`
        )
        const nextBody = yield* json(next, IdItemsSchema)
        expect(nextBody.items[0]?.id).not.toBe(pageBody.items[0]?.id)

        const updated = yield* HttpClient.execute(
          HttpClientRequest.patch(`/api/collections/posts/${first.id}`).pipe(
            HttpClientRequest.bodyJsonUnsafe({ title: "one-updated" })
          )
        )
        expect(updated.status).toBe(200)
        expect((yield* json(updated, TitleItemSchema)).title).toBe("one-updated")

        const deleted = yield* HttpClient.execute(HttpClientRequest.delete(`/api/collections/posts/${first.id}`))
        expect(deleted.status).toBe(204)

        const bulk = yield* HttpClient.execute(
          HttpClientRequest.post("/api/collections/posts/bulk").pipe(
            HttpClientRequest.bodyJsonUnsafe({
              records: [{ title: "bulk-1" }, { title: "bulk-2" }]
            })
          )
        )
        expect(bulk.status).toBe(201)
        expect((yield* json(bulk, Schema.Struct({ records: Schema.Array(Schema.Unknown) }))).records).toHaveLength(2)

        const denied = yield* HttpClient.execute(
          HttpClientRequest.post("/api/collections/locked").pipe(HttpClientRequest.bodyJsonUnsafe({ title: "nope" }))
        )
        expect(denied.status).toBe(403)

        const user = yield* HttpClient.execute(
          HttpClientRequest.post("/api/collections/users").pipe(
            HttpClientRequest.bodyJsonUnsafe({
              email: "libsql@example.com",
              password: "correct-password",
              passwordConfirm: "correct-password"
            })
          )
        )
        expect(user.status).toBe(201)
        const userBody = yield* json(user, Schema.Struct({ password: Schema.optional(Schema.Unknown) }))
        expect(userBody.password).toBeUndefined()

        const login = yield* HttpClient.execute(
          HttpClientRequest.post("/api/collections/users/auth-with-password").pipe(
            HttpClientRequest.bodyJsonUnsafe({
              email: "libsql@example.com",
              password: "correct-password"
            })
          )
        )
        expect(login.status).toBe(200)
        const loginBody = yield* json(
          login,
          Schema.Struct({
            token: Schema.optional(Schema.String),
            record: Schema.optional(Schema.Struct({ email: Schema.String }))
          })
        )
        expect(typeof loginBody.token).toBe("string")
        expect(loginBody.record?.email).toBe("libsql@example.com")
      }).pipe(Effect.provide(app.buildServiceLayer().pipe(Layer.provideMerge(NodeHttpServer.layerTest)))))
    },
    30_000
  )

  it.effect(
    "persists telemetry and retention into a dedicated libSQL database",
    () => {
      const dir = tempDir("mira-libsql-telemetry-")
      const app = Mira.builder()
        .platform(NodePlatform)
        .database(LibsqlDatabase({ url: fileUrl(join(dir, "app.db")) }))
        .storage(LocalFileStorage({ directory: join(dir, "uploads") }))
        .collections([Posts])
        .telemetry(
          makeTelemetryLayer({
            storage: {
              mode: "dedicated",
              database: LibsqlDatabase({ url: fileUrl(join(dir, "telemetry.db")) })
            }
          })
        )
        .build()

      return Effect.gen(function* () {
        const store = yield* TelemetryStore
        yield* Effect.logInfo("libsql-telemetry-log")
        yield* Effect.void.pipe(Effect.withSpan("libsql-telemetry-span"))
        yield* delay(150)

        const read = store.read
        if (read === null) throw new Error("expected telemetry read store")
        const logs = yield* read.listLogs({
          limit: 100,
          after: null,
          filter: null,
          traceId: null
        })
        const spans = yield* read.listSpans({
          limit: 100,
          after: null,
          filter: null,
          traceId: null
        })
        expect(logs.items.some((row) => row.message === "libsql-telemetry-log")).toBe(true)
        expect(spans.items.some((row) => row.name === "libsql-telemetry-span")).toBe(true)

        const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
        const recent = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString()
        yield* store.appendLogs([
          {
            id: "old-log",
            level: "INFO",
            message: "old",
            created: old,
            updated: old,
            traceId: null,
            spanId: null
          },
          {
            id: "recent-log",
            level: "INFO",
            message: "recent",
            created: recent,
            updated: recent,
            traceId: null,
            spanId: null
          }
        ])
        const deleted = yield* store.deleteOlderThan(recent)
        expect(deleted.logs).toBeGreaterThanOrEqual(1)
      }).pipe(Effect.provide(app.buildServiceLayer()))
    },
    30_000
  )

  it("flushes a partial telemetry batch after flushInterval", async () => {
    const dir = tempDir("mira-libsql-telemetry-interval-")
    const app = Mira.builder()
      .platform(NodePlatform)
      .database(LibsqlDatabase({ url: fileUrl(join(dir, "app.db")) }))
      .storage(LocalFileStorage({ directory: join(dir, "uploads") }))
      .collections([Posts])
      .telemetry(
        makeTelemetryLayer({
          storage: {
            mode: "dedicated",
            database: LibsqlDatabase({ url: fileUrl(join(dir, "telemetry.db")) })
          },
          flushBatchSize: 100,
          flushInterval: "50 millis"
        })
      )
      .build()

    const program = Effect.gen(function* () {
      const store = yield* TelemetryStore
      yield* Effect.logInfo("interval-libsql-log")
      yield* delay(300)
      const read = store.read
      if (read === null) throw new Error("expected telemetry read store")
      const logs = yield* read.listLogs({
        limit: 100,
        after: null,
        filter: null,
        traceId: null
      })
      expect(logs.items.some((row) => row.message === "interval-libsql-log")).toBe(true)
    }).pipe(Effect.provide(app.buildServiceLayer()), Effect.scoped)

    await Effect.runPromise(closeEffect(program))
  }, 30_000)

  it.effect(
    "skips shared telemetry DDL when migrate is false",
    () => {
      const dir = tempDir("mira-libsql-shared-no-migrate-")
      const app = Mira.builder()
        .platform(NodePlatform)
        .database(LibsqlDatabase({ url: fileUrl(join(dir, "app.db")) }))
        .storage(LocalFileStorage({ directory: join(dir, "uploads") }))
        .collections([Posts])
        .telemetry(
          makeTelemetryLayer({
            storage: { mode: "shared", migrate: false }
          })
        )
        .build()

      return Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const tables = yield* sql<{ name: string }>`
        SELECT name FROM sqlite_master WHERE name LIKE '_telemetry_%'
      `
        expect(tables).toEqual([])
      }).pipe(Effect.provide(app.buildServiceLayer()))
    },
    30_000
  )
})

describe("libSQL duplicate key classification", () => {
  it.effect("classifies a real local libSQL unique violation", () => {
    const database = LibsqlDatabase({ url: ":memory:" })
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql.unsafe(`
        CREATE TABLE "_duplicate_email" (
          "email" TEXT NOT NULL UNIQUE
        )
      `)
      yield* sql.unsafe(`INSERT INTO "_duplicate_email" ("email") VALUES (?)`, ["a@example.com"])
      const duplicate = yield* Effect.result(
        sql.unsafe(`INSERT INTO "_duplicate_email" ("email") VALUES (?)`, ["a@example.com"])
      )
      expect(Result.isFailure(duplicate)).toBe(true)
      if (Result.isFailure(duplicate)) {
        expect(libsqlDialect("local").store.isDuplicateKey(duplicate.failure)).toBe(true)
      }

      const notNull = yield* Effect.result(sql.unsafe(`INSERT INTO "_duplicate_email" ("email") VALUES (?)`, [null]))
      expect(Result.isFailure(notNull)).toBe(true)
      if (Result.isFailure(notNull)) {
        expect(libsqlDialect("local").store.isDuplicateKey(notNull.failure)).toBe(false)
      }
    }).pipe(Effect.provide(database.layer))
  })
})
