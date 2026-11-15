export interface CacheEntry<A> {
  value: A
  insertedAt: number
  expiresAt: number
}

export interface CollectionCacheConfigValues {
  recordTtlMs: number
  listTtlMs: number
  maxRecords: number
  maxLists: number
}

/**
 * Default tuning for the in-memory collection cache.
 *
 * Thirty-second record TTL, ten-second list TTL, and soft caps of 50 000
 * records / 5 000 lists. These are starting points, not commitments — override
 * them per application with `Mira.builder().cache({ ... })`.
 */
export const defaultCollectionCacheConfig: CollectionCacheConfigValues = {
  recordTtlMs: 30_000,
  listTtlMs: 10_000,
  maxRecords: 50_000,
  maxLists: 5_000
}

/**
 * Merge a partial cache configuration over {@link defaultCollectionCacheConfig}.
 *
 * @param config - Any subset of the cache tuning values
 * @returns A complete configuration with defaults filled in
 */
export function resolveCollectionCacheConfig(
  config: Partial<CollectionCacheConfigValues> = {}
): CollectionCacheConfigValues {
  return { ...defaultCollectionCacheConfig, ...config }
}

/**
 * Application-level configuration for the in-memory collection cache.
 *
 * The cache trades process memory for speed on repeated reads: cached list
 * pages and single records are served without touching the database until
 * their TTL expires or a write invalidates them. It is a convenience for
 * read-heavy workloads, **not** a substitute for fixing a slow read path —
 * missing indexes, unindexed filters, and N+1 relation loads should be fixed
 * at the query layer.
 *
 * Disable it with `{ enabled: false }` when memory is tight, when every read
 * must reflect the database immediately, or when measuring raw query cost.
 */
export interface MiraCacheConfig extends Partial<CollectionCacheConfigValues> {
  /** Whether the cached collection service is used. Defaults to `true`. */
  readonly enabled?: boolean
}
