import type { AnyCollectionDef, FieldFilterOperand,FieldsMap, FilterNode, InferFieldValue } from "@gettersethya/mira-collection"
import { Filter, FilterNodeSchema } from "@gettersethya/mira-collection"
import type { Schedule} from "effect";
import { Effect, MutableRef, Option, Schema } from "effect"
import type { HttpClient, HttpClientRequest } from "effect/http"
import { HttpClientRequest as HCR } from "effect/http"
import type { HttpBodyError } from "effect/http/HttpBody"

import { MiraError } from "./errors.js"
import { makeFileFields } from "./file.js"
import type { ClientHandler, ExecuteFn } from "./handler.js"
import { makeClientHandler as makeHandler, makeMutationHandler } from "./handler.js"
import type { CollectionFileFields, CollectionKind, CreateInput, InferRecord, RegisterInput, RelationKeys, UpdateInput, WithExpand } from "./types.js"

type RequestWithBody = Effect.Effect<HttpClientRequest.HttpClientRequest, HttpBodyError, never>

function toExecuteEffect<T>(
  reqEffect: RequestWithBody,
  execute: ExecuteFn
): Effect.Effect<T, MiraError, HttpClient.HttpClient> {
  return reqEffect.pipe(
    Effect.flatMap((req) => execute<T>(req)),
    Effect.catchTag("HttpBodyError", (e) =>
      Effect.fail(new MiraError({ status: 500, body: String(e) }))
    )
  )
}

function hasFileOrBlob(input: object): boolean {
  return Object.values(input).some((v) => v instanceof Blob)
}

function buildFormData(input: object): FormData {
  const fd = new FormData()
  for (const [key, value] of Object.entries(input)) {
    if (value instanceof Blob) {
      fd.append(key, value)
    } else if (value !== null && value !== undefined) {
      fd.append(key, String(value))
    }
  }
  return fd
}

/**
 * Optional retry configuration for collection operations.
 * Wraps an Effect `Schedule` that determines retry behavior when a `MiraError` occurs.
 *
 * If not provided, the operation is not retried. Set at the collection level via
 * `defaultRetryOptions` in `createMiraClient()` or per-call via the `retryOptions` parameter.
 *
 * @example
 * import { Schedule } from "effect"
 *
 * const retry: RetryOptions = {
 *   schedule: Schedule.exponential(100)  // retry with exponential backoff starting at 100ms
 * }
 *
 * @see createMiraClient — accepts defaultRetryOptions
 * @see CollectionClient — each method accepts retryOptions
 */
export type RetryOptions = { schedule?: Schedule.Schedule<unknown, MiraError, never> }

export type GetListOptions<F extends FieldsMap, E extends ReadonlyArray<string>> = {
  filter?: (f: FilterBuilder<F>) => FilterNode
  sort?: keyof F & string
  order?: "asc" | "desc"
  cursor?: number | null
  limit?: number
  select?: ReadonlyArray<keyof F & string>
  expand?: E
  retryOptions?: RetryOptions
}

export type GetOneOptions<F extends FieldsMap, E extends ReadonlyArray<string>> = {
  select?: ReadonlyArray<keyof F & string>
  expand?: E
  retryOptions?: RetryOptions
}

/**
 * Typed filter builder used inside `CollectionClient` callback methods.
 * Same shape as `FilterBuilder<F>` in `filter/builder.ts` but re-exported
 * from the client module for convenience.
 *
 * @example
 * const posts = await mira.posts.getList({
 *   filter: (f) => f.and(
 *     f.field("published").eq(true),
 *     f.field("views").gte(100)
 *   )
 * }).raw()
 *
 * @see CollectionClient.getList — accepts filter callback
 * @see Filter — untyped filter builder
 */
export type FilterBuilder<F extends FieldsMap> = {
  field<K extends keyof F & string>(name: K): FieldFilterOperand<InferFieldValue<F[K]>>
  and(left: FilterNode, right: FilterNode): FilterNode
  or(left: FilterNode, right: FilterNode): FilterNode
  not(node: FilterNode): FilterNode
}

function makeFilterBuilder<F extends FieldsMap>(): FilterBuilder<F> {
  return {
    field: (name: string) => Filter.field(name),
    and: (left, right) => Filter.and(left, right),
    or: (left, right) => Filter.or(left, right),
    not: (node) => Filter.not(node),
  }
}

