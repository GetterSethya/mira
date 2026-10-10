import type {
  AdaptedAuthByKind,
  AdaptedCollectionClient,
  AdaptedCommon,
  AdaptedMutationOptions,
  AdaptedQueryOptions,
  CollectionClient,
  CollectionKind,
  FieldsMap,
  FilterBuilder,
  FilterNode,
  GetListOptions,
  GetOneOptions,
  RelationKeys
} from "@gettersethya/mira-client"

/**
 * A readonly array of unknown values used as a TanStack Query query key.
 *
 * @example
 * ```ts
 * const key: QueryKey = ["todos", "getList", { limit: 10 }]
 * ```
 */
export type QueryKey = ReadonlyArray<unknown>

/**
 * Shape expected by TanStack Query's `useQuery` for a query returning `T`.
 *
 * The adapter produces plain objects of this shape (it does not import the
 * framework): `useQuery` / `createQuery` accept them directly and infer `data`.
 */
export type QueryOptionsShape<T> = AdaptedQueryOptions<T>

/**
 * Shape expected by TanStack Query's `useMutation` for a mutation consuming
 * `TInput` and returning `TData`.
 */
export type MutationOptionsShape<TData, TInput> = AdaptedMutationOptions<TData, TInput>

/**
 * A map of human-readable action names to their string key values.
 * Used internally to build structured query keys that include the action being performed.
 *
 * @example
 * ```ts
 * ActionKeys.GetList  // => "getList"
 * ActionKeys.GetOne   // => "getOne"
 * ```
 */
export const ActionKeys = {
  GetList:        "getList",
  GetOne:         "getOne",
  GetFirstOrNone: "getFirstOrNone",
  GetFullList:    "getFullList",
} as const

/**
 * Union of all valid action key string values derived from {@link ActionKeys}.
 */
export type ActionKey = (typeof ActionKeys)[keyof typeof ActionKeys]

/**
 * Extends a query handler with a `queryKey` and pre-built `queryOptions` object.
 *
 * The returned handler retains all original methods (e.g. `raw()`, `toEffect()`)
 * with `queryKey` and `queryOptions` added as extra properties via `Object.assign`.
 *
 * @template T - The data type returned by the underlying handler.
 * @template H - The handler type, constrained to objects with a zero-arg `raw()` method returning `Promise<T>`.
 * @param handler - The original handler (e.g. from `client.getList()`).
 * @param key - The query key array to associate with this query.
 * @returns The original handler augmented with `queryKey` and `queryOptions`.
 * @see enrichMutation For the mutation equivalent.
 */
export function enrichQuery<H extends { raw(): Promise<unknown> }>(
  handler: H,
  key: QueryKey
): H & { queryKey: QueryKey; queryOptions: { queryKey: QueryKey; queryFn: H["raw"] } } {
  return Object.assign(handler, {
    queryKey: key,
    queryOptions: { queryKey: key, queryFn: () => handler.raw() }
  })
}

/**
 * Extends a mutation handler with a pre-built `mutationOptions` object.
 *
 * @template TData - The data type returned by the mutation handler.
 * @template TInput - The input data type consumed by the mutation handler.
 * @template H - The handler type, constrained to objects with a single-arg `raw(input)` method.
 * @param handler - The original handler (e.g. from `client.create()`).
 * @returns The original handler augmented with `mutationOptions`.
 * @see enrichQuery For the query equivalent.
 */
export function enrichMutation<H extends { raw(input: never): Promise<unknown> }>(
  handler: H
): H & { mutationOptions: { mutationFn: H["raw"] } } {
  return Object.assign(handler, {
    mutationOptions: { mutationFn: (input: Parameters<H["raw"]>[0]) => handler.raw(input) }
  })
}

/**
 * Correlated per-kind builders: indexing this mapped type with a generic `K`
 * yields `(client: CollectionClient<F, K>, name: string) => AdaptedAuthByKind<F>[K]`,
 * so the `kind` argument drives which (and only which) auth extras are built —
 * without a type assertion.
 */
type KindAuthAdapters<F extends FieldsMap> = {
  [P in CollectionKind]: (
    client: CollectionClient<F, P>,
    name: string
  ) => AdaptedAuthByKind<F>[P]
}

