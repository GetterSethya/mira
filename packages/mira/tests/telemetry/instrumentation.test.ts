import { SqlClient } from "@effect/sql"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Chunk, Effect, Layer, Queue } from "effect"
import { randomBytes } from "node:crypto"
import { describe, it } from "@effect/vitest"
import { expect } from "vitest"
import { BaseCollection } from "@gettersethya/mira-client"
import { Field } from "@gettersethya/mira-client"
import { Rule } from "@gettersethya/mira-client"
import { CollectionService } from "@/collection-service/collection-service.js"
import type { RequestCtx } from "@/collection-service/context.js"
import { makeCachedCollectionServiceLayer } from "@/cache/cached-collection.js"
import { RepositoryLive } from "@/repository/repository.js"
import { FileStorage, FileStorageNotFound } from "@/storage/storage.js"
import type { CompletedSpan } from "@/telemetry/tracer.js"
import { makeConsoleTracer } from "@/telemetry/tracer.js"
import { NodeCryptoLayer } from "@/crypto/node.js"

const testCollection = BaseCollection.define("test_items", {
  title: Field.text(),
}).rules((R) => ({
  list: R.public(),
  view: R.public(),
  create: R.public(),
  update: R.public(),
  delete: R.public(),
}))

const noCtx: RequestCtx = { headers: {}, query: {} }

const FileStorageTest = Layer.succeed(
  FileStorage,
  FileStorage.of({
    upload: (key) => Effect.succeed(key),
    delete: () => Effect.void,
    url: (key) => `/files/${key}`,
    read: (key) => Effect.fail(new FileStorageNotFound({ key })),
    exists: () => Effect.succeed(false),
    list: () => Effect.succeed([]),
  })
)

function makeTestLayer(queue: Queue.Queue<CompletedSpan>) {
  const sqliteLayer = SqliteClient.layer({ filename: ":memory:" })
  const tracerLayer = Layer.setTracer(makeConsoleTracer(queue, (size) => randomBytes(size)))

  // Wire Repository to its SqlClient dependency
  const repoLayer = RepositoryLive.pipe(Layer.provide(sqliteLayer))

  // Wire service to all its dependencies (no remaining requirements)
  const service = makeCachedCollectionServiceLayer([testCollection]).pipe(
    Layer.provide(repoLayer),
    Layer.provide(sqliteLayer),
    Layer.provide(FileStorageTest),
    Layer.provide(NodeCryptoLayer),
  )

  // Expose CollectionService + SqlClient + FileStorage + tracer; requires nothing
  return Layer.mergeAll(service, sqliteLayer, FileStorageTest, tracerLayer, NodeCryptoLayer)
}

const setupTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "test_items" (
      "seqId"   INTEGER PRIMARY KEY AUTOINCREMENT,
      "id"      TEXT NOT NULL UNIQUE,
      "title"   TEXT NOT NULL DEFAULT '',
      "created" TEXT NOT NULL,
      "updated" TEXT NOT NULL
    )
  `)
  yield* sql.unsafe(`DELETE FROM "test_items"`)
})

function collectSpans(queue: Queue.Queue<CompletedSpan>) {
  return Queue.takeAll(queue).pipe(Effect.map(Chunk.toArray))
}

describe("instrumentation integration", () => {
  it.effect("repository.create span has correct table attribute", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<CompletedSpan>()
      yield* Effect.gen(function* () {
        yield* setupTable
        const cs = yield* CollectionService
        yield* cs.create(testCollection, { title: "hello" }, noCtx)
        const spans = yield* collectSpans(queue)
        const span = spans.find((s) => s.name === "repository.create")
        expect(span).toBeDefined()
        expect(span!.attributes["table"]).toBe(testCollection.name)
      }).pipe(Effect.provide(makeTestLayer(queue)))
    })
  )

  it.effect("repository.view span has correct table attribute", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<CompletedSpan>()
      yield* Effect.gen(function* () {
        yield* setupTable
        const cs = yield* CollectionService
        const created = yield* cs.create(testCollection, { title: "view-test" }, noCtx)
        yield* collectSpans(queue)
        yield* cs.view(testCollection, String(created["id"]), noCtx)
        const spans = yield* collectSpans(queue)
        const span = spans.find((s) => s.name === "repository.view" || s.name === "repository.viewFilter")
        expect(span).toBeDefined()
        expect(span!.attributes["table"]).toBe(testCollection.name)
      }).pipe(Effect.provide(makeTestLayer(queue)))
    })
  )

  it.effect("repository.list span has correct table attribute", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<CompletedSpan>()
      yield* Effect.gen(function* () {
        yield* setupTable
        const cs = yield* CollectionService
        yield* cs.list(testCollection, null, 10, noCtx)
        const spans = yield* collectSpans(queue)
        const span = spans.find((s) => s.name === "repository.list")
        expect(span).toBeDefined()
        expect(span!.attributes["table"]).toBe(testCollection.name)
      }).pipe(Effect.provide(makeTestLayer(queue)))
    })
  )

  it.effect("collection.create span has correct collection attribute and internal kind", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<CompletedSpan>()
      yield* Effect.gen(function* () {
        yield* setupTable
        const cs = yield* CollectionService
        yield* cs.create(testCollection, { title: "col-span" }, noCtx)
        const spans = yield* collectSpans(queue)
        const span = spans.find((s) => s.name === "collection.create")
        expect(span).toBeDefined()
        expect(span!.attributes["collection"]).toBe(testCollection.name)
        expect(span!.kind).toBe("internal")
      }).pipe(Effect.provide(makeTestLayer(queue)))
    })
  )

  it.effect("collection.view span has correct collection attribute", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<CompletedSpan>()
      yield* Effect.gen(function* () {
        yield* setupTable
        const cs = yield* CollectionService
        const created = yield* cs.create(testCollection, { title: "view-span" }, noCtx)
        yield* collectSpans(queue)
        yield* cs.view(testCollection, String(created["id"]), noCtx)
        const spans = yield* collectSpans(queue)
        const span = spans.find((s) => s.name === "collection.view")
        expect(span).toBeDefined()
        expect(span!.attributes["collection"]).toBe(testCollection.name)
      }).pipe(Effect.provide(makeTestLayer(queue)))
    })
  )

  it.effect("collection.list span is emitted", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<CompletedSpan>()
      yield* Effect.gen(function* () {
        yield* setupTable
        const cs = yield* CollectionService
        yield* cs.list(testCollection, null, 10, noCtx)
        const spans = yield* collectSpans(queue)
        const span = spans.find((s) => s.name === "collection.list")
        expect(span).toBeDefined()
      }).pipe(Effect.provide(makeTestLayer(queue)))
    })
  )

  it.effect("repository span is nested inside collection span — same traceId, correct parentSpanId", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<CompletedSpan>()
      yield* Effect.gen(function* () {
        yield* setupTable
        const cs = yield* CollectionService
        yield* cs.create(testCollection, { title: "nesting" }, noCtx)
        const spans = yield* collectSpans(queue)
        const colSpan = spans.find((s) => s.name === "collection.create")
        const repoSpan = spans.find((s) => s.name === "repository.create")
        expect(colSpan).toBeDefined()
        expect(repoSpan).toBeDefined()
        expect(repoSpan!.traceId).toBe(colSpan!.traceId)
        expect(repoSpan!.parentSpanId).toBe(colSpan!.spanId)
      }).pipe(Effect.provide(makeTestLayer(queue)))
    })
  )

  it.effect("cache span is the root span when no outer withSpan is present", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<CompletedSpan>()
      yield* Effect.gen(function* () {
        yield* setupTable
        const cs = yield* CollectionService
        yield* cs.list(testCollection, null, 10, noCtx)
        const spans = yield* collectSpans(queue)
        const cacheSpan = spans.find((s) => s.name === "cache.list")
        expect(cacheSpan).toBeDefined()
        expect(cacheSpan!.parentSpanId).toBeUndefined()
      }).pipe(Effect.provide(makeTestLayer(queue)))
    })
  )

  it.effect("cache.view on miss — span emitted with cache.hit: false and collection.view child", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<CompletedSpan>()
      yield* Effect.gen(function* () {
        yield* setupTable
        const cs = yield* CollectionService
        const created = yield* cs.create(testCollection, { title: "cache-miss" }, noCtx)
        yield* collectSpans(queue)
        yield* cs.view(testCollection, String(created["id"]), noCtx)
        const spans = yield* collectSpans(queue)
        const cacheSpan = spans.find((s) => s.name === "cache.view")
        expect(cacheSpan).toBeDefined()
        expect(cacheSpan!.attributes["cache.hit"]).toBe(false)
        const colSpan = spans.find((s) => s.name === "collection.view")
        expect(colSpan).toBeDefined()
        expect(colSpan!.parentSpanId).toBe(cacheSpan!.spanId)
      }).pipe(Effect.provide(makeTestLayer(queue)))
    })
  )

  it.effect("cache.view on hit — span emitted with cache.hit: true, no collection.view child", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<CompletedSpan>()
      yield* Effect.gen(function* () {
        yield* setupTable
        const cs = yield* CollectionService
        const created = yield* cs.create(testCollection, { title: "cache-hit" }, noCtx)
        yield* cs.view(testCollection, String(created["id"]), noCtx)
        yield* collectSpans(queue)
        yield* cs.view(testCollection, String(created["id"]), noCtx)
        const spans = yield* collectSpans(queue)
        const cacheSpan = spans.find((s) => s.name === "cache.view")
        expect(cacheSpan).toBeDefined()
        expect(cacheSpan!.attributes["cache.hit"]).toBe(true)
        const colSpan = spans.find((s) => s.name === "collection.view")
        expect(colSpan).toBeUndefined()
      }).pipe(Effect.provide(makeTestLayer(queue)))
    })
  )

  it.effect("cache.list on miss — span emitted with cache.hit: false", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<CompletedSpan>()
      yield* Effect.gen(function* () {
        yield* setupTable
        const cs = yield* CollectionService
        yield* cs.list(testCollection, null, 10, noCtx)
        const spans = yield* collectSpans(queue)
        const cacheSpan = spans.find((s) => s.name === "cache.list")
        expect(cacheSpan).toBeDefined()
        expect(cacheSpan!.attributes["cache.hit"]).toBe(false)
      }).pipe(Effect.provide(makeTestLayer(queue)))
    })
  )

  it.effect("cache.list on hit — span emitted with cache.hit: true, no collection.list child", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<CompletedSpan>()
      yield* Effect.gen(function* () {
        yield* setupTable
        const cs = yield* CollectionService
        yield* cs.list(testCollection, null, 10, noCtx)
        yield* collectSpans(queue)
        yield* cs.list(testCollection, null, 10, noCtx)
        const spans = yield* collectSpans(queue)
        const cacheSpan = spans.find((s) => s.name === "cache.list")
        expect(cacheSpan).toBeDefined()
        expect(cacheSpan!.attributes["cache.hit"]).toBe(true)
        const colSpan = spans.find((s) => s.name === "collection.list")
        expect(colSpan).toBeUndefined()
      }).pipe(Effect.provide(makeTestLayer(queue)))
    })
  )
})
