import { SqlClient } from "@effect/sql"
import { unsafeFragment } from "@effect/sql/Statement"
import { Context, Effect, Layer, Option, Schema } from "effect"
import type { AnyCollectionDef, CollectionSchema } from "@gettersethya/mira-client"
import { filterNodeToWhereClause } from "@gettersethya/mira-client"
import type { FilterNode } from "@gettersethya/mira-client"
import { enforcerForAction } from "@/rule/enforcer.js"
import { Repository } from "@/repository/repository.js"
import type { ExpandDef, RepoRecord, SortOrder, WhereClause } from "@/repository/types.js"
import { FileStorage } from "@/storage/storage.js"
import type { RowDecoder } from "./decode.js"
import { makeRowDecoder } from "./decode.js"
import type { CursorPage, RequestCtx } from "./context.js"
import type { CollectionError } from "./errors.js"
import { ForbiddenError, NotFoundError, ReadOnlyError, ValidationError } from "./errors.js"
import { buildInputSchemas, parseErrToValidationError } from "./input-schema.js"
import { andWhere, cursorClause, idClause, resolveCtxPlaceholders, resolveFieldRefs } from "./where.js"

/**
 * Collection Service tag — the core business-logic layer sitting between
 * the HTTP router and the repository.
 *
 * Each method performs:
 * - Schema validation (field types, required fields, constraints via Effect Schema)
 * - Access rule enforcement (compiles and applies x-rules)
 * - System field management (seqId, created, updated timestamps)
 * - Hidden/read-only field stripping for responses
 * - Cursor-based pagination for list operations
 * - File cleanup on update/delete (best-effort)
 *
 * @example
 * import { CollectionService } from "@gettersethya/mira"
 *
 * Effect.gen(function* () {
 *   const svc = yield* CollectionService
 *   const page = yield* svc.list(postsDef, null, 20, ctx, undefined, { field: "seqId", direction: "asc" })
 * })
 *
 * @see makeCollectionServiceLayer — factory function
 * @see Repository — the underlying data access layer
 */
export class CollectionService extends Context.Tag("CollectionService")<
  CollectionService,
  {
    list(
      collection: AnyCollectionDef,
      cursor: number | null,
      perPage: number,
      ctx: RequestCtx,
      filter?: FilterNode,
      sort?: SortOrder,
      select?: ReadonlyArray<string> | null,
      expand?: ReadonlyArray<string> | null
    ): Effect.Effect<CursorPage, CollectionError>

    view(
      collection: AnyCollectionDef,
      id: string,
      ctx: RequestCtx,
      select?: ReadonlyArray<string> | null,
      expand?: ReadonlyArray<string> | null
    ): Effect.Effect<RepoRecord, CollectionError>

    create(collection: AnyCollectionDef, data: RepoRecord, ctx: RequestCtx): Effect.Effect<RepoRecord, CollectionError>

    update(
      collection: AnyCollectionDef,
      id: string,
      data: RepoRecord,
      ctx: RequestCtx
    ): Effect.Effect<RepoRecord, CollectionError>

    delete(collection: AnyCollectionDef, id: string, ctx: RequestCtx): Effect.Effect<void, CollectionError>
  }
>() {}

function resolveFields(schema: CollectionSchema, userSelect: ReadonlyArray<string> | null, admin = false): ReadonlyArray<string> {
  const nonHidden = Object.entries(schema.properties)
    .filter(([, p]) => admin || !p["x-hidden"])
    .map(([k]) => k)

  if (userSelect === null) return nonHidden

  // Intersect with non-hidden fields (admin bypasses hidden filter)
  const nonHiddenSet = new Set(nonHidden)
  const selected = userSelect.filter((f) => admin || nonHiddenSet.has(f))

  // Always include core system fields needed for the response
  const always = new Set<string>(["id", "created", "updated"])

  for (const a of always) {
    if (!selected.includes(a)) {
      selected.push(a)
    }
  }

  return selected
}

function resolveExpand(
  schema: CollectionSchema,
  expandFieldNames: ReadonlyArray<string> | null,
  allCollections: ReadonlyArray<AnyCollectionDef>
): ReadonlyArray<ExpandDef> {
  if (expandFieldNames === null) return []

  const collectionMap = new Map(allCollections.map((c) => [c.name, c]))
  const result: Array<ExpandDef> = []

  for (const name of expandFieldNames) {
    const prop = schema.properties[name]
    if (!prop || prop["x-kind"] !== "relation") continue
    if (!prop["x-collection"]) continue

    const target = collectionMap.get(prop["x-collection"])
    if (!target) continue

    const targetColumns = resolveFields(target.schema, null)
    result.push({ localField: name, targetTable: prop["x-collection"], targetColumns })
  }

  return result
}

