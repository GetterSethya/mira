import { HttpClient, HttpClientRequest, HttpServer } from "@effect/platform"
import { NodeHttpServer } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { assert, describe, it } from "@effect/vitest"
import { Mira } from "@/app/index.js"
import { NodePlatform } from "@/platforms/node.js"
import { SqliteDatabase } from "@/databases/sqlite.js"
import { LocalFileStorage } from "@/storage/index.js"
import { BaseCollection } from "@gettersethya/mira-client"
import { Field } from "@gettersethya/mira-client"
import { Rule } from "@gettersethya/mira-client"
import { makeCollectionRouter } from "@/http/router.js"

const Posts = BaseCollection.define("posts", {
  title: Field.text(),
}).rules((R) => ({
  list: R.public(),
  view: R.public(),
  create: R.public(),
  update: R.public(),
  delete: R.public(),
}))

const app = Mira.builder()
  .platform(NodePlatform)
  .database(SqliteDatabase({ filename: ":memory:" }))
  .storage(LocalFileStorage({ directory: "./tmp/test-uploads" }))
  .collections([Posts])
  .build()

// Service layer is built fresh per describe invocation; each it.scoped test
// gets its own initialized scope (fresh in-memory SQLite with auto-migrated tables)
const testLayer = Layer.mergeAll(
  app.buildServiceLayer(),
  NodeHttpServer.layerTest,
)

describe("MiraApp integration", () => {
  it.scoped("GET /api/collections/posts returns empty list after migration", () =>
    Effect.gen(function* () {
      yield* makeCollectionRouter([Posts]).pipe(HttpServer.serveEffect())
      const res = yield* HttpClient.get("/api/collections/posts")
      assert.strictEqual(res.status, 200)
      const body = yield* res.json
      assert.ok(typeof body === "object" && body !== null && "items" in body)
      const items = (body as { items: unknown[] }).items
      assert.ok(Array.isArray(items))
      assert.strictEqual(items.length, 0)
    }).pipe(Effect.provide(testLayer)),
  )

  it.scoped("POST /api/collections/posts creates a record", () =>
    Effect.gen(function* () {
      yield* makeCollectionRouter([Posts]).pipe(HttpServer.serveEffect())
      const res = yield* HttpClient.execute(
        HttpClientRequest.post("/api/collections/posts").pipe(
          HttpClientRequest.bodyUnsafeJson({ title: "hello" }),
        ),
      )
      assert.strictEqual(res.status, 201)
      const body = yield* res.json
      assert.ok(typeof body === "object" && body !== null && "title" in body)
      assert.strictEqual((body as { title: string }).title, "hello")
      assert.ok("id" in body && typeof (body as { id: string }).id === "string")
    }).pipe(Effect.provide(testLayer)),
  )

  it.scoped("POST then GET list returns the created record", () =>
    Effect.gen(function* () {
      yield* makeCollectionRouter([Posts]).pipe(HttpServer.serveEffect())
      yield* HttpClient.execute(
        HttpClientRequest.post("/api/collections/posts").pipe(
          HttpClientRequest.bodyUnsafeJson({ title: "my post" }),
        ),
      )
      const res = yield* HttpClient.get("/api/collections/posts")
      assert.strictEqual(res.status, 200)
      const body = yield* res.json
      assert.ok(typeof body === "object" && body !== null && "items" in body)
      const items = (body as { items: unknown[] }).items
      assert.strictEqual(items.length, 1)
    }).pipe(Effect.provide(testLayer)),
  )

  it.scoped("POST then GET by id returns the record", () =>
    Effect.gen(function* () {
      yield* makeCollectionRouter([Posts]).pipe(HttpServer.serveEffect())
      const createRes = yield* HttpClient.execute(
        HttpClientRequest.post("/api/collections/posts").pipe(
          HttpClientRequest.bodyUnsafeJson({ title: "find me" }),
        ),
      )
      const created = yield* createRes.json
      assert.ok(typeof created === "object" && created !== null && "id" in created)
      const id = (created as { id: string }).id
      const res = yield* HttpClient.get(`/api/collections/posts/${id}`)
      assert.strictEqual(res.status, 200)
      const body = yield* res.json
      assert.ok(typeof body === "object" && body !== null && "title" in body)
      assert.strictEqual((body as { title: string }).title, "find me")
    }).pipe(Effect.provide(testLayer)),
  )

  it.scoped("GET /api/collections/unknown returns 404", () =>
    Effect.gen(function* () {
      yield* makeCollectionRouter([Posts]).pipe(HttpServer.serveEffect())
      const res = yield* HttpClient.get("/api/collections/unknown")
      assert.strictEqual(res.status, 404)
    }).pipe(Effect.provide(testLayer)),
  )
})
