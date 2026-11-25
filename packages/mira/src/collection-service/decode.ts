import type { CollectionSchema } from "@gettersethya/mira-client"
import { Effect, Schema } from "effect"

import type { RepoRecord } from "@/repository/types.js"

import { cursorFromSeqId } from "./cursor.js"

export type RowDecoder = (record: RepoRecord) => Effect.Effect<RepoRecord>
/** Synchronous row decoder: pure, allocates one new row, never mutates its input. */
export type RowDecoderSync = (record: RepoRecord) => RepoRecord
export type RowEncoder = (record: RepoRecord) => RepoRecord

type SchemaProperty = CollectionSchema["properties"][string]

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

const INTEGER_STRING = /^-?\d+$/
const NUMERIC_STRING = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/

function booleanKeys(colSchema: CollectionSchema) {
  const boolKeys = new Set<string>()
  for (const [key, prop] of Object.entries(colSchema.properties)) {
    if (prop.type === "boolean") boolKeys.add(key)
  }
  return boolKeys
}

function isRecord(value: unknown): value is RepoRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function normalizeSeqIdField(value: unknown): unknown {
  if (typeof value !== "bigint") return value
  const cursor = cursorFromSeqId(value)
  return cursor === null ? value : cursor
}

function normalizeExpand(expand: RepoRecord): RepoRecord {
  let out: RepoRecord | undefined
  for (const [key, value] of Object.entries(expand)) {
    if (!isRecord(value)) continue
    const normalized = normalizeSeqId(value)
    if (normalized === value) continue
    if (out === undefined) out = { ...expand }
    out[key] = normalized
  }
  return out ?? expand
}

/**
 * Normalizes a driver `bigint` `seqId` to the opaque cursor form. Only the
 * `seqId` key and a nested `expand` object are inspected; any other record,
 * including a `seqId` already stored as a number or string, is returned by
 * identity. An out-of-range bigint is also left untouched.
 */
export function normalizeSeqId(record: RepoRecord): RepoRecord {
  const seqId = record["seqId"]
  const normalizedSeqId = normalizeSeqIdField(seqId)
  const expand = record["expand"]
  const normalizedExpand = isRecord(expand) ? normalizeExpand(expand) : expand
  if (normalizedSeqId === seqId && normalizedExpand === expand) return record

  const out = { ...record }
  if (normalizedSeqId !== seqId) out["seqId"] = normalizedSeqId
  if (normalizedExpand !== expand) out["expand"] = normalizedExpand
  return out
}

function coerceInteger(value: unknown): unknown {
  if (typeof value === "bigint") {
    const number = Number(value)
    return Number.isSafeInteger(number) ? number : value.toString()
  }
  if (typeof value === "string" && INTEGER_STRING.test(value)) {
    const number = Number(value)
    return Number.isSafeInteger(number) ? number : BigInt(value).toString()
  }
  return value
}

function coerceNumber(value: unknown): unknown {
  if (typeof value === "bigint") {
    const number = Number(value)
    return Number.isFinite(number) ? number : value
  }
  if (typeof value === "string" && NUMERIC_STRING.test(value)) {
    const number = Number(value)
    return Number.isFinite(number) ? number : value
  }
  return value
}

function coerceBoolean(value: unknown): unknown {
  if (typeof value === "boolean") return value
  if (value === 0 || value === 1) return value === 1
  if (typeof value === "bigint" && (value === 0n || value === 1n)) return value === 1n
  return value
}

function decodeViewField(value: unknown, prop: SchemaProperty): unknown {
  if (prop["x-kind"] === "json") {
    return typeof value === "string" ? value : encodeJson(value)
  }
  switch (prop.type) {
    case "integer":
      return coerceInteger(value)
    case "number":
      return coerceNumber(value)
    case "boolean":
      return coerceBoolean(value)
    default:
      return value
  }
}

/**
 * Decodes a view row against the declared view schema: `bigint` and numeric
 * strings become the JavaScript values the schema promises, JSON values become
 * their text storage form, and `seqId` keeps the cursor type.
 */
