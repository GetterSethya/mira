Mira is a self-hosted backend: you define collections in TypeScript, attach access rules, and the server generates the REST routes and database tables for you. This page installs the packages, defines a `users` auth collection and a `posts` base collection, and takes you from `app.serve()` to your first `curl` and your first typed client call. Each topic here has a dedicated page; this page carries only enough of each to get a working API.

## Install the packages

Mira ships as a set of packages. A server install needs one:

```install
pnpm add @gettersethya/mira effect@4.0.0
```

`@gettersethya/mira` is the server library. It depends on `@gettersethya/mira-client` (the typed client and collection DSL) and `@gettersethya/mira-collection` (the isomorphic collection builders), so this install pulls all three. `effect` is a peer dependency in the `~4.0.0` range for this alpha; install `effect@4.0.0` explicitly.

On Bun, use `bun add @gettersethya/mira effect@4.0.0` and import the runtime presets from `@gettersethya/mira/bun`. See the [Bun runtime page](../bun/) for the builder snippet and the SQLite preset. The collection and client code is unchanged.

Install the packages the frontend needs in its own app:

```install
pnpm add @gettersethya/mira-client effect@^4
pnpm add @gettersethya/mira-tanstack-adapter   # optional, for TanStack Query options
```

`@gettersethya/mira-tanstack-adapter` peer-depends on `@gettersethya/mira-client`. The dashboard is a separate plugin, `@gettersethya/mira-dashboard`, which you add when you want the admin UI.

## Define two collections

Put the definitions in one module and import them from both the server entrypoint and the client. This module must import only `@gettersethya/mira-client`; rules are server-only and live in a separate module so the shared definitions stay browser-safe.

```ts
import { AuthCollection, BaseCollection, Field } from "@gettersethya/mira-client"

export const Users = AuthCollection.define("users", {
  displayName: Field.text({ required: true, minLength: 1 }),
})

export const Posts = BaseCollection.define("posts", {
  title: Field.text({ maxLength: 200 }),
  body: Field.text({ required: false }),
  published: Field.boolean({ default: false }),
  author: Field.relation(Users, { required: false }),
})
```

`BaseCollection.define()` injects `id`, `seqId`, `created`, and `updated`. `AuthCollection.define()` takes extra fields only and adds the auth system fields: `email` and `emailVerified` in the public field map plus a hidden, write-only `password`, and a unique index on `email`. Both return a builder that is already a usable collection definition, so there is no separate build step. The [collections page](../collections/) covers every field kind and the [auth page](../auth/) covers the credential fields.

## Give the collection a rule

Rules are not optional decoration: a collection with no rule for an action denies that action to ordinary callers. Without a rule your first `GET` would return `403`. Define a minimal public rule for `Posts`:

```ts
import { defineRule } from "@gettersethya/mira"
import { Posts } from "./collections.js"

export const postsRules = defineRule(Posts, (R) => ({
  list: R.public(),
  view: R.public(),
  create: R.public(),
}))
```

`list` and `view` are what a read request needs. `create` is opened here so the walkthrough can insert a record; replace it with an owner check as soon as you have auth wired up. `update` and `delete` have no entries, so they stay denied. `Users` has no generic CRUD rules either, so those actions are denied until you follow the [auth page](../auth/) and the [rules page](../rules/); the dedicated login and `/api/auth/me` routes are separate. `R.public()` compiles to an always-true condition. Keep this rule in a server-only module and import the collection definitions from the shared module.

## Wire the builder

The builder enforces required steps at compile time: `platform`, `database`, `storage`, and `collections`. Rules are optional.

```ts
import { LocalFileStorage, Mira, NodePlatform, SqliteDatabase } from "@gettersethya/mira"
import { Posts, Users } from "./collections.js"
import { postsRules } from "./rules.js"

const app = Mira.builder()
  .platform(NodePlatform)
  .database(SqliteDatabase({ filename: "mira.db" }))
  .storage(LocalFileStorage({ directory: "./uploads" }))
  .collections([Users, Posts])
  .rules([postsRules])
  .build()

app.serve()
```

