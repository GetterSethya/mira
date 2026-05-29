import { SqlClient } from "@effect/sql"
import { Effect, Layer, Option, Tracer } from "effect"
import type { AnyCollectionDef } from "@gettersethya/mira-client"
import type { FilterNode } from "@gettersethya/mira-client"
import { Repository } from "@/repository/repository.js"
import type { SortOrder } from "@/repository/types.js"
import { CollectionService, makeCollectionServiceLayer } from "@/collection-service/collection-service.js"
import { FileStorage } from "@/storage/storage.js"
import { CollectionCache, makeCollectionCacheLayer } from "./collection-cache.js"
import type { CollectionCacheConfigValues } from "./types.js"

function serializeFilterNode(node: FilterNode): string {
  switch (node.op) {
    case "eq":
    case "neq":
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return `${node.op}(${node.field},${String(node.value)})`
    case "in":
      return `in(${node.field},[${node.values.map(String).join(",")}])`
    case "like":
      return `like(${node.field},${node.value})`
    case "null":
    case "not_null":
      return `${node.op}(${node.field})`
    case "and":
    case "or":
      return `${node.op}(${serializeFilterNode(node.left)},${serializeFilterNode(node.right)})`
    case "not":
      return `not(${serializeFilterNode(node.node)})`
  }
}

function stableViewKey(
  col: string,
  id: string,
  select: ReadonlyArray<string> | null | undefined,
  expand: ReadonlyArray<string> | null | undefined
): string {
  const selectPart = select != null ? [...select].sort().join(",") : ""
  const expandPart = expand != null ? [...expand].sort().join(",") : ""
  return `${col}:${id}:${selectPart}|${expandPart}`
}

function stableListKey(
  cursor: number | null,
  perPage: number,
  filter: FilterNode | undefined,
  sort: SortOrder | undefined,
  select: ReadonlyArray<string> | null | undefined,
  expand: ReadonlyArray<string> | null | undefined
): string {
  const filterPart = filter !== undefined ? serializeFilterNode(filter) : ""
  const sortPart = sort !== undefined ? `${sort.field}:${sort.direction}` : ""
  const selectPart = select != null ? [...select].sort().join(",") : ""
  const expandPart = expand != null ? [...expand].sort().join(",") : ""
  return `${cursor ?? ""}|${perPage}|${filterPart}|${sortPart}|${selectPart}|${expandPart}`
}

const defaultConfig: CollectionCacheConfigValues = {
  recordTtlMs: 30_000,
  listTtlMs: 10_000,
  maxRecords: 50_000,
  maxLists: 5_000,
}

/**
 * Create a cached `CollectionService` layer that wraps the standard collection service.
 *
 * The cache is transparent — it implements the same `CollectionService` tag.
 * List results and individual records are cached with a configurable TTL.
 * Cache is invalidated (nuked) on any write operation (create/update/delete).
 *
 * This is the default service layer used by MiraApp — the standard
 * `makeCollectionServiceLayer` is wrapped by this function internally.
 *
 * @param allCollections - Array of collection definitions
 * @param config - Optional cache configuration (record TTL, list TTL, max entries)
 * @returns A Layer providing CollectionService with caching
 *
 * @example
 * makeCachedCollectionServiceLayer([Posts, Users])
 * makeCachedCollectionServiceLayer([Posts], { recordTtlMs: 60_000 })
 *
 * @see CollectionService — the service tag
 * @see makeCollectionServiceLayer — the underlying uncached service
 */
export function makeCachedCollectionServiceLayer(
  allCollections: ReadonlyArray<AnyCollectionDef>,
  config: CollectionCacheConfigValues = defaultConfig
): Layer.Layer<CollectionService, never, Repository | SqlClient.SqlClient | FileStorage> {
  return Layer.effect(
    CollectionService,
    Effect.gen(function* () {
      const svc = yield* CollectionService
      const cache = yield* CollectionCache

      return CollectionService.of({
        list: (collection, cursor, perPage, ctx, filter, sort, select, expand) => {
          const key = `${collection.name}:${stableListKey(cursor, perPage, filter, sort, select, expand)}`
          return Effect.gen(function* () {
            const cached = yield* cache.getList(key)
            yield* Effect.currentSpan.pipe(
              Effect.tap((span: Tracer.Span) =>
                Effect.sync(() => span.attribute("cache.hit", Option.isSome(cached)))
              ),
              Effect.ignore
            )
            if (Option.isSome(cached)) return cached.value
            const page = yield* svc.list(collection, cursor, perPage, ctx, filter, sort, select, expand)
            yield* cache.putList(key, page)
            return page
          }).pipe(
            Effect.withSpan("cache.list", {
              kind: "internal",
              attributes: { collection: collection.name },
            })
          )
        },

        view: (collection, id, ctx, select, expand) => {
          const key = stableViewKey(collection.name, id, select, expand)
          return Effect.gen(function* () {
            const cached = yield* cache.getRecord(key)
            yield* Effect.currentSpan.pipe(
              Effect.tap((span: Tracer.Span) =>
                Effect.sync(() => span.attribute("cache.hit", Option.isSome(cached)))
              ),
              Effect.ignore
            )
            if (Option.isSome(cached)) return cached.value
            const record = yield* svc.view(collection, id, ctx, select, expand)
            yield* cache.putRecord(key, record)
            return record
          }).pipe(
            Effect.withSpan("cache.view", {
              kind: "internal",
              attributes: { collection: collection.name },
            })
          )
        },

        create: (collection, data, ctx) =>
          svc.create(collection, data, ctx).pipe(
            Effect.tap(() => cache.nukeListsFor(collection.name))
          ),

        update: (collection, id, data, ctx) =>
          svc.update(collection, id, data, ctx).pipe(
            Effect.tap(() =>
              Effect.all(
                [cache.invalidateRecord(collection.name, id), cache.nukeListsFor(collection.name)],
                { concurrency: "unbounded" }
              )
            )
          ),

        delete: (collection, id, ctx) =>
          svc.delete(collection, id, ctx).pipe(
            Effect.tap(() =>
              Effect.all(
                [cache.invalidateRecord(collection.name, id), cache.nukeListsFor(collection.name)],
                { concurrency: "unbounded" }
              )
            )
          ),
      })
    })
  ).pipe(
    Layer.provide(
      Layer.merge(makeCollectionServiceLayer(allCollections), makeCollectionCacheLayer(config))
    )
  )
}
