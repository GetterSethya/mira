# @gettersethya/mira-client

> **Early pre-alpha.** Breaking changes may occur without notice.

Type-safe client SDK for [Mira](https://github.com/gettersethya/mira). Works in the browser and Node.js (SSR). Every operation returns a handler with both a Promise interface (`.raw()`) and an Effect interface (`.toEffect()`).

## Installation

```bash
npm install @gettersethya/mira-client @gettersethya/mira-collection effect
# or
pnpm add @gettersethya/mira-client @gettersethya/mira-collection effect
```

## Setup

```typescript
import { createMiraClient } from "@gettersethya/mira-client"
import { Posts, Users } from "./collections.js"

// Browser — token stored automatically in a cookie
const mira = createMiraClient("/").withCollections({ posts: Posts, users: Users })

// Server — token managed manually
const mira = createMiraClient("http://localhost:3000", { type: "server" })
  .withCollections({ posts: Posts, users: Users })
```

## Queries

```typescript
// Paginated list — returns { items, nextCursor }
const { items, nextCursor } = await mira.posts.getList({
  filter: (f) => f.field("published").eq(true),
  sort:   "created",
  order:  "desc",
  limit:  10,
  cursor: null,
  expand: ["authorId"],
  select: ["id", "title", "authorId"],
}).raw()

// Single record by id
const post = await mira.posts.getOne("post-id").raw()

// First match or nothing (returns Option<T>)
const latest = await mira.posts.getFirstOrNone({
  filter: (f) => f.field("published").eq(true),
  sort:   "created",
  order:  "desc",
}).raw()

// All records as a flat array (no pagination)
const all = await mira.posts.getFullList({ limit: 5000 }).raw()
```

## Mutations

```typescript
// Create
const post = await mira.posts.create().raw({ title: "Hello", published: false })

// Create with file upload — pass File or Blob for file fields
const post = await mira.posts.create().raw({
  title:     "With Image",
  thumbnail: new File([bytes], "thumb.png", { type: "image/png" }),
})

// Update
const updated = await mira.posts.update().raw(["post-id", { title: "Updated" }])

// Delete
await mira.posts.delete().raw("post-id")
```

## Authentication

```typescript
// Login — token stored automatically (browser) or set manually (server)
const { token, record } = await mira.users.authWithPassword().raw({
  email:    "user@example.com",
  password: "password123",
})

// Server: set the token after login
mira.auth.setToken(token)

// Check login state
mira.auth.loggedIn()  // boolean

// Logout
mira.auth.logout()
```

## Effect-based usage

Every handler exposes `.toEffect()` for use inside Effect pipelines.

```typescript
import { Effect } from "effect"

const effect = mira.posts.getList({ limit: 10 }).toEffect()
// Effect.Effect<{ items: Post[], nextCursor: number | null }, MiraError, HttpClient>

Effect.gen(function* () {
  const { items } = yield* mira.posts.getList({ limit: 10 }).toEffect()
  const post      = yield* mira.posts.getOne("post-id").toEffect()
})
```

## File URLs

```typescript
import { buildFileUrl } from "@gettersethya/mira-client"

// Public file
const url = buildFileUrl("posts", postId, "thumb.png")

// Protected file — request a short-lived token first
const res = await fetch("/api/files/token", {
  method:  "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body:    JSON.stringify({ collection: "posts" }),
})
const { token: fileToken } = await res.json()
const url = `${buildFileUrl("posts", postId, "thumb.png")}?token=${fileToken}`
```

## Type inference

```typescript
import type { InferRecord, InferCreateInput } from "@gettersethya/mira-client"

type Post        = InferRecord<typeof Posts>        // full record with system fields
type NewPost     = InferCreateInput<typeof Posts>   // creation input, no system fields
```

## More

See the [Mira root README](https://github.com/gettersethya/mira) for full documentation.
