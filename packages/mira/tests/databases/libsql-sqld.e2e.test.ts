/**
 * Remote libSQL end-to-end coverage against a Docker sqld endpoint.
 *
 * Start the pinned service first:
 *
 *   docker run --rm -d --name mira-libsql-sqld -p 18080:8080 ghcr.io/tursodatabase/libsql-server:v0.24.33
 *   $env:MIRA_LIBSQL_E2E = "1"
 *   pnpm --filter @gettersethya/mira exec vitest run tests/databases/libsql-sqld.e2e.test.ts
 *
 * The default URL is http://127.0.0.1:18080. Override it with
 * MIRA_LIBSQL_URL. The normal suite skips this file.
 */
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { NodeHttpServer } from "@effect/platform-node"
import { describe, it } from "@effect/vitest"
import {
  AuthCollection,
  BaseCollection,
  type CollectionSchema,
  Field
} from "@gettersethya/mira-client"
import { Effect, Layer, Schedule, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/http"
import { SqlClient } from "effect/sql"
import { expect } from "vitest"

import { applyRulesToCollections, defineRule, Mira } from "@/app/index.js"
import { LibsqlDatabase } from "@/databases/libsql.js"
import { makeCollectionRouter } from "@/http/router.js"
import { Migrator, MigratorLive } from "@/migrator/migrator.js"
import { NodePlatform } from "@/platforms/node.js"
import { LocalFileStorage } from "@/storage/local-preset.js"
import { makeTelemetryLayer } from "@/telemetry/layer.js"
import { TelemetryStore } from "@/telemetry/store.js"

function closeEffect<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, never> {
  // The built app layer is closed at runtime; the test graph widens R through
  // plugin/cron config, so this helper restores the closed run type.
  // oxlint-disable-next-line typescript/consistent-type-assertions
  return effect as Effect.Effect<A, E, never>
}

const enabled = process.env["MIRA_LIBSQL_E2E"] === "1"
const describeE2E = enabled ? describe : describe.skip
const url = process.env["MIRA_LIBSQL_URL"] ?? "http://127.0.0.1:18080"

const delay = (millis: number) =>
  Effect.promise(() => new Promise((resolve) => setTimeout(resolve, millis)))

const IdItemSchema = Schema.Struct({ id: Schema.String })
const TitleItemSchema = Schema.Struct({ title: Schema.String })
const IdItemsSchema = Schema.Struct({ items: Schema.Array(IdItemSchema) })
const TitleItemsSchema = Schema.Struct({ items: Schema.Array(TitleItemSchema) })

const json = <A>(res: { json: Effect.Effect<unknown, unknown> }, schema: Schema.Schema<A>) =>
  res.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(schema)))

const encodeFilter = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ op: Schema.String, field: Schema.String, value: Schema.Unknown }))
)

const PostsDef = BaseCollection.define("e2e_posts", {
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

const LockedDef = BaseCollection.define("e2e_locked", {
  title: Field.text({ required: true })
})
const lockedRules = defineRule(LockedDef, (R) => ({
  list: R.public(),
  view: R.public()
}))

const UsersDef = AuthCollection.define("e2e_users", {})
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

const waitForServer = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`SELECT 1 AS ok`.pipe(
    Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 60 })
  )
})

const dropRebuildTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  for (const name of [
    "e2e_todos",
    "e2e_collections",
    "e2e_migrations",
    "e2e_rollback"
  ]) {
    yield* sql.unsafe(`DROP TABLE IF EXISTS "${name}"`).pipe(Effect.ignore)
  }
  yield* sql.unsafe(`DROP VIEW IF EXISTS "e2e_view"`).pipe(Effect.ignore)
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

