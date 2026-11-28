/**
 * Gated PostgreSQL HTTP behavior suite.
 *
 * Run with a real PostgreSQL 15+ server:
 *
 *   $env:MIRA_TEST_POSTGRES_URL = "postgres://postgres:mira@127.0.0.1:55432/mira_test"
 *   pnpm --filter @gettersethya/mira exec vitest run tests/databases/postgres.e2e.test.ts
 *
 * The file self-skips when the URL is absent. Its dedicated metadata pair is
 * e2e_http_collections/e2e_http_migrations, and every app build starts by
 * dropping that pair plus the suite's data objects and the fixed-name internal
 * tables. Do not run this file in parallel with another gated PostgreSQL
 * suite: the fixed internal tables would collide.
 */
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { NodeHttpServer } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { describe, it } from "@effect/vitest"
import { AuthCollection, BaseCollection, Field, Rule, ViewCollection } from "@gettersethya/mira-client"
import { Effect, Layer, Redacted, Schema, Schedule } from "effect"
import { HttpClient, HttpClientRequest, HttpIncomingMessage, HttpRouter, HttpServer } from "effect/http"
import { SqlClient } from "effect/sql"
import { expect } from "vitest"

import { applyRulesToCollections, defineRule, Mira, type RuleBinding } from "@/app/index.js"
import { AuthChallengeStore } from "@/auth/index.js"
import { CollectionService } from "@/collection-service/collection-service.js"
import type { RequestCtx } from "@/collection-service/context.js"
import { AppConfig } from "@/config/index.js"
import { CronService } from "@/cron/cron-service.js"
import { PostgresDatabase } from "@/databases/postgres.js"
import { TokenStore } from "@/http/token-store.js"
import { makeCollectionRouter } from "@/http/router.js"
import { NodePlatform } from "@/platforms/node.js"
import { RateLimitStore } from "@/rate-limit/index.js"
import { LocalFileStorage } from "@/storage/local-preset.js"
import { makeTelemetryLayer } from "@/telemetry/layer.js"

function closeEffect<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, never> {
  // The app layer is closed at runtime; the test graph widens R through
  // plugin/cron config, so this helper restores the closed run type.
  // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion, typescript/consistent-type-assertions
  return effect as Effect.Effect<A, E, never>
}
import { TelemetryStore } from "@/telemetry/store.js"

const postgresUrl = process.env["MIRA_TEST_POSTGRES_URL"]
const enabled = postgresUrl !== undefined
const describeE2E = enabled ? describe : describe.skip
const url = postgresUrl ?? "postgres://postgres:mira@127.0.0.1:55432/mira_test"

