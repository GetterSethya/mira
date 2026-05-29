import { Schema } from "effect"
import { Effect } from "effect"
import type { CollectionSchema } from "@gettersethya/mira-client"
import { ValidationError } from "@/collection-service/errors.js"
import { FilterNodeSchema } from "@gettersethya/mira-client"
import type { FilterNode } from "@gettersethya/mira-client"
import type { SortOrder, WhereClause } from "@/repository/types.js"
import type { RequestCtx } from "@/collection-service/context.js"

export function parseFilterParam(
  query: RequestCtx["query"],
  schema: CollectionSchema,
  collectionName: string
): Effect.Effect<FilterNode | null, ValidationError> {
  const raw = typeof query["filter"] === "string" ? query["filter"] : null
  if (raw === null) return Effect.succeed(null)

  return Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => JSON.parse(raw),
      catch: () => new ValidationError({ collection: collectionName, issues: ["filter: invalid JSON"] })
    })

    const decoded = yield* Schema.decodeUnknown(FilterNodeSchema)(parsed).pipe(
      Effect.mapError((e) =>
        new ValidationError({
          collection: collectionName,
          issues: [`filter: schema mismatch: ${e.message}`]
        })
      )
    )
    return decoded
  })
}

export function parseSortParam(
  query: RequestCtx["query"],
  schema: CollectionSchema
): SortOrder | null {
  const sortField = typeof query["sort"] === "string" ? query["sort"] : null
  if (sortField === null || !schema.properties[sortField]) return null
  const rawOrder = typeof query["order"] === "string" ? query["order"] : null
  const direction = rawOrder === "desc" ? "desc" : "asc"
  return { field: sortField, direction }
}

export function parsePaginationParam(
  query: RequestCtx["query"]
): { cursor: number | null; limit: number } {
  const rawCursor = typeof query["after"] === "string" ? Number(query["after"]) : NaN
  const rawLimit  = typeof query["limit"]  === "string" ? Number(query["limit"])  : NaN
  const cursor = !Number.isNaN(rawCursor) && rawCursor >= 0 ? Math.floor(rawCursor) : null
  const limit  = !Number.isNaN(rawLimit)  && rawLimit  >= 1 ? Math.min(Math.floor(rawLimit), 100) : 30
  return { cursor, limit }
}

export function parseSelectParam(
  query: RequestCtx["query"]
): ReadonlyArray<string> | null {
  const raw = typeof query["select"] === "string" ? query["select"] : null
  if (raw === null) return null
  return raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
}

export function parseExpandParam(
  query: RequestCtx["query"]
): ReadonlyArray<string> | null {
  const raw = typeof query["expand"] === "string" ? query["expand"] : null
  if (raw === null) return null
  return raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
}