function buildQueryParams(params: Record<string, string | undefined>): string {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) sp.set(k, v)
  }
  const qs = sp.toString()
  return qs ? `?${qs}` : ""
}

/**
 * Client interface for a single collection, providing typed CRUD operations.
 * Created via `makeCollectionClient()` or automatically via `createMiraClient()`.
 *
 * All query methods return `ClientHandler` — call `.raw()` for Promise-based usage
 * or `.toEffect()` for Effect-based usage.
 * All mutation methods return a mutation `ClientHandler` — call `.raw(input)` with
 * the data payload.
 *
 * @typeParam F - The FieldsMap type of the collection
 *
 * @example
 * const posts = mira.posts  // inferred as CollectionClient<PostFields>
 * const list = await posts.getList({ sort: "created", order: "desc" }).raw()
 * const one = await posts.getOne("abc123").raw()
 * const created = await posts.create().raw({ title: "hello", body: "world" })
 *
 * @see makeCollectionClient — constructs CollectionClient instances
 * @see ClientHandler — return type of all methods
 */
export type RawCollectionClient<F extends FieldsMap, K extends CollectionKind = "base"> = {
  /**
   * List records with optional filtering, sorting, cursor pagination, and field selection.
   *
   * Returns `{ items, nextCursor }` where `nextCursor` is `null` when there are
   * no more pages. Pagination is cursor-based — iterate by passing the previous
   * response's `nextCursor` as the `cursor` option.
   *
   * @example
   * let cursor: number | null = null
   * do {
   *   const { items, nextCursor } = await posts.getList({ cursor, limit: 20 }).raw()
   *   cursor = nextCursor
   * } while (cursor !== null)
   *
   * @param options.filter - Optional filter callback using the typed FilterBuilder
   * @param options.sort - Field name to sort by
   * @param options.order - Sort direction: "asc" or "desc" (default: "asc")
   * @param options.cursor - Cursor for pagination (from previous response's nextCursor)
   * @param options.limit - Maximum items per page (server default applies if omitted)
   * @param options.select - Subset of field names to include in the response
   * @param options.expand - Relation field names to expand (fetches related records)
   * @param options.retryOptions - Optional retry schedule
   * @returns ClientHandler for the paginated result
   */
  getList<E extends ReadonlyArray<RelationKeys<F>> = []>(
    options?: GetListOptions<F, E>
  ): ClientHandler<{ items: Array<WithExpand<F, E>>; nextCursor: number | null }>

  /**
   * Get the first record matching a filter, or `Option.none()` if none match.
   *
   * **Requires a `filter` callback** — unlike `getList`, the filter is mandatory.
   * Internally calls `getList` with `limit: 1` and extracts the first item.
   *
   * @param filter - Filter callback (required) — use `(f) => f.field("id").eq("x")` etc.
   * @param options.sort - Field name to sort by (determines which is "first")
   * @param options.order - Sort direction
   * @param options.select - Subset of field names to include
   * @param options.expand - Relation field names to expand
   * @param options.retryOptions - Optional retry schedule
   * @returns ClientHandler resolving to Option of the record (None if no match)
   */
  getFirstOrNone<E extends ReadonlyArray<RelationKeys<F>> = []>(
    filter: (f: FilterBuilder<F>) => FilterNode,
    options?: Omit<GetListOptions<F, E>, "filter" | "limit" | "cursor">
  ): ClientHandler<Option.Option<WithExpand<F, E>>>

  /**
   * Fetch all records matching the filter, automatically following pagination.
   * Defaults to `limit: 1000` — override via options if you need a different page size.
   *
   * Unlike `getList` which returns a single page with `nextCursor`,
   * `getFullList` fetches pages internally and returns a flat array.
   *
   * @param options.filter - Optional filter callback
   * @param options.sort - Field name to sort by
   * @param options.order - Sort direction
   * @param options.limit - Page size for internal pagination (default: 1000)
   * @param options.select - Subset of field names to include
   * @param options.expand - Relation field names to expand
   * @param options.retryOptions - Optional retry schedule
   * @returns ClientHandler resolving to a flat array of records
   */
  getFullList<E extends ReadonlyArray<RelationKeys<F>> = []>(
    options?: Omit<GetListOptions<F, E>, "limit" | "cursor"> & { limit?: number }
  ): ClientHandler<Array<WithExpand<F, E>>>

  /**
   * Get a single record by its `id`.
   * Returns a 404 `MiraError` if the record does not exist.
   *
   * @param id - The record ID (string UUID)
   * @param options.select - Subset of field names to include
   * @param options.expand - Relation field names to expand
   * @param options.retryOptions - Optional retry schedule
   * @returns ClientHandler resolving to the record
   */
  getOne<E extends ReadonlyArray<RelationKeys<F>> = []>(
    id: string,
    options?: GetOneOptions<F, E>
  ): ClientHandler<WithExpand<F, E>>

  /**
   * Create a new record.
   *
   * When the input contains any `File` or `Blob` values (for file fields), the
   * request is automatically dispatched as `multipart/form-data` instead of JSON.
   *
   * @returns A mutation ClientHandler — call `.raw(input)` with the record data
   */
  create(): ClientHandler<InferRecord<F>, CreateInput<F, K>>

  /**
   * Update an existing record by ID.
   * Only the fields present in `data` are updated (partial/patch semantics).
   *
   * When `data` contains any `File` or `Blob` values, the request is automatically
   * dispatched as `multipart/form-data`.
   *
   * @returns A mutation ClientHandler — call `.raw({ id, data })`
   */
  update(): ClientHandler<InferRecord<F>, UpdateInput<F, K>>

  /**
   * Delete a record by ID.
   * Returns `void` on success. Throws `MiraError` (404) if the record does not exist.
   *
   * @returns A mutation ClientHandler — call `.raw(id)` with the record ID
   */
  delete(): ClientHandler<void, string>

  /**
   * Authenticate with email and password on an auth collection.
   * Only available on collections defined with `AuthCollection.define()`.
   * On success, stores the returned JWT token for subsequent requests.
   *
   * @example
   * const { token, record } = await mira.users.authWithPassword().raw({
   *   email: "user@example.com",
   *   password: "secret123"
   * })
   *
   * @returns A mutation ClientHandler — call `.raw({ email, password })`
   */
  authWithPassword?(): ClientHandler<{ token: string; record: InferRecord<F> }, { email: string; password: string }>

  /**
   * Register (self-signup) a new user on an auth collection.
   * Only available on collections defined with `AuthCollection.define()`.
   *
   * Wraps the create endpoint (`POST /api/collections/:name`) — open registration
   * therefore requires the collection's create rule to permit it (e.g. `create: R.public()`).
   * Does **not** auto-login; call `authWithPassword()` after if needed.
   *
   * @example
   * const user = await mira.users.register().raw({
   *   email: "user@example.com",
   *   password: "secret123",
   *   passwordConfirm: "secret123"
   * })
   *
   * @returns A mutation ClientHandler — call `.raw({ email, password, passwordConfirm, ... })`
   */
  register?(): ClientHandler<InferRecord<F>, RegisterInput<F>>

  /**
   * File field client interfaces for the collection.
   * Provides `.url()` and `.asyncUrl()` methods for constructing file download URLs.
   *
   * @example
   * const url = posts.fields.cover.url(post.id, "cover.jpg")
   */
  fields: CollectionFileFields<F>
}

