import type { CollectionSchema } from "@gettersethya/mira-client"
import { Effect } from "effect"

import type { RepoRecord } from "@/repository/types.js"

export type RowDecoder = (record: RepoRecord) => Effect.Effect<RepoRecord>
export type RowEncoder = (record: RepoRecord) => RepoRecord

function booleanKeys(colSchema: CollectionSchema) {
  const boolKeys = new Set<string>()
  for (const [key, prop] of Object.entries(colSchema.properties)) {
    if (prop.type === "boolean") boolKeys.add(key)
  }
  return boolKeys
}

export function makeRowDecoder(colSchema: CollectionSchema, storesBooleanAsInteger: boolean): RowDecoder {
  if (!storesBooleanAsInteger) return Effect.succeed

  const boolKeys = booleanKeys(colSchema)
  if (boolKeys.size === 0) return Effect.succeed

  return (record) =>
    Effect.sync(() => {
      const result = { ...record }
      for (const key of boolKeys) {
        const v = result[key]
        if (v === 0 || v === 1) result[key] = v === 1
      }
      return result
    })
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
