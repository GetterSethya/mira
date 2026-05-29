import type { HttpClient, HttpClientRequest } from "@effect/platform"
import { HttpClientRequest as HCR } from "@effect/platform"
import type { HttpBodyError } from "@effect/platform/HttpBody"
import { Effect, MutableRef, Option, Schedule, Schema } from "effect"
import type { AnyCollectionDef, FieldsMap, InferFieldValue, FilterNode, FieldFilterOperand } from "@gettersethya/mira-collection"
import { Filter, FilterNodeSchema } from "@gettersethya/mira-collection"
import { MiraError } from "./errors.js"
import type { ClientHandler, ExecuteFn } from "./handler.js"
import { makeClientHandler as makeHandler, makeMutationHandler } from "./handler.js"
import { makeFileFields } from "./file.js"
import type { CollectionFileFields, InferMutationInput, InferRecord, RelationKeys, WithExpand } from "./types.js"

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

type GetListOptions<F extends FieldsMap, E extends ReadonlyArray<string>> = {
  filter?: (f: FilterBuilder<F>) => FilterNode
  sort?: keyof F & string
  order?: "asc" | "desc"
  cursor?: number | null
  limit?: number
  select?: ReadonlyArray<keyof F & string>
  expand?: E
  retryOptions?: RetryOptions
}

type GetOneOptions<F extends FieldsMap, E extends ReadonlyArray<string>> = {
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
export type CollectionClient<F extends FieldsMap> = {
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
  ): ClientHandler<{ items: WithExpand<F, E>[]; nextCursor: number | null }>

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
  ): ClientHandler<WithExpand<F, E>[]>

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
  create(): ClientHandler<InferRecord<F>, InferMutationInput<F>>

  /**
   * Update an existing record by ID.
   * Only the fields present in `data` are updated (partial/patch semantics).
   *
   * When `data` contains any `File` or `Blob` values, the request is automatically
   * dispatched as `multipart/form-data`.
   *
   * @returns A mutation ClientHandler — call `.raw({ id, data })`
   */
  update(): ClientHandler<InferRecord<F>, { id: string; data: Partial<InferMutationInput<F>> }>

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
   * File field client interfaces for the collection.
   * Provides `.url()` and `.asyncUrl()` methods for constructing file download URLs.
   *
   * @example
   * const url = posts.fields.cover.url(post.id, "cover.jpg")
   */
  fields: CollectionFileFields<F>
}

type MakeCollectionClientParams<F extends FieldsMap> = {
  collectionName: string
  schema: AnyCollectionDef["schema"]
  fields: F
  execute: ExecuteFn
  baseUrl: string
  authTokenRef: MutableRef.MutableRef<string | null> | null
  loggedInRef: MutableRef.MutableRef<boolean> | null
  fileTokenCacheRef: MutableRef.MutableRef<Map<string, { token: string; expiresAt: number }>>
  isAuth: boolean
  defaultRetryOptions?: RetryOptions
}

/**
 * Construct a `CollectionClient<F>` for a given collection definition.
 * This is the internal factory — users should use `createMiraClient()` which
 * handles all wiring (auth, execute, file fields).
 *
 * @internal Use `createMiraClient().collection(def)` or `withCollections()` instead.
 */
export function makeCollectionClient<F extends FieldsMap>(
  params: MakeCollectionClientParams<F>
): CollectionClient<F> {
  const { collectionName, schema, fields, execute, baseUrl, authTokenRef, loggedInRef, fileTokenCacheRef, isAuth, defaultRetryOptions } = params

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
  ): ClientHandler<{ items: WithExpand<F, E>[]; nextCursor: number | null }> {
    const filterNode = options?.filter?.(makeFilterBuilder<F>())
    const queryParams = buildQueryParams({
      ...(filterNode ? { filter: Schema.encodeSync(Schema.parseJson(FilterNodeSchema))(filterNode) } : {}),
      ...(options?.sort ? { sort: options.sort } : {}),
      ...(options?.order ? { order: options.order } : {}),
      ...(options?.cursor != null ? { after: String(options.cursor) } : {}),
      ...(options?.limit ? { limit: String(options.limit) } : {}),
      ...(options?.select ? { select: options.select.join(",") } : {}),
      ...(options?.expand ? { expand: options.expand.join(",") } : {}),
    })

    const effect = execute<{ items: WithExpand<F, E>[]; nextCursor: number | null }>(
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
      .pipe(Effect.map(({ items }) => Option.fromNullable(items[0] ?? null)))
    return makeHandler(effect)
  }

  function getFullList<E extends ReadonlyArray<RelationKeys<F>> = []>(
    options?: Omit<GetListOptions<F, E>, "limit" | "cursor"> & { limit?: number }
  ): ClientHandler<WithExpand<F, E>[]> {
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
    return makeMutationHandler<InferRecord<F>, InferMutationInput<F>>((input) => {
      const reqEffect: RequestWithBody = hasFileOrBlob(input)
        ? Effect.succeed(HCR.bodyFormData(HCR.post(`/api/collections/${collectionName}`), buildFormData(input)))
        : HCR.bodyJson(HCR.post(`/api/collections/${collectionName}`), input)
      return withRetry(toExecuteEffect<InferRecord<F>>(reqEffect, execute))
    })
  }

  function update() {
    return makeMutationHandler<InferRecord<F>, { id: string; data: Partial<InferMutationInput<F>> }>(({ id, data }) => {
      const reqEffect: RequestWithBody = hasFileOrBlob(data)
        ? Effect.succeed(HCR.bodyFormData(HCR.patch(`/api/collections/${collectionName}/${id}`), buildFormData(data)))
        : HCR.bodyJson(HCR.patch(`/api/collections/${collectionName}/${id}`), data)
      return withRetry(toExecuteEffect<InferRecord<F>>(reqEffect, execute))
    })
  }

  function deleteFn() {
    return makeMutationHandler<void, string>((id) => {
      const effect = execute<void>(HCR.del(`/api/collections/${collectionName}/${id}`))
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

  const client: CollectionClient<F> = {
    getList,
    getFirstOrNone,
    getFullList,
    getOne,
    create,
    update,
    delete: deleteFn,
    ...(isAuth ? { authWithPassword } : {}),
    fields: fileFields,
  }
  return client
}
