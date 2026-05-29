import { mutationOptions, queryOptions } from "@tanstack/svelte-query"
import { createCollectionAdapter, ActionKeys } from "./_core.js"

/**
 * A pre-built {@link createCollectionAdapter | collection adapter} for **TanStack Svelte Query**.
 *
 * Uses `queryOptions` and `mutationOptions` from `@tanstack/svelte-query` to produce
 * options objects compatible with `createQuery` and `createMutation`.
 *
 * @example
 * ```svelte
 * <script lang="ts">
 *   import { createQuery, createMutation, getQueryClient } from "@tanstack/svelte-query"
 *   import { collectionAdapter } from "@gettersethya/mira-tanstack-adapter/svelte"
 *   import { createMiraClient } from "@gettersethya/mira-client"
 *   import { PostCollection } from "../collections"
 *
 *   const client = createMiraClient({ url: "/api" }).withCollections({ posts: PostCollection })
 *   const api = collectionAdapter(client, "posts")
 *
 *   const query = createQuery(api.getList({ limit: 10 }).queryOptions)
 *   const queryClient = getQueryClient()
 *
 *   async function handleCreate() {
 *     const mutation = createMutation({
 *       ...api.create().mutationOptions,
 *       onSuccess: () => api.invalidateAll(queryClient),
 *     })
 *     $mutation.mutate({ title: "New Post" })
 *   }
 * </script>
 *
 * {#if $query.isLoading}
 *   <p>Loading...</p>
 * {:else}
 *   <ul>{#each $query.data?.items ?? [] as post}<li>{post.title}</li>{/each}</ul>
 * {/if}
 * ```
 */
export const collectionAdapter = createCollectionAdapter(queryOptions, mutationOptions)
export { ActionKeys }
export type { ActionKey } from "./_core.js"
