# @gettersethya/mira-tanstack-adapter

> **Early pre-alpha.** Breaking changes may occur without notice.

TanStack Query adapters for [@gettersethya/mira-client](https://www.npmjs.com/package/@gettersethya/mira-client). Wraps collection client methods with `queryOptions` and `mutationOptions`, with structured query keys for fine-grained cache invalidation.

Supports React, Svelte, and Solid via separate entry points.

## Installation

```bash
# React
npm install @gettersethya/mira-tanstack-adapter @tanstack/react-query

# Svelte
npm install @gettersethya/mira-tanstack-adapter @tanstack/svelte-query

# Solid
npm install @gettersethya/mira-tanstack-adapter @tanstack/solid-query
```

`@gettersethya/mira-client` is a required peer dependency. Only install the TanStack package for the framework you use.

## Setup

```typescript
import { createMiraClient } from "@gettersethya/mira-client"
import { collectionAdapter } from "@gettersethya/mira-tanstack-adapter/react"
// import { collectionAdapter } from "@gettersethya/mira-tanstack-adapter/svelte"
// import { collectionAdapter } from "@gettersethya/mira-tanstack-adapter/solid"
import { Posts } from "./collections.js"

const mira     = createMiraClient("/api").withCollections({ posts: Posts })
const postsApi = collectionAdapter(mira, "posts")
```

## Queries

```tsx
import { useQuery } from "@tanstack/react-query"
import { postsApi } from "./setup.js"

function PostList() {
  const { data, isLoading } = useQuery(
    postsApi.getList({
      filter: (f) => f.field("published").eq(true),
      limit:  10,
    }).queryOptions
  )

  if (isLoading) return <p>Loading...</p>
  return <ul>{data?.items.map(p => <li key={p.id}>{p.title}</li>)}</ul>
}

function PostDetail({ id }: { id: string }) {
  const { data } = useQuery(postsApi.getOne(id).queryOptions)
  return <h1>{data?.title}</h1>
}
```

## Mutations

```tsx
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { postsApi } from "./setup.js"

function PostActions() {
  const queryClient = useQueryClient()

  const create = useMutation({
    ...postsApi.create().mutationOptions,
    onSuccess: () => postsApi.invalidateAll(queryClient),
  })

  const update = useMutation({
    ...postsApi.update().mutationOptions,
    onSuccess: (post) => postsApi.invalidateOne(queryClient, post.id),
  })

  const remove = useMutation({
    ...postsApi.delete().mutationOptions,
    onSuccess: () => postsApi.invalidateAll(queryClient),
  })

  return (
    <button onClick={() => create.mutate({ title: "New Post", published: false })}>
      Create
    </button>
  )
}
```

## Svelte and Solid

The API is identical across all three frameworks. Only the import path changes.

```typescript
// Svelte
import { collectionAdapter } from "@gettersethya/mira-tanstack-adapter/svelte"
// use with createQuery / createMutation from @tanstack/svelte-query

// Solid
import { collectionAdapter } from "@gettersethya/mira-tanstack-adapter/solid"
// use with createQuery / createMutation from @tanstack/solid-query
```

## Query key structure

The adapter produces structured query keys for fine-grained cache invalidation:

```typescript
// ["posts", "getList",        { limit, filter, sort, order, cursor, select, expand }]
// ["posts", "getOne",         "post-id"]
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
postsApi.invalidateAll(queryClient)         // invalidates all posts queries
postsApi.invalidateOne(queryClient, postId) // invalidates the getOne query for postId
```

## More

See the [Mira root README](https://github.com/gettersethya/mira) for collection definitions, field types, rules, and client usage.
