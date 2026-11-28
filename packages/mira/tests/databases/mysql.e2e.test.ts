import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { NodeHttpServer } from "@effect/platform-node"
import { describe, it } from "@effect/vitest"
import {
  AuthCollection,
  BaseCollection,
  Field,
  ViewCollection
} from "@gettersethya/mira-client"
import { Effect, Layer, Option, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/http"
import { SqlClient } from "effect/sql"
import mysql from "mysql2/promise"
import { expect } from "vitest"

import { applyRulesToCollections, defineRule, Mira } from "@/app/index.js"
import { MysqlDatabase } from "@/databases/mysql.js"
import { readMysqlAffectedRows } from "@/dialect/dialect-mysql-core.js"
import { makeCollectionRouter } from "@/http/router.js"
import { NodePlatform } from "@/platforms/node.js"
import { LocalFileStorage } from "@/storage/local-preset.js"

type EngineConfig = {
  readonly label: string
  readonly envUrl: string | undefined
  readonly fallbackUrl: string
}

const engines: ReadonlyArray<EngineConfig> = [
  {
    label: "MySQL",
    envUrl: process.env["MIRA_TEST_MYSQL_URL"],
    fallbackUrl: "mysql://root:mira@127.0.0.1:53307/mira_test"
  },
  {
    label: "MariaDB",
    envUrl: process.env["MIRA_TEST_MARIADB_URL"],
    fallbackUrl: "mysql://root:mira@127.0.0.1:53306/mira_test"
  }
]

const adminUrl = (url: string) => {
  const parsed = new URL(url)
  parsed.pathname = "/"
  return parsed.toString()
}

const databaseUrl = (url: string, name: string) => {
  const parsed = new URL(url)
  parsed.pathname = `/${name}`
  return parsed.toString()
}

const createDatabase = (url: string, name: string) =>
  Effect.promise(async () => {
    const connection = await mysql.createConnection(adminUrl(url))
    try {
      await connection.query(`DROP DATABASE IF EXISTS \`${name}\``)
      await connection.query(`CREATE DATABASE \`${name}\``)
    } finally {
      await connection.end()
    }
  })

const dropDatabase = (url: string, name: string) =>
  Effect.promise(async () => {
    const connection = await mysql.createConnection(adminUrl(url))
    try {
      await connection.query(`DROP DATABASE IF EXISTS \`${name}\``)
    } finally {
      await connection.end()
    }
  })

const UsersDef = AuthCollection.define("e2e_mysql_users", {})
const usersRules = defineRule(UsersDef, (R) => ({
  list: R.public(),
  view: R.public(),
  create: R.public(),
  update: R.field("id").eq(R.selfId()),
  delete: R.field("id").eq(R.selfId())
}))

const PostsDef = BaseCollection.define("e2e_mysql_posts", {
  title: Field.text({ required: true }),
  published: Field.boolean({ default: false }),
  views: Field.integer({ default: 0 }),
  age: Field.integer({ required: false }),
  secret: Field.text({ required: false, hidden: true })
})
const postsRules = defineRule(PostsDef, (R) => ({
  list: R.public(),
  view: R.public(),
  create: R.public(),
  update: R.public(),
  delete: R.public()
}))

const AgedDef = BaseCollection.define("e2e_mysql_aged", {
  age: Field.integer({ required: true })
})
const agedRules = defineRule(AgedDef, (R) => ({
  list: R.public(),
  view: R.public(),
  create: R.field("age").gte(R.literal(18)),
  update: R.request("body", "age").neq(R.literal("17")),
  delete: R.public()
}))

const LockedDef = BaseCollection.define("e2e_mysql_locked", {
  title: Field.text({ required: true })
})
const lockedRules = defineRule(LockedDef, (R) => ({
  list: R.public(),
  view: R.public()
}))

const CursorDef = BaseCollection.define("e2e_mysql_cursor", {
  title: Field.text({ required: true })
})
const cursorRules = defineRule(CursorDef, (R) => ({
  list: R.public(),
  view: R.public(),
  create: R.public(),
  update: R.public(),
  delete: R.public()
}))

const ViewDef = ViewCollection.define(
  "e2e_mysql_view",
  "SELECT id, `seqId`, title, COUNT(*) AS total, COALESCE(SUM(views), 0) AS total_views, JSON_OBJECT('a', 1) AS meta FROM e2e_mysql_posts GROUP BY id, `seqId`, title",
  {
    id: Field.text().view(),
    seqId: Field.integer().view(),
    title: Field.text().view(),
    total: Field.integer().view(),
    total_views: Field.integer().view(),
    meta: Field.json().view()
  }
)
const viewRules = defineRule(ViewDef, (R) => ({
  list: R.public(),
  view: R.public()
}))

const [Posts, Aged, Locked, Users, Cursor, PostsView] = applyRulesToCollections(
  [PostsDef, AgedDef, LockedDef, UsersDef, CursorDef, ViewDef],
  [postsRules, agedRules, lockedRules, usersRules, cursorRules, viewRules]
)
const collections = [Posts, Aged, Locked, Users, Cursor, PostsView]

const AuthRecord = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  password: Schema.optional(Schema.String)
})
const LoginBody = Schema.Struct({ token: Schema.String, record: AuthRecord })
const MeBody = Schema.Struct({
  collection: Schema.String,
  record: Schema.Struct({ id: Schema.String, email: Schema.String })
})
const PostItem = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  published: Schema.Boolean,
  views: Schema.Number
})
const ListBody = Schema.Struct({
  items: Schema.Array(PostItem),
  nextCursor: Schema.NullOr(Schema.Union([Schema.String, Schema.Number]))
})
const ViewList = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      total: Schema.Number,
      total_views: Schema.Number
    })
  )
})
const BulkBody = Schema.Struct({
  records: Schema.Array(Schema.Struct({ id: Schema.String }))
})
const CursorListBody = Schema.Struct({
  items: Schema.Array(Schema.Struct({ id: Schema.String })),
  nextCursor: Schema.NullOr(Schema.Union([Schema.String, Schema.Number]))
})

