import type { AnyCollectionDef } from "@gettersethya/mira-client"
import type { FilterNode } from "@gettersethya/mira-client"
import type { Tracer } from "effect";
import { Effect, Layer, Option } from "effect"
import type { SqlClient } from "effect/sql"

import { CollectionService, makeBatchedCollectionServiceLayer, makeCollectionServiceLayer } from "@/collection-service/collection-service.js"
import type {
  BatchMutationStats,
  ResolvedBatchMutationConfig
} from "@/collection-service/mutation-batcher.js"
import type { Dialect } from "@/dialect/dialect.js"
import type { AuthService } from "@/http/auth.js"
import type { Repository } from "@/repository/repository.js"
import type { SortOrder } from "@/repository/types.js"
import type { FileStorage } from "@/storage/storage.js"

import { CollectionCache, makeCollectionCacheLayer } from "./collection-cache.js"
import { buildCtxCacheTag } from "./ctx-key.js"
import { resolveCollectionCacheConfig, type CollectionCacheConfigValues } from "./types.js"

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
  const selectPart = select == null ? "*" : [...select].sort().join(",")
  const expandPart = expand == null ? "*" : [...expand].sort().join(",")
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
  const selectPart = select == null ? "*" : [...select].sort().join(",")
  const expandPart = expand == null ? "*" : [...expand].sort().join(",")
  return `${cursor ?? ""}|${perPage}|${filterPart}|${sortPart}|${selectPart}|${expandPart}`
}

/**
 * Base-service selection for {@link makeCachedCollectionServiceLayer}.
 *
 * Batched-without-stats is not representable: the batcher needs the app's
 * single `BatchMutationStats` value, so enabling batching requires both fields.
 */
export type CachedCollectionServiceOptions =
  | { readonly batchMutation?: null | undefined; readonly statsLayer?: never }
  | {
      readonly batchMutation: ResolvedBatchMutationConfig
      readonly statsLayer: Layer.Layer<BatchMutationStats>
    }

/**
 * Create a cached `CollectionService` layer that wraps the standard collection service.
 *
 * The cache trades process memory for repeated-read speed. It is not a
 * substitute for fixing a slow read path — fix missing indexes and expensive
 * queries first, then use the cache to absorb remaining read volume.
 *
 * The cache is transparent — it implements the same `CollectionService` tag.
 * List results and individual records are cached with a configurable TTL.
 * Cache is invalidated (nuked) on any write operation (create/update/delete).
 *
 * This is the default service layer used by MiraApp — the standard
 * `makeCollectionServiceLayer` is wrapped by this function internally.
 *
 * @param allCollections - Array of collection definitions
 * @param config - Optional partial cache configuration (record TTL, list TTL,
 *   max entries); unset values fall back to `defaultCollectionCacheConfig`
 * @param serviceOptions - Optional base-service selection. Pass
 *   `{ batchMutation, statsLayer }` to enable transparent mutation batching;
 *   omit it (or pass `{ batchMutation: null }`) for the inline path.
 * @returns A Layer providing CollectionService with caching
 *
 * @example
 * makeCachedCollectionServiceLayer([Posts, Users])
 * makeCachedCollectionServiceLayer([Posts], { recordTtlMs: 60_000 })
 * makeCachedCollectionServiceLayer([Posts], {}, { batchMutation: resolved, statsLayer })
 *
 * @see CollectionService — the service tag
 * @see makeCollectionServiceLayer — the underlying uncached service
 * @see makeBatchedCollectionServiceLayer — the batched uncached service
 */
