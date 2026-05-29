import { mutationOptions, queryOptions } from "@tanstack/solid-query"
import { createCollectionAdapter, ActionKeys } from "./_core.js"

/**
 * A pre-built {@link createCollectionAdapter | collection adapter} for **TanStack Solid Query**.
 *
 * Uses `queryOptions` and `mutationOptions` from `@tanstack/solid-query` to produce
 * options objects compatible with `createQuery` and `createMutation`.
 *
 * @example
 * ```tsx
 * import { createQuery, createMutation, useQueryClient } from "@tanstack/solid-query"
 * import { collectionAdapter } from "@gettersethya/mira-tanstack-adapter/solid"
 * import { createMiraClient } from "@gettersethya/mira-client"
 * import { PostCollection } from "../collections"
 *
 * const client = createMiraClient({ url: "/api" }).withCollections({ posts: PostCollection })
 * const api = collectionAdapter(client, "posts")
 * const queryClient = useQueryClient()
 *
 * function PostList() {
 *   const query = createQuery(() => api.getList({ limit: 10 }).queryOptions)
 *
 *   const mutation = createMutation(() => ({
 *     ...api.create().mutationOptions,
 *     onSuccess: () => api.invalidateAll(queryClient),
 *   }))
 *
 *   return (
 *     <div>
 *       <Show when={query.isLoading}><p>Loading...</p></Show>
 *       <Show when={query.data}>
 *         <ul>{query.data!.items.map(p => <li>{p.title}</li>)}</ul>
 *       </Show>
 *     </div>
 *   )
 * }
 * ```
 */
export const collectionAdapter = createCollectionAdapter(queryOptions, mutationOptions)
export { ActionKeys }
export type { ActionKey } from "./_core.js"
