import type { AnyCollectionDef, CollectionSchema } from "@gettersethya/mira-client"
import type { FilterNode } from "@gettersethya/mira-client"
import { filterNodeToWhereClause } from "@gettersethya/mira-client"
import { Clock, Context, Effect, Layer, Option, References, Schema } from "effect"
import { SqlClient } from "effect/sql"

import { AuthChallengeStore } from "@/auth/challenge-store.js"
import { Dialect } from "@/dialect/dialect.js"
import type { DialectType } from "@/dialect/dialect.js"
import { AuthService } from "@/http/auth.js"
import { Repository } from "@/repository/repository.js"
import { renderRuleCheck } from "@/repository/sql.js"
import type { AccessPredicate, ExpandDef, RepoRecord, SortOrder, WhereClause } from "@/repository/types.js"
import { enforcerForAction, payloadEnforcerForAction } from "@/rule/enforcer.js"
import type { FieldRefMode } from "@/rule/compiler.js"
import { FileStorage } from "@/storage/storage.js"
import { withSpanWhenEnabled } from "@/telemetry/span.js"

import type { CursorPage, RequestCtx } from "./context.js"
import { MutationBatcher, MutationBatcherDisabledLive, estimateRowBytes, makeMutationBatcherLayer } from "./mutation-batcher.js"
import type {
  BatchMutationStats,
  MutationBatchResult,
  PreparedCreate,
  ResolvedBatchMutationConfig
} from "./mutation-batcher.js"
import type { RowDecoder, RowDecoderSync, RowEncoder } from "./decode.js"
import { makeListRowMapper, makeProjectedListRowMapper, makeRowDecoder, makeRowEncoder, stripHiddenFields } from "./decode.js"
import type { CollectionError } from "./errors.js"
import { ForbiddenError, NotFoundError, ReadOnlyError, ValidationError } from "./errors.js"
import { buildInputSchemas, parseErrToValidationError } from "./input-schema.js"
import type { BodyBinding, BodyBindingPlan, ResolveOptions } from "./where.js"
import { andWhere, cursorClause, extractCtxRefs, idClause, keysetClause, resolveCtxPlaceholders, resolveFieldRefs, seqIdEqualsClause } from "./where.js"

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

const defaultFieldsCache = new WeakMap<
  CollectionSchema,
  { readonly user: ReadonlyArray<string>; readonly admin: ReadonlyArray<string> }
>()

const listFieldsCache = new WeakMap<
  ReadonlyArray<string>,
  ReadonlyArray<string>
>()

function defaultFields(schema: CollectionSchema) {
  const cached = defaultFieldsCache.get(schema)
  if (cached !== undefined) return cached
  const all = Object.keys(schema.properties)
  const value = {
    user: Object.freeze(all.filter((field) => schema.properties[field]["x-hidden"] !== true)),
    admin: Object.freeze(all)
  }
  defaultFieldsCache.set(schema, value)
  return value
}

function listQueryFields(fields: ReadonlyArray<string>) {
  if (fields.includes("seqId")) return fields
  const cached = listFieldsCache.get(fields)
  if (cached !== undefined) return cached
  const value = Object.freeze([...fields, "seqId"])
  listFieldsCache.set(fields, value)
  return value
}

