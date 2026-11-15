import type { AnyCollectionDef, CollectionSchema } from "@gettersethya/mira-client"
import type { FilterNode } from "@gettersethya/mira-client"
import { filterNodeToWhereClause } from "@gettersethya/mira-client"
import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { literal } from "effect/sql/Statement"

import { AuthChallengeStore } from "@/auth/challenge-store.js"
import { Dialect } from "@/dialect/dialect.js"
import { AuthService } from "@/http/auth.js"
import { Repository } from "@/repository/repository.js"
import type { ExpandDef, RepoRecord, SortOrder, WhereClause } from "@/repository/types.js"
import { enforcerForAction } from "@/rule/enforcer.js"
import { FileStorage } from "@/storage/storage.js"

import type { CursorPage, RequestCtx } from "./context.js"
import { CreateBatcher, CreateBatcherDisabledLive, estimateRowBytes, makeCreateBatcherLayer } from "./create-batcher.js"
import type { CreateBatchStats, PreparedCreate, ResolvedBatchOperationConfig } from "./create-batcher.js"
import type { RowDecoder, RowDecoderSync, RowEncoder } from "./decode.js"
import { makeListRowMapper, makeRowDecoder, makeRowEncoder, stripHiddenFields } from "./decode.js"
import type { CollectionError } from "./errors.js"
import { ForbiddenError, NotFoundError, ReadOnlyError, ValidationError } from "./errors.js"
import { buildInputSchemas, parseErrToValidationError } from "./input-schema.js"
import type { ResolveOptions } from "./where.js"
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
export class CollectionService extends Context.Service<
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

    /**
     * Create several records in one database transaction.
     *
     * Every record goes through the same path as {@link create} — validation,
     * rule enforcement, credential checks, password hashing, id/timestamp
     * generation and hidden-field stripping — so batch semantics never diverge
     * from single-record semantics. A failure on any record rolls the whole
     * batch back.
     */
    createMany(
      collection: AnyCollectionDef,
      records: ReadonlyArray<RepoRecord>,
      ctx: RequestCtx
    ): Effect.Effect<ReadonlyArray<RepoRecord>, CollectionError>

    update(
      collection: AnyCollectionDef,
      id: string,
      data: RepoRecord,
      ctx: RequestCtx
    ): Effect.Effect<RepoRecord, CollectionError>

    /**
     * Update several records in one database transaction.
     *
     * Each entry runs through the same path as {@link update} — validation,
     * rule enforcement against the effective post-write row, credential checks,
     * password hashing, timestamps and hidden-field stripping. A missing id, a
     * denied rule or an invalid payload rolls the whole batch back.
     */
    updateMany(
      collection: AnyCollectionDef,
      updates: ReadonlyArray<{ id: string; data: RepoRecord }>,
      ctx: RequestCtx
    ): Effect.Effect<ReadonlyArray<RepoRecord>, CollectionError>

    delete(collection: AnyCollectionDef, id: string, ctx: RequestCtx): Effect.Effect<void, CollectionError>

    /**
     * Delete several records in one database transaction.
     *
     * Each id runs through the same path as {@link delete} — existence check,
     * rule enforcement, file/thumbnail cleanup. A missing id or a denied rule
     * rolls the whole batch back, so the returned ids are exactly the rows that
     * were deleted.
     */
    deleteMany(
      collection: AnyCollectionDef,
      ids: ReadonlyArray<string>,
      ctx: RequestCtx
    ): Effect.Effect<ReadonlyArray<string>, CollectionError>
  }
>()("CollectionService") {}

/**
 * Maximum number of records accepted by a single bulk create/update/delete
 * request.
 *
 * The whole batch runs inside one transaction, so it buffers every record's
 * payload, hooks and result in memory. 1 000 keeps that bounded while remaining
 * large enough for realistic seeding, import and cleanup jobs.
 */
export const MAX_BULK_RECORDS = 1_000

/** @deprecated Use {@link MAX_BULK_RECORDS}. Kept as a compatibility alias. */
export const MAX_BULK_CREATE_RECORDS = MAX_BULK_RECORDS

