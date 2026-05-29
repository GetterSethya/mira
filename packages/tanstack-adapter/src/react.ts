import { mutationOptions, queryOptions } from "@tanstack/react-query"
import { createCollectionAdapter, ActionKeys } from "./_core.js"

/**
 * A pre-built {@link createCollectionAdapter | collection adapter} for **TanStack React Query**.
 *
 * Uses `queryOptions` and `mutationOptions` from `@tanstack/react-query` to produce
 * options objects compatible with `useQuery` and `useMutation`.
 *
 * @example
 * ```tsx
 * import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
 * import { collectionAdapter } from "@gettersethya/mira-tanstack-adapter/react"
 * import { createMiraClient } from "@gettersethya/mira-client"
 *
 * const client = createMiraClient({ url: "/api" }).withCollections({ posts: PostCollection })
 * const api = collectionAdapter(client, "posts")
 *
 * function PostList() {
 *   const { data } = useQuery(api.getList({ limit: 10 }).queryOptions)
 *   const queryClient = useQueryClient()
 *
 *   const mutation = useMutation({
 *     ...api.create().mutationOptions,
 *     onSuccess: () => api.invalidateAll(queryClient),
 *   })
 *
 *   if (!data) return <div>Loading...</div>
 *   return <ul>{data.items.map(p => <li key={p.id}>{p.title}</li>)}</ul>
 * }
 * ```
 */
export const collectionAdapter = createCollectionAdapter(queryOptions, mutationOptions)
export { ActionKeys }
export type { ActionKey } from "./_core.js"
