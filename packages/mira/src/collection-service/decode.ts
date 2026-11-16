import type { CollectionSchema } from "@gettersethya/mira-client"
import { Effect } from "effect"

import type { RepoRecord } from "@/repository/types.js"

export type RowDecoder = (record: RepoRecord) => Effect.Effect<RepoRecord>
/** Synchronous row decoder: pure, allocates one new row, never mutates its input. */
export type RowDecoderSync = (record: RepoRecord) => RepoRecord
export type RowEncoder = (record: RepoRecord) => RepoRecord

function booleanKeys(colSchema: CollectionSchema) {
  const boolKeys = new Set<string>()
  for (const [key, prop] of Object.entries(colSchema.properties)) {
    if (prop.type === "boolean") boolKeys.add(key)
  }
  return boolKeys
}

/** Shared no-op decoder so `makeRowDecoderSync` can report "nothing to do" by identity. */
const identityRow: RowDecoderSync = (record) => record

/**
 * Synchronous counterpart to {@link makeRowDecoder}. When the dialect stores
 * booleans as integers, `0`/`1` are converted in a single pass; the input row is
 * never mutated (the caller gets a fresh object). Returns the shared identity
 * function when no conversion is needed, so hot paths can skip the work.
 */
export function makeRowDecoderSync(colSchema: CollectionSchema, storesBooleanAsInteger: boolean): RowDecoderSync {
  if (!storesBooleanAsInteger) return identityRow

  const boolKeys = booleanKeys(colSchema)
  if (boolKeys.size === 0) return identityRow

  return (record) => {
    const result = { ...record }
    for (const key of boolKeys) {
      const v = result[key]
      if (v === 0 || v === 1) result[key] = v === 1
    }
    return result
  }
}

export function makeRowDecoder(colSchema: CollectionSchema, storesBooleanAsInteger: boolean): RowDecoder {
  const syncDecode = makeRowDecoderSync(colSchema, storesBooleanAsInteger)
  if (syncDecode === identityRow) return Effect.succeed

  return (record) => Effect.sync(() => syncDecode(record))
}

/**
 * Builds the single-pass mapper used by `CollectionService.list`: it turns a
 * repository row into a public list item, dropping `seqId` (the internal cursor
 * column) and decoding boolean storage representation at the same time.
 *
 * The source row is never mutated — the response item is a fresh object, so the
 * repository result cannot leak `seqId` back through the cache or another caller.
 */
export function makeListRowMapper(colSchema: CollectionSchema, storesBooleanAsInteger: boolean) {
  const boolKeys = storesBooleanAsInteger ? booleanKeys(colSchema) : undefined

  return (record: RepoRecord): RepoRecord => {
    const out: RepoRecord = {}
    for (const key of Object.keys(record)) {
      if (key === "seqId") continue
      const value = record[key]
      out[key] = boolKeys !== undefined && boolKeys.has(key) && (value === 0 || value === 1) ? value === 1 : value
    }
    return out
  }
}

/**
 * Projection-based counterpart to {@link makeListRowMapper}. The projection is
 * the exact `fieldsForQuery` array sent to `Repository.list`, so iteration order
 * matches the row's SELECT order and keys outside the projection are never
 * emitted as `undefined`.
 *
 * `expand` is the only non-projection key `Repository.reshapeExpand` adds; it is
 * copied explicitly when present. The caller uses this mapper only for a
 * non-empty projection; the empty-projection `SELECT *` fallback keeps
 * {@link makeListRowMapper}.
 */
export function makeProjectedListRowMapper(
  colSchema: CollectionSchema,
  storesBooleanAsInteger: boolean,
  projection: ReadonlyArray<string>
) {
  const keys = projection
    .filter((key) => key !== "seqId")
    .map((key) => ({
      key,
      boolean:
        storesBooleanAsInteger && colSchema.properties[key]?.type === "boolean"
    }))

  return (record: RepoRecord): RepoRecord => {
    const out: RepoRecord = {}
    for (const entry of keys) {
      if (!Object.hasOwn(record, entry.key)) continue
      const value = record[entry.key]
      out[entry.key] =
        entry.boolean && (value === 0 || value === 1) ? value === 1 : value
    }
    if (Object.hasOwn(record, "expand")) out["expand"] = record["expand"]
    return out
  }
}

export function makeRowEncoder(colSchema: CollectionSchema, storesBooleanAsInteger: boolean): RowEncoder {
  if (!storesBooleanAsInteger) return (record) => record

  const boolKeys = booleanKeys(colSchema)
  if (boolKeys.size === 0) return (record) => record

  return (record) => {
    const result = { ...record }
    for (const key of boolKeys) {
      const v = result[key]
      if (typeof v === "boolean") result[key] = v ? 1 : 0
    }
    return result
  }
}

/**
 * Drops `x-hidden` properties (and any key with no schema property, so computed
 * or joined columns never leak) from a record. This is the allowlist counterpart
 * to `CollectionService`'s admin check: auth passwords, `seqId`, and other
 * server-managed columns are removed before a record is serialised to a client.
 */
export function stripHiddenFields(colSchema: CollectionSchema, record: RepoRecord): RepoRecord {
  const out: RepoRecord = {}
  for (const [k, v] of Object.entries(record)) {
    const prop = colSchema.properties[k]
    if (prop === undefined || prop["x-hidden"] === true) continue
    out[k] = v
  }
  return out
}

/**
 * Converts a stored row into the shape returned by public read endpoints: boolean
 * columns are decoded from their storage representation (`0`/`1` on SQLite) and
 * hidden fields are stripped. Used by `/api/auth/me` and the login route, which
 * read the auth row directly rather than through `CollectionService` (which would
 * apply the collection's `view` rule).
 */
export function toPublicRecord(
  colSchema: CollectionSchema,
  storesBooleanAsInteger: boolean,
  record: RepoRecord
): Effect.Effect<RepoRecord> {
  return makeRowDecoder(colSchema, storesBooleanAsInteger)(record).pipe(
    Effect.map((decoded) => stripHiddenFields(colSchema, decoded))
  )
}