/**
 * Client interface for a single collection, providing typed CRUD operations.
 * Created via `makeCollectionClient()` or automatically via `createMiraClient()`.
 *
 * For auth collections (`K = "auth"`) the `authWithPassword`/`register` methods
 * are guaranteed present; for other kinds they are absent.
 *
 * @typeParam F - The FieldsMap type of the collection
 * @typeParam K - The collection kind (`"base" | "auth" | "view"`)
 */
export type CollectionClient<F extends FieldsMap, K extends CollectionKind = "base"> = RawCollectionClient<F, K> &
  AuthByKind<F>[K]

/**
 * The auth methods guaranteed for each collection kind. For `"base"` collections
 * there are none; for `"auth"` collections `authWithPassword`/`register` are
 * required (they are always built at runtime for auth collections).
 *
 * Expressed as a lookup map indexed by `K` rather than a `K extends "auth" ? … : {}`
 * conditional so that adapters can branch on a generic `K` without assertions.
 */
export type AuthByKind<F extends FieldsMap> = {
  [P in CollectionKind]: P extends "auth"
    ? {
        authWithPassword(): ClientHandler<{ token: string; record: InferRecord<F> }, { email: string; password: string }>
        register(): ClientHandler<InferRecord<F>, RegisterInput<F>>
      }
    : {}
}

