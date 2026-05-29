import { Context, Effect, HashMap, Layer, Option, Ref } from "effect"
import type { CursorPage } from "@/collection-service/context.js"
import type { RepoRecord } from "@/repository/types.js"
import type { CacheEntry, CollectionCacheConfigValues } from "./types.js"

export class CollectionCache extends Context.Tag("CollectionCache")<
  CollectionCache,
  {
    getRecord(key: string): Effect.Effect<Option.Option<RepoRecord>>
    putRecord(key: string, v: RepoRecord): Effect.Effect<void>
    invalidateRecord(col: string, id: string): Effect.Effect<void>
    getList(key: string): Effect.Effect<Option.Option<CursorPage>>
    putList(key: string, v: CursorPage): Effect.Effect<void>
    nukeListsFor(col: string): Effect.Effect<void>
  }
>() {}

const get = <A>(
  ref: Ref.Ref<HashMap.HashMap<string, CacheEntry<A>>>,
  key: string
): Effect.Effect<Option.Option<A>> =>
  Ref.get(ref).pipe(
    Effect.map(HashMap.get(key)),
    Effect.map(Option.filter((e) => e.expiresAt > Date.now())),
    Effect.map(Option.map((e) => e.value))
  )

const put = <A>(
  ref: Ref.Ref<HashMap.HashMap<string, CacheEntry<A>>>,
  key: string,
  value: A,
  ttlMs: number,
  maxSize: number
): Effect.Effect<void> => {
  const now = Date.now()
  const entry: CacheEntry<A> = { value, insertedAt: now, expiresAt: now + ttlMs }
  return Ref.update(ref, (map) => {
    const inserted = HashMap.set(map, key, entry)
    if (HashMap.size(inserted) <= maxSize) return inserted
    let oldestKey: string | undefined
    let oldestTime = Infinity
    for (const [k, v] of inserted) {
      if (v.insertedAt < oldestTime) {
        oldestTime = v.insertedAt
        oldestKey = k
      }
    }
    return oldestKey !== undefined ? HashMap.remove(inserted, oldestKey) : inserted
  })
}

export function makeCollectionCacheLayer(
  config: CollectionCacheConfigValues
): Layer.Layer<CollectionCache> {
  return Layer.effect(
    CollectionCache,
    Effect.gen(function* () {
      const recordRef = yield* Ref.make(HashMap.empty<string, CacheEntry<RepoRecord>>())
      const listRef = yield* Ref.make(HashMap.empty<string, CacheEntry<CursorPage>>())

      return CollectionCache.of({
        getRecord: (key) => get(recordRef, key),

        putRecord: (key, v) => put(recordRef, key, v, config.recordTtlMs, config.maxRecords),

        invalidateRecord: (col, id) =>
          Ref.update(recordRef, (map) =>
            HashMap.filter(map, (_, key) => !key.startsWith(`${col}:${id}:`))
          ),

        getList: (key) => get(listRef, key),

        putList: (key, v) => put(listRef, key, v, config.listTtlMs, config.maxLists),

        nukeListsFor: (col) =>
          Ref.update(listRef, (map) =>
            HashMap.filter(map, (_, key) => !key.startsWith(`${col}:`))
          ),
      })
    })
  )
}