/**
 * Creates a framework-agnostic collection adapter.
 *
 * The adapter wraps a `CollectionClient` and enriches every query method
 * (getList, getOne, getFirstOrNone, getFullList) with `queryKey` and
 * `queryOptions`, and every mutation method (create, update, delete, register)
 * with `mutationOptions`. The produced option objects are plain
 * `{ queryKey, queryFn }` / `{ mutationFn }` shapes, accepted by TanStack Query
 * in every framework — so the package has no runtime dependency on TanStack.
 *
 * Query keys follow a structured pattern: `[collectionName, actionKey, ...params]`,
 * enabling fine-grained cache invalidation (e.g. `[name, "getOne", id]`).
 *
 * The returned object also exposes `invalidateAll(queryClient)` and
 * `invalidateOne(queryClient, id)` helpers.
 *
 * @returns An adapter function that takes a `CollectionClient` and collection
 *   name, and returns an enhanced client with query/mutation metadata.
 *
 * @example
 * ```ts
 * import { collectionAdapter } from "@gettersethya/mira-tanstack-adapter"
 * import { createMiraClient } from "@gettersethya/mira-client"
 *
 * const client = createMiraClient("/api").withCollections(
 *   { posts: PostCollection },
 *   { adapter: collectionAdapter },
 * )
 *
 * const { data } = useQuery(client.posts.getList({ limit: 10 }).queryOptions)
 * const mutation = useMutation(client.posts.create().mutationOptions)
 * ```
 *
 * @see enrichQuery
 * @see enrichMutation
 */
export function createCollectionAdapter() {
  return function adaptCollectionClient<F extends FieldsMap, K extends CollectionKind = "base">(
    client: CollectionClient<F, K>,
    name: string,
    kind: K
  ): AdaptedCollectionClient<F, K> {
    const kindAuthAdapters: KindAuthAdapters<F> = {
      base: () => ({}),
      view: () => ({}),
      auth: (authClient) => ({
        authWithPassword: () => authClient.authWithPassword(),
        register: () => enrichMutation(authClient.register()),
      }),
    }
    const authExtras = kindAuthAdapters[kind](client, name)

    const common: AdaptedCommon<F, K> = {
      fields: client.fields,

      getList: <E extends ReadonlyArray<RelationKeys<F>> = []>(options?: GetListOptions<F, E>) =>
        enrichQuery(client.getList<E>(options), [name, ActionKeys.GetList, options ?? {}]),

      getOne: <E extends ReadonlyArray<RelationKeys<F>> = []>(id: string, options?: GetOneOptions<F, E>) =>
        enrichQuery(client.getOne<E>(id, options), [name, ActionKeys.GetOne, id, options ?? {}]),

      getFirstOrNone: <E extends ReadonlyArray<RelationKeys<F>> = []>(
        filter: (f: FilterBuilder<F>) => FilterNode,
        options?: Omit<GetListOptions<F, E>, "filter" | "limit" | "cursor">
      ) => enrichQuery(client.getFirstOrNone<E>(filter, options), [name, ActionKeys.GetFirstOrNone, options ?? {}]),

      getFullList: <E extends ReadonlyArray<RelationKeys<F>> = []>(
        options?: Omit<GetListOptions<F, E>, "limit" | "cursor"> & { limit?: number }
      ) => enrichQuery(client.getFullList<E>(options), [name, ActionKeys.GetFullList, options ?? {}]),

      create: () => enrichMutation(client.create()),
      update: () => enrichMutation(client.update()),
      delete: () => enrichMutation(client.delete()),

      /**
       * Invalidates all cached queries for this collection.
       * Calls `queryClient.invalidateQueries` with key prefix `[name]`.
       */
      invalidateAll: (queryClient: { invalidateQueries(opts: { queryKey: QueryKey }): unknown }) =>
        queryClient.invalidateQueries({ queryKey: [name] }),

      /**
       * Invalidates only the `getOne` cache entry for a specific record.
       */
      invalidateOne: (
        queryClient: { invalidateQueries(opts: { queryKey: QueryKey }): unknown },
        id: string
      ) => queryClient.invalidateQueries({ queryKey: [name, ActionKeys.GetOne, id] })
    }

    // Spread of the concrete head and the generic per-kind extras yields exactly
    // `AdaptedCommon<F, K> & AdaptedAuthByKind<F>[K]` == AdaptedCollectionClient<F, K>.
    return { ...common, ...authExtras }
  }
}

/**
 * A pre-built {@link createCollectionAdapter | collection adapter}.
 *
 * Framework-agnostic — the option objects it produces satisfy TanStack Query's
 * `useQuery` / `useMutation` (React, Solid) and `createQuery` / `createMutation`
 * (Svelte) inputs.
 */
export const collectionAdapter = createCollectionAdapter()