export type AdaptedAuthByKind<F extends FieldsMap> = {
  [P in CollectionKind]: P extends "auth"
    ? {
        authWithPassword(): EnrichedMutationHandler<
          ClientHandler<{ token: string; record: InferRecord<F> }, { email: string; password: string }>
        >
        register(): EnrichedMutationHandler<ClientHandler<InferRecord<F>, RegisterInput<F>>>
      }
    : {}
}

/**
 * A readonly array of values used as a TanStack Query key.
 *
 * @see AdaptedCollectionClient — carries `queryKey` on every query handler
 */
export type QueryKey = ReadonlyArray<unknown>

/**
 * The structural shape of a TanStack Query `queryOptions` object, as produced
 * by any framework adapter. The client package cannot depend on TanStack, so
 * the option objects are typed structurally; TanStack's `useQuery` accepts this
 * shape and infers `data` from `queryFn`'s return type.
 */
export type AdaptedQueryOptions<T> = {
  queryKey: QueryKey
  queryFn: () => Promise<T>
}

/**
 * The structural shape of a TanStack Query `mutationOptions` object.
 *
 * @see AdaptedCollectionClient — carries `mutationOptions` on every mutation handler
 */
export type AdaptedMutationOptions<TData, TInput> = {
  mutationFn: (input: TInput) => Promise<TData>
}

/**
 * A query handler (`getList` / `getOne` / `getFirstOrNone` / `getFullList`)
 * augmented with the query key and `queryOptions`. `queryFn` is the handler's
 * own `raw` function, so the option type is derived from the handler directly
 * (no re-instantiation of the result type).
 */
type EnrichedQueryHandler<H extends { raw(): Promise<unknown> }> = H & {
  queryKey: QueryKey
  queryOptions: { queryKey: QueryKey; queryFn: H["raw"] }
}

/**
 * A mutation handler (`create` / `update` / `delete` / `register`) augmented
 * with `mutationOptions`. `mutationFn` is the handler's own `raw` function.
 */
type EnrichedMutationHandler<H extends { raw(input: never): Promise<unknown> }> = H & {
  mutationOptions: { mutationFn: H["raw"] }
}

/**
 * A {@link CollectionClient} whose query handlers also expose `queryKey` /
 * `queryOptions` and whose mutation handlers also expose `mutationOptions`,
 * plus `invalidateAll` / `invalidateOne` query-cache helpers.
 *
 * Produced at runtime by an adapter (e.g. `collectionAdapter` from
 * `@gettersethya/mira-tanstack-adapter`) and surfaced through
 * `withCollections(map, { adapter })`.
 *
 * @typeParam F - The collection's `FieldsMap`
 * @typeParam K - The collection kind (`"base" | "auth" | "view"`)
 */
export type AdaptedCollectionClient<F extends FieldsMap, K extends CollectionKind = "base"> = AdaptedCommon<F, K> &
  AdaptedAuthByKind<F>[K]

/**
 * The kind-independent members of {@link AdaptedCollectionClient}. Split out so
 * the adapter body can annotate the object it builds and spread the per-kind
 * extras on top (yielding exactly this type).
 */
export type AdaptedCommon<F extends FieldsMap, K extends CollectionKind = "base"> = Omit<
  RawCollectionClient<F, K>,
  | "getList"
  | "getOne"
  | "getFirstOrNone"
  | "getFullList"
  | "create"
  | "update"
  | "delete"
  | "register"
  | "authWithPassword"