On Bun, keep the same collections and rules and swap the runtime presets:

```ts
import {
  BunPlatform,
  BunSqliteDatabase,
  LocalFileStorage,
  Mira
} from "@gettersethya/mira/bun"
import { Posts, Users } from "./collections.js"
import { postsRules } from "./rules.js"

const app = Mira.builder()
  .platform(BunPlatform)
  .database(BunSqliteDatabase({ filename: "mira.db" }))
  .storage(LocalFileStorage({ directory: "./uploads" }))
  .collections([Users, Posts])
  .rules([postsRules])
  .build()

app.serve()
```

The Bun entry uses native Bun filesystem, path, HTTP, runtime, and SQLite; it reuses the Node-compatible crypto, password, and SMTP layers. See the [Bun runtime page](../bun/) for the install, export conditions, and telemetry caveat.

The core presets are `NodePlatform`/`BunPlatform`, `SqliteDatabase`/`BunSqliteDatabase`, `LocalFileStorage`, and `S3CompatibleStorage`. `SqliteDatabase({ filename })` accepts a file path or `":memory:"`; `LocalFileStorage({ directory })` writes uploads under that folder. Swap in `S3CompatibleStorage({ endpoint, bucketName, regionName, accessKey, secret })` for any S3-compatible bucket; its config values can also be Effect `Config` values, and it is optional because local storage is enough to start. Email is optional too: add `.email(SmtpEmail({ host, port, from }))` when you want login alerts, password reset, verification, or OTP login; the [email page](../email/) covers it. Tables and indexes are created by auto-migration during boot, before the first request.

## Serve the app

`serve()` blocks the main thread and reads the port from the `_config` table, which is seeded with `8080` on first boot. If that port is taken, the server increments and retries (up to `maxPortAttempts`, default 10) and updates the configured port and URL to the one it actually bound. Pass options to override:

```ts
app.serve({ port: 3000 })
app.serve({ port: 8080, maxPortAttempts: 1 }) // fail instead of incrementing
```

`serve()` also runs plugin bootstrap hooks and starts configured crons. The [server page](../server/) covers config, storage, and telemetry in depth.

Run the server entrypoint with your TypeScript runner (`tsx server.ts` on Node, `bun run server.ts` on Bun). If port 8080 is taken, check the logged port before using the `curl` commands below.

## Make the first requests

List the (empty) collection:

```bash
curl http://localhost:8080/api/collections/posts
```

```json
{ "items": [], "nextCursor": null }
```

Create a record:

```bash
curl -X POST http://localhost:8080/api/collections/posts \
  -H "content-type: application/json" \
  -d '{"title":"Hello Mira","published":true}'
```

The response contains the inserted fields plus the server-managed `id`, `created`, and `updated` values. Fields you omitted are not added to the response.

List again and the record appears in `items`; pass the previous `nextCursor` as the `after` query parameter to fetch the next page.

## Call it from TypeScript

Create one client and reuse the same collection definitions. Query handlers take their options at the call site and `.raw()` takes nothing; mutation handlers take no call-site arguments and `.raw(input)` takes the payload.

```ts
import { createMiraClient } from "@gettersethya/mira-client"
import { Posts } from "./collections.js"

const mira = createMiraClient("http://localhost:8080").withCollections({ posts: Posts })

const page = await mira.posts.getList({ limit: 10, sort: "title", order: "asc" }).raw()
console.log(page.items, page.nextCursor)

const created = await mira.posts.create().raw({
  title: "Hello from the SDK",
  published: false,
})
```

`.raw()` returns a Promise and rejects with `MiraError` carrying `status` and `body`. Call `.toEffect()` instead when you want the Effect in your own runtime; the [client SDK page](../client-sdk/) covers the full surface, including auth, files, and the TanStack adapter.

## Next steps

- [Collections and fields](../collections/) for field kinds, indexes, relations, and view collections.
- [Auth collections and sessions](../auth/) to add login, registration, and session handling.
- [Access rules](../rules/) to replace the public rules with per-action checks.
- [Client SDK and TanStack](../client-sdk/) for filters, files, and query/mutation options.
