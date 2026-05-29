import type { CollectionClient, FieldsMap, FilterBuilder, FilterNode } from "@gettersethya/mira-client"

/**
 * A readonly array of unknown values used as a TanStack Query query key.
 *
 * @example
 * ```ts
 * const key: QueryKey = ["posts", "getList", { limit: 10 }]
 * ```
 */
export type QueryKey = ReadonlyArray<unknown>

/**
 * Shape expected by TanStack Query's `queryOptions` for a query returning `T`.
 *
 * @template T - The data type returned by the query function.
 */
export type QueryOptionsShape<T> = {
  queryKey: QueryKey
  queryFn: () => Promise<T>
}

/**
 * Shape expected by TanStack Query's `mutationOptions` for a mutation consuming `TInput` and returning `TData`.
 *
 * @template TData - The data type returned by the mutation function.
 * @template TInput - The input data type consumed by the mutation function.
 */
export type MutationOptionsShape<TData, TInput> = {
  mutationFn: (input: TInput) => Promise<TData>
}

/**
 * Signature for the framework-provided `queryOptions` factory.
 * TanStack Query in each framework exports a `queryOptions` function that accepts
 * a {@link QueryOptionsShape} and returns a framework-specific options object.
 */
export type MakeQueryOptions = <T>(opts: QueryOptionsShape<T>) => QueryOptionsShape<T>

/**
 * Signature for the framework-provided `mutationOptions` factory.
 * TanStack Query in each framework exports a `mutationOptions` function that accepts
 * a {@link MutationOptionsShape} and returns a framework-specific options object.
 */
export type MakeMutationOptions = <TData, TInput>(
  opts: MutationOptionsShape<TData, TInput>
) => MutationOptionsShape<TData, TInput>

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
 * Uses the provided {@link MakeQueryOptions} factory to convert the handler into
 * a TanStack Query-compatible options object. The returned handler retains all
 * original methods (e.g. `raw()`, `toEffect()`) with `queryKey` and `queryOptions`
 * added as extra properties via `Object.assign`.
 *
 * @template T - The data type returned by the underlying handler.
 * @template H - The handler type, constrained to objects with a zero-arg `raw()` method returning `Promise<T>`.
 * @param handler - The original handler (e.g. from `client.getList()`).
 * @param key - The query key array to associate with this query.
 * @param makeQueryOptions - Framework-specific `queryOptions` factory.
 * @returns The original handler augmented with `queryKey` and `queryOptions`.
 * @see enrichMutation For the mutation equivalent.
 */
export function enrichQuery<T, H extends { raw(): Promise<T> }>(
  handler: H,
  key: QueryKey,
  makeQueryOptions: MakeQueryOptions
): H & { queryKey: QueryKey; queryOptions: QueryOptionsShape<T> } {
  return Object.assign(handler, {
    queryKey: key,
    queryOptions: makeQueryOptions({ queryKey: key, queryFn: () => handler.raw() }),
  })
}

/**
 * Extends a mutation handler with a pre-built `mutationOptions` object.
 *
 * Uses the provided {@link MakeMutationOptions} factory to convert the handler into
 * a TanStack Query-compatible mutation options object. The returned handler retains all
 * original methods with `mutationOptions` added as an extra property via `Object.assign`.
 *
 * @template TData - The data type returned by the mutation handler.
 * @template TInput - The input data type consumed by the mutation handler.
 * @template H - The handler type, constrained to objects with a single-arg `raw(input)` method returning `Promise<TData>`.
 * @param handler - The original handler (e.g. from `client.create()`).
 * @param makeMutationOptions - Framework-specific `mutationOptions` factory.
 * @returns The original handler augmented with `mutationOptions`.
 * @see enrichQuery For the query equivalent.
 */
export function enrichMutation<TData, TInput, H extends { raw(input: TInput): Promise<TData> }>(
  handler: H,
  makeMutationOptions: MakeMutationOptions
): H & { mutationOptions: MutationOptionsShape<TData, TInput> } {
  return Object.assign(handler, {
    mutationOptions: makeMutationOptions({
      mutationFn: (input: TInput) => handler.raw(input),
    }),
  })
}

