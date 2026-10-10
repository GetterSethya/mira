# @gettersethya/mira-tanstack-adapter

[![npm](https://img.shields.io/npm/v/@gettersethya/mira-tanstack-adapter)](https://www.npmjs.com/package/@gettersethya/mira-tanstack-adapter)

> **Early pre-alpha.** Breaking changes may occur without notice.

Framework-agnostic TanStack Query adapter for
[@gettersethya/mira-client](https://www.npmjs.com/package/@gettersethya/mira-client).
Wraps a collection client's methods with `queryOptions` and `mutationOptions`,
with structured query keys for fine-grained cache invalidation.

The option objects are plain `{ queryKey, queryFn }` / `{ mutationFn }` shapes,
so this package has **no runtime dependency on TanStack** — `useQuery` /
`useMutation` (React, Solid) and `createQuery` / `createMutation` (Svelte) all
accept them and infer `data`.

## Installation

```bash
npm install @gettersethya/mira-tanstack-adapter
```

`@gettersethya/mira-client` is a required peer dependency. Install whichever
TanStack Query package your framework uses separately.

## Setup

Pass `collectionAdapter` to `withCollections` and every accessor is enriched in
one call:

```typescript
import { createMiraClient } from "@gettersethya/mira-client"
import { collectionAdapter } from "@gettersethya/mira-tanstack-adapter"
import { Posts, Users } from "./collections.js"

export const client = createMiraClient("/api").withCollections(
  { posts: Posts, users: Users },
  { adapter: collectionAdapter },
)
```

## Queries

```tsx
import { useQuery } from "@tanstack/react-query"
import { client } from "./setup.js"

function PostList() {
  const { data, isLoading } = useQuery(
    client.posts.getList({
      filter: (f) => f.field("published").eq(true),
      limit:  10,
    }).queryOptions
  )

  if (isLoading) return <p>Loading...</p>
  return <ul>{data?.items.map(p => <li key={p.id}>{p.title}</li>)}</ul>
}

function PostDetail({ id }: { id: string }) {
  const { data } = useQuery(client.posts.getOne(id).queryOptions)
  return <h1>{data?.title}</h1>
}
```

## Mutations

```tsx
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { client } from "./setup.js"

function PostActions() {
  const queryClient = useQueryClient()

  const create = useMutation({
    ...client.posts.create().mutationOptions,
    onSuccess: () => client.posts.invalidateAll(queryClient),
  })

  const update = useMutation({
    ...client.posts.update().mutationOptions,
    onSuccess: (post) => client.posts.invalidateOne(queryClient, post.id),
  })

  const remove = useMutation({
    ...client.posts.delete().mutationOptions,
    onSuccess: () => client.posts.invalidateAll(queryClient),
  })

  return (
    <button onClick={() => create.mutate({ title: "New Post", published: false })}>
      Create
    </button>
  )
}
```

## Solid and Svelte

The same call shape works everywhere — the adapter is framework-agnostic:

```typescript
// Solid — createQuery / createMutation from @tanstack/solid-query
createQuery(() => client.posts.getList({ limit: 10 }).queryOptions)

// Svelte — reactive getters from @tanstack/svelte-query
createQuery(() => client.posts.getList({ limit: 10 }).queryOptions)
```

## Per-collection usage

If you prefer to adapt a single collection (for example with `createMiraClient().collection(def)`),
call the adapter directly:

```typescript
import { collectionAdapter } from "@gettersethya/mira-tanstack-adapter"

const postsApi = collectionAdapter(client.collection(Posts), Posts.name, Posts.schema["x-collection-kind"])
```

Or build one yourself with the framework-agnostic factory:

```typescript
import { createCollectionAdapter } from "@gettersethya/mira-tanstack-adapter"

const collectionAdapter = createCollectionAdapter()
```

## Query key structure

The adapter produces structured query keys for fine-grained cache invalidation:

```typescript
// ["posts", "getList",        { limit, filter, sort, order, cursor, select, expand }]
// ["posts", "getOne",         "post-id", {}]
// ["posts", "getFirstOrNone", { filter, sort, order, select, expand }]
// ["posts", "getFullList",    { limit, filter, sort, order, select, expand }]

// Invalidate all queries for a collection
queryClient.invalidateQueries({ queryKey: ["posts"] })

// Invalidate only list queries
queryClient.invalidateQueries({ queryKey: ["posts", "getList"] })

// Invalidate a specific record
queryClient.invalidateQueries({ queryKey: ["posts", "getOne", "post-id"] })
```

The adapter also exposes two helpers:

```typescript
client.posts.invalidateAll(queryClient)         // invalidates all posts queries
client.posts.invalidateOne(queryClient, postId) // invalidates the getOne query for postId
```

## More

See the [Mira root README](https://github.com/gettersethya/mira) for collection definitions, field types, rules, and client usage.
