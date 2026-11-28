/**
 * Gated PostgreSQL cursor behavior suite.
 *
 * Run with a real PostgreSQL 15+ server:
 *
 *   $env:MIRA_TEST_POSTGRES_URL = "postgres://postgres:mira@127.0.0.1:55432/mira_test"
 *   pnpm --filter @gettersethya/mira exec vitest run tests/databases/postgres-cursor.e2e.test.ts
 *
 * The file self-skips when the URL is absent. Its dedicated metadata pair is
 * e2e_cursor_collections/e2e_cursor_migrations. Every run starts by dropping
 * that pair plus the data table and fixed internal tables. Do not run this file
 * in parallel with another gated PostgreSQL suite.
 */
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { NodeHttpServer } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { describe, it } from "@effect/vitest"
import { BaseCollection, Field } from "@gettersethya/mira-client"
import { Effect, Layer, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpIncomingMessage, HttpRouter, HttpServer } from "effect/http"
import { SqlClient } from "effect/sql"
import { expect } from "vitest"

import { applyRulesToCollections, defineRule, Mira } from "@/app/index.js"
import { CollectionService } from "@/collection-service/collection-service.js"
import type { RequestCtx } from "@/collection-service/context.js"
import { PostgresDatabase } from "@/databases/postgres.js"
import { makeCollectionRouter } from "@/http/router.js"
import { NodePlatform } from "@/platforms/node.js"
import { LocalFileStorage } from "@/storage/local-preset.js"

function closeEffect<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, never> {
  // The app layer is closed at runtime; the test graph widens R through
  // plugin/cron config, so this helper restores the closed run type.
  // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion, typescript/consistent-type-assertions
  return effect as Effect.Effect<A, E, never>
}

const postgresUrl = process.env["MIRA_TEST_POSTGRES_URL"]
const enabled = postgresUrl !== undefined
const describeE2E = enabled ? describe : describe.skip
const url = postgresUrl ?? "postgres://postgres:mira@127.0.0.1:55432/mira_test"

const metadataOptions = {
  schemaTable: "e2e_cursor_collections",
  migrationsTable: "e2e_cursor_migrations"
}

const quoteName = (name: string) => `"${name.replaceAll('"', '""')}"`

const dropTable = (name: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.unsafe(`DROP TABLE IF EXISTS ${quoteName(name)} CASCADE`).pipe(Effect.ignore)
  })