function rejectSystemFields(
  data: RepoRecord,
  schema: CollectionSchema,
  collectionName: string
): Effect.Effect<void, ValidationError> {
  const sysKeys = Object.keys(data).filter((k) => schema.properties[k]?.["x-system"] === true)
  if (sysKeys.length === 0) return Effect.void
  return Effect.fail(
    new ValidationError({
      collection: collectionName,
      issues: [`Fields are read-only: ${sysKeys.join(", ")}`]
    })
  )
}

function extractFileKeys(record: RepoRecord, schema: CollectionSchema): ReadonlyArray<string> {
  return Object.entries(schema.properties)
    .filter(([, prop]) => prop["x-kind"] === "file")
    .map(([field]) => record[field])
    .filter((v): v is string => typeof v === "string" && v.length > 0)
}

function extractReplacedFileKeys(
  existing: RepoRecord,
  patch: RepoRecord,
  schema: CollectionSchema
): ReadonlyArray<string> {
  return Object.entries(schema.properties)
    .filter(([, prop]) => prop["x-kind"] === "file")
    .flatMap(([field]) => {
      const oldKey = existing[field]
      const newKey = patch[field]
      if (typeof oldKey === "string" && oldKey.length > 0 && field in patch && newKey !== oldKey) {
        return [oldKey]
      }
      return []
    })
}

function compileRule(
  collection: AnyCollectionDef,
  action: "list" | "view" | "create" | "update" | "delete",
  ctx: RequestCtx
) {
  const result = enforcerForAction(collection.schema, action)
  if (result === null) {
    return Effect.fail(new ForbiddenError({ collection: collection.name, action }))
  }
  return resolveCtxPlaceholders(result, ctx, collection.name, action)
}

/**
 * Create a `CollectionService` layer for a given set of collection definitions.
 * Each collection gets its own validated service instance with per-collection
 * rules, field schemas, and system field handling.
 *
 * The layer depends on `Repository`, `SqlClient`, and `FileStorage`.
 *
 * @param allCollections - Array of collection definitions
 * @returns A Layer providing CollectionService
 *
 * @example
 * Layer.provideMerge(makeCollectionServiceLayer([Posts, Users]))
 *
 * @see CollectionService — the service tag
 * @see makeCachedCollectionServiceLayer — wrapping layer that adds caching
 */