const metadataOptions = {
  schemaTable: "e2e_http_collections",
  migrationsTable: "e2e_http_migrations"
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

const cleanupHttpDatabase = Effect.gen(function* () {
  yield* dropView("e2e_pg_view")
  for (const name of [
    "e2e_http_collections",
    "e2e_http_migrations",
    "e2e_pg_posts",
    "e2e_pg_locked",
    "e2e_pg_users",
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

const database = PostgresDatabase({ url: Redacted.make(url) })

const UsersDef = AuthCollection.define("e2e_pg_users", {})
const usersRules = defineRule(UsersDef, (R) => ({
  list: R.public(),
  view: R.public(),
  create: R.public(),
  update: R.field("id").eq(R.selfId()),
  delete: R.field("id").eq(R.selfId())
}))

const postFields = {
  title: Field.text({ required: true }),
  published: Field.boolean({ default: false }),
  views: Field.integer({ default: 0 }),
  age: Field.integer({ required: false }),
  author: Field.relation(UsersDef, { required: false }),
  secret: Field.text({ required: false, hidden: true })
}

const PostsDef = BaseCollection.define("e2e_pg_posts", postFields)
const postsRules = defineRule(PostsDef, (R) => ({
  list: R.public(),
  view: R.public(),
  create: R.public(),
  update: R.public(),
  delete: R.public()
}))

const LockedDef = BaseCollection.define("e2e_pg_locked", {
  title: Field.text({ required: true })
})
const lockedRules = defineRule(LockedDef, (R) => ({
  list: R.public(),
  view: R.public()
}))

const PostsViewDef = ViewCollection.define(
  "e2e_pg_view",
  `SELECT id, "seqId", title, COUNT(*) AS total, COALESCE(SUM(views), 0) AS total_views, json_build_object('a', 1) AS meta
   FROM e2e_pg_posts
   GROUP BY id, "seqId", title`,
  {
    id: Field.text().view(),
    seqId: Field.integer().view(),
    title: Field.text().view(),
    total: Field.integer().view(),
    total_views: Field.integer().view(),
    meta: Field.json().view()
  }
)
const viewRules = defineRule(PostsViewDef, (R) => ({
  list: R.public(),
  view: R.public()
}))

const [Posts, Locked, Users, PostsView] = applyRulesToCollections(
  [PostsDef, LockedDef, UsersDef, PostsViewDef],
  [postsRules, lockedRules, usersRules, viewRules]
)

const collections = [Posts, Locked, Users, PostsView]

const ageRuleBinding: RuleBinding = {
  _tag: "RuleBinding",
  collectionName: "e2e_pg_posts",
  ruleMap: {
    list: Rule.field("age").gte(Rule.literal("18")),
    view: Rule.public(),
    create: Rule.public(),
    update: Rule.public(),
    delete: Rule.public()
  }
}
const [AgePosts] = applyRulesToCollections([PostsDef], [ageRuleBinding])

const seqIdRuleBinding: RuleBinding = {
  _tag: "RuleBinding",
  collectionName: "e2e_pg_posts",
  ruleMap: {
    list: Rule.field("seqId").gt(Rule.literal("2147483648")),
    view: Rule.public(),
    create: Rule.public(),
    update: Rule.public(),
    delete: Rule.public()
  }
}
const [SeqIdPosts] = applyRulesToCollections([PostsDef], [seqIdRuleBinding])

const IdResponse = Schema.Struct({ id: Schema.String })
const PostItem = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  published: Schema.Boolean,
  views: Schema.Finite,
  age: Schema.NullOr(Schema.Finite),
  secret: Schema.optional(Schema.String)
})
const PostList = Schema.Struct({
  items: Schema.Array(PostItem),
  nextCursor: Schema.NullOr(Schema.String)
})
const AuthRecord = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  password: Schema.optional(Schema.Unknown)
})
const LoginBody = Schema.Struct({ token: Schema.String })
const MeBody = Schema.Struct({
  collection: Schema.String,
  record: Schema.Struct({ id: Schema.String, email: Schema.String })
})
const BulkBody = Schema.Struct({ records: Schema.Array(Schema.Unknown) })
const ExpandedPost = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  secret: Schema.optional(Schema.String),
  expand: Schema.Struct({
    author: Schema.Struct({ id: Schema.String, email: Schema.String })
  })
})
const ViewRow = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  total: Schema.Finite,
  total_views: Schema.Finite,
  meta: Schema.String
})
const ViewList = Schema.Struct({
  items: Schema.Array(ViewRow),
  nextCursor: Schema.NullOr(Schema.String)
})

const encodeFilter = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      op: Schema.String,
      field: Schema.String,
      value: Schema.Unknown
    })
  )
)

const filterQuery = (op: string, field: string, value: unknown, extra = "") =>
  `/api/collections/e2e_pg_posts?filter=${encodeURIComponent(encodeFilter({ op, field, value }))}${extra}`

const json = <S extends Schema.ConstraintCodec<unknown>, E>(
  res: HttpIncomingMessage.HttpIncomingMessage<E>,
  schema: S
) => HttpIncomingMessage.schemaBodyJson(schema)(res)

const realDelay = (millis: number) => Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, millis)))

const noCtx: RequestCtx = { headers: {}, query: {} }
const adminCtx: RequestCtx = { headers: {}, query: {}, admin: true }