> & {
  getList<E extends ReadonlyArray<RelationKeys<F>> = []>(
    options?: GetListOptions<F, E>
  ): EnrichedQueryHandler<ClientHandler<{ items: Array<WithExpand<F, E>>; nextCursor: number | null }>>
  getOne<E extends ReadonlyArray<RelationKeys<F>> = []>(
    id: string,
    options?: GetOneOptions<F, E>
  ): EnrichedQueryHandler<ClientHandler<WithExpand<F, E>>>
  getFirstOrNone<E extends ReadonlyArray<RelationKeys<F>> = []>(
    filter: (f: FilterBuilder<F>) => FilterNode,
    options?: Omit<GetListOptions<F, E>, "filter" | "limit" | "cursor">
  ): EnrichedQueryHandler<ClientHandler<Option.Option<WithExpand<F, E>>>>
  getFullList<E extends ReadonlyArray<RelationKeys<F>> = []>(
    options?: Omit<GetListOptions<F, E>, "limit" | "cursor"> & { limit?: number }
  ): EnrichedQueryHandler<ClientHandler<Array<WithExpand<F, E>>>>
  create(): EnrichedMutationHandler<ClientHandler<InferRecord<F>, CreateInput<F, K>>>
  update(): EnrichedMutationHandler<ClientHandler<InferRecord<F>, UpdateInput<F, K>>>
  delete(): EnrichedMutationHandler<ClientHandler<void, string>>
  invalidateAll(queryClient: { invalidateQueries(opts: { queryKey: QueryKey }): unknown }): unknown
  invalidateOne(queryClient: { invalidateQueries(opts: { queryKey: QueryKey }): unknown }, id: string): unknown
}



type MakeCollectionClientParams<F extends FieldsMap, K extends CollectionKind = "base"> = {
  collectionName: string
  schema: AnyCollectionDef["schema"]
  fields: F
  execute: ExecuteFn
  baseUrl: string
  authTokenRef: MutableRef.MutableRef<string | null> | null
  loggedInRef: MutableRef.MutableRef<boolean> | null
  fileTokenCacheRef: MutableRef.MutableRef<Map<string, { token: string; expiresAt: number }>>
  isAuth: boolean
  kind?: K
  defaultRetryOptions?: RetryOptions
}

/**
 * Construct a `CollectionClient<F>` for a given collection definition.
 * This is the internal factory — users should use `createMiraClient()` which
 * handles all wiring (auth, execute, file fields).
 *
 * @internal Use `createMiraClient().collection(def)` or `withCollections()` instead.
 */