function resolveFields(schema: CollectionSchema, userSelect: ReadonlyArray<string> | null, admin = false): ReadonlyArray<string> {
  const properties = schema.properties
  const isVisible = (field: string) => admin || properties[field]["x-hidden"] !== true
  const nonHidden = Object.keys(properties).filter(isVisible)

  if (userSelect === null) return nonHidden

  // Allowlist every requested name against the collection's own property keys
  // (`Object.hasOwn`) — for admin too. Only real fields are selected.
  const selected = userSelect.filter((f) => Object.hasOwn(properties, f) && isVisible(f))

  // Always include core system fields needed for the response
  const always = new Set<string>(["id", "created", "updated"])

  for (const a of always) {
    if (!selected.includes(a)) {
      selected.push(a)
    }
  }

  return selected
}

/**
 * Resolve the requested `expand=` relation names into join definitions.
 *
 * A relation is only joined when the caller is allowed to read the target row:
 * - admin bypasses the target's rules entirely (unrestricted join);
 * - otherwise the target collection's `view` rule is compiled against the
 *   current `ctx` and attached as `onClause`;
 * - a target with no `view` rule, or a rule that needs auth when the caller is
 *   anonymous, is not expanded.
 *
 * Duplicate names are collapsed so `expand=profile,profile` emits one join.
 */
function resolveExpand(
  schema: CollectionSchema,
  expandFieldNames: ReadonlyArray<string> | null,
  allCollections: ReadonlyArray<AnyCollectionDef>,
  ctx: RequestCtx
) {
  return Effect.gen(function* () {
    if (expandFieldNames === null) return []

    const collectionMap = new Map(allCollections.map((c) => [c.name, c]))
    const result: Array<ExpandDef> = []
    const seen = new Set<string>()

    for (const name of expandFieldNames) {
      if (seen.has(name)) continue
      seen.add(name)

      const prop = schema.properties[name]
      if (!prop || prop["x-kind"] !== "relation") continue
      if (!prop["x-collection"]) continue

      const target = collectionMap.get(prop["x-collection"])
      if (!target) continue

      const targetColumns = resolveFields(target.schema, null, ctx.admin === true)
      const base: ExpandDef = { localField: name, targetTable: prop["x-collection"], targetColumns }

      if (ctx.admin === true) {
        result.push(base)
        continue
      }

      // No view rule on the target → do not expand.
      const targetView = enforcerForAction(target.schema, "view")
      if (targetView === null) continue

      // A rule that needs auth with no authenticated actor → do not expand.
      const resolved = yield* resolveCtxPlaceholders(targetView, ctx, target.name, "view").pipe(
        Effect.catchTag("ForbiddenError", () => Effect.succeed(null))
      )
      if (resolved === null) continue

      result.push({ ...base, onClause: resolved })
    }

    return result
  })
}

/**
 * Reject a user-supplied sort on an `x-hidden` field for non-admin callers.
 * Unknown fields are ignored (falls back to the default `seqId` order),
 * matching prior behaviour.
 */
function validateSort(
  schema: CollectionSchema,
  collectionName: string,
  sort: SortOrder,
  admin: boolean
) {
  const prop = Object.hasOwn(schema.properties, sort.field) ? schema.properties[sort.field] : undefined
  if (prop === undefined) return Effect.succeed(undefined)
  if (!admin && prop["x-hidden"] === true) {
    return Effect.fail(
      new ValidationError({
        collection: collectionName,
        issues: [`Hidden field cannot be sorted: "${sort.field}"`]
      })
    )
  }
  return Effect.succeed(sort)
}

// These fields are auto-generated by the system and must never be accepted from user input.
// Detected via the `x-generated` schema annotation rather than a hardcoded name list,
// so auth fields (email/password) and future additions stay user-writable.
function rejectSystemFields(
  data: RepoRecord,
  schema: CollectionSchema,
  collectionName: string
): Effect.Effect<void, ValidationError> {
  const sysKeys = Object.keys(data).filter((k) => schema.properties[k]?.["x-generated"] === true)
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
  ctx: RequestCtx,
  options?: ResolveOptions
) {
  const result = enforcerForAction(collection.schema, action)
  if (result === null) {
    return Effect.fail(new ForbiddenError({ collection: collection.name, action }))
  }
  return resolveCtxPlaceholders(result, ctx, collection.name, action, options)
}

