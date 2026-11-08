The Mira client SDK gives you a typed accessor for every collection definition you use on the server. Every operation is a handler you can run as a Promise with `.raw()` or as an Effect with `.toEffect()`, so the same code fits a browser app, an SSR loader, or a background Effect job.

## Install and create a client

```install
pnpm add @gettersethya/mira-client effect@^4
pnpm add @gettersethya/mira-tanstack-adapter   # optional
```

`effect` is a peer dependency of the client package, so install it explicitly. The TanStack adapter is optional; the client works without it.

```ts
import { createMiraClient } from "@gettersethya/mira-client"
import { PostCollection, UserCollection } from "./collections.js"

const client = createMiraClient("http://localhost:3000")
```

`createMiraClient(baseUrl)` prefixes every request with the base URL. The default is `"/"` for a same-origin browser app. Pass `{ type: "server" }` when you run it in SSR or a server process and want to manage the JWT yourself.

## Attach collections

`collection(def)` creates one accessor:

```ts
const posts = client.collection(PostCollection)
```

`withCollections(map)` creates several accessors at once. The base client returned by `createMiraClient` also exposes `auth`, `telemetry`, and `collection`; `withCollections` adds the per-collection accessors:

```ts
const mira = createMiraClient("/").withCollections({
  posts: PostCollection,
  users: UserCollection
})

const page = await mira.posts.getList().raw()
```

Map keys become property names. TanStack keys use the collection's `def.name`, so they match the server route.

## Handlers

| Method | Call site | Resolves to |
|---|---|---|
| `getList` | `getList(options?)` | `{ items, nextCursor }` |
| `getOne` | `getOne(id, options?)` | one record |
| `getFirstOrNone` | `getFirstOrNone(filter, options?)` | `Option<record>` |
| `getFullList` | `getFullList(options?)` | flat array |
| `create` | `create()` then `.raw(input)` | created record |
| `update` | `update()` then `.raw({ id, data })` | updated record |
| `delete` | `delete()` then `.raw(id)` | `void` |

Queries take their arguments at the call site and their terminal call is zero-argument. Mutations take no arguments until the payload is supplied:

```ts
const page = await mira.posts.getList({ limit: 20 }).raw()
// Promise<{ items: PostRecord[]; nextCursor: number | null }>

const one = mira.posts.getOne("abc123").toEffect()
// Effect<PostRecord, MiraError, HttpClient.HttpClient>
```

`.raw()` supplies the fetch-based HTTP client and rejects with the unwrapped `MiraError`, which carries `status` and `body`. `.toEffect()` leaves the `HttpClient` requirement to you, so you can provide a test client or a different transport.

`getFirstOrNone` requires a filter and forces `limit: 1`. `getFullList` fetches pages at a default page size of `1000` and returns the flat array; it is a convenience method, not an unbounded export.

## Query options

`getList` accepts `filter`, `sort`, `order`, `cursor`, `limit`, `select`, `expand`, and `retryOptions`. The filter is a **callback** that receives the typed builder, not a prebuilt node. The `cursor` value is whatever the previous page returned as `nextCursor`, and the client sends it as the `after` parameter.

```ts
let cursor: number | null = null

do {
  const page = await mira.posts.getList({
    filter: (f) => f.and(f.field("published").eq(true), f.field("views").gte(100)),
    sort: "created",
    order: "desc",
    cursor,
    limit: 20,
    select: ["id", "title", "views"],
    expand: ["author"]
  }).raw()

  cursor = page.nextCursor
} while (cursor !== null)
```

`select` and `expand` accept literal arrays, and the returned type narrows to the keys you named. A page envelope looks like this:

```json
{
  "items": [{ "id": "post_1", "title": "Hello", "views": 120 }],
  "nextCursor": 42
}
```

See [Querying and pagination](../querying/) for the full filter and pagination model.

## Mutations and files

Mutations are dispatched as JSON unless the payload contains a `Blob`. If any value is a `File` or `Blob`, the client switches to `multipart/form-data` automatically, so the write type for a file field is `File | Blob`.

```ts
const cover = new File(["binary"], "cover.png", { type: "image/png" })

const created = await mira.posts.create().raw({
  title: "Hello",
  cover
})

// The server stores a generated key; use the value on the record.
const url = mira.posts.fields.cover.url(created.id, created.cover)
```

The `fields` map exists for every `x-kind: "file"` property. Public fields expose `url(id, filename, { thumb? })`. Protected fields expose `asyncUrl(id, filename)` and `getToken()` as handlers: call `.raw()` on them, and `url` requires an explicit `{ token }`.