export function makeCollectionServiceLayer(
  allCollections: ReadonlyArray<AnyCollectionDef>
): Layer.Layer<CollectionService, never, Repository | SqlClient.SqlClient | FileStorage> {
  return Layer.effect(
    CollectionService,
    Effect.gen(function* () {
      const repo = yield* Repository
      const sql = yield* SqlClient.SqlClient
      const fileStorage = yield* FileStorage

      const decoderMap = new Map<string, RowDecoder>(allCollections.map((c) => [c.name, makeRowDecoder(c.schema)]))
      const inputSchemaMap = new Map(allCollections.map((c) => [c.name, buildInputSchemas(c)]))
      const getInputSchemas = (col: AnyCollectionDef) => inputSchemaMap.get(col.name) ?? buildInputSchemas(col)
      const decodeRow = (collection: AnyCollectionDef, record: RepoRecord): Effect.Effect<RepoRecord> =>
        (decoderMap.get(collection.name) ?? Effect.succeed)(record)

      const list = (
        collection: AnyCollectionDef,
        cursor: number | null,
        perPage: number,
        ctx: RequestCtx,
        filter?: FilterNode,
        sort?: SortOrder,
        select?: ReadonlyArray<string> | null,
        expand?: ReadonlyArray<string> | null
      ) =>
        Effect.gen(function* () {
          const ruleWhere = ctx.admin ? null : yield* compileRule(collection, "list", ctx)
          const userFilter =
            filter !== undefined ? yield* filterNodeToWhereClause(filter, collection.schema, collection.name) : null
          const where: WhereClause | null =
            ruleWhere !== null && userFilter !== null ? andWhere(ruleWhere, userFilter) : (userFilter ?? ruleWhere)
          const combined = cursor !== null && where !== null ? andWhere(where, cursorClause(cursor)) : where

          const fields = resolveFields(collection.schema, select ?? null, ctx.admin)
          const expandDefs = resolveExpand(collection.schema, expand ?? null, allCollections)
          const fieldsWithExpand = [...new Set([...fields, ...expandDefs.map((e) => e.localField)])]

          // seqId is x-hidden but must be fetched for cursor-based pagination
          const fieldsForQuery = fieldsWithExpand.includes("seqId") ? fieldsWithExpand : [...fieldsWithExpand, "seqId"]

          const listOpts = {
            sort: sort ?? { field: "seqId", direction: "asc" as const },
            fields: fieldsForQuery,
            expand: expandDefs
          } as const

          const rows = yield* repo.list(
            collection.name,
            perPage,
            combined !== null ? { ...listOpts, where: combined } : listOpts
          )

          const lastRow = rows.items.at(-1)
          const rawSeqId = lastRow?.["seqId"]
          const lastSeqId = typeof rawSeqId === "number" ? rawSeqId : null
          const nextCursor = rows.items.length === perPage ? lastSeqId : null

          // Strip seqId — it's internal and must not appear in API responses
          const items = yield* Effect.forEach(
            rows.items.map((r) => {
              const copy: RepoRecord = { ...r }
              delete copy["seqId"]
              return copy
            }),
            (r) => decodeRow(collection, r)
          )
          return { items, nextCursor }
        }).pipe(
          Effect.withSpan("collection.list", {
            kind: "internal",
            attributes: { collection: collection.name }
          })
        )

      const view = (
        collection: AnyCollectionDef,
        id: string,
        ctx: RequestCtx,
        select?: ReadonlyArray<string> | null,
        expand?: ReadonlyArray<string> | null
      ) =>
        Effect.gen(function* () {
          const ruleWhere = ctx.admin ? null : yield* compileRule(collection, "view", ctx)
          const combined = ruleWhere !== null ? andWhere(ruleWhere, idClause(id)) : idClause(id)

          const fields = resolveFields(collection.schema, select ?? null, ctx.admin)
          const expandDefs = resolveExpand(collection.schema, expand ?? null, allCollections)
          const fieldsWithExpand = [...new Set([...fields, ...expandDefs.map((e) => e.localField)])]

          const rows = yield* repo.viewFilter(collection.name, {
            where: combined,
            fields: fieldsWithExpand,
            expand: expandDefs
          })

          if (rows.length === 0) {
            return yield* new NotFoundError({ collection: collection.name, id })
          }
          return yield* decodeRow(collection, rows[0])
        }).pipe(
          Effect.withSpan("collection.view", {
            kind: "internal",
            attributes: { collection: collection.name }
          })
        )

      const create = (collection: AnyCollectionDef, data: RepoRecord, ctx: RequestCtx) =>
        Effect.gen(function* () {
          if (collection.schema["x-collection-kind"] === "view") {
            return yield* new ReadOnlyError({ collection: collection.name })
          }

          yield* rejectSystemFields(data, collection.schema, collection.name)
          const schemas = getInputSchemas(collection)
          const cleaned = yield* Schema.decodeUnknown(schemas.create)(data).pipe(
            Effect.mapError(parseErrToValidationError(collection.name))
          )

          if (!ctx.admin) {
            const ruleWhere = yield* compileRule(collection, "create", ctx)

            // Pre-check: evaluate the create rule against the payload (no table needed).
            const payloadBound = resolveFieldRefs(ruleWhere, cleaned)
            const where = unsafeFragment(payloadBound.sql, payloadBound.params)
            const check = yield* sql<{ ok: number }>`SELECT 1 AS ok WHERE ${where}`

            if (check.length === 0) {
              return yield* new ForbiddenError({ collection: collection.name, action: "create" })
            }
          }

          const row = yield* repo.create(collection.name, cleaned)
          return yield* decodeRow(collection, row)
        }).pipe(
          Effect.withSpan("collection.create", {
            kind: "internal",
            attributes: { collection: collection.name }
          })
        )

      const update = (collection: AnyCollectionDef, id: string, data: RepoRecord, ctx: RequestCtx) =>
        Effect.gen(function* () {
          if (collection.schema["x-collection-kind"] === "view") {
            return yield* new ReadOnlyError({ collection: collection.name })
          }

          yield* rejectSystemFields(data, collection.schema, collection.name)
          const schemas = getInputSchemas(collection)
          const cleaned = yield* Schema.decodeUnknown(schemas.update)(data).pipe(
            Effect.mapError(parseErrToValidationError(collection.name))
          )

          // If the collection has no rules at all, deny immediately (don't leak existence)
          if (!ctx.admin) {
            const enforcerResult = enforcerForAction(collection.schema, "update")
            if (enforcerResult === null) {
              return yield* new ForbiddenError({ collection: collection.name, action: "update" })
            }
          }

          const existing = yield* repo.view(collection.name, id)
          if (Option.isNone(existing)) {
            return yield* new NotFoundError({ collection: collection.name, id })
          }

          if (!ctx.admin) {
            const ruleWhere = yield* compileRule(collection, "update", ctx)

            // Rule check against this specific row
            const combined = andWhere(ruleWhere, idClause(id))
            const allowed = yield* repo.viewFilter(collection.name, { where: combined })
            if (allowed.length === 0) {
              return yield* new ForbiddenError({ collection: collection.name, action: "update" })
            }
          }

          const updated = yield* repo.update(collection.name, id, cleaned)

          // Best-effort: delete old files and their thumbnails for any replaced file fields.
          const oldKeys = extractReplacedFileKeys(existing.value, cleaned, collection.schema)
          yield* Effect.forEach(
            oldKeys,
            (key) =>
              Effect.gen(function* () {
                yield* fileStorage.delete(key).pipe(Effect.orElse(() => Effect.void))
                const thumbKeys = yield* fileStorage.list(`_thumbs/${key}/`).pipe(Effect.orElseSucceed(() => []))
                yield* Effect.forEach(
                  thumbKeys,
                  (tk) => fileStorage.delete(tk).pipe(Effect.orElse(() => Effect.void)),
                  { concurrency: "unbounded" }
                )
              }),
            { concurrency: "unbounded" }
          )

          return yield* decodeRow(
            collection,
            Option.getOrElse(updated, () => existing.value)
          )
        }).pipe(
          Effect.withSpan("collection.update", {
            kind: "internal",
            attributes: { collection: collection.name }
          })
        )

      const deleteImpl = (collection: AnyCollectionDef, id: string, ctx: RequestCtx) =>
        Effect.gen(function* () {
          if (collection.schema["x-collection-kind"] === "view") {
            return yield* new ReadOnlyError({ collection: collection.name })
          }

          // If the collection has no rules at all, deny immediately (don't leak existence)
          if (!ctx.admin) {
            const enforcerResult = enforcerForAction(collection.schema, "delete")
            if (enforcerResult === null) {
              return yield* new ForbiddenError({ collection: collection.name, action: "delete" })
            }
          }

          const existing = yield* repo.view(collection.name, id)
          if (Option.isNone(existing)) {
            return yield* new NotFoundError({ collection: collection.name, id })
          }

          if (!ctx.admin) {
            const ruleWhere = yield* compileRule(collection, "delete", ctx)
            const combined = andWhere(ruleWhere, idClause(id))
            const allowed = yield* repo.viewFilter(collection.name, { where: combined })
            if (allowed.length === 0) {
              return yield* new ForbiddenError({ collection: collection.name, action: "delete" })
            }
          }

          yield* repo.delete(collection.name, id)

          // Best-effort: delete files and their thumbnails after the record is gone.
          const keys = extractFileKeys(existing.value, collection.schema)
          yield* Effect.forEach(
            keys,
            (key) =>
              Effect.gen(function* () {
                yield* fileStorage.delete(key).pipe(Effect.orElse(() => Effect.void))
                const thumbKeys = yield* fileStorage.list(`_thumbs/${key}/`).pipe(Effect.orElseSucceed(() => []))
                yield* Effect.forEach(
                  thumbKeys,
                  (tk) => fileStorage.delete(tk).pipe(Effect.orElse(() => Effect.void)),
                  { concurrency: "unbounded" }
                )
              }),
            { concurrency: "unbounded" }
          )
        }).pipe(
          Effect.withSpan("collection.delete", {
            kind: "internal",
            attributes: { collection: collection.name }
          })
        )

      return { list, view, create, update, delete: deleteImpl }
    })
  )
}

/** @deprecated Use makeCollectionServiceLayer(allCollections) */
export const CollectionServiceLive = makeCollectionServiceLayer([])