/**
 * Dependencies the collection service layer needs from the app.
 */
type CollectionServiceDeps = Repository | SqlClient.SqlClient | FileStorage | Dialect | AuthService

/**
 * Create a `CollectionService` layer for a given set of collection definitions.
 * Each collection gets its own validated service instance with per-collection
 * rules, field schemas, and system field handling.
 *
 * Create batching is provided internally as the disabled (inline) batcher, so
 * this signature and the layer's requirements are unchanged. Use
 * `makeBatchedCollectionServiceLayer` to enable transparent create batching.
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
 * @see makeBatchedCollectionServiceLayer — same layer with create batching enabled
 */
export function makeCollectionServiceLayer(
  allCollections: ReadonlyArray<AnyCollectionDef>
): Layer.Layer<CollectionService, never, CollectionServiceDeps> {
  return makeCollectionServiceLayerWith(allCollections, CreateBatcherDisabledLive)
}

/**
 * Create a `CollectionService` layer whose `create` inserts go through the
 * shared create batcher.
 *
 * The batcher merges concurrent single creates into one transaction per flush.
 * Preparation (validation, rules, credentials, password hashing) still runs in
 * the caller's fiber before queueing.
 *
 * @param allCollections - Array of collection definitions
 * @param config - A resolved (validated) batching configuration
 * @param statsLayer - The app's single `CreateBatchStats` layer value
 */
export function makeBatchedCollectionServiceLayer(
  allCollections: ReadonlyArray<AnyCollectionDef>,
  config: ResolvedBatchOperationConfig,
  statsLayer: Layer.Layer<CreateBatchStats>
): Layer.Layer<CollectionService, never, CollectionServiceDeps> {
  return makeCollectionServiceLayerWith(allCollections, makeCreateBatcherLayer(config, statsLayer))
}