Multipart drops `null` and `undefined` values, so clear other fields with a separate JSON update.

## Auth collections

Auth collections are the only kind that expose `authWithPassword`, `register`, and `me` at runtime; the typed `CollectionClient` requires them for `K = "auth"` and omits them from the required surface for base/view collections.

```ts
const session = await mira.users.authWithPassword().raw({
  email: "user@example.com",
  password: "secret123"
})

const me = await mira.users.me().raw()

const user = await mira.users.register().raw({
  email: "user@example.com",
  password: "secret123",
  passwordConfirm: "secret123"
})
```

`register()` does not log the user in; call `authWithPassword()` afterwards. It wraps the collection's create endpoint, so open signup requires the collection's `create` rule to allow it. `me()` unwraps the `{ collection, record }` envelope and rejects with a 401 `MiraError` if the token belongs to another collection.

### Browser sessions

In browser mode the server sets an HttpOnly cookie. The client never reads it, so use the auth helper to restore state after a reload:

```ts
await mira.auth.ensureSession() // memoized GET /api/auth/me
mira.auth.isLoggedIn()         // in-memory flag
mira.auth.refresh()            // always issues a fresh check
mira.auth.clear()              // logs out and flips the flag
```

`ensureSession()` shares one request across route guards on a page load. `clear()` flips the local flag immediately and sends a fire-and-forget logout.

### Server tokens

In server mode there is no cookie. Set the token from your SSR context and check its expiry locally:

```ts
const mira = createMiraClient("http://localhost:3000", { type: "server" })

mira.auth.setToken(tokenFromRequest)
mira.auth.isValid() // checks the JWT exp claim, not the signature
mira.auth.clear()
```

See [Auth collections and sessions](../auth/) for credential rules and the session model.

## TanStack adapter

The adapter package produces plain `{ queryKey, queryFn }` and `{ mutationFn }` objects; it has no TanStack runtime dependency, so React, Solid, and Svelte bindings all consume the same adapter.

The snippets use `PostCollection` and `UserCollection` as placeholders for your own definitions; import them from the shared collections module (see [collections](../collections/)).

```ts
import { collectionAdapter } from "@gettersethya/mira-tanstack-adapter"

const mira = createMiraClient("/").withCollections(
  { posts: PostCollection, users: UserCollection },
  { adapter: collectionAdapter }
)

const listOptions = mira.posts.getList({ limit: 10 }).queryOptions
const createOptions = mira.posts.create().mutationOptions
// Pass these plain objects to useQuery / useMutation (React), createQuery (Svelte),
// or the equivalent binding. The adapter imports no framework.
```

Query handlers expose `queryKey` and `queryOptions`. Mutation handlers expose `mutationOptions`. Query keys follow `[collectionName, action, ...params]`, with `getOne` inserting the record id and `me` using `[name, "me"]`. The v1 key for `getFirstOrNone` does not include its filter, so use `getList` with a filter when the filter must be part of the cache identity. To invalidate the cache after a write, use the accessor helpers:

```ts
await mira.posts.invalidateAll(queryClient)          // [name] prefix
await mira.posts.invalidateOne(queryClient, created.id) // [name, "getOne", id]
```

## Worked example

```ts
import { createMiraClient } from "@gettersethya/mira-client"
import { collectionAdapter } from "@gettersethya/mira-tanstack-adapter"
import { PostCollection, UserCollection } from "./collections.js"

const mira = createMiraClient("https://api.example.com").withCollections(
  { posts: PostCollection, users: UserCollection },
  { adapter: collectionAdapter }
)

// Log in and confirm the session.
await mira.users.authWithPassword().raw({
  email: "user@example.com",
  password: "secret123"
})
const me = await mira.users.me().raw()

// List published posts, newest first.
const page = await mira.posts.getList({
  filter: (f) => f.field("published").eq(true),
  sort: "title",
  order: "asc",
  limit: 20
}).raw()

// Create a post with a file field.
const created = await mira.posts.create().raw({
  title: "Hello",
  cover: new File(["binary"], "cover.png", { type: "image/png" })
})

// TanStack options for a component.
const listOptions = mira.posts.getList({ limit: 10 }).queryOptions
const createOptions = mira.posts.create().mutationOptions
```

## Next steps

- [Querying and pagination](../querying/) for filter operators, sorting, and cursors.
- [Auth collections and sessions](../auth/) for credential lifecycle and `manage` access.