export function decodeViewRow(record: RepoRecord, colSchema: CollectionSchema): RepoRecord {
  const normalized = normalizeSeqId(record)
  let out: RepoRecord | undefined
  for (const [key, prop] of Object.entries(colSchema.properties)) {
    if (key === "seqId") continue
    const value = normalized[key]
    if (value === undefined || value === null) continue
    const decoded = decodeViewField(value, prop)
    if (decoded === value) continue
    if (out === undefined) out = { ...normalized }
    out[key] = decoded
  }
  return out ?? normalized
}

/** Shared no-op decoder so `makeRowDecoderSync` can report "nothing to do" by identity. */
const identityRow: RowDecoderSync = (record) => record

/**
 * Synchronous counterpart to {@link makeRowDecoder}. View rows always run
 * {@link decodeViewRow}. Base and auth rows convert `0`/`1` to booleans when the
 * dialect stores them as integers and, when `normalizesBigintSeqId` is set,
 * normalize a bigint `seqId`. The input row is never mutated. Returns the shared
 * identity function when neither conversion is needed.
 */
export function makeRowDecoderSync(
  colSchema: CollectionSchema,
  storesBooleanAsInteger: boolean,
  normalizesBigintSeqId = false
): RowDecoderSync {
  if (colSchema["x-collection-kind"] === "view") {
    return (record) => decodeViewRow(record, colSchema)
  }

  const boolKeys = storesBooleanAsInteger ? booleanKeys(colSchema) : undefined
  const hasBooleanKeys = boolKeys !== undefined && boolKeys.size > 0
  if (!normalizesBigintSeqId && !hasBooleanKeys) return identityRow

  return (record) => {
    const normalized = normalizesBigintSeqId ? normalizeSeqId(record) : record
    if (boolKeys === undefined || boolKeys.size === 0) return normalized

    const result = { ...normalized }
    for (const key of boolKeys) {
      const v = result[key]
      if (v === 0 || v === 1) result[key] = v === 1
    }
    return result
  }
}

export function makeRowDecoder(
  colSchema: CollectionSchema,
  storesBooleanAsInteger: boolean,
  normalizesBigintSeqId = false
): RowDecoder {
  const syncDecode = makeRowDecoderSync(colSchema, storesBooleanAsInteger, normalizesBigintSeqId)
  if (syncDecode === identityRow) return Effect.succeed

  return (record) => Effect.sync(() => syncDecode(record))
}

/**
 * Builds the single-pass mapper used by `CollectionService.list`: it turns a
 * repository row into a public list item, dropping `seqId` (the internal cursor
 * column) and decoding boolean storage representation at the same time.
 *
 * View rows are decoded with {@link decodeViewRow} before `seqId` is dropped.
 * When `normalizesBigintSeqId` is set, the nested `expand` object is normalized
 * with {@link normalizeSeqId} only, never with the view decoder.
 *
 * The source row is never mutated - the response item is a fresh object, so the
 * repository result cannot leak `seqId` back through the cache or another caller.
 */
export function makeListRowMapper(
  colSchema: CollectionSchema,
  storesBooleanAsInteger: boolean,
  normalizesBigintSeqId = false
) {
  const view = colSchema["x-collection-kind"] === "view"
  const boolKeys = storesBooleanAsInteger ? booleanKeys(colSchema) : undefined

  return (record: RepoRecord): RepoRecord => {
    const source = view ? decodeViewRow(record, colSchema) : normalizesBigintSeqId ? normalizeSeqId(record) : record
    const out: RepoRecord = {}
    for (const key of Object.keys(source)) {
      if (key === "seqId") continue
      const value = source[key]
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
  projection: ReadonlyArray<string>,
  normalizesBigintSeqId = false
) {
  const view = colSchema["x-collection-kind"] === "view"
  const keys = projection
    .filter((key) => key !== "seqId")
    .map((key) => ({
      key,
      boolean:
        storesBooleanAsInteger && colSchema.properties[key]?.type === "boolean"
    }))

  return (record: RepoRecord): RepoRecord => {
    const source = view ? decodeViewRow(record, colSchema) : normalizesBigintSeqId ? normalizeSeqId(record) : record
    const out: RepoRecord = {}
    for (const entry of keys) {
      if (!Object.hasOwn(source, entry.key)) continue
      const value = source[entry.key]
      out[entry.key] =
        entry.boolean && (value === 0 || value === 1) ? value === 1 : value
    }
    if (Object.hasOwn(source, "expand")) out["expand"] = source["expand"]
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