function makeCollectionServiceLayerWith(
  allCollections: ReadonlyArray<AnyCollectionDef>,
  batcherLayer: Layer.Layer<CreateBatcher, never, SqlClient.SqlClient>
): Layer.Layer<CollectionService, never, CollectionServiceDeps> {
  return Layer.effect(
    CollectionService,
    Effect.gen(function* () {
      const repo = yield* Repository
      const sql = yield* SqlClient.SqlClient
      const batcher = yield* CreateBatcher
      const fileStorage = yield* FileStorage
      const dialect = yield* Dialect
      const authService = yield* AuthService
      const challengeStore = yield* AuthChallengeStore
      const resolveOptions: ResolveOptions = {
        encodeParam: dialect.storesBooleanAsInteger
          ? (value) => (typeof value === "boolean" ? (value ? 1 : 0) : value)
          : (value) => value
      }

      // One-time dev warning: a `@request_body_` reference in a list/view/delete
      // rule can never match a submitted value — bodiless actions carry no body,
      // so the reference always resolves to null. Warn once per collection/action
      // here at layer-build time, never per request.
      for (const col of allCollections) {
        for (const action of ["list", "view", "delete"] as const) {
          const compiled = enforcerForAction(col.schema, action)
          if (compiled !== null && compiled.sql.includes("@request_body_")) {
            yield* Effect.logWarning(
              `Collection "${col.name}" ${action} rule references @request_body_* but ${action} requests carry no body — the reference always resolves to null`
            )
          }
        }
      }

      // Passwords on auth collections are hashed here, at the single write
      // chokepoint, so every caller (HTTP router, dashboard, plugins) stores a
      // hash rather than a plaintext value. On update, an empty password is
      // dropped from the patch entirely so an edit form that leaves the field
      // blank does not overwrite the stored hash.
      const hashAuthPassword = (
        collection: AnyCollectionDef,
        data: RepoRecord,
        dropEmpty: boolean
      ): Effect.Effect<RepoRecord> =>
        Effect.gen(function* () {
          if (collection.schema["x-collection-kind"] !== "auth") return data
          if (!("password" in data)) return data
          const raw = data["password"]
          if (typeof raw !== "string" || raw.length === 0) {
            if (!dropEmpty) return data
            const withoutPassword = { ...data }
            delete withoutPassword["password"]
            return withoutPassword
          }
          const hash = yield* authService.hashPassword(raw)
          return { ...data, password: hash }
        })

      const decoderMap = new Map<string, RowDecoder>(
        allCollections.map((c) => [c.name, makeRowDecoder(c.schema, dialect.storesBooleanAsInteger)])
      )
      const listRowMapperMap = new Map<string, RowDecoderSync>(
        allCollections.map((c) => [c.name, makeListRowMapper(c.schema, dialect.storesBooleanAsInteger)])
      )
      const encoderMap = new Map<string, RowEncoder>(
        allCollections.map((c) => [c.name, makeRowEncoder(c.schema, dialect.storesBooleanAsInteger)])
      )
      const inputSchemaMap = new Map(allCollections.map((c) => [c.name, buildInputSchemas(c)]))
      const getInputSchemas = (col: AnyCollectionDef) => inputSchemaMap.get(col.name) ?? buildInputSchemas(col)
      const decodeRow = (collection: AnyCollectionDef, record: RepoRecord): Effect.Effect<RepoRecord> =>
        (decoderMap.get(collection.name) ?? Effect.succeed)(record)
      const getListRowMapper = (collection: AnyCollectionDef): RowDecoderSync =>
        listRowMapperMap.get(collection.name) ??
        makeListRowMapper(collection.schema, dialect.storesBooleanAsInteger)
      const getEncoder = (collection: AnyCollectionDef): RowEncoder => encoderMap.get(collection.name) ?? ((r) => r)

      // create/update return the stored row directly (no `resolveFields` pass), so
      // hidden fields (auth password, seqId) must be stripped here for non-admin
      // callers — matching the list/view response contract.
      const stripHidden = (collection: AnyCollectionDef, record: RepoRecord, admin: boolean): RepoRecord => {
        if (admin) return record
        return stripHiddenFields(collection.schema, record)
      }

      const isAuthCollection = (collection: AnyCollectionDef) =>
        collection.schema["x-collection-kind"] === "auth"

      const asString = (value: unknown) => (typeof value === "string" ? value : undefined)

      // canManage = admin OR (auth + authenticated + manage rule matches). Evaluated
      // against the incoming payload for create (emailVerified forced false so the
      // rule can't be gamed by the field it guards) and against the stored record for
      // update. Additive: the base create/update rule still gates access — manage only
      // escalates privileges (email, emailVerified, password without oldPassword).
      const canManagePayload = (
        collection: AnyCollectionDef,
        payload: RepoRecord,
        ctx: RequestCtx
      ) =>
        Effect.gen(function* () {
          if (ctx.admin === true) return true
          if (!isAuthCollection(collection) || ctx.auth === undefined) return false
          const rule = enforcerForAction(collection.schema, "manage")
          if (rule === null) return false
          const resolved = yield* resolveCtxPlaceholders(rule, ctx, collection.name, "manage", resolveOptions)
          const bound = resolveFieldRefs(resolved, { ...payload, emailVerified: false }, resolveOptions)
          const where = literal(bound.sql, bound.params)
          const check = yield* sql<{ ok: number }>`SELECT 1 AS ok WHERE ${where}`
          return check.length > 0
        })

      const canManageRecord = (
        collection: AnyCollectionDef,
        id: string,
        ctx: RequestCtx
      ) =>
        Effect.gen(function* () {
          if (ctx.admin === true) return true
          if (!isAuthCollection(collection) || ctx.auth === undefined) return false
          const rule = enforcerForAction(collection.schema, "manage")
          if (rule === null) return false
          const resolved = yield* resolveCtxPlaceholders(rule, ctx, collection.name, "manage", resolveOptions)
          const allowed = yield* repo.viewFilter(collection.name, {
            where: andWhere(resolved, idClause(id))
          })
          return allowed.length > 0
        })

      const credentialError = (collection: AnyCollectionDef, issue: string) =>
        new ValidationError({ collection: collection.name, issues: [issue] })

      const verifyOldPassword = (
        collection: AnyCollectionDef,
        raw: RepoRecord,
        existing: RepoRecord
      ) =>
        Effect.gen(function* () {
          const oldPassword = asString(raw["oldPassword"])
          if (oldPassword === undefined || oldPassword.length === 0) {
            return yield* Effect.fail(credentialError(collection, "oldPassword is required"))
          }
          const stored = asString(existing["password"])
          const ok = stored !== undefined
            ? yield* authService.verifyPassword(oldPassword, stored).pipe(Effect.orElseSucceed(() => false))
            : false
          if (!ok) {
            return yield* Effect.fail(credentialError(collection, "Missing or invalid old password"))
          }
        })

      const enforceCreateCredentials = (
        collection: AnyCollectionDef,
        raw: RepoRecord,
        cleaned: RepoRecord,
        canManage: boolean,
        ctx: RequestCtx
      ) =>
        Effect.gen(function* () {
          if (!isAuthCollection(collection) || ctx.admin === true || ctx.internal === "auth-flow") return
          const password = asString(cleaned["password"]) ?? asString(raw["password"]) ?? ""
          if (password.length > 0) {
            const confirm = asString(raw["passwordConfirm"])
            if (confirm === undefined || confirm !== password) {
              return yield* Effect.fail(credentialError(collection, "passwordConfirm must match password"))
            }
          }
          if (!canManage && cleaned["emailVerified"] === true) {
            return yield* Effect.fail(credentialError(collection, "emailVerified cannot be set"))
          }
        })

      const enforceUpdateCredentials = (
        collection: AnyCollectionDef,
        raw: RepoRecord,
        cleaned: RepoRecord,
        existing: RepoRecord,
        canManage: boolean,
        ctx: RequestCtx
      ) =>
        Effect.gen(function* () {
          if (!isAuthCollection(collection)) return
          if (ctx.internal === "auth-flow" || ctx.internal === "email-change") {
            const allowed =
              ctx.internal === "email-change"
                ? new Set(["email", "emailVerified"])
                : new Set(["password", "emailVerified"])
            const disallowed = Object.keys(cleaned).filter((key) => !allowed.has(key))
            if (disallowed.length > 0) {
              return yield* Effect.fail(
                credentialError(collection, `${ctx.internal} cannot update: ${disallowed.join(", ")}`)
              )
            }
            return
          }
          if (ctx.admin === true) return
          const newPassword = asString(cleaned["password"])
          const passwordChanging = newPassword !== undefined && newPassword.length > 0
          const emailChanging = "email" in cleaned && cleaned["email"] !== existing["email"]
          const verifiedChanging =
            "emailVerified" in cleaned && Boolean(cleaned["emailVerified"]) !== Boolean(existing["emailVerified"])

          if (passwordChanging) {
            const confirm = asString(raw["passwordConfirm"])
            if (confirm === undefined || confirm !== newPassword) {
              return yield* Effect.fail(credentialError(collection, "passwordConfirm must match password"))
            }
          }

          if (!canManage && (passwordChanging || emailChanging)) {
            yield* verifyOldPassword(collection, raw, existing)
          }

          if (!canManage && verifiedChanging) {
            return yield* Effect.fail(credentialError(collection, "emailVerified cannot be changed"))
          }
        })

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
          const ruleWhere = ctx.admin ? null : yield* compileRule(collection, "list", ctx, resolveOptions)
          const userFilter =
            filter !== undefined
              ? yield* filterNodeToWhereClause(filter, collection.schema, collection.name, {
                  allowHiddenFields: ctx.admin === true
                })
              : null
          const where: WhereClause | null =
            ruleWhere !== null && userFilter !== null ? andWhere(ruleWhere, userFilter) : (userFilter ?? ruleWhere)
          const combined = cursor !== null && where !== null ? andWhere(where, cursorClause(cursor)) : where

          const sortOrder = sort !== undefined ? yield* validateSort(collection.schema, collection.name, sort, ctx.admin === true) : undefined
          const fields = resolveFields(collection.schema, select ?? null, ctx.admin === true)
          const expandDefs = yield* resolveExpand(collection.schema, expand ?? null, allCollections, ctx)
          const fieldsWithExpand = [...new Set([...fields, ...expandDefs.map((e) => e.localField)])]

          // seqId is x-hidden but must be fetched for cursor-based pagination
          const fieldsForQuery = fieldsWithExpand.includes("seqId") ? fieldsWithExpand : [...fieldsWithExpand, "seqId"]

          const listOpts = {
            sort: sortOrder ?? { field: "seqId", direction: "asc" as const },
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

          // One synchronous pass per row: strip seqId (internal pagination column,
          // must not appear in API responses) and decode booleans together. Each
          // item is a fresh object, so the repository result is never mutated.
          const mapRow = getListRowMapper(collection)
          const items = rows.items.map(mapRow)
          return { items, nextCursor }
        }).pipe(
          Effect.withSpan("collection.list", {
            kind: "internal",
            attributes: { collection: collection.name }
          }, { captureStackTrace: false })
        )

      const view = (
        collection: AnyCollectionDef,
        id: string,
        ctx: RequestCtx,
        select?: ReadonlyArray<string> | null,
        expand?: ReadonlyArray<string> | null
      ) =>
        Effect.gen(function* () {
          const ruleWhere = ctx.admin ? null : yield* compileRule(collection, "view", ctx, resolveOptions)
          const combined = ruleWhere !== null ? andWhere(ruleWhere, idClause(id)) : idClause(id)

          const fields = resolveFields(collection.schema, select ?? null, ctx.admin === true)
          const expandDefs = yield* resolveExpand(collection.schema, expand ?? null, allCollections, ctx)
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
          }, { captureStackTrace: false })
        )

      /**
       * Request-specific half of a create: everything that must run in the
       * caller's fiber before an insert may be queued.
       *
       * Order matters: credentials compare the *plaintext* password with
       * `passwordConfirm`, so hashing happens last.
       */
      const prepareCreate = (
        collection: AnyCollectionDef,
        data: RepoRecord,
        ctx: RequestCtx
      ): Effect.Effect<PreparedCreate, CollectionError> =>
        Effect.gen(function* () {
          if (collection.schema["x-collection-kind"] === "view") {
            return yield* new ReadOnlyError({ collection: collection.name })
          }

          yield* rejectSystemFields(data, collection.schema, collection.name)
          const schemas = getInputSchemas(collection)
          const cleaned = yield* Schema.decodeUnknownEffect(schemas.create)(data).pipe(
            Effect.mapError(parseErrToValidationError(collection.name)),
          )

          if (!ctx.admin) {
            const ctxWithBody: RequestCtx = { ...ctx, body: cleaned }
            const ruleWhere = yield* compileRule(collection, "create", ctxWithBody, resolveOptions)

            // Pre-check: evaluate the create rule against the payload (no table needed).
            const payloadBound = resolveFieldRefs(ruleWhere, cleaned, resolveOptions)
            const where = literal(payloadBound.sql, payloadBound.params)
            const check = yield* sql<{ ok: number }>`SELECT 1 AS ok WHERE ${where}`

            if (check.length === 0) {
              return yield* new ForbiddenError({ collection: collection.name, action: "create" })
            }
          }

          const canManage = yield* canManagePayload(collection, cleaned, { ...ctx, body: cleaned })
          yield* enforceCreateCredentials(collection, data, cleaned, canManage, ctx)

          const hashed = yield* hashAuthPassword(collection, cleaned, false)
          return {
            collection,
            row: getEncoder(collection)(hashed),
            admin: ctx.admin === true
          }
        })

      /**
       * Mergeable half of a create: the insert, decode and hidden-field strip.
       *
       * `admin` comes from the entry, never from a batch-wide flag, and the
       * returned row is paired with its request only through the entry's
       * `Deferred`.
       */
      const insertPrepared = (prepared: PreparedCreate): Effect.Effect<RepoRecord, CollectionError> =>
        Effect.gen(function* () {
          const row = yield* repo.create(prepared.collection.name, prepared.row)
          const decoded = yield* decodeRow(prepared.collection, row)
          return stripHidden(prepared.collection, decoded, prepared.admin)
        })

      const create = (collection: AnyCollectionDef, data: RepoRecord, ctx: RequestCtx) =>
        Effect.gen(function* () {
          const prepared = yield* prepareCreate(collection, data, ctx)
          const startedAt = yield* Clock.currentTimeMillis
          const row = yield* batcher.submit({
            collection,
            insert: insertPrepared(prepared),
            estimatedBytes: estimateRowBytes(prepared.row)
          })
          // `batch.size` is deliberately absent: the request fiber does not
          // know its batch until the deferred resolves. The flusher's
          // `collection.createBatch` span carries the size.
          yield* Effect.annotateCurrentSpan({
            "batch.wait_ms": (yield* Clock.currentTimeMillis) - startedAt
          })
          return row
        }).pipe(
          Effect.withSpan("collection.create", {
            kind: "internal",
            attributes: { collection: collection.name }
          }, { captureStackTrace: false })
        )

      // Prepare outside the transaction, then insert everything in one
      // transaction: validation, rules and password hashing no longer run while
      // the write lock is held, and a prepare failure writes nothing. The
      // queue is never consulted, so `createMany` keeps its all-or-nothing
      // contract and is safe to call from code that already holds a
      // transaction.
      //
      // Semantic delta: because rules now evaluate before any row is inserted,
      // a create rule that reads the same table (for example
      // `Rule.subquery()`) no longer sees rows inserted earlier in the same
      // bulk call. The explicit bulk endpoint is one caller's unit; rules that
      // need intra-batch visibility must not use subqueries over their own
      // collection.
      const createMany = (collection: AnyCollectionDef, records: ReadonlyArray<RepoRecord>, ctx: RequestCtx) =>
        Effect.gen(function* () {
          if (collection.schema["x-collection-kind"] === "view") {
            return yield* new ReadOnlyError({ collection: collection.name })
          }
          const prepared = yield* Effect.forEach(records, (data) => prepareCreate(collection, data, ctx), {
            concurrency: 1
          })
          if (prepared.length === 0) return []
          return yield* sql.withTransaction(
            Effect.forEach(prepared, insertPrepared, { concurrency: 1 })
          )
        }).pipe(
          Effect.withSpan("collection.createMany", {
            kind: "internal",
            attributes: { collection: collection.name }
          }, { captureStackTrace: false })
        )

      const updateOne = (collection: AnyCollectionDef, id: string, data: RepoRecord, ctx: RequestCtx) =>
        Effect.gen(function* () {
          if (collection.schema["x-collection-kind"] === "view") {
            return yield* new ReadOnlyError({ collection: collection.name })
          }

          yield* rejectSystemFields(data, collection.schema, collection.name)
          const schemas = getInputSchemas(collection)
          const cleaned = yield* Schema.decodeUnknownEffect(schemas.update)(data).pipe(
            Effect.mapError(parseErrToValidationError(collection.name)),
          )

          // If the collection has no rules at all, deny immediately (don't leak existence)
          if (!ctx.admin && ctx.internal === undefined) {
            const enforcerResult = enforcerForAction(collection.schema, "update")
            if (enforcerResult === null) {
              return yield* new ForbiddenError({ collection: collection.name, action: "update" })
            }
          }

          const existing = yield* repo.view(collection.name, id)
          if (Option.isNone(existing)) {
            return yield* new NotFoundError({ collection: collection.name, id })
          }

          // The rule sees the effective post-write value: a body key present in
          // the patch resolves to the patch value, otherwise to the stored
          // record's value, otherwise to null.
          const ctxWithBody: RequestCtx = { ...ctx, body: { ...existing.value, ...cleaned } }

          if (!ctx.admin && ctx.internal === undefined) {
            const ruleWhere = yield* compileRule(collection, "update", ctxWithBody, resolveOptions)

            // Rule check against this specific row
            const combined = andWhere(ruleWhere, idClause(id))
            const allowed = yield* repo.viewFilter(collection.name, { where: combined })
            if (allowed.length === 0) {
              return yield* new ForbiddenError({ collection: collection.name, action: "update" })
            }
          }

          const canManage = yield* canManageRecord(collection, id, ctxWithBody)
          yield* enforceUpdateCredentials(collection, data, cleaned, existing.value, canManage, ctx)

          const updated = yield* repo.update(
            collection.name,
            id,
            getEncoder(collection)(yield* hashAuthPassword(collection, cleaned, true))
          )

          if (isAuthCollection(collection) && asString(cleaned["password"]) !== undefined) {
            yield* challengeStore
              .consumeAllForUser(collection.name, id, Date.now())
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("auth.password_change.challenge_cleanup_failed", {
                    cause: String(cause)
                  })
                )
              )
          }

          // Best-effort: delete old files and their thumbnails for any replaced file fields.
          const oldKeys = extractReplacedFileKeys(existing.value, cleaned, collection.schema)
          yield* Effect.forEach(
            oldKeys,
            (key) =>
              Effect.gen(function* () {
                yield* fileStorage.delete(key).pipe(Effect.catch(() => Effect.void))
                const thumbKeys = yield* fileStorage.list(`_thumbs/${key}/`).pipe(Effect.orElseSucceed(() => []))
                yield* Effect.forEach(
                  thumbKeys,
                  (tk) => fileStorage.delete(tk).pipe(Effect.catch(() => Effect.void)),
                  { concurrency: "unbounded" }
                )
              }),
            { concurrency: "unbounded" }
          )

          return stripHidden(
            collection,
            yield* decodeRow(collection, Option.getOrElse(updated, () => existing.value)),
            ctx.admin === true
          )
        }).pipe(
          Effect.withSpan("collection.update", {
            kind: "internal",
            attributes: { collection: collection.name }
          }, { captureStackTrace: false })
        )

      const update = (collection: AnyCollectionDef, id: string, data: RepoRecord, ctx: RequestCtx) =>
        updateOne(collection, id, data, ctx)

      // Same transaction contract as createMany: one BEGIN, every per-record
      // update (validation, rule check against the merged row, credentials,
      // hashing, file cleanup), COMMIT only if all succeed. A 404/403/422 on any
      // entry rolls back the updates already applied.
      const updateMany = (
        collection: AnyCollectionDef,
        updates: ReadonlyArray<{ id: string; data: RepoRecord }>,
        ctx: RequestCtx
      ) =>
        Effect.gen(function* () {
          if (collection.schema["x-collection-kind"] === "view") {
            return yield* new ReadOnlyError({ collection: collection.name })
          }
          return yield* sql.withTransaction(
            Effect.forEach(updates, (update) => updateOne(collection, update.id, update.data, ctx), {
              concurrency: 1
            })
          )
        }).pipe(
          Effect.withSpan("collection.updateMany", {
            kind: "internal",
            attributes: { collection: collection.name }
          }, { captureStackTrace: false })
        )

      const deleteOne = (collection: AnyCollectionDef, id: string, ctx: RequestCtx) =>
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
            const ruleWhere = yield* compileRule(collection, "delete", ctx, resolveOptions)
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
                yield* fileStorage.delete(key).pipe(Effect.catch(() => Effect.void))
                const thumbKeys = yield* fileStorage.list(`_thumbs/${key}/`).pipe(Effect.orElseSucceed(() => []))
                yield* Effect.forEach(
                  thumbKeys,
                  (tk) => fileStorage.delete(tk).pipe(Effect.catch(() => Effect.void)),
                  { concurrency: "unbounded" }
                )
              }),
            { concurrency: "unbounded" }
          )
        }).pipe(
          Effect.withSpan("collection.delete", {
            kind: "internal",
            attributes: { collection: collection.name }
          }, { captureStackTrace: false })
        )

      const deleteMany = (collection: AnyCollectionDef, ids: ReadonlyArray<string>, ctx: RequestCtx) =>
        Effect.gen(function* () {
          if (collection.schema["x-collection-kind"] === "view") {
            return yield* new ReadOnlyError({ collection: collection.name })
          }
          yield* sql.withTransaction(
            Effect.forEach(ids, (id) => deleteOne(collection, id, ctx), { concurrency: 1 })
          )
          // Every id succeeded (otherwise the transaction rolled back), so the
          // input order is also the order of the rows that were actually deleted.
          return ids
        }).pipe(
          Effect.withSpan("collection.deleteMany", {
            kind: "internal",
            attributes: { collection: collection.name }
          }, { captureStackTrace: false })
        )

      return { list, view, create, createMany, update, updateMany, delete: deleteOne, deleteMany }
    })
  ).pipe(Layer.provide(batcherLayer))
}

/** @deprecated Use makeCollectionServiceLayer(allCollections) */
export const CollectionServiceLive = makeCollectionServiceLayer([])
