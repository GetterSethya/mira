# Mira

> **Early pre-alpha.** This project is under active development. Any new feature or fix may introduce breaking changes without notice. Use at your own risk.

A self-hosted backend in TypeScript. Define collections, get a full REST API with auth, file storage, rules, and a type-safe client — all with zero config.

## Packages

| Package | Description |
|---|---|
| `@gettersethya/mira` | Server library (Node.js) |
| `@gettersethya/mira-collection` | Collection definitions, filter DSL, rule builder (browser + Node) |
| `@gettersethya/mira-client` | Client SDK |
| `@gettersethya/mira-tanstack-adapter` | TanStack Query adapters (React / Svelte / Solid) |

---

## Scaffolding the server

```typescript
import { LocalFileStorage, Mira, NodePlatform, SqliteDatabase } from "@gettersethya/mira"
import { Posts, Users } from "./collections.js"

const app = Mira.builder()
  .platform(NodePlatform)
  .database(SqliteDatabase({ filename: "mira.db" }))
  .storage(LocalFileStorage({ directory: "./uploads" }))
  .collections([Users, Posts])
  .build()

app.serve()
```

The builder enforces each step at the type level — TypeScript will not let you call `.build()` until `.platform()`, `.database()`, `.storage()`, and `.collections()` have all been called.

On first boot, Mira auto-generates a `jwt_secret`, runs schema migrations, and creates SQL views for view collections. Everything is stored in the SQLite database.

---

## Collection definitions

### Base collection

A standard CRUD collection. System fields `id`, `seqId`, `created`, and `updated` are injected automatically.

```typescript
import { BaseCollection, Bytes, Field, Rule } from "@gettersethya/mira-collection"

const Users = AuthCollection.define("users", {
  displayName: Field.text()
})

const Posts = BaseCollection.define("posts", {
  title:       Field.text({ maxLength: 200 }),
  slug:        Field.text({ unique: true }),
  content:     Field.text(),
  published:   Field.boolean({ default: false }),
  authorId:    Field.relation(Users),
  viewCount:   Field.integer({ min: 0, default: 0 }),
  thumbnail:   Field.file({ maxSize: Bytes.fromMB(5), mimeTypes: ["image/*"] }),
})
.indexes((I) => [
  I.on("authorId"),
  I.on("authorId", "published"),
  I.unique("slug"),
])
.rules((R) => ({
  list:   R.field("published").eq(R.literal(true)),
  view:   Rule.or(
    R.field("published").eq(R.literal(true)),
    R.field("authorId").eq(R.authId(Users))
  ),
  create: R.authId(Users).neq(R.literal(null)),
  update: R.field("authorId").eq(R.authId(Users)),
  delete: R.field("authorId").eq(R.authId(Users)),
}))
```

### Auth collection

Adds `email`, `password` (hashed), and `emailVerified` system fields. Exposes an `authWithPassword` endpoint.

```typescript
import { AuthCollection, Field, Rule } from "@gettersethya/mira-collection"

const Users = AuthCollection.define("users", {
  displayName: Field.text(),
  username:    Field.text({ unique: true }),
  bio:         Field.text({ required: false }),
  role:        Field.text({ default: "user" }),
})
.indexes((I) => [
  I.unique("username"),
])
.rules((R) => ({
  list:   Rule.public(),
  view:   Rule.public(),
  create: Rule.public(),
  update: R.selfId().eq(R.authId(Users)),
}))
```

> `R.selfId()` inside an auth collection refers to the record's own `id` — equivalent to "the user is editing themselves".

### View collection

A read-only collection backed by a SQL `VIEW`. Supports `list` and `view` only. Every field must be marked `.view()`, and `id` and `seqId` must be declared explicitly.

```typescript
import { Field, Rule, ViewCollection } from "@gettersethya/mira-collection"

const PostsWithAuthors = ViewCollection.define(
  "posts_with_authors",
  `SELECT
     p.id,
     p.seqId,
     p.title,
     p.published,
     u.displayName AS authorName
   FROM posts p
   LEFT JOIN users u ON p.authorId = u.id
   WHERE p.published = 1`,
  {
    id:         Field.text().view(),
    seqId:      Field.integer().view(),
    title:      Field.text().view(),
    published:  Field.boolean().view(),
    authorName: Field.text().view(),
  }
)
.rules((R) => ({
  list: Rule.public(),
  view: Rule.public(),
}))
```

---

## Field types

```typescript
Field.text({ minLength?, maxLength?, unique?, indexed?, required?, default? })
Field.email()
Field.integer({ min?, max?, unique?, indexed?, default? })
Field.number({ min?, max? })
Field.boolean({ default? })
Field.date()
Field.json()
Field.file({ maxSize?, mimeTypes?, protected? })
Field.relation(Collection)

// Byte helpers
Bytes.fromKB(1)
Bytes.fromMB(5)
Bytes.fromGB(1)
```

---

## Index examples

Indexes can be defined at the field level (shorthand) or in the `.indexes()` callback (for composite or explicit unique constraints).

```typescript
// Field-level (single column)
Field.text({ unique: true })    // unique index
Field.text({ indexed: true })   // non-unique index

// Callback (composite or explicit)
.indexes((I) => [
  I.on("authorId"),                   // non-unique index on one field
  I.on("authorId", "createdAt"),      // composite index
  I.unique("slug"),                   // unique constraint
  I.unique("teamId", "userId"),       // composite unique constraint
])
```

---

## Rule examples

Rules are evaluated server-side on every request. A missing rule means **deny all** for that action. `Rule.public()` means allow all.