export function makeCachedCollectionServiceLayer(
  allCollections: ReadonlyArray<AnyCollectionDef>,
  config: Partial<CollectionCacheConfigValues> = {},
  serviceOptions: CachedCollectionServiceOptions = {}
): Layer.Layer<CollectionService, never, Repository | SqlClient.SqlClient | FileStorage | Dialect | AuthService> {
  const resolved = resolveCollectionCacheConfig(config)
  const baseLayer =
    serviceOptions.batchMutation != null && "statsLayer" in serviceOptions
      ? makeBatchedCollectionServiceLayer(
          allCollections,
          serviceOptions.batchMutation,
          serviceOptions.statsLayer
        )
      : makeCollectionServiceLayer(allCollections)
  return Layer.effect(
    CollectionService,
    Effect.gen(function* () {
      const svc = yield* CollectionService
      const cache = yield* CollectionCache

      return CollectionService.of({
        list: (collection, cursor, perPage, ctx, filter, sort, select, expand) => {
          // Reads that expand a relation are not cached.
          if (expand != null && expand.length > 0) {
            return svc.list(collection, cursor, perPage, ctx, filter, sort, select, expand).pipe(
              Effect.withSpan(
                "cache.list",
                { kind: "internal", attributes: { collection: collection.name, "cache.bypass": true } },
                { captureStackTrace: false }
              )
            )
          }

          const ctxTag = buildCtxCacheTag(collection, "list", ctx)
          const key = `${collection.name}:${stableListKey(cursor, perPage, filter, sort, select, expand)}::${ctxTag}`
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
            Effect.withSpan(
              "cache.list",
              { kind: "internal", attributes: { collection: collection.name } },
              { captureStackTrace: false }
            )
          )
        },

        view: (collection, id, ctx, select, expand) => {
          // Reads that expand a relation are not cached.
          if (expand != null && expand.length > 0) {
            return svc.view(collection, id, ctx, select, expand).pipe(
              Effect.withSpan(
                "cache.view",
                { kind: "internal", attributes: { collection: collection.name, "cache.bypass": true } },
                { captureStackTrace: false }
              )
            )
          }

          const ctxTag = buildCtxCacheTag(collection, "view", ctx)
          const key = `${stableViewKey(collection.name, id, select, expand)}::${ctxTag}`
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
            Effect.withSpan(
              "cache.view",
              { kind: "internal", attributes: { collection: collection.name } },
              { captureStackTrace: false }
            )
          )
        },

        create: (collection, data, ctx) =>
          svc.create(collection, data, ctx).pipe(
            Effect.tap(() => cache.nukeListsFor(collection.name)),
            Effect.withSpan(
              "cache.create",
              { kind: "internal", attributes: { collection: collection.name } },
              { captureStackTrace: false }
            )
          ),

        // The whole batch commits or rolls back together, so the cache is
        // invalidated exactly once — after the transaction succeeds.
        createMany: (collection, records, ctx) =>
          svc.createMany(collection, records, ctx).pipe(
            Effect.tap(() => cache.nukeListsFor(collection.name)),
            Effect.withSpan(
              "cache.createMany",
              { kind: "internal", attributes: { collection: collection.name } },
              { captureStackTrace: false }
            )
          ),

        update: (collection, id, data, ctx) =>
          svc.update(collection, id, data, ctx).pipe(
            Effect.tap(() =>
              Effect.all(
                [cache.invalidateRecord(collection.name, id), cache.nukeListsFor(collection.name)],
                { concurrency: "unbounded" }
              )
            ),
            Effect.withSpan(
              "cache.update",
              { kind: "internal", attributes: { collection: collection.name } },
              { captureStackTrace: false }
            )
          ),

        // Bulk update/delete commit or roll back together, so every affected
        // record key and the collection's lists are invalidated once, after the
        // transaction succeeds — never per record.
        updateMany: (collection, updates, ctx) =>
          svc.updateMany(collection, updates, ctx).pipe(
            Effect.tap(() =>
              Effect.all(
                [
                  ...updates.map((update) => cache.invalidateRecord(collection.name, update.id)),
                  cache.nukeListsFor(collection.name)
                ],
                { concurrency: "unbounded" }
              )
            ),
            Effect.withSpan(
              "cache.updateMany",
              { kind: "internal", attributes: { collection: collection.name } },
              { captureStackTrace: false }
            )
          ),

        delete: (collection, id, ctx) =>
          svc.delete(collection, id, ctx).pipe(
            Effect.tap(() =>
              Effect.all(
                [cache.invalidateRecord(collection.name, id), cache.nukeListsFor(collection.name)],
                { concurrency: "unbounded" }
              )
            ),
            Effect.withSpan(
              "cache.delete",
              { kind: "internal", attributes: { collection: collection.name } },
              { captureStackTrace: false }
            )
          ),

        deleteMany: (collection, ids, ctx) =>
          svc.deleteMany(collection, ids, ctx).pipe(
            Effect.tap(() =>
              Effect.all(
                [
                  ...ids.map((id) => cache.invalidateRecord(collection.name, id)),
                  cache.nukeListsFor(collection.name)
                ],
                { concurrency: "unbounded" }
              )
            ),
            Effect.withSpan(
              "cache.deleteMany",
              { kind: "internal", attributes: { collection: collection.name } },
              { captureStackTrace: false }
            )
          ),
      })
    })
  ).pipe(
    Layer.provide(
      Layer.merge(baseLayer, makeCollectionCacheLayer(resolved))
    )
  )
}