export function makeCollectionClient<F extends FieldsMap, K extends CollectionKind = "base">(
  params: MakeCollectionClientParams<F, K>
): RawCollectionClient<F, K> {
  const { authTokenRef, baseUrl, collectionName, defaultRetryOptions, execute, fields, fileTokenCacheRef, isAuth, loggedInRef, schema } = params

  function withRetry<T>(
    effect: Effect.Effect<T, MiraError, HttpClient.HttpClient>,
    methodOptions?: { retryOptions?: RetryOptions }
  ): Effect.Effect<T, MiraError, HttpClient.HttpClient> {
    const schedule = methodOptions?.retryOptions?.schedule ?? defaultRetryOptions?.schedule
    return schedule ? Effect.retry(effect, schedule) : effect
  }

  const fileFields = makeFileFields<F>(
    { name: collectionName, fields, schema },
    schema,
    baseUrl,
    execute,
    fileTokenCacheRef,
    makeHandler
  )

  function getList<E extends ReadonlyArray<RelationKeys<F>> = []>(
    options?: GetListOptions<F, E>
  ): ClientHandler<{ items: Array<WithExpand<F, E>>; nextCursor: number | null }> {
    const filterNode = options?.filter?.(makeFilterBuilder<F>())
    const queryParams = buildQueryParams({
      ...(filterNode ? { filter: Schema.encodeSync(Schema.fromJsonString(FilterNodeSchema))(filterNode) } : {}),
      ...(options?.sort ? { sort: options.sort } : {}),
      ...(options?.order ? { order: options.order } : {}),
      ...(options?.cursor != null ? { after: String(options.cursor) } : {}),
      ...(options?.limit ? { limit: String(options.limit) } : {}),
      ...(options?.select ? { select: options.select.join(",") } : {}),
      ...(options?.expand ? { expand: options.expand.join(",") } : {}),
    })

    const effect = execute<{ items: Array<WithExpand<F, E>>; nextCursor: number | null }>(
      HCR.get(`/api/collections/${collectionName}${queryParams}`)
    )
    return makeHandler(withRetry(effect, options))
  }

  function getFirstOrNone<E extends ReadonlyArray<RelationKeys<F>> = []>(
    filter: (f: FilterBuilder<F>) => FilterNode,
    options?: Omit<GetListOptions<F, E>, "filter" | "limit" | "cursor">
  ): ClientHandler<Option.Option<WithExpand<F, E>>> {
    const effect = getList<E>({ ...options, filter, limit: 1 })
      .toEffect()
      .pipe(Effect.map(({ items }) => Option.fromNullishOr(items[0] ?? null)))
    return makeHandler(effect)
  }

  function getFullList<E extends ReadonlyArray<RelationKeys<F>> = []>(
    options?: Omit<GetListOptions<F, E>, "limit" | "cursor"> & { limit?: number }
  ): ClientHandler<Array<WithExpand<F, E>>> {
    const effect = getList<E>({ ...options, limit: options?.limit ?? 1000 })
      .toEffect()
      .pipe(Effect.map(({ items }) => items))
    return makeHandler(effect)
  }

  function getOne<E extends ReadonlyArray<RelationKeys<F>> = []>(
    id: string,
    options?: GetOneOptions<F, E>
  ): ClientHandler<WithExpand<F, E>> {
    const queryParams = buildQueryParams({
      ...(options?.select ? { select: options.select.join(",") } : {}),
      ...(options?.expand ? { expand: options.expand.join(",") } : {}),
    })

    const effect = execute<WithExpand<F, E>>(
      HCR.get(`/api/collections/${collectionName}/${id}${queryParams}`)
    )
    return makeHandler(withRetry(effect, options))
  }

  function create() {
    return makeMutationHandler<InferRecord<F>, CreateInput<F, K>>((input) => {
      const reqEffect: RequestWithBody = hasFileOrBlob(input)
        ? Effect.succeed(HCR.bodyFormData(HCR.post(`/api/collections/${collectionName}`), buildFormData(input)))
        : HCR.bodyJson(HCR.post(`/api/collections/${collectionName}`), input)
      return withRetry(toExecuteEffect<InferRecord<F>>(reqEffect, execute))
    })
  }

  function update() {
    return makeMutationHandler<InferRecord<F>, UpdateInput<F, K>>(({ data, id }) => {
      const reqEffect: RequestWithBody = hasFileOrBlob(data)
        ? Effect.succeed(HCR.bodyFormData(HCR.patch(`/api/collections/${collectionName}/${id}`), buildFormData(data)))
        : HCR.bodyJson(HCR.patch(`/api/collections/${collectionName}/${id}`), data)
      return withRetry(toExecuteEffect<InferRecord<F>>(reqEffect, execute))
    })
  }

  function deleteFn() {
    return makeMutationHandler<void, string>((id) => {
      const effect = execute<void>(HCR.delete(`/api/collections/${collectionName}/${id}`))
      return withRetry(effect)
    })
  }

  function authWithPassword() {
    return makeMutationHandler<{ token: string; record: InferRecord<F> }, { email: string; password: string }>(
      ({ email, password }) =>
        withRetry(Effect.gen(function* () {
          const res = yield* toExecuteEffect<{ token: string; record: InferRecord<F> }>(
            HCR.bodyJson(HCR.post(`/api/collections/${collectionName}/auth-with-password`), { email, password }),
            execute
          )
          if (authTokenRef !== null) {
            MutableRef.set(authTokenRef, res.token)
          }
          if (loggedInRef !== null) {
            MutableRef.set(loggedInRef, true)
          }
          return res
        }))
    )
  }

  function register() {
    return makeMutationHandler<InferRecord<F>, RegisterInput<F>>((input) => {
      const reqEffect: RequestWithBody = hasFileOrBlob(input)
        ? Effect.succeed(HCR.bodyFormData(HCR.post(`/api/collections/${collectionName}`), buildFormData(input)))
        : HCR.bodyJson(HCR.post(`/api/collections/${collectionName}`), input)
      return withRetry(toExecuteEffect<InferRecord<F>>(reqEffect, execute))
    })
  }

  const client: RawCollectionClient<F, K> = {
    getList,
    getFirstOrNone,
    getFullList,
    getOne,
    create,
    update,
    delete: deleteFn,
    ...(isAuth ? { authWithPassword, register } : {}),
    fields: fileFields,
  }
  return client
}