const cleanupCursorDatabase = Effect.gen(function* () {
  for (const name of [
    "e2e_cursor_collections",
    "e2e_cursor_migrations",
    "e2e_pg_posts",
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

const PostsDef = BaseCollection.define("e2e_pg_posts", {
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
const [Posts] = applyRulesToCollections([PostsDef], [postsRules])

const PostItem = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  published: Schema.Boolean
})
const Page = Schema.Struct({
  items: Schema.Array(PostItem),
  nextCursor: Schema.NullOr(Schema.String)
})

const json = <S extends Schema.ConstraintCodec<unknown>, E>(
  res: HttpIncomingMessage.HttpIncomingMessage<E>,
  schema: S
) => HttpIncomingMessage.schemaBodyJson(schema)(res)

const adminCtx: RequestCtx = { headers: {}, query: {}, admin: true }

const serveRouter = Effect.flatMap(
  HttpRouter.toHttpEffect(HttpRouter.addAll(makeCollectionRouter([Posts]))),
  HttpServer.serveEffect()
)

const createApp = () =>
  Mira.builder()
    .platform(NodePlatform)
    .database(PostgresDatabase({ url: Redacted.make(url) }))
    .storage(
      LocalFileStorage({
        directory: join(mkdtempSync(join(tmpdir(), "mira-pg-cursor-")), "uploads")
      })
    )
    .collections([Posts])
    .migrations(metadataOptions)
    .build()

describeE2E("PostgreSQL cursors", () => {
  it.effect(
    "pages across 2^53 with string cursors, sorted keysets, and admin seqIds",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const cleanupCtx = yield* Layer.build(PgClient.layer({ url: Redacted.make(url), maxConnections: 1 }))
          yield* cleanupCursorDatabase.pipe(Effect.provide(cleanupCtx))

          const app = createApp()
          const appCtx = yield* Layer.build(app.buildServiceLayer().pipe(Layer.provideMerge(NodeHttpServer.layerTest)))

          yield* Effect.gen(function* () {
            yield* serveRouter
            const sql = yield* SqlClient.SqlClient

            yield* sql.unsafe(`ALTER TABLE "e2e_pg_posts" ALTER COLUMN "seqId" RESTART WITH 9007199254740993`)

            const first = yield* HttpClient.execute(
              HttpClientRequest.post("/api/collections/e2e_pg_posts").pipe(
                HttpClientRequest.bodyJsonUnsafe({ title: "alpha" })
              )
            )
            expect(first.status).toBe(201)
            const firstBody = yield* json(first, Schema.Struct({ id: Schema.String }))

            const second = yield* HttpClient.execute(
              HttpClientRequest.post("/api/collections/e2e_pg_posts").pipe(
                HttpClientRequest.bodyJsonUnsafe({ title: "beta" })
              )
            )
            expect(second.status).toBe(201)
            const secondBody = yield* json(second, Schema.Struct({ id: Schema.String }))

            const pageOne = yield* HttpClient.get("/api/collections/e2e_pg_posts?limit=1")
            expect(pageOne.status).toBe(200)
            const pageOneBody = yield* json(pageOne, Page)
            expect(pageOneBody.items).toHaveLength(1)
            expect(pageOneBody.items[0]?.id).toBe(firstBody.id)
            expect(pageOneBody.nextCursor).toBe("9007199254740993")

            if (pageOneBody.nextCursor === null) {
              return yield* Effect.die("expected the first page cursor")
            }
            const pageTwo = yield* HttpClient.get(
              `/api/collections/e2e_pg_posts?limit=1&after=${encodeURIComponent(pageOneBody.nextCursor)}`
            )
            expect(pageTwo.status).toBe(200)
            const pageTwoBody = yield* json(pageTwo, Page)
            expect(pageTwoBody.items[0]?.id).toBe(secondBody.id)

            const outOfRange = yield* HttpClient.get(
              `/api/collections/e2e_pg_posts?limit=1&after=${encodeURIComponent("9223372036854775808")}`
            )
            expect(outOfRange.status).toBe(200)
            const outOfRangeBody = yield* json(outOfRange, Page)
            expect(outOfRangeBody.items[0]?.id).toBe(firstBody.id)

            const titlePage = yield* HttpClient.get("/api/collections/e2e_pg_posts?sort=title&order=asc&limit=1")
            expect(titlePage.status).toBe(200)
            const titlePageBody = yield* json(titlePage, Page)
            expect(titlePageBody.items[0]?.title).toBe("alpha")
            expect(typeof titlePageBody.nextCursor).toBe("string")
            if (titlePageBody.nextCursor === null) {
              return yield* Effect.die("expected the title cursor")
            }
            const titleCursor = titlePageBody.nextCursor
            const titleNext = yield* HttpClient.get(
              `/api/collections/e2e_pg_posts?sort=title&order=asc&limit=1&after=${encodeURIComponent(titleCursor)}`
            )
            expect(titleNext.status).toBe(200)
            const titleNextBody = yield* json(titleNext, Page)
            expect(titleNextBody.items[0]?.title).toBe("beta")

            const svc = yield* CollectionService
            // seqId is hidden from public sort fields, so the descending leg
            // uses the service-level admin context, matching the SDK contract
            // that a public caller pages by seqId through the returned cursor.
            const descending = yield* svc.list(Posts, null, 1, adminCtx, undefined, {
              field: "seqId",
              direction: "desc"
            })
            expect(descending.items[0]?.id).toBe(secondBody.id)
            expect(typeof descending.nextCursor).toBe("string")
            if (descending.nextCursor === null) {
              return yield* Effect.die("expected the descending cursor")
            }
            const descendingCursor = descending.nextCursor
            const descendingNext = yield* svc.list(Posts, descendingCursor, 1, adminCtx, undefined, {
              field: "seqId",
              direction: "desc"
            })
            expect(descendingNext.items[0]?.id).toBe(firstBody.id)

            const adminRow = yield* svc.view(Posts, secondBody.id, adminCtx)
            expect(adminRow["seqId"]).toBe("9007199254740994")
            const serialized = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(adminRow)
            expect(typeof serialized).toBe("string")
            if (typeof serialized === "string") {
              expect(serialized).toContain('"seqId"')
            }

            const deleted = yield* HttpClient.execute(
              HttpClientRequest.delete(`/api/collections/e2e_pg_posts/${firstBody.id}`)
            )
            expect(deleted.status).toBe(204)

            const staleCursor = yield* HttpClient.get(
              `/api/collections/e2e_pg_posts?sort=title&order=asc&limit=1&after=${encodeURIComponent(titleCursor)}`
            )
            expect(staleCursor.status).toBe(422)
          }).pipe(Effect.provide(appCtx))
        })
      ).pipe(closeEffect),
    120_000
  )
})
