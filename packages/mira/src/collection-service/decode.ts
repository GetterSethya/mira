import { Effect, Schema } from "effect"
import type { CollectionSchema } from "@gettersethya/mira-client"
import type { RepoRecord } from "@/repository/types.js"

const RecordSchema = Schema.Record({ key: Schema.String, value: Schema.Unknown })

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

  const RowSchema = Schema.transform(RecordSchema, RecordSchema, {
    decode: (record) => {
      const result = { ...record }
      for (const key of boolKeys) {
        const v = result[key]
        if (v === 0 || v === 1) result[key] = v === 1
      }
      return result
    },
    encode: (v) => v
  })

  const decode = Schema.decodeUnknown(RowSchema)
  return (record) => decode(record).pipe(Effect.orDie, Effect.map((r) => r as RepoRecord))
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
