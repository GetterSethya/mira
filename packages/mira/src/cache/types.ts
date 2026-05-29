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