```typescript
import { Rule } from "@gettersethya/mira-collection"

// Always allow
Rule.public()

// Always deny (omit the key — same effect)

// Logged-in users only
R.authId(Users).neq(R.literal(null))

// Owner-only
R.field("ownerId").eq(R.authId(Users))

// Field comparison
R.field("status").eq(R.literal("published"))
R.field("price").lte(R.literal(100))
R.field("role").in(R.literal(["admin", "moderator"]))
R.field("title").startsWith(R.literal("How to"))

// Combine
Rule.or(
  R.field("isPublic").eq(R.literal(true)),
  R.field("ownerId").eq(R.authId(Users))
)
Rule.and(
  R.field("published").eq(R.literal(true)),
  R.field("ownerId").eq(R.authId(Users))
)
Rule.not(R.field("archived").eq(R.literal(true)))

// Access a field from the authenticated user's record
R.auth(Users, "role").eq(R.literal("admin"))

// Date arithmetic (e.g., records created in the last 30 days)
R.field("created").gte(Rule.dateAdd(Rule.now(), -30, "day"))

// Request values (header, query param, or body field)
Rule.request("header", "x-api-key").eq(R.literal("secret"))

// Subquery (check membership)
const Members = BaseCollection.define("members", { userId: Field.text(), teamId: Field.text() })

Rule.subquery(Members, "teamId").where(
  R.field("userId").eq(R.authId(Users))
)
```

---

## Filter examples

Filters are used in client queries and are type-checked against the collection's field types.

```typescript
// Single condition
f.field("published").eq(true)
f.field("viewCount").gte(100)
f.field("status").in(["draft", "published"])
f.field("title").like("%effect%")
f.field("deletedAt").null()
f.field("deletedAt").notNull()
f.field("price").between(10, 100)

// Combining
f.and(
  f.field("published").eq(true),
  f.field("viewCount").gte(100)
)

f.or(
  f.field("category").eq("tech"),
  f.field("category").eq("science")
)

f.not(f.field("archived").eq(true))
```

---

## Client usage (browser)

```typescript
import { createMiraClient } from "@gettersethya/mira-client"
import { Posts, Users } from "./collections.js"

const mira = createMiraClient("/").withCollections({ posts: Posts, users: Users })
```

### Queries

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

### Mutations

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

### Authentication

```typescript
// Login — token is stored automatically and sent on all subsequent requests
const { token, record } = await mira.users.authWithPassword().raw({
  email:    "user@example.com",
  password: "password123",
})

// Check login state
mira.auth.loggedIn()   // boolean

// Logout — clears the stored token
mira.auth.logout()
```

---

## Client usage (server-to-server)

Use `{ type: "server" }` when calling Mira from a server environment (SSR, API routes, scripts). The token is managed manually.

```typescript
import { createMiraClient } from "@gettersethya/mira-client"
import { Posts, Users } from "./collections.js"

const mira = createMiraClient("http://localhost:3000", { type: "server" })
  .withCollections({ posts: Posts, users: Users })

// Obtain a token (e.g., service account or from the request context)
const { token } = await mira.users.authWithPassword().raw({
  email:    "service@example.com",
  password: "secret",
})

mira.auth.setToken(token)

// All subsequent calls include the Bearer token
const { items } = await mira.posts.getList({ limit: 100 }).raw()
```

### Effect-based usage

Every handler exposes a `.toEffect()` method for use inside Effect pipelines.

```typescript
import { Effect } from "effect"

const effect = mira.posts.getList({ limit: 10 }).toEffect()
// Effect.Effect<{ items: Post[], nextCursor: number | null }, MiraError, HttpClient>

Effect.gen(function* () {
  const { items } = yield* mira.posts.getList({ limit: 10 }).toEffect()
  const post      = yield* mira.posts.getOne("post-id").toEffect()
})
```

---

## TanStack adapter (React)

```typescript
// setup.ts
import { createMiraClient } from "@gettersethya/mira-client"
import { collectionAdapter } from "@gettersethya/mira-tanstack-adapter/react"
import { Posts } from "./collections.js"

const mira    = createMiraClient("/api").withCollections({ posts: Posts })
const postsApi = collectionAdapter(mira, "posts")

export { mira, postsApi }
```

### Queries

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

### Mutations

```tsx
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { postsApi } from "./setup.js"

function CreatePost() {
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

### Svelte and Solid

```typescript
// Svelte
import { collectionAdapter } from "@gettersethya/mira-tanstack-adapter/svelte"

// Solid
import { collectionAdapter } from "@gettersethya/mira-tanstack-adapter/solid"
```

The API is identical across all three frameworks. Only the import path changes.

---

## Query key structure

The adapter produces structured query keys that support fine-grained cache invalidation:

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

---

## File serving

Files are served at `/api/files/:collection/:id/:filename`.

- **Public files** — accessible without authentication.
- **Protected files** (`Field.file({ protected: true })`) — require a short-lived JWT token obtained from `POST /api/files/token`.

```typescript
// Request a file access token (requires a valid Bearer token)
const res = await fetch("/api/files/token", {
  method:  "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body:    JSON.stringify({ collection: "posts" }),
})
const { token: fileToken } = await res.json()

// Download a protected file
const file = await fetch(`/api/files/posts/${id}/thumb.png?token=${fileToken}`)
```

---

## Commands

```bash
# Build all packages (client → mira → adapter)
pnpm build

# Typecheck all packages (requires client built first)
pnpm -r typecheck

# Run all tests
pnpm -r test
```
