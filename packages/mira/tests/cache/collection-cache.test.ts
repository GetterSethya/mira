import { Effect, Option } from "effect"
import { describe, it } from "@effect/vitest"
import { expect } from "vitest"
import { CollectionCache, makeCollectionCacheLayer } from "@/cache/collection-cache.js"
import type { CursorPage } from "@/collection-service/context.js"

const smallConfig = {
  recordTtlMs: 5_000,
  listTtlMs: 5_000,
  maxRecords: 50,
  maxLists: 50,
}

const cacheLayer = makeCollectionCacheLayer(smallConfig)

const record = { id: "r1", title: "Hello", created: "2024-01-01", updated: "2024-01-01" }
const page: CursorPage = { items: [record], nextCursor: null }

describe("CollectionCache", () => {
  it.effect("cache miss — getRecord on empty cache returns None", () =>
    Effect.gen(function* () {
      const cache = yield* CollectionCache
      const result = yield* cache.getRecord("col:id1::")
      expect(Option.isNone(result)).toBe(true)
    }).pipe(Effect.provide(cacheLayer)))

  it.effect("cache hit — putRecord then getRecord within TTL returns Some", () =>
    Effect.gen(function* () {
      const cache = yield* CollectionCache
      yield* cache.putRecord("col:id2::", record)
      const result = yield* cache.getRecord("col:id2::")
      expect(Option.isSome(result)).toBe(true)
      if (Option.isSome(result)) {
        expect(result.value["id"]).toBe("r1")
      }
    }).pipe(Effect.provide(cacheLayer)))

  it.effect("TTL expiry — putRecord with recordTtlMs=0 returns None immediately", () =>
    Effect.gen(function* () {
      const cache = yield* CollectionCache
      yield* cache.putRecord("col:id3::", record)
      const result = yield* cache.getRecord("col:id3::")
      expect(Option.isNone(result)).toBe(true)
    }).pipe(Effect.provide(makeCollectionCacheLayer({ ...smallConfig, recordTtlMs: 0 }))))

  it.effect("invalidateRecord — put then invalidate returns None", () =>
    Effect.gen(function* () {
      const cache = yield* CollectionCache
      yield* cache.putRecord("col:id4::", record)
      yield* cache.invalidateRecord("col", "id4")
      const result = yield* cache.getRecord("col:id4::")
      expect(Option.isNone(result)).toBe(true)
    }).pipe(Effect.provide(cacheLayer)))

  it.effect("nukeListsFor — only evicts the target collection's lists", () =>
    Effect.gen(function* () {
      const cache = yield* CollectionCache
      yield* cache.putList("posts:|||||", page)
      yield* cache.putList("users:|||||", page)
      yield* cache.nukeListsFor("posts")
      const postsResult = yield* cache.getList("posts:|||||")
      const usersResult = yield* cache.getList("users:|||||")
      expect(Option.isNone(postsResult)).toBe(true)
      expect(Option.isSome(usersResult)).toBe(true)
    }).pipe(Effect.provide(cacheLayer)))

  it.effect("capacity eviction — maxRecords=2, putting 3 evicts one", () =>
    Effect.gen(function* () {
      const cache = yield* CollectionCache
      yield* cache.putRecord("col:a::", { id: "a" })
      yield* cache.putRecord("col:b::", { id: "b" })
      yield* cache.putRecord("col:c::", { id: "c" })
      const a = yield* cache.getRecord("col:a::")
      const b = yield* cache.getRecord("col:b::")
      const c = yield* cache.getRecord("col:c::")
      const hits = [a, b, c].filter(Option.isSome).length
      expect(hits).toBe(2)
    }).pipe(
      Effect.provide(
        makeCollectionCacheLayer({ ...smallConfig, maxRecords: 2 })
      )
    ))

  it.effect("list cache hit — putList then getList returns Some", () =>
    Effect.gen(function* () {
      const cache = yield* CollectionCache
      yield* cache.putList("posts:|||||", page)
      const result = yield* cache.getList("posts:|||||")
      expect(Option.isSome(result)).toBe(true)
      if (Option.isSome(result)) {
        expect(result.value.items.length).toBe(1)
      }
    }).pipe(Effect.provide(cacheLayer)))
})