/**
 * Creates a TanStack Query adapter for any {@link CollectionClient}.
 *
 * Returns a function that wraps a `CollectionClient` and enriches every query method
 * (getList, getOne, getFirstOrNone, getFullList) with `queryKey` and `queryOptions`,
 * and every mutation method (create, update, delete) with `mutationOptions`.
 *
 * Query keys follow a structured pattern: `[collectionName, actionKey, ...params]`.
 * This enables fine-grained cache invalidation — for example, invalidating only
 * `getOne` queries for a specific record by referencing key `["posts", "getOne", id]`.
 *
 * The returned object also exposes `invalidateAll(queryClient)` and
 * `invalidateOne(queryClient, id)` convenience methods that call
 * `queryClient.invalidateQueries` with the appropriate key prefix.
 *
 * @param makeQueryOptions - Framework-specific `queryOptions` factory
 *   (e.g. from `@tanstack/react-query`, `@tanstack/svelte-query`, or `@tanstack/solid-query`).
 * @param makeMutationOptions - Framework-specific `mutationOptions` factory.
 * @returns An adapter function that takes a `CollectionClient` and collection name,
 *   and returns an enhanced client with query/mutation metadata.
 *
 * @example
 * ```ts
 * import { queryOptions, mutationOptions } from "@tanstack/react-query"
 * import { createMiraClient } from "@gettersethya/mira-client"
 * import { createCollectionAdapter } from "@gettersethya/mira-tanstack-adapter"
 *
 * const adapt = createCollectionAdapter(queryOptions, mutationOptions)
 * const client = createMiraClient({ url: "/api" }).withCollections({ posts: PostCollection })
 * const adapted = adapt(client, "posts")
 *
 * // Use in a React component:
 * const { data } = useQuery(adapted.getList({ limit: 10 }).queryOptions)
 * const mutation = useMutation(adapted.create().mutationOptions)
 *
 * // Invalidate after mutation:
 * adapted.invalidateAll(queryClient)
 * adapted.invalidateOne(queryClient, recordId)
 * ```
 *
 * @see enrichQuery
 * @see enrichMutation
 * @see MakeQueryOptions
 * @see MakeMutationOptions
 */
export function createCollectionAdapter(
  makeQueryOptions: MakeQueryOptions,
  makeMutationOptions: MakeMutationOptions
) {
  return function adaptCollectionClient<F extends FieldsMap>(
    client: CollectionClient<F>,
    name: string
  ) {
    return {
      ...client,

      /**
       * Enriched version of `getList` that also returns `queryKey` and `queryOptions`.
       * Query key: `[name, "getList", options]`.
       */
      getList: (options?: Parameters<CollectionClient<F>["getList"]>[0]) =>
        enrichQuery(
          client.getList(options),
          [name, ActionKeys.GetList, options ?? {}],
          makeQueryOptions
        ),

      /**
       * Enriched version of `getOne` that also returns `queryKey` and `queryOptions`.
       * Query key: `[name, "getOne", id, options]`.
       */
      getOne: (id: string, options?: Parameters<CollectionClient<F>["getOne"]>[1]) =>
        enrichQuery(
          client.getOne(id, options),
          [name, ActionKeys.GetOne, id, options ?? {}],
          makeQueryOptions
        ),

      /**
       * Enriched version of `getFirstOrNone` that also returns `queryKey` and `queryOptions`.
       * Query key: `[name, "getFirstOrNone", options]`.
       */
      getFirstOrNone: (filter: (f: FilterBuilder<F>) => FilterNode, options?: Parameters<CollectionClient<F>["getFirstOrNone"]>[1]) =>
        enrichQuery(
          client.getFirstOrNone(filter, options),
          [name, ActionKeys.GetFirstOrNone, options ?? {}],
          makeQueryOptions
        ),

      /**
       * Enriched version of `getFullList` that also returns `queryKey` and `queryOptions`.
       * Query key: `[name, "getFullList", options]`.
       */
      getFullList: (options?: Parameters<CollectionClient<F>["getFullList"]>[0]) =>
        enrichQuery(
          client.getFullList(options),
          [name, ActionKeys.GetFullList, options ?? {}],
          makeQueryOptions
        ),

      /**
       * Enriched mutation for creating records. Call `raw(input)` to execute.
       */
      create: () => enrichMutation(client.create(), makeMutationOptions),

      /**
       * Enriched mutation for updating records. Call `raw(input)` to execute.
       */
      update: () => enrichMutation(client.update(), makeMutationOptions),

      /**
       * Enriched mutation for deleting records. Call `raw(input)` to execute.
       */
      delete: () => enrichMutation(client.delete(), makeMutationOptions),

      /**
       * Invalidates all cached queries for this collection.
       * Calls `queryClient.invalidateQueries` with key prefix `[name]`.
       *
       * @param queryClient - Any TanStack Query client with `invalidateQueries`.
       */
      invalidateAll: (queryClient: { invalidateQueries(opts: { queryKey: QueryKey }): unknown }) =>
        queryClient.invalidateQueries({ queryKey: [name] }),

      /**
       * Invalidates only the `getOne` cache entry for a specific record.
       * Calls `queryClient.invalidateQueries` with key `[name, "getOne", id]`.
       *
       * @param queryClient - Any TanStack Query client with `invalidateQueries`.
       * @param id - The record ID whose cached `getOne` entry should be invalidated.
       */
      invalidateOne: (queryClient: { invalidateQueries(opts: { queryKey: QueryKey }): unknown }, id: string) =>
        queryClient.invalidateQueries({ queryKey: [name, ActionKeys.GetOne, id] }),
    }
  }
}
