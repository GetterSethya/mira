# Collection Cache

## Overview

An in-memory read-through cache that sits directly in front of `CollectionService` and
implements the same service tag, so callers cannot tell whether they are hitting the cache
or the underlying database. It keeps two independent `Ref<HashMap>` stores — one for
individual records (`view`) and one for cursor pages (`list`) — enforces per-entry TTLs
lazily on read, caps each store with oldest-first eviction, and nukes the relevant entries
on every write. Because list and record reads are authorization-dependent, every cache key
is suffixed with a context tag derived from exactly the request values the collection's
compiled row-level rule references, preventing a cached row from leaking across requesters.

## Interface

- `CollectionCache` — `Context.Service` tag exposing `getRecord`, `putRecord`, `invalidateRecord`, `getList`, `putList`, `nukeListsFor` [collection-cache.ts:CollectionCache]
- `makeCollectionCacheLayer(config)` — builds the cache layer from `CollectionCacheConfigValues` [collection-cache.ts:makeCollectionCacheLayer]
- `makeCachedCollectionServiceLayer(allCollections, config?)` — cached `CollectionService` layer; wires the uncached service and the cache together [cached-collection.ts:makeCachedCollectionServiceLayer]
- `buildCtxCacheTag(collection, action, ctx)` — derives the authorization-scoped suffix of a list/view cache key [ctx-key.ts:buildCtxCacheTag]
- `CacheEntry<A>` (type) — `{ value, insertedAt, expiresAt }` stored per key [types.ts:CacheEntry]
- `CollectionCacheConfigValues` (type) — `recordTtlMs`, `listTtlMs`, `maxRecords`, `maxLists` [types.ts:CollectionCacheConfigValues]
- Barrel re-exports the above real symbols: `makeCachedCollectionServiceLayer`, `CollectionCache`, `makeCollectionCacheLayer`, `buildCtxCacheTag`, and the two types [index.ts:makeCachedCollectionServiceLayer] [index.ts:CollectionCache] [index.ts:buildCtxCacheTag] [index.ts:CollectionCacheConfigValues]

## Invariants

- A read is a miss when `expiresAt <= Date.now()`; expired entries are filtered out but not opportunistically deleted [collection-cache.ts:get]
- Inserting past `maxSize` evicts the single entry with the smallest `insertedAt` [collection-cache.ts:put]
- Record keys are `col:id:<select>|<expand>::<ctxTag>`; `invalidateRecord(col, id)` removes every key starting with `col:id:` [cached-collection.ts:stableViewKey] [collection-cache.ts:makeCollectionCacheLayer]
- List keys start with `col:` and end with `::<ctxTag>`; `nukeListsFor(col)` removes every key starting with `col:` [cached-collection.ts:stableListKey] [collection-cache.ts:makeCollectionCacheLayer]
- `create` nukes the collection's lists; `update` and `delete` invalidate the record and nuke the lists, both after the underlying write succeeds [cached-collection.ts:makeCachedCollectionServiceLayer]
- Any read with a non-empty `expand` bypasses the cache entirely and is marked `cache.bypass: true` [cached-collection.ts:makeCachedCollectionServiceLayer]
- The ctx tag is `"admin"` when `ctx.admin === true`, `"denied"` when the action has no rule, and `"public"` when the rule references no context value [ctx-key.ts:buildCtxCacheTag]
- Only the auth/query/header/body keys the compiled rule references (via `extractCtxRefs`) contribute to the tag; the whole `ctx` is never encoded [ctx-key.ts:buildCtxCacheTag]
- Referenced values are encoded with the rule resolver's semantics: arrays collapse to their first element, absent values become the `\N` marker, and `\`, NUL, `,`, `=`, `|` are escaped [ctx-key.ts:encodeCtxValue] [ctx-key.ts:encodeScalar] [ctx-key.ts:ABSENT]
- `select`/`expand` list parts are sorted so key order cannot split a cache entry [cached-collection.ts:stableViewKey] [cached-collection.ts:stableListKey]
- Defaults are 30 s record TTL, 10 s list TTL, 50 000 records, 5 000 lists [cached-collection.ts:defaultConfig]
- Cache spans set `cache.hit` from the lookup result and never fail the call even if no span is active [cached-collection.ts:makeCachedCollectionServiceLayer]

## Side Effects

- Mutates two in-process `Ref<HashMap>` stores (records and lists); no durable storage [collection-cache.ts:makeCollectionCacheLayer]
- Reads wall-clock time via `Date.now()` on every get/put [collection-cache.ts:get] [collection-cache.ts:put]
- Annotates the current tracing span with `cache.hit` / `cache.bypass` attributes [cached-collection.ts:makeCachedCollectionServiceLayer]
- Delegates all database/file/auth work to the wrapped `CollectionService`; the cache itself performs no SQL or I/O [cached-collection.ts:makeCachedCollectionServiceLayer]

## Verification

- Run: `pnpm --filter @gettersethya/mira test`
- Typecheck: `pnpm --filter @gettersethya/mira typecheck`