const json = <A>(res: { json: Effect.Effect<unknown, unknown> }, schema: Schema.Schema<A>) =>
  res.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(schema)))

const encodeFilter = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({ op: Schema.String, field: Schema.String, value: Schema.Unknown })
  )
)

const filterQuery = (op: string, field: string, value: unknown) =>
  `/api/collections/e2e_mysql_posts?filter=${encodeURIComponent(
    encodeFilter({ op, field, value })
  )}`

const serveRouter = Effect.flatMap(
  HttpRouter.toHttpEffect(HttpRouter.addAll(makeCollectionRouter(collections))),
  HttpServer.serveEffect()
)

const createApp = (url: string) =>
  Mira.builder()
    .platform(NodePlatform)
    .database(MysqlDatabase({ url: Redacted.make(url) }))
    .storage(
      LocalFileStorage({
        directory: join(mkdtempSync(join(tmpdir(), "mira-mysql-http-")), "uploads")
      })
    )
    .collections(collections)
    .build()

const withEngine = <A, E, R>(
  url: string,
  body: (url: string) => Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> =>
  Effect.scoped(
    Effect.acquireRelease(
      Effect.sync(
        () =>
          `mira_e2e_http_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      ),
      (name) => dropDatabase(url, name)
    ).pipe(
      Effect.flatMap((name) =>
        Effect.gen(function* () {
          yield* createDatabase(url, name)
          return yield* body(databaseUrl(url, name))
        })
      )
    )
  )

for (const engine of engines) {
  const enabled = engine.envUrl !== undefined
  const describeEngine = enabled ? describe : describe.skip
  const url = engine.envUrl ?? engine.fallbackUrl

  describeEngine(`${engine.label} HTTP behavior`, () => {
    it.effect(
      "serves CRUD, list, filters, rules, auth, bulk, and a view",
      () =>
        withEngine(url, (databaseUrlValue) =>
          Effect.gen(function* () {
            const app = createApp(databaseUrlValue)
            const appLayer = Layer.mergeAll(
              app.buildServiceLayer(),
              NodeHttpServer.layerTest
            )

            yield* Effect.gen(function* () {
              yield* serveRouter

              const registered = yield* HttpClient.execute(
                HttpClientRequest.post("/api/collections/e2e_mysql_users").pipe(
                  HttpClientRequest.bodyJsonUnsafe({
                    email: "e2e-mysql@example.com",
                    password: "correct-password",
                    passwordConfirm: "correct-password"
                  })
                )
              )
              expect(registered.status).toBe(201)
              const user = yield* json(registered, AuthRecord)
              expect(user.password).toBeUndefined()

              const login = yield* HttpClient.execute(
                HttpClientRequest.post(
                  "/api/collections/e2e_mysql_users/auth-with-password"
                ).pipe(
                  HttpClientRequest.bodyJsonUnsafe({
                    email: "e2e-mysql@example.com",
                    password: "correct-password"
                  })
                )
              )
              expect(login.status).toBe(200)
              const loginBody = yield* json(login, LoginBody)

              const me = yield* HttpClient.execute(
                HttpClientRequest.get("/api/auth/me").pipe(
                  HttpClientRequest.setHeader("Authorization", `Bearer ${loginBody.token}`)
                )
              )
              expect(me.status).toBe(200)
              const meBody = yield* json(me, MeBody)
              expect(meBody.collection).toBe("e2e_mysql_users")
              expect(meBody.record.id).toBe(user.id)

              const secondRegistered = yield* HttpClient.execute(
                HttpClientRequest.post("/api/collections/e2e_mysql_users").pipe(
                  HttpClientRequest.bodyJsonUnsafe({
                    email: "e2e-mysql-2@example.com",
                    password: "correct-password",
                    passwordConfirm: "correct-password"
                  })
                )
              )
              expect(secondRegistered.status).toBe(201)
              const secondUser = yield* json(secondRegistered, AuthRecord)
              const secondLogin = yield* HttpClient.execute(
                HttpClientRequest.post(
                  "/api/collections/e2e_mysql_users/auth-with-password"
                ).pipe(
                  HttpClientRequest.bodyJsonUnsafe({
                    email: "e2e-mysql-2@example.com",
                    password: "correct-password"
                  })
                )
              )
              expect(secondLogin.status).toBe(200)
              const secondToken = (yield* json(secondLogin, LoginBody)).token

              const forbiddenDelete = yield* HttpClient.execute(
                HttpClientRequest.delete(
                  `/api/collections/e2e_mysql_users/${user.id}`
                ).pipe(
                  HttpClientRequest.setHeader(
                    "Authorization",
                    `Bearer ${secondToken}`
                  )
                )
              )
              expect(forbiddenDelete.status).toBe(403)

              const ownDelete = yield* HttpClient.execute(
                HttpClientRequest.delete(
                  `/api/collections/e2e_mysql_users/${secondUser.id}`
                ).pipe(
                  HttpClientRequest.setHeader(
                    "Authorization",
                    `Bearer ${secondToken}`
                  )
                )
              )
              expect(ownDelete.status).toBe(204)

              const young = yield* HttpClient.execute(
                HttpClientRequest.post("/api/collections/e2e_mysql_aged").pipe(
                  HttpClientRequest.bodyJsonUnsafe({ age: 17 })
                )
              )
              expect(young.status).toBe(403)
              const adult = yield* HttpClient.execute(
                HttpClientRequest.post("/api/collections/e2e_mysql_aged").pipe(
                  HttpClientRequest.bodyJsonUnsafe({ age: 18 })
                )
              )
              expect(adult.status).toBe(201)
              const adultBody = yield* json(
                adult,
                Schema.Struct({ id: Schema.String })
              )
              const blockedUpdate = yield* HttpClient.execute(
                HttpClientRequest.patch(
                  `/api/collections/e2e_mysql_aged/${adultBody.id}`
                ).pipe(HttpClientRequest.bodyJsonUnsafe({ age: 17 }))
              )
              expect(blockedUpdate.status).toBe(403)
              const allowedUpdate = yield* HttpClient.execute(
                HttpClientRequest.patch(
                  `/api/collections/e2e_mysql_aged/${adultBody.id}`
                ).pipe(HttpClientRequest.bodyJsonUnsafe({ age: 20 }))
              )
              expect(allowedUpdate.status).toBe(200)

              const created = yield* HttpClient.execute(
                HttpClientRequest.post("/api/collections/e2e_mysql_posts").pipe(
                  HttpClientRequest.bodyJsonUnsafe({
                    title: "Beta",
                    published: true,
                    views: 3,
                    age: 20
                  })
                )
              )
              expect(created.status).toBe(201)
              const post = yield* json(created, PostItem)
              expect(post.published).toBe(true)
              expect(post.views).toBe(3)

              const fetched = yield* HttpClient.execute(
                HttpClientRequest.get(`/api/collections/e2e_mysql_posts/${post.id}`)
              )
              expect(fetched.status).toBe(200)
              const fetchedPost = yield* json(fetched, PostItem)
              expect(fetchedPost.id).toBe(post.id)

              const second = yield* HttpClient.execute(
                HttpClientRequest.post("/api/collections/e2e_mysql_posts").pipe(
                  HttpClientRequest.bodyJsonUnsafe({
                    title: "Alpha",
                    published: false,
                    views: 1,
                    age: 30
                  })
                )
              )
              expect(second.status).toBe(201)

              const firstPage = yield* HttpClient.execute(
                HttpClientRequest.get("/api/collections/e2e_mysql_posts?limit=1")
              )
              expect(firstPage.status).toBe(200)
              const firstPageBody = yield* json(firstPage, ListBody)
              expect(firstPageBody.items).toHaveLength(1)
              expect(firstPageBody.nextCursor).not.toBeNull()
              if (firstPageBody.nextCursor === null) {
                return yield* Effect.die("expected a next cursor")
              }
              const secondPage = yield* HttpClient.execute(
                HttpClientRequest.get(
                  `/api/collections/e2e_mysql_posts?limit=1&after=${encodeURIComponent(String(firstPageBody.nextCursor))}`
                )
              )
              expect(secondPage.status).toBe(200)
              const secondPageBody = yield* json(secondPage, ListBody)
              expect(secondPageBody.items[0]?.id).not.toBe(firstPageBody.items[0]?.id)

              const listed = yield* HttpClient.execute(
                HttpClientRequest.get("/api/collections/e2e_mysql_posts?limit=10")
              )
              expect(listed.status).toBe(200)
              const page = yield* json(listed, ListBody)
              expect(page.items.some((item) => item.id === post.id)).toBe(true)

              const filtered = yield* HttpClient.execute(
                HttpClientRequest.get(filterQuery("like", "title", "%Bet%"))
              )
              expect(filtered.status).toBe(200)
              const filteredPage = yield* json(filtered, ListBody)
              expect(filteredPage.items.some((item) => item.id === post.id)).toBe(true)

              const sorted = yield* HttpClient.execute(
                HttpClientRequest.get(
                  "/api/collections/e2e_mysql_posts?sort=title&order=asc"
                )
              )
              expect(sorted.status).toBe(200)
              const sortedPage = yield* json(sorted, ListBody)
              const sortedTitles = sortedPage.items.map((item) => item.title)
              expect(sortedTitles.indexOf("Alpha")).toBeGreaterThanOrEqual(0)
              expect(sortedTitles.indexOf("Beta")).toBeGreaterThanOrEqual(0)
              expect(sortedTitles.indexOf("Alpha")).toBeLessThan(
                sortedTitles.indexOf("Beta")
              )

              const updated = yield* HttpClient.execute(
                HttpClientRequest.patch(`/api/collections/e2e_mysql_posts/${post.id}`).pipe(
                  HttpClientRequest.bodyJsonUnsafe({ title: "Gamma" })
                )
              )
              expect(updated.status).toBe(200)

              const view = yield* HttpClient.execute(
                HttpClientRequest.get("/api/collections/e2e_mysql_view")
              )
              expect(view.status).toBe(200)
              const viewBody = yield* json(view, ViewList)
              expect(viewBody.items.length).toBeGreaterThanOrEqual(1)

              const lockedCreate = yield* HttpClient.execute(
                HttpClientRequest.post("/api/collections/e2e_mysql_locked").pipe(
                  HttpClientRequest.bodyJsonUnsafe({ title: "no" })
                )
              )
              expect(lockedCreate.status).toBe(403)

              const bulk = yield* HttpClient.execute(
                HttpClientRequest.post("/api/collections/e2e_mysql_posts/bulk").pipe(
                  HttpClientRequest.bodyJsonUnsafe({
                    records: [{ title: "One" }, { title: "Two" }]
                  })
                )
              )
              expect(bulk.status).toBe(201)
              const bulkBody = yield* json(bulk, BulkBody)
              expect(bulkBody.records).toHaveLength(2)

              const bulkIds = bulkBody.records.map((record) => record.id)
              const bulkUpdate = yield* HttpClient.execute(
                HttpClientRequest.patch("/api/collections/e2e_mysql_posts/bulk").pipe(
                  HttpClientRequest.bodyJsonUnsafe({
                    records: bulkIds.map((id) => ({ id, data: { title: "Bulk" } }))
                  })
                )
              )
              expect(bulkUpdate.status).toBe(200)

              const bulkDelete = yield* HttpClient.execute(
                HttpClientRequest.delete("/api/collections/e2e_mysql_posts/bulk").pipe(
                  HttpClientRequest.bodyJsonUnsafe({ ids: bulkIds })
                )
              )
              expect(bulkDelete.status).toBe(200)

              const removed = yield* HttpClient.execute(
                HttpClientRequest.delete(`/api/collections/e2e_mysql_posts/${post.id}`)
              )
              expect(removed.status).toBe(204)
              const secondDelete = yield* HttpClient.execute(
                HttpClientRequest.delete(`/api/collections/e2e_mysql_posts/${post.id}`)
              )
              expect(secondDelete.status).toBe(404)

              const logout = yield* HttpClient.execute(
                HttpClientRequest.post("/api/auth/logout").pipe(
                  HttpClientRequest.setHeader("Authorization", `Bearer ${loginBody.token}`)
                )
              )
              expect([200, 204]).toContain(logout.status)

              const afterLogout = yield* HttpClient.execute(
                HttpClientRequest.get("/api/auth/me").pipe(
                  HttpClientRequest.setHeader("Authorization", `Bearer ${loginBody.token}`)
                )
              )
              expect(afterLogout.status).toBe(401)
            }).pipe(Effect.provide(appLayer))
          })
        ),
      180_000
    )

    it.effect(
      "supports a big seqId cursor and migrateAtStartup false",
      () =>
        withEngine(url, (databaseUrlValue) =>
          Effect.gen(function* () {
            const noMigrate = Mira.builder()
              .platform(NodePlatform)
              .database(
                MysqlDatabase({
                  url: Redacted.make(databaseUrlValue),
                  migrateAtStartup: false
                })
              )
              .storage(
                LocalFileStorage({
                  directory: join(
                    mkdtempSync(join(tmpdir(), "mira-mysql-nomigrate-")),
                    "uploads"
                  )
                })
              )
              .collections(collections)
              .build()
            const noMigrateCtx = yield* Layer.build(noMigrate.buildServiceLayer())
            yield* Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient
              const tables = yield* sql<{ name: string }>`
                SELECT TABLE_NAME AS name FROM information_schema.tables
                WHERE TABLE_SCHEMA = DATABASE()
                  AND TABLE_NAME IN ('e2e_mysql_posts', '_config', '_auth_challenges')
              `
              const names = tables.map((row) => row.name)
              expect(names).toContain("_config")
              expect(names).toContain("_auth_challenges")
              expect(names).not.toContain("e2e_mysql_posts")
            }).pipe(Effect.provide(noMigrateCtx))

            const app = createApp(databaseUrlValue)
            yield* Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient
              yield* sql.unsafe(
                "ALTER TABLE `e2e_mysql_cursor` AUTO_INCREMENT = 9007199254740993"
              )
              yield* sql.unsafe(
                "INSERT INTO `e2e_mysql_cursor` (`id`, `title`, `created`, `updated`) VALUES ('big-1', 'Big One', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'), ('big-2', 'Big Two', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')"
              )
              const rows = yield* sql<{ seqId: string | number }>`
                SELECT \`seqId\` FROM \`e2e_mysql_cursor\` ORDER BY \`seqId\` ASC
              `
              expect(String(rows[0]?.seqId)).toBe("9007199254740993")

              const migrations = yield* sql<{ n: number }>`
                SELECT COUNT(*) AS n FROM \`_migrations\`
              `
              expect(Number(migrations[0]?.n)).toBeGreaterThan(0)

              const now = new Date().toISOString()
              yield* sql`INSERT INTO ${sql("e2e_mysql_posts")} ${sql.insert({
                id: "direct-delete",
                title: "Direct",
                published: 0,
                views: 0,
                created: now,
                updated: now
              })}`
              const deletedRaw = yield* sql
                .unsafe("DELETE FROM `e2e_mysql_posts` WHERE `id` = ?", ["direct-delete"])
                .raw
              expect(readMysqlAffectedRows(deletedRaw)).toEqual(Option.some(1))
              const deletedAgain = yield* sql
                .unsafe("DELETE FROM `e2e_mysql_posts` WHERE `id` = ?", ["direct-delete"])
                .raw
              expect(readMysqlAffectedRows(deletedAgain)).toEqual(Option.some(0))
            }).pipe(Effect.provide(app.buildServiceLayer()))

            yield* Effect.gen(function* () {
              yield* serveRouter
              const res = yield* HttpClient.execute(
                HttpClientRequest.get("/api/collections/e2e_mysql_cursor?limit=1")
              )
              expect(res.status).toBe(200)
              const body = yield* json(res, CursorListBody)
              expect(body.nextCursor).toBe("9007199254740993")
              expect(body.items[0]?.id).toBe("big-1")

              const second = yield* HttpClient.execute(
                HttpClientRequest.get(
                  "/api/collections/e2e_mysql_cursor?limit=1&after=9007199254740993"
                )
              )
              expect(second.status).toBe(200)
              const secondBody = yield* json(second, CursorListBody)
              expect(secondBody.items[0]?.id).toBe("big-2")
              expect(secondBody.nextCursor).toBeNull()
            }).pipe(
              Effect.provide(
                Layer.merge(app.buildServiceLayer(), NodeHttpServer.layerTest)
              )
            )
          })
        ),
      180_000
    )
  })
}

