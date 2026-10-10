import { createCollectionAdapter, ActionKeys } from "./_core.js"
import type { MakeMutationOptions, MakeQueryOptions } from "./_core.js"

/**
 * Creates a {@link createCollectionAdapter | collection adapter} for **TanStack Svelte Query**.
 *
 * Unlike the React and Solid entries, this entry cannot ship a pre-built adapter:
 * `@tanstack/svelte-query` v6 brands its option objects with a `unique symbol`
 * that is not exported from the package, so any pre-built value re-exposed here
 * fails declaration emit (`TS2527`). Accepting the factories as arguments keeps
 * this entry emit-safe: inference happens in the consumer's project, where the
 * branded types resolve in memory.
 *
 * Uses `queryOptions` and `mutationOptions` from `@tanstack/svelte-query` to produce
 * options objects compatible with `createQuery` and `createMutation`.
 *
 * @example
 * ```svelte
 * <script lang="ts">
 *   import { createQuery, createMutation, getQueryClient, mutationOptions, queryOptions } from "@tanstack/svelte-query"
 *   import { createSvelteCollectionAdapter } from "@gettersethya/mira-tanstack-adapter/svelte"
 *   import { createMiraClient } from "@gettersethya/mira-client"
 *   import { PostCollection } from "../collections"
 *
 *   const client = createMiraClient({ url: "/api" }).withCollections({ posts: PostCollection })
 *   const collectionAdapter = createSvelteCollectionAdapter(queryOptions, mutationOptions)
 *   const api = collectionAdapter(client, "posts")
 *
 *   const query = createQuery(() => api.getList({ limit: 10 }).queryOptions)
 *   const queryClient = getQueryClient()
 *
 *   async function handleCreate() {
 *     const mutation = createMutation(() => ({
 *       ...api.create().mutationOptions,
 *       onSuccess: () => api.invalidateAll(queryClient),
 *     }))
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
export function createSvelteCollectionAdapter<FQ extends MakeQueryOptions, FM extends MakeMutationOptions>(
  makeQueryOptions: FQ,
  makeMutationOptions: FM
) {
  return createCollectionAdapter(makeQueryOptions, makeMutationOptions)
}
export { ActionKeys }
export type { ActionKey } from "./_core.js"