const serveRouter = Effect.flatMap(
  HttpRouter.toHttpEffect(HttpRouter.addAll(makeCollectionRouter(collections))),
  HttpServer.serveEffect()
)

const tableNames = (names: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ table_name: string }>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = current_schema()
    `
    return rows.map((row) => row.table_name).filter((name) => names.includes(name))
  })

const CronEntry = Schema.Struct({
  lastStatus: Schema.NullOr(Schema.Literals(["success", "error"]))
})
const CronState = Schema.fromJsonString(Schema.Record(Schema.String, CronEntry))

const createApp = () =>
  Mira.builder()
    .platform(NodePlatform)
    .database(database)
    .storage(
      LocalFileStorage({
        directory: join(mkdtempSync(join(tmpdir(), "mira-pg-http-")), "uploads")
      })
    )
    .collections(collections)
    .migrations(metadataOptions)
    .build()

const createStoreApp = () =>
  Mira.builder()
    .platform(NodePlatform)
    .database(database)
    .storage(
      LocalFileStorage({
        directory: join(mkdtempSync(join(tmpdir(), "mira-pg-stores-")), "uploads")
      })
    )
    .collections(collections)
    .migrations(metadataOptions)
    .crons([
      {
        name: "e2e-pg-cron",
        schedule: Schedule.duration("24 hours"),
        handler: () => Effect.void
      }
    ])
    .build()

const createTelemetryApp = () =>
  Mira.builder()
    .platform(NodePlatform)
    .database(database)
    .storage(
      LocalFileStorage({
        directory: join(mkdtempSync(join(tmpdir(), "mira-pg-telemetry-")), "uploads")
      })
    )
    .collections([Posts])
    .migrations(metadataOptions)
    .telemetry(
      makeTelemetryLayer({
        storage: { mode: "shared" },
        flushBatchSize: 100,
        flushInterval: "1 second"
      })
    )
    .build()

describeE2E("PostgreSQL HTTP behavior", () => {
  it.effect(
    "serves CRUD, filters, rules, auth, views, and a high-water admin seqId",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const cleanupCtx = yield* Layer.build(PgClient.layer({ url: Redacted.make(url), maxConnections: 1 }))
          yield* cleanupHttpDatabase.pipe(Effect.provide(cleanupCtx))

          const app = createApp()
          const appCtx = yield* Layer.build(app.buildServiceLayer().pipe(Layer.provideMerge(NodeHttpServer.layerTest)))

          yield* Effect.gen(function* () {
            yield* serveRouter

            const registered = yield* HttpClient.execute(
              HttpClientRequest.post("/api/collections/e2e_pg_users").pipe(
                HttpClientRequest.bodyJsonUnsafe({
                  email: "e2e-pg@example.com",
                  password: "correct-password",
                  passwordConfirm: "correct-password"
                })
              )
            )
            expect(registered.status).toBe(201)
            const user = yield* json(registered, AuthRecord)
            expect(user.password).toBeUndefined()

            const login = yield* HttpClient.execute(
              HttpClientRequest.post("/api/collections/e2e_pg_users/auth-with-password").pipe(
                HttpClientRequest.bodyJsonUnsafe({
                  email: "e2e-pg@example.com",
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
            expect(meBody.collection).toBe("e2e_pg_users")
            expect(meBody.record.id).toBe(user.id)
            expect(meBody.record.email).toBe("e2e-pg@example.com")

            const createPost = (payload: Record<string, unknown>) =>
              HttpClient.execute(
                HttpClientRequest.post("/api/collections/e2e_pg_posts").pipe(HttpClientRequest.bodyJsonUnsafe(payload))
              )

            const one = yield* createPost({
              title: "one",
              published: true,
              views: 10,
              age: 18,
              author: user.id,
              secret: "hidden-one"
            })
            expect(one.status).toBe(201)
            const first = yield* json(one, PostItem)
            expect(first.secret).toBeUndefined()

            const two = yield* createPost({
              title: "two",
              published: false,
              views: 0,
              age: 9,
              author: user.id
            })
            expect(two.status).toBe(201)

            const five = yield* createPost({
              title: "5",
              published: false,
              views: 5,
              age: 18
            })
            expect(five.status).toBe(201)

            const listed = yield* HttpClient.get("/api/collections/e2e_pg_posts")
            expect(listed.status).toBe(200)
            const listBody = yield* json(listed, PostList)
            expect(listBody.items).toHaveLength(3)
            for (const item of listBody.items) {
              expect(Object.hasOwn(item, "secret")).toBe(false)
            }

            const numberOnText = yield* HttpClient.get(filterQuery("eq", "title", 5))
            expect(numberOnText.status).toBe(200)
            const numberBody = yield* json(numberOnText, PostList)
            expect(numberBody.items.map((item) => item.title)).toEqual(["5"])

            const likeNumber = yield* HttpClient.get(filterQuery("like", "title", 5))
            expect(likeNumber.status).toBe(422)

            const likeNonText = yield* HttpClient.get(filterQuery("like", "age", "1%"))
            expect(likeNonText.status).toBe(200)
            const likeBody = yield* json(likeNonText, PostList)
            expect(likeBody.items).toHaveLength(2)
            expect(likeBody.items.every((item) => item.age === 18)).toBe(true)

            const badInteger = yield* HttpClient.get(filterQuery("eq", "views", "not-a-number"))
            expect(badInteger.status).toBe(422)

            const booleanFilter = yield* HttpClient.get(filterQuery("eq", "published", true))
            expect(booleanFilter.status).toBe(200)
            const booleanBody = yield* json(booleanFilter, PostList)
            expect(booleanBody.items.map((item) => item.title)).toEqual(["one"])

            const sorted = yield* HttpClient.get("/api/collections/e2e_pg_posts?sort=title&order=asc")
            expect(sorted.status).toBe(200)
            const sortedBody = yield* json(sorted, PostList)
            expect(sortedBody.items.map((item) => item.title)).toEqual(["5", "one", "two"])

            const page = yield* HttpClient.get("/api/collections/e2e_pg_posts?limit=1")
            expect(page.status).toBe(200)
            const pageBody = yield* json(page, PostList)
            expect(pageBody.items).toHaveLength(1)
            expect(typeof pageBody.nextCursor).toBe("string")
            if (pageBody.nextCursor === null) {
              return yield* Effect.die("expected a next cursor")
            }
            const next = yield* HttpClient.get(
              `/api/collections/e2e_pg_posts?limit=1&after=${encodeURIComponent(pageBody.nextCursor)}`
            )
            expect(next.status).toBe(200)
            const nextBody = yield* json(next, PostList)
            expect(nextBody.items[0]?.id).not.toBe(pageBody.items[0]?.id)

            const updated = yield* HttpClient.execute(
              HttpClientRequest.patch(`/api/collections/e2e_pg_posts/${first.id}`).pipe(
                HttpClientRequest.bodyJsonUnsafe({ title: "one-updated" })
              )
            )
            expect(updated.status).toBe(200)
            const updatedBody = yield* json(updated, PostItem)
            expect(updatedBody.title).toBe("one-updated")

            const bulk = yield* HttpClient.execute(
              HttpClientRequest.post("/api/collections/e2e_pg_posts/bulk").pipe(
                HttpClientRequest.bodyJsonUnsafe({
                  records: [{ title: "bulk-1" }, { title: "bulk-2" }]
                })
              )
            )
            expect(bulk.status).toBe(201)
            const bulkBody = yield* json(bulk, BulkBody)
            expect(bulkBody.records).toHaveLength(2)

            const denied = yield* HttpClient.execute(
              HttpClientRequest.post("/api/collections/e2e_pg_locked").pipe(
                HttpClientRequest.bodyJsonUnsafe({ title: "nope" })
              )
            )
            expect(denied.status).toBe(403)

            const expanded = yield* HttpClient.get(`/api/collections/e2e_pg_posts/${first.id}?expand=author`)
            expect(expanded.status).toBe(200)
            const expandedBody = yield* json(expanded, ExpandedPost)
            expect(expandedBody.expand.author.id).toBe(user.id)
            expect(expandedBody.expand.author.email).toBe("e2e-pg@example.com")
            expect(expandedBody.secret).toBeUndefined()

            const view = yield* HttpClient.get("/api/collections/e2e_pg_view")
            expect(view.status).toBe(200)
            const viewBody = yield* json(view, ViewList)
            const updatedRow = viewBody.items.find((row) => row.id === first.id)
            expect(updatedRow).toBeDefined()
            if (updatedRow === undefined) {
              return yield* Effect.die("expected the view row")
            }
            expect(updatedRow.title).toBe("one-updated")
            expect(typeof updatedRow.total).toBe("number")
            expect(typeof updatedRow.total_views).toBe("number")
            expect(updatedRow.total_views).toBe(10)
            expect(typeof updatedRow.meta).toBe("string")
            expect(updatedRow.meta).toContain('"a"')

            const svc = yield* CollectionService
            const ageRestricted = yield* svc.list(AgePosts, null, 20, noCtx)
            expect(ageRestricted.items.some((row) => row["title"] === "two")).toBe(false)
            expect(ageRestricted.items.every((row) => typeof row["age"] === "number" && row["age"] >= 18)).toBe(true)

            const sql = yield* SqlClient.SqlClient
            yield* sql.unsafe(`ALTER TABLE "e2e_pg_posts" ALTER COLUMN "seqId" RESTART WITH 2147483649`)
            const big = yield* createPost({
              title: "big",
              published: false,
              views: 1,
              age: 18
            })
            expect(big.status).toBe(201)
            const bigBody = yield* json(big, IdResponse)

            const seqRestricted = yield* svc.list(SeqIdPosts, null, 20, noCtx)
            expect(seqRestricted.items).toHaveLength(1)
            expect(seqRestricted.items[0]?.["title"]).toBe("big")

            const adminRow = yield* svc.view(Posts, bigBody.id, adminCtx)
            expect(typeof adminRow["seqId"]).toBe("string")
            const serialized = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(adminRow)
            expect(typeof serialized).toBe("string")
            if (typeof serialized === "string") {
              expect(serialized).toContain('"seqId"')
            }
          }).pipe(Effect.provide(appCtx))
        })
      ).pipe(closeEffect),
    120_000
  )

  it.effect(
    "boots internal stores and round-trips cron state through _config",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const cleanupCtx = yield* Layer.build(PgClient.layer({ url: Redacted.make(url), maxConnections: 1 }))
          yield* cleanupHttpDatabase.pipe(Effect.provide(cleanupCtx))

          const app = createStoreApp()
          const appCtx = yield* Layer.build(app.buildServiceLayer())

          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            const tables = yield* tableNames([
              "_config",
              "_auth_challenges",
              "_revoked_tokens",
              "_auth_generations",
              "_rate_limits"
            ])
            expect(tables).toHaveLength(5)

            const config = yield* AppConfig
            expect(config.appName).toBe("mira")

            const now = Date.now()
            const tokens = yield* TokenStore
            yield* tokens.revoke(`e2e-pg-jti-${now}`, now + 60_000)
            expect(yield* tokens.isRevoked(`e2e-pg-jti-${now}`)).toBe(true)

            const challenges = yield* AuthChallengeStore
            yield* challenges.create({
              id: `e2e-pg-challenge-${now}`,
              collection: "e2e_pg_users",
              userId: "e2e-pg-user",
              purpose: "login_otp",
              tokenHash: `e2e-pg-hash-${now}`,
              expiresAt: now + 60_000,
              consumedAt: null,
              attempts: 0,
              createdAt: now,
              newEmail: null
            })
            expect(yield* challenges.findByTokenHash("e2e_pg_users", "login_otp", `e2e-pg-hash-${now}`)).toBeDefined()

            const limits = yield* RateLimitStore
            const result = yield* limits.increment([
              {
                bucket: `e2e-pg-bucket-${now}`,
                limit: 2,
                cost: 1,
                expiresAt: now + 60_000
              }
            ])
            expect(result).toEqual({ ok: true, counts: [1] })

            const cron = yield* CronService
            yield* cron.runNow("e2e-pg-cron")
            yield* realDelay(100)

            const rows = yield* sql<{ value: string }>`
              SELECT value FROM ${sql("_config")} WHERE key = ${"cron_state"}
            `
            const value = rows[0]?.value
            expect(value).toBeDefined()
            if (value === undefined) {
              return yield* Effect.die("expected persisted cron state")
            }
            const state = yield* Schema.decodeEffect(CronState)(value).pipe(Effect.orDie)
            expect(state["e2e-pg-cron"]?.lastStatus).toBe("success")
          }).pipe(Effect.provide(appCtx))
        })
      ).pipe(closeEffect),
    120_000
  )

  it.live(
    "persists shared telemetry and retention",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const cleanupCtx = yield* Layer.build(PgClient.layer({ url: Redacted.make(url), maxConnections: 1 }))
          yield* cleanupHttpDatabase.pipe(Effect.provide(cleanupCtx))

          const app = createTelemetryApp()
          const appCtx = yield* Layer.build(app.buildServiceLayer())

          yield* Effect.gen(function* () {
            const tables = yield* tableNames(["logs", "spans"])
            expect(tables).toHaveLength(2)

            const store = yield* TelemetryStore
            yield* Effect.logInfo("e2e-pg-telemetry-log")
            yield* Effect.void.pipe(Effect.withSpan("e2e-pg-telemetry-span"))
            yield* realDelay(4_000)

            const read = store.read
            if (read === null) {
              return yield* Effect.die("expected telemetry read store")
            }
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
            expect(logs.items.some((row) => row.message === "e2e-pg-telemetry-log")).toBe(true)
            expect(spans.items.some((row) => row.name === "e2e-pg-telemetry-span")).toBe(true)

            const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
            const recent = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString()
            yield* store.appendLogs([
              {
                id: "e2e-pg-old-log",
                level: "INFO",
                message: "old",
                created: old,
                updated: old,
                traceId: null,
                spanId: null
              },
              {
                id: "e2e-pg-recent-log",
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
          }).pipe(Effect.provide(appCtx))
        })
      ).pipe(closeEffect),
    120_000
  )

  it.effect(
    "migrateAtStartup false leaves collection tables absent but bootstraps internal stores",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const cleanupCtx = yield* Layer.build(PgClient.layer({ url: Redacted.make(url), maxConnections: 1 }))
          yield* cleanupHttpDatabase.pipe(Effect.provide(cleanupCtx))

          const app = Mira.builder()
            .platform(NodePlatform)
            .database(PostgresDatabase({ url: Redacted.make(url), migrateAtStartup: false }))
            .storage(
              LocalFileStorage({
                directory: join(mkdtempSync(join(tmpdir(), "mira-pg-boot-")), "uploads")
              })
            )
            .collections(collections)
            .migrations(metadataOptions)
            .build()

          const appCtx = yield* Layer.build(app.buildServiceLayer())

          yield* Effect.gen(function* () {
            const collectionTables = yield* tableNames(["e2e_pg_posts", "e2e_pg_locked", "e2e_pg_users", "e2e_pg_view"])
            expect(collectionTables).toEqual([])

            const internalTables = yield* tableNames([
              "_config",
              "_auth_challenges",
              "_revoked_tokens",
              "_rate_limits",
              "_auth_generations"
            ])
            expect(internalTables).toHaveLength(5)
          }).pipe(Effect.provide(appCtx))
        })
      ).pipe(closeEffect),
    120_000
  )
})