function resolveFields(schema: CollectionSchema, userSelect: ReadonlyArray<string> | null, admin = false): ReadonlyArray<string> {
  const properties = schema.properties
  const isVisible = (field: string) => admin || properties[field]["x-hidden"] !== true

  if (userSelect === null) {
    return admin ? defaultFields(schema).admin : defaultFields(schema).user
  }

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
  ctx: RequestCtx,
  dialect: DialectType,
  resolveOptions: ResolveOptions
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
      const targetView = enforcerForAction(target.schema, "view", dialect)
      if (targetView === null) continue

      // A rule that needs auth with no authenticated actor → do not expand.
      const resolved = yield* resolveCtxPlaceholders(
        targetView,
        ctx,
        target.name,
        "view",
        resolveOptions
      ).pipe(
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
function isNullableSortField(schema: CollectionSchema, field: string): boolean {
  const prop = schema.properties[field]
  if (prop?.["x-system"] === true) return false
  return !(schema.required?.includes(field) ?? false)
}

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
  dialect: DialectType,
  mode: FieldRefMode,
  options: ResolveOptions
) {
  const result =
    mode === "param"
      ? payloadEnforcerForAction(collection.schema, "create", dialect)
      : enforcerForAction(collection.schema, action, dialect)
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
  return makeCollectionServiceLayerWith(allCollections, MutationBatcherDisabledLive)
}

/**
 * Create a `CollectionService` layer whose single-record mutations go through
 * the shared mutation batcher.
 *
 * The batcher merges concurrent creates, updates and deletes into one
 * transaction per flush. Preparation that does not depend on the stored row
 * still runs in the caller's fiber before queueing.
 *
 * @param allCollections - Array of collection definitions
 * @param config - A resolved (validated) batching configuration
 * @param statsLayer - The app's single `BatchMutationStats` layer value
 */
export function makeBatchedCollectionServiceLayer(
  allCollections: ReadonlyArray<AnyCollectionDef>,
  config: ResolvedBatchMutationConfig,
  statsLayer: Layer.Layer<BatchMutationStats>
): Layer.Layer<CollectionService, never, CollectionServiceDeps> {
  return makeCollectionServiceLayerWith(allCollections, makeMutationBatcherLayer(config, statsLayer))
}

function makeCollectionServiceLayerWith(
  allCollections: ReadonlyArray<AnyCollectionDef>,
  batcherLayer: Layer.Layer<MutationBatcher, never, SqlClient.SqlClient>
): Layer.Layer<CollectionService, never, CollectionServiceDeps> {
  return Layer.effect(
    CollectionService,
    Effect.gen(function* () {
      const repo = yield* Repository
      const sql = yield* SqlClient.SqlClient
      const batcher = yield* MutationBatcher
      const fileStorage = yield* FileStorage
      const dialect = yield* Dialect
      const authService = yield* AuthService
      const challengeStore = yield* AuthChallengeStore
      const resolveOptions: ResolveOptions = {
        encodeParam: dialect.storesBooleanAsInteger
          ? (value) => (typeof value === "boolean" ? (value ? 1 : 0) : value)
          : (value) => value,
        quoteIdentifier: dialect.quoteIdentifier,
        castValue: dialect.castValue
      }

      // One-time dev warning: a `@request_body_` reference in a list/view/delete
      // rule can never match a submitted value — bodiless actions carry no body,
      // so the reference always resolves to null. Warn once per collection/action
      // here at layer-build time, never per request.
      for (const col of allCollections) {
        for (const action of ["list", "view", "delete"] as const) {
          const compiled = enforcerForAction(col.schema, action, dialect)
          if (compiled !== null && extractCtxRefs(compiled.sql).bodyKeys.length > 0) {
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
      const projectedListMapperCache = new WeakMap<ReadonlyArray<string>, RowDecoderSync>()
      const getProjectedListMapper = (
        collection: AnyCollectionDef,
        projection: ReadonlyArray<string>
      ): RowDecoderSync => {
        const cached = projectedListMapperCache.get(projection)
        if (cached !== undefined) return cached
        const mapper = makeProjectedListRowMapper(
          collection.schema,
          dialect.storesBooleanAsInteger,
          projection
        )
        projectedListMapperCache.set(projection, mapper)
        return mapper
      }
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

      const hasReservedAccessField = (collection: AnyCollectionDef) =>
        Object.keys(collection.schema.properties).some((key) => key.startsWith("__mira_access_"))

      /**
       * Builds the binding plan for an update rule's `@request_body_*` keys.
       *
       * A key in the patch binds the patch value as a param. A key absent from
       * the patch binds `t."<key>"`, so the rule reads the stored row in the same
       * SELECT. A body-only key (passwordConfirm, oldPassword, unknown) or a
       * generated/system field cannot be resolved before the read, so the caller
       * must use the row-first fallback. Subquery rules are also excluded:
       * substituting `t."<key>"` inside a subquery is not alias-safe.
       */
      const buildBodyPlan = (
        collection: AnyCollectionDef,
        ruleSql: string,
        cleaned: RepoRecord
      ): BodyBindingPlan | null => {
        const refs = extractCtxRefs(ruleSql)
        if (refs.bodyKeys.length === 0) return new Map()
        if (refs.hasSubquery) return null

        const plan = new Map<string, BodyBinding>()
        for (const key of refs.bodyKeys) {
          if (Object.hasOwn(cleaned, key)) {
            plan.set(key, { _tag: "param", value: cleaned[key] })
            continue
          }
          const property = collection.schema.properties[key]
          if (property === undefined || property["x-generated"] === true || property["x-system"] === true) {
            return null
          }
          plan.set(key, { _tag: "column", column: key })
        }
        return plan
      }

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
          const rule = payloadEnforcerForAction(collection.schema, "manage", dialect)
          if (rule === null) return false
          const resolved = yield* resolveCtxPlaceholders(rule, ctx, collection.name, "manage", resolveOptions)
          const bound = resolveFieldRefs(resolved, { ...payload, emailVerified: false }, resolveOptions)
          const check = renderRuleCheck(bound, dialect)
          const rows = yield* sql.unsafe<{ ok: number }>(check.sql, check.params)
          return rows.length > 0
        })

      const canManageRecord = (
        collection: AnyCollectionDef,
        id: string,
        ctx: RequestCtx
      ) =>
        Effect.gen(function* () {
          if (ctx.admin === true) return true
          if (!isAuthCollection(collection) || ctx.auth === undefined) return false
          const rule = enforcerForAction(collection.schema, "manage", dialect)
          if (rule === null) return false
          const resolved = yield* resolveCtxPlaceholders(rule, ctx, collection.name, "manage", resolveOptions)
          const allowed = yield* repo.viewFilter(collection.name, {
            where: andWhere(resolved, idClause(id, dialect.quoteIdentifier))
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
          const ruleWhere = ctx.admin ? null : yield* compileRule(collection, "list", ctx, dialect, "column", resolveOptions)
          const userFilter =
            filter !== undefined
              ? yield* filterNodeToWhereClause(filter, collection.schema, collection.name, {
                  allowHiddenFields: ctx.admin === true,
                  quoteIdentifier: dialect.quoteIdentifier
                })
              : null
          const where: WhereClause | null =
            ruleWhere !== null && userFilter !== null ? andWhere(ruleWhere, userFilter) : (userFilter ?? ruleWhere)
          const sortOrder = sort !== undefined ? yield* validateSort(collection.schema, collection.name, sort, ctx.admin === true) : undefined
          const effectiveSort: SortOrder = sortOrder ?? { field: "seqId", direction: "asc" }

          let cursorWhere: WhereClause | null = null
          if (cursor !== null) {
            if (effectiveSort.field === "seqId") {
              cursorWhere = cursorClause(cursor, dialect.quoteIdentifier)
            } else {
              if (isNullableSortField(collection.schema, effectiveSort.field)) {
                return yield* Effect.fail(
                  new ValidationError({
                    collection: collection.name,
                    issues: [
                      `Cannot paginate a sorted list on nullable field "${effectiveSort.field}"; sort by seqId or a non-null field`
                    ]
                  })
                )
              }
              const cursorRows = yield* repo.viewFilter(collection.name, {
                where: seqIdEqualsClause(cursor, dialect.quoteIdentifier),
                fields: [effectiveSort.field]
              })
              const cursorRow = cursorRows[0]
              const value = cursorRow?.[effectiveSort.field]
              if (cursorRow === undefined || value === null || value === undefined) {
                return yield* Effect.fail(
                  new ValidationError({
                    collection: collection.name,
                    issues: [`Invalid cursor: row ${cursor} no longer exists`]
                  })
                )
              }
              cursorWhere = keysetClause(effectiveSort, value, cursor, dialect.quoteIdentifier)
            }
          }
          const combined =
            cursorWhere !== null ? (where !== null ? andWhere(where, cursorWhere) : cursorWhere) : where

          const fields = resolveFields(collection.schema, select ?? null, ctx.admin === true)
          const expandDefs =
            expand === null || expand === undefined || expand.length === 0
              ? []
              : yield* resolveExpand(collection.schema, expand, allCollections, ctx, dialect, resolveOptions)
          const defaultProjection = select === null && expandDefs.length === 0
          const fieldsWithExpand = defaultProjection
            ? fields
            : [...new Set([...fields, ...expandDefs.map((e) => e.localField)])]

          // seqId is x-hidden but must be fetched for cursor-based pagination
          const fieldsForQuery = defaultProjection
            ? listQueryFields(fieldsWithExpand)
            : [...new Set([...fieldsWithExpand, "seqId"])]

          const listOpts = {
            sort: effectiveSort,
            tieBreaker: "seqId",
            fields: fieldsForQuery,
            expand: expandDefs
          }

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
          const mapRow = defaultProjection
            ? getProjectedListMapper(collection, fieldsForQuery)
            : getListRowMapper(collection)
          const items = rows.items.map(mapRow)
          return { items, nextCursor }
        }).pipe(
          withSpanWhenEnabled("collection.list", {
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
          const ruleWhere = ctx.admin ? null : yield* compileRule(collection, "view", ctx, dialect, "column", resolveOptions)
          const combined =
            ruleWhere !== null
              ? andWhere(ruleWhere, idClause(id, dialect.quoteIdentifier))
              : idClause(id, dialect.quoteIdentifier)

          const fields = resolveFields(collection.schema, select ?? null, ctx.admin === true)
          const expandDefs = yield* resolveExpand(
            collection.schema,
            expand ?? null,
            allCollections,
            ctx,
            dialect,
            resolveOptions
          )
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
          withSpanWhenEnabled("collection.view", {
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
            const ruleWhere = yield* compileRule(
              collection,
              "create",
              ctxWithBody,
              dialect,
              "param",
              resolveOptions
            )

            // Pre-check: evaluate the create rule against the payload (no table needed).
            const payloadBound = resolveFieldRefs(ruleWhere, cleaned, resolveOptions)
            const check = renderRuleCheck(payloadBound, dialect)
            const rows = yield* sql.unsafe<{ ok: number }>(check.sql, check.params)

            if (rows.length === 0) {
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
      const insertPrepared = (
        prepared: PreparedCreate
      ): Effect.Effect<MutationBatchResult, CollectionError> =>
        Effect.gen(function* () {
          const row = yield* repo.create(prepared.collection.name, prepared.row)
          const decoded = yield* decodeRow(prepared.collection, row)
          return {
            value: stripHidden(prepared.collection, decoded, prepared.admin),
            afterCommit: Effect.void
          }
        })

      const create = (collection: AnyCollectionDef, data: RepoRecord, ctx: RequestCtx) =>
        Effect.gen(function* () {
          const prepared = yield* prepareCreate(collection, data, ctx)
          const tracingEnabled = yield* References.TracerEnabled
          const startedAt = tracingEnabled ? yield* Clock.currentTimeMillis : 0
          const row = yield* batcher.submit({
            operation: "create",
            collection,
            execute: insertPrepared(prepared),
            estimatedBytes: estimateRowBytes(prepared.row)
          })
          // `batch.size` is deliberately absent: the request fiber does not
          // know its batch until the deferred resolves. The flusher's
          // `collection.mutationBatch` span carries the size.
          if (tracingEnabled) {
            yield* Effect.annotateCurrentSpan({
              "batch.wait_ms": (yield* Clock.currentTimeMillis) - startedAt
            })
          }
          return row
        }).pipe(
          withSpanWhenEnabled("collection.create", {
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
          const results = yield* sql.withTransaction(
            Effect.forEach(prepared, insertPrepared, { concurrency: 1 })
          )
          return results.map((result) => result.value)
        }).pipe(
          withSpanWhenEnabled("collection.createMany", {
            kind: "internal",
            attributes: { collection: collection.name }
          }, { captureStackTrace: false })
        )

      interface PreparedUpdate {
        readonly collection: AnyCollectionDef
        readonly id: string
        readonly raw: RepoRecord
        readonly cleaned: RepoRecord
        readonly hashed: RepoRecord
        readonly passwordChanging: boolean
        readonly passwordKeyPresent: boolean
        readonly ctx: RequestCtx
        readonly admin: boolean
      }

      interface PreparedDelete {
        readonly collection: AnyCollectionDef
        readonly id: string
        readonly ctx: RequestCtx
        readonly admin: boolean
      }

      const deleteFiles = (keys: ReadonlyArray<string>) =>
        Effect.forEach(
          keys,
          (key) =>
            Effect.gen(function* () {
              yield* fileStorage.delete(key).pipe(Effect.catch(() => Effect.void))
              const thumbKeys = yield* fileStorage
                .list(`_thumbs/${key}/`)
                .pipe(Effect.orElseSucceed(() => []))
              yield* Effect.forEach(
                thumbKeys,
                (tk) => fileStorage.delete(tk).pipe(Effect.catch(() => Effect.void)),
                { concurrency: "unbounded" }
              )
            }),
          { concurrency: "unbounded" }
        )

      const prepareUpdate = (
        collection: AnyCollectionDef,
        id: string,
        data: RepoRecord,
        ctx: RequestCtx
      ): Effect.Effect<PreparedUpdate, CollectionError> =>
        Effect.gen(function* () {
          if (collection.schema["x-collection-kind"] === "view") {
            return yield* new ReadOnlyError({ collection: collection.name })
          }

          yield* rejectSystemFields(data, collection.schema, collection.name)
          const schemas = getInputSchemas(collection)
          const cleaned = yield* Schema.decodeUnknownEffect(schemas.update)(data).pipe(
            Effect.mapError(parseErrToValidationError(collection.name))
          )

          // If the collection has no rules at all, deny immediately (don't leak existence).
          if (!ctx.admin && ctx.internal === undefined) {
            const enforcerResult = enforcerForAction(collection.schema, "update", dialect)
            if (enforcerResult === null) {
              return yield* new ForbiddenError({ collection: collection.name, action: "update" })
            }
          }

          const newPassword = asString(cleaned["password"])
          const passwordChanging =
            isAuthCollection(collection) && newPassword !== undefined && newPassword.length > 0

          if (passwordChanging && ctx.admin !== true && ctx.internal === undefined) {
            const confirm = asString(data["passwordConfirm"])
            if (confirm === undefined || confirm !== newPassword) {
              return yield* new ValidationError({
                collection: collection.name,
                issues: ["passwordConfirm must match password"]
              })
            }
          }

          if (ctx.internal === "auth-flow" || ctx.internal === "email-change") {
            const allowed =
              ctx.internal === "email-change"
                ? new Set(["email", "emailVerified"])
                : new Set(["password", "emailVerified"])
            const disallowed = Object.keys(cleaned).filter((key) => !allowed.has(key))
            if (disallowed.length > 0) {
              return yield* new ValidationError({
                collection: collection.name,
                issues: [`${ctx.internal} cannot update: ${disallowed.join(", ")}`]
              })
            }
          }

          return {
            collection,
            id,
            raw: data,
            cleaned,
            hashed: yield* hashAuthPassword(collection, cleaned, true),
            passwordChanging,
            passwordKeyPresent: "password" in cleaned,
            ctx,
            admin: ctx.admin === true
          }
        })

      const executeUpdate = (
        prepared: PreparedUpdate,
        deferCleanup: boolean
      ): Effect.Effect<MutationBatchResult, CollectionError> =>
        Effect.gen(function* () {
          const collection = prepared.collection
          const viewWithAccess = repo.viewWithAccess
          const updateEnforcer =
            prepared.admin || prepared.ctx.internal !== undefined
              ? null
              : enforcerForAction(collection.schema, "update", dialect)
          const updateRefs = updateEnforcer === null ? null : extractCtxRefs(updateEnforcer.sql)
          const updateBodyPlan =
            updateEnforcer === null ? null : buildBodyPlan(collection, updateEnforcer.sql, prepared.cleaned)
          const manageEnforcer =
            isAuthCollection(collection) &&
            prepared.ctx.auth !== undefined &&
            !prepared.admin &&
            prepared.ctx.internal === undefined
              ? enforcerForAction(collection.schema, "manage", dialect)
              : null
          const manageRefs = manageEnforcer === null ? null : extractCtxRefs(manageEnforcer.sql)
          const manageBodyPlan =
            manageEnforcer === null ? null : buildBodyPlan(collection, manageEnforcer.sql, prepared.cleaned)

          const fastPath =
            viewWithAccess !== undefined &&
            !hasReservedAccessField(collection) &&
            updateEnforcer !== null &&
            updateRefs !== null &&
            updateBodyPlan !== null &&
            !updateRefs.hasUnknownSource &&
            !(prepared.ctx.auth === undefined && updateRefs.authFields.length > 0) &&
            (manageEnforcer === null ||
              (manageRefs !== null && manageBodyPlan !== null && !manageRefs.hasUnknownSource))
          let existingRecord: RepoRecord | null = null
          let canManage = false

          if (fastPath && updateEnforcer !== null && updateBodyPlan !== null) {
            const ruleWhere = yield* resolveCtxPlaceholders(
              updateEnforcer,
              prepared.ctx,
              collection.name,
              "update",
              resolveOptions,
              updateBodyPlan
            )
            const predicates: [AccessPredicate, ...Array<AccessPredicate>] = [
              { name: "rule", where: ruleWhere }
            ]
            if (manageEnforcer !== null && manageBodyPlan !== null) {
              const manageWhere = yield* resolveCtxPlaceholders(
                manageEnforcer,
                prepared.ctx,
                collection.name,
                "manage",
                resolveOptions,
                manageBodyPlan
              )
              predicates.push({ name: "manage", where: manageWhere })
            }

            const accesses = yield* viewWithAccess(collection.name, prepared.id, predicates)
            if (Option.isNone(accesses)) {
              return yield* new NotFoundError({ collection: collection.name, id: prepared.id })
            }
            if (accesses.value.access.rule !== true) {
              return yield* new ForbiddenError({ collection: collection.name, action: "update" })
            }
            existingRecord = accesses.value.record
            canManage = accesses.value.access.manage === true
          } else {
            const existing = yield* repo.view(collection.name, prepared.id)
            if (Option.isNone(existing)) {
              return yield* new NotFoundError({ collection: collection.name, id: prepared.id })
            }
            existingRecord = existing.value

            // The rule sees the effective post-write value: a body key present in
            // the patch resolves to the patch value, otherwise to the stored
            // record's value, otherwise to null.
            const ctxWithBody: RequestCtx = {
              ...prepared.ctx,
              body: { ...existing.value, ...prepared.cleaned }
            }

            if (!prepared.admin && prepared.ctx.internal === undefined) {
              const ruleWhere = yield* compileRule(
                collection,
                "update",
                ctxWithBody,
                dialect,
                "column",
                resolveOptions
              )
              const allowed = yield* repo.viewFilter(collection.name, {
                where: andWhere(ruleWhere, idClause(prepared.id, dialect.quoteIdentifier))
              })
              if (allowed.length === 0) {
                return yield* new ForbiddenError({ collection: collection.name, action: "update" })
              }
            }

            canManage = yield* canManageRecord(collection, prepared.id, ctxWithBody)
          }

          const existingValue = existingRecord
          if (existingValue === null) {
            return yield* new NotFoundError({ collection: collection.name, id: prepared.id })
          }

          yield* enforceUpdateCredentials(
            collection,
            prepared.raw,
            prepared.cleaned,
            existingValue,
            canManage,
            prepared.ctx
          )

          const updated = yield* repo.update(
            collection.name,
            prepared.id,
            getEncoder(collection)(prepared.hashed)
          )

          const challengeCleanup = prepared.passwordKeyPresent
            ? challengeStore
                .consumeAllForUser(collection.name, prepared.id, Date.now())
                .pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("auth.password_change.challenge_cleanup_failed", {
                      cause: String(cause)
                    })
                  )
                )
            : Effect.void

          const oldKeys = extractReplacedFileKeys(
            existingValue,
            prepared.cleaned,
            collection.schema
          )
          const cleanup = challengeCleanup.pipe(Effect.andThen(deleteFiles(oldKeys)))

          const value = stripHidden(
            collection,
            yield* decodeRow(collection, Option.getOrElse(updated, () => existingValue)),
            prepared.admin
          )

          if (!deferCleanup) {
            yield* cleanup
            return { value, afterCommit: Effect.void }
          }
          return { value, afterCommit: cleanup }
        })

      const updateOne = (collection: AnyCollectionDef, id: string, data: RepoRecord, ctx: RequestCtx) =>
        Effect.gen(function* () {
          const prepared = yield* prepareUpdate(collection, id, data, ctx)
          const result = yield* executeUpdate(prepared, false)
          return result.value
        }).pipe(
          withSpanWhenEnabled("collection.update", {
            kind: "internal",
            attributes: { collection: collection.name }
          }, { captureStackTrace: false })
        )

      const update = (collection: AnyCollectionDef, id: string, data: RepoRecord, ctx: RequestCtx) =>
        Effect.gen(function* () {
          const prepared = yield* prepareUpdate(collection, id, data, ctx)
          const tracingEnabled = yield* References.TracerEnabled
          const startedAt = tracingEnabled ? yield* Clock.currentTimeMillis : 0
          const entry = {
            operation: "update" as const,
            collection,
            execute: executeUpdate(prepared, true),
            estimatedBytes: estimateRowBytes(prepared.cleaned) + id.length * 2
          }
          const row =
            ctx.internal !== undefined
              ? yield* batcher.submitInline(entry)
              : yield* batcher.submit(entry)
          if (tracingEnabled) {
            yield* Effect.annotateCurrentSpan({
              "batch.wait_ms": (yield* Clock.currentTimeMillis) - startedAt
            })
          }
          return row
        }).pipe(
          withSpanWhenEnabled("collection.update", {
            kind: "internal",
            attributes: { collection: collection.name }
          }, { captureStackTrace: false })
        )

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
          withSpanWhenEnabled("collection.updateMany", {
            kind: "internal",
            attributes: { collection: collection.name }
          }, { captureStackTrace: false })
        )

      const prepareDelete = (
        collection: AnyCollectionDef,
        id: string,
        ctx: RequestCtx
      ): Effect.Effect<PreparedDelete, CollectionError> =>
        Effect.gen(function* () {
          if (collection.schema["x-collection-kind"] === "view") {
            return yield* new ReadOnlyError({ collection: collection.name })
          }

          // If the collection has no rules at all, deny immediately (don't leak existence).
          if (!ctx.admin) {
            const enforcerResult = enforcerForAction(collection.schema, "delete", dialect)
            if (enforcerResult === null) {
              return yield* new ForbiddenError({ collection: collection.name, action: "delete" })
            }
          }

          return { collection, id, ctx, admin: ctx.admin === true }
        })

      const executeDelete = (
        prepared: PreparedDelete,
        deferCleanup: boolean
      ): Effect.Effect<MutationBatchResult, CollectionError> =>
        Effect.gen(function* () {
          const viewWithAccess = repo.viewWithAccess
          const deleteExisting = repo.deleteExisting
          const enforcer = prepared.admin
            ? null
            : enforcerForAction(prepared.collection.schema, "delete", dialect)
          const refs = enforcer === null ? null : extractCtxRefs(enforcer.sql)
          const fastPath =
            viewWithAccess !== undefined &&
            deleteExisting !== undefined &&
            !hasReservedAccessField(prepared.collection) &&
            (prepared.admin ||
              (refs !== null &&
                refs.bodyKeys.length === 0 &&
                !(prepared.ctx.auth === undefined && refs.authFields.length > 0)))

          let existingRecord: RepoRecord | null = null
          if (fastPath && !prepared.admin && refs !== null) {
            const ruleWhere = yield* compileRule(
              prepared.collection,
              "delete",
              prepared.ctx,
              dialect,
              "column",
              resolveOptions
            )
            const accesses = yield* viewWithAccess(
              prepared.collection.name,
              prepared.id,
              [{ name: "rule", where: ruleWhere }]
            )
            if (Option.isNone(accesses)) {
              return yield* new NotFoundError({
                collection: prepared.collection.name,
                id: prepared.id
              })
            }
            if (accesses.value.access.rule !== true) {
              return yield* new ForbiddenError({
                collection: prepared.collection.name,
                action: "delete"
              })
            }
            existingRecord = accesses.value.record
          } else {
            const existing = yield* repo.view(prepared.collection.name, prepared.id)
            if (Option.isNone(existing)) {
              return yield* new NotFoundError({
                collection: prepared.collection.name,
                id: prepared.id
              })
            }
            existingRecord = existing.value

            if (!prepared.admin) {
              const ruleWhere = yield* compileRule(
                prepared.collection,
                "delete",
                prepared.ctx,
                dialect,
                "column",
                resolveOptions
              )
              const allowed = yield* repo.viewFilter(prepared.collection.name, {
                where: andWhere(ruleWhere, idClause(prepared.id, dialect.quoteIdentifier))
              })
              if (allowed.length === 0) {
                return yield* new ForbiddenError({
                  collection: prepared.collection.name,
                  action: "delete"
                })
              }
            }
          }

          const existingValue = existingRecord
          if (existingValue === null) {
            return yield* new NotFoundError({
              collection: prepared.collection.name,
              id: prepared.id
            })
          }

          const deleted =
            fastPath && deleteExisting !== undefined
              ? yield* deleteExisting(prepared.collection.name, prepared.id)
              : yield* repo.delete(prepared.collection.name, prepared.id)
          if (Option.isNone(deleted)) {
            return yield* new NotFoundError({ collection: prepared.collection.name, id: prepared.id })
          }

          const cleanup = deleteFiles(
            extractFileKeys(existingValue, prepared.collection.schema)
          )

          if (!deferCleanup) {
            yield* cleanup
            return { value: existingValue, afterCommit: Effect.void }
          }
          return { value: existingValue, afterCommit: cleanup }
        })

      const deleteOne = (collection: AnyCollectionDef, id: string, ctx: RequestCtx) =>
        Effect.gen(function* () {
          const prepared = yield* prepareDelete(collection, id, ctx)
          const result = yield* executeDelete(prepared, false)
          void result
        }).pipe(
          withSpanWhenEnabled("collection.delete", {
            kind: "internal",
            attributes: { collection: collection.name }
          }, { captureStackTrace: false })
        )

      const deleteBatched = (collection: AnyCollectionDef, id: string, ctx: RequestCtx) =>
        Effect.gen(function* () {
          const prepared = yield* prepareDelete(collection, id, ctx)
          const tracingEnabled = yield* References.TracerEnabled
          const startedAt = tracingEnabled ? yield* Clock.currentTimeMillis : 0
          const entry = {
            operation: "delete" as const,
            collection,
            execute: executeDelete(prepared, true),
            estimatedBytes: id.length * 2 + 64
          }
          if (ctx.internal !== undefined) {
            yield* batcher.submitInline(entry)
          } else {
            yield* batcher.submit(entry)
          }
          if (tracingEnabled) {
            yield* Effect.annotateCurrentSpan({
              "batch.wait_ms": (yield* Clock.currentTimeMillis) - startedAt
            })
          }
        }).pipe(
          withSpanWhenEnabled("collection.delete", {
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
          withSpanWhenEnabled("collection.deleteMany", {
            kind: "internal",
            attributes: { collection: collection.name }
          }, { captureStackTrace: false })
        )

      return { list, view, create, createMany, update, updateMany, delete: deleteBatched, deleteMany }
    })
  ).pipe(Layer.provide(batcherLayer))
}

/** @deprecated Use makeCollectionServiceLayer(allCollections) */
export const CollectionServiceLive = makeCollectionServiceLayer([])