describeE2E("libSQL remote sqld", () => {
  it.effect("runs migrations, CRUD, list/filter/sort/cursor, rules, auth, and bulk", () => {
    const dir = mkdtempSync(join(tmpdir(), "mira-libsql-e2e-http-"))
    const database = LibsqlDatabase({ url })
    const app = Mira.builder()
      .platform(NodePlatform)
      .database(database)
      .storage(LocalFileStorage({ directory: join(dir, "uploads") }))
      .collections([Posts, Locked, Users])
      .build()

    const router = makeCollectionRouter([Posts, Locked, Users])
    const serveRouter = Effect.flatMap(
      HttpRouter.toHttpEffect(HttpRouter.addAll(router)),
      HttpServer.serveEffect()
    )

    return Effect.gen(function* () {
      yield* waitForServer
      const sql = yield* SqlClient.SqlClient
      for (const table of ["e2e_posts", "e2e_locked", "e2e_users"]) {
        yield* sql.unsafe(`DELETE FROM "${table}"`).pipe(Effect.ignore)
      }
      yield* serveRouter

      const created = yield* HttpClient.execute(
        HttpClientRequest.post("/api/collections/e2e_posts").pipe(
          HttpClientRequest.bodyJsonUnsafe({ title: "one", published: true })
        )
      )
      expect(created.status).toBe(201)
      const first = yield* json(created, IdItemSchema)

      const second = yield* HttpClient.execute(
        HttpClientRequest.post("/api/collections/e2e_posts").pipe(
          HttpClientRequest.bodyJsonUnsafe({ title: "two" })
        )
      )
      expect(second.status).toBe(201)

      const filtered = yield* HttpClient.get(
        `/api/collections/e2e_posts?filter=${encodeURIComponent(
          encodeFilter({ op: "eq", field: "title", value: "two" })
        )}`
      )
      expect(filtered.status).toBe(200)
      const filteredBody = yield* json(filtered, TitleItemsSchema)
      expect(filteredBody.items.map((row) => row.title)).toEqual(["two"])

      const sorted = yield* HttpClient.get(
        "/api/collections/e2e_posts?sort=title&order=asc"
      )
      expect(sorted.status).toBe(200)
      const sortedBody = yield* json(sorted, TitleItemsSchema)
      expect(sortedBody.items.map((row) => row.title)).toEqual(["one", "two"])

      const page = yield* HttpClient.get(
        "/api/collections/e2e_posts?limit=1&sort=title&order=asc"
      )
      const pageBody = yield* json(
        page,
        Schema.Struct({ items: Schema.Array(IdItemSchema), nextCursor: Schema.NullOr(Schema.Number) })
      )
      expect(pageBody.items).toHaveLength(1)
      expect(pageBody.nextCursor).not.toBeNull()
      const next = yield* HttpClient.get(
        `/api/collections/e2e_posts?limit=1&sort=title&order=asc&after=${pageBody.nextCursor}`
      )
      const nextBody = yield* json(next, IdItemsSchema)
      expect(nextBody.items[0]?.id).not.toBe(pageBody.items[0]?.id)

      const updated = yield* HttpClient.execute(
        HttpClientRequest.patch(`/api/collections/e2e_posts/${first.id}`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ title: "one-updated" })
        )
      )
      expect(updated.status).toBe(200)

      const bulk = yield* HttpClient.execute(
        HttpClientRequest.post("/api/collections/e2e_posts/bulk").pipe(
          HttpClientRequest.bodyJsonUnsafe({
            records: [{ title: "bulk-1" }, { title: "bulk-2" }]
          })
        )
      )
      expect(bulk.status).toBe(201)
      expect((yield* json(bulk, Schema.Struct({ records: Schema.Array(Schema.Unknown) }))).records).toHaveLength(2)

      const denied = yield* HttpClient.execute(
        HttpClientRequest.post("/api/collections/e2e_locked").pipe(
          HttpClientRequest.bodyJsonUnsafe({ title: "nope" })
        )
      )
      expect(denied.status).toBe(403)

      const user = yield* HttpClient.execute(
        HttpClientRequest.post("/api/collections/e2e_users").pipe(
          HttpClientRequest.bodyJsonUnsafe({
            email: "e2e@example.com",
            password: "correct-password",
            passwordConfirm: "correct-password"
          })
        )
      )
      expect(user.status).toBe(201)

      const login = yield* HttpClient.execute(
        HttpClientRequest.post("/api/collections/e2e_users/auth-with-password").pipe(
          HttpClientRequest.bodyJsonUnsafe({
            email: "e2e@example.com",
            password: "correct-password"
          })
        )
      )
      expect(login.status).toBe(200)
      expect(typeof (yield* json(login, Schema.Struct({ token: Schema.optional(Schema.String) }))).token).toBe("string")
    }).pipe(
      Effect.provide(Layer.mergeAll(app.buildServiceLayer(), NodeHttpServer.layerTest))
    )
  }, 60_000)

  it.effect("rebuilds a table with a view, preserves the high-water mark, and rolls DDL back", () => {
    const database = LibsqlDatabase({ url })
    const layer = Layer.mergeAll(
      MigratorLive.pipe(Layer.provide(database.layer)),
      database.layer
    )

    return Effect.gen(function* () {
      yield* waitForServer
      yield* dropRebuildTables
      const sql = yield* SqlClient.SqlClient
      const migrator = yield* Migrator
      const options = { schemaTable: "e2e_collections", migrationsTable: "e2e_migrations" }

      yield* migrator.migrate([{ name: "e2e_todos", schema: todosSchema(true) }], options)
      yield* sql`INSERT INTO ${sql("e2e_todos")} ${sql.insert({
        id: "t1",
        title: "one",
        category: "c1",
        created: "2026-01-01",
        updated: "2026-01-01"
      })}`
      yield* sql`INSERT INTO ${sql("e2e_todos")} ${sql.insert({
        id: "t2",
        title: "two",
        category: "c2",
        created: "2026-01-01",
        updated: "2026-01-01"
      })}`
      yield* sql`INSERT INTO ${sql("e2e_todos")} ${sql.insert({
        id: "t3",
        title: "three",
        category: "c3",
        created: "2026-01-01",
        updated: "2026-01-01"
      })}`
      yield* sql`DELETE FROM ${sql("e2e_todos")} WHERE id = ${"t3"}`
      yield* sql.unsafe(`CREATE VIEW e2e_view AS SELECT id, title FROM e2e_todos`)

      yield* migrator.migrate([{ name: "e2e_todos", schema: todosSchema(false) }], options)

      const view = yield* sql<{ id: string; title: string }>`SELECT id, title FROM e2e_view ORDER BY id`
      expect(view).toEqual([
        { id: "t1", title: "one" },
        { id: "t2", title: "two" }
      ])
      const seq = yield* sql<{ seq: number }>`SELECT seq FROM sqlite_sequence WHERE name = 'e2e_todos'`
      expect(seq[0]?.seq).toBe(3)

      yield* sql`INSERT INTO ${sql("e2e_todos")} ${sql.insert({
        id: "t4",
        title: "four",
        category: "c4",
        created: "2026-01-01",
        updated: "2026-01-01"
      })}`
      const inserted = yield* sql<{ seqId: number }>`SELECT seqId FROM ${sql("e2e_todos")} WHERE id = ${"t4"}`
      expect(inserted[0]?.seqId).toBe(4)

      const foreignKeys = yield* sql<{ table: string }>`PRAGMA foreign_key_list(e2e_todos)`
      expect(foreignKeys).toEqual([])

      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql.unsafe(`CREATE TABLE e2e_rollback (id INTEGER PRIMARY KEY)`)
          return yield* Effect.fail("intentional")
        })
      ).pipe(Effect.catch(() => Effect.succeed("rolled back")))
      const rolledBack = yield* sql<{ name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'e2e_rollback'
      `
      expect(rolledBack).toEqual([])
    }).pipe(Effect.provide(layer))
  }, 60_000)

  it("persists remote shared telemetry and retention", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mira-libsql-e2e-telemetry-"))
    const app = Mira.builder()
      .platform(NodePlatform)
      .database(LibsqlDatabase({ url }))
      .storage(LocalFileStorage({ directory: join(dir, "uploads") }))
      .collections([Posts])
      .telemetry(
        makeTelemetryLayer({
          storage: { mode: "shared" },
          flushBatchSize: 100,
          flushInterval: "1 second"
        })
      )
      .build()

    const program = Effect.gen(function* () {
      yield* waitForServer
      const sql = yield* SqlClient.SqlClient
      yield* sql.unsafe(`DELETE FROM "logs"`).pipe(Effect.ignore)
      yield* sql.unsafe(`DELETE FROM "spans"`).pipe(Effect.ignore)
      const store = yield* TelemetryStore

      yield* Effect.logInfo("e2e-libsql-log")
      yield* Effect.void.pipe(Effect.withSpan("e2e-libsql-span"))
      yield* delay(2_000)

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
      expect(logs.items.some((row) => row.message === "e2e-libsql-log")).toBe(true)
      expect(spans.items.some((row) => row.name === "e2e-libsql-span")).toBe(true)

      const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
      const recent = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString()
      yield* store.appendLogs([
        {
          id: "e2e-old-log",
          level: "INFO",
          message: "old",
          created: old,
          updated: old,
          traceId: null,
          spanId: null
        },
        {
          id: "e2e-recent-log",
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
    }).pipe(Effect.provide(app.buildServiceLayer()), Effect.scoped)

    await Effect.runPromise(closeEffect(program))
  }, 60_000)
})
