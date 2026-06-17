# Mira

> **Early pre-alpha.** This project is under active development. Any new feature or fix may introduce breaking changes without notice. Use at your own risk.

Mira is a self-hosted backend framework in TypeScript built on [Effect](https://effect.website/). You define your data model as typed collections, and Mira generates a full REST API with authentication, file uploads, access rules, cursor pagination, hooks, and an admin dashboard — all from code, with zero config files.

Your collections are TypeScript files. Your rules are composable expressions evaluated server-side on every request.

---

## Packages

| Package | Description | npm |
|---|---|---|
| `@gettersethya/mira` | Server library (Node.js) — the main package you run on the server | [![npm](https://img.shields.io/npm/v/@gettersethya/mira)](https://www.npmjs.com/package/@gettersethya/mira) |
| `@gettersethya/mira-collection` | Collection definitions, filter DSL, rule builder — isomorphic (browser + Node) | [![npm](https://img.shields.io/npm/v/@gettersethya/mira-collection)](https://www.npmjs.com/package/@gettersethya/mira-collection) |
| `@gettersethya/mira-client` | Type-safe HTTP client SDK for browsers or server-to-server calls | [![npm](https://img.shields.io/npm/v/@gettersethya/mira-client)](https://www.npmjs.com/package/@gettersethya/mira-client) |
| `@gettersethya/mira-tanstack-adapter` | TanStack Query adapters (React / Svelte / Solid) | [![npm](https://img.shields.io/npm/v/@gettersethya/mira-tanstack-adapter)](https://www.npmjs.com/package/@gettersethya/mira-tanstack-adapter) |
| `@gettersethya/mira-dashboard` | Admin dashboard plugin — SvelteKit SPA with a record editor, log viewer, and config display | [![npm](https://img.shields.io/npm/v/@gettersethya/mira-dashboard)](https://www.npmjs.com/package/@gettersethya/mira-dashboard) |

All packages require `effect >= 3.21` as a peer dependency.

---

## Installation

**Server** (runs in Node.js, produces the HTTP API)

```bash
npm install @gettersethya/mira @gettersethya/mira-collection effect
# or
pnpm add @gettersethya/mira @gettersethya/mira-collection effect
```

**Client** (runs in the browser or in SSR/server-to-server contexts)

```bash
npm install @gettersethya/mira-client @gettersethya/mira-collection effect
```

**TanStack adapter** — install alongside your framework's TanStack Query package:

```bash
# React
npm install @gettersethya/mira-tanstack-adapter @tanstack/react-query

# Svelte
npm install @gettersethya/mira-tanstack-adapter @tanstack/svelte-query

# Solid
npm install @gettersethya/mira-tanstack-adapter @tanstack/solid-query
```

**Admin dashboard** (optional plugin)

```bash
npm install @gettersethya/mira-dashboard
```

---

## Quick start

### 1. Define your collections

```typescript
// collections.ts
import { AuthCollection, BaseCollection, Bytes, Field, Rule } from "@gettersethya/mira-collection"

export const Users = AuthCollection.define("users", {
  displayName: Field.text({ maxLength: 100 }),
  role:        Field.literalText({ literal: ["user", "admin"], default: "user" }),
})
.rules((R) => ({
  list:   Rule.public(),
  view:   Rule.public(),
  create: Rule.public(),
  update: R.selfId().eq(R.authId(Users)),
}))

export const Posts = BaseCollection.define("posts", {
  title:     Field.text({ maxLength: 200 }),
  content:   Field.text(),
  published: Field.boolean({ default: false }),
  authorId:  Field.relation(Users),
  thumbnail: Field.file({ maxSize: Bytes.fromMB(5), mimeTypes: ["image/*"] }),
})
.rules((R) => ({
  list:   R.field("published").eq(R.literal(true)),
  view:   R.or(
    R.field("published").eq(R.literal(true)),
    R.field("authorId").eq(R.authId(Users))
  ),
  create: R.authId(Users).neq(R.literal(null)),
  update: R.field("authorId").eq(R.authId(Users)),
  delete: R.field("authorId").eq(R.authId(Users)),
}))
```

### 2. Bootstrap the server

```typescript
// server.ts
import { Mira, NodePlatform, SqliteDatabase, LocalFileStorage } from "@gettersethya/mira"
import { Users, Posts } from "./collections.js"

const app = Mira.builder()
  .platform(NodePlatform)
  .database(SqliteDatabase({ filename: "mira.db" }))
  .storage(LocalFileStorage({ directory: "./uploads" }))
  .collections([Users, Posts])
  .build()

app.serve()
```

On first boot Mira:
- Auto-generates a `jwt_secret` and stores it in the database
- Runs schema migrations (creates tables, indexes, views)
- Starts listening (default port 8080 — configure via `AppConfig` in the `_config` table)

---

## The builder API

`Mira.builder()` returns a `MiraBuilder<Has>` that uses TypeScript's type system to enforce step order. You cannot call `.build()` until all four required steps have been called.

```typescript
Mira.builder()
  .platform(NodePlatform)                                            // required — Node.js runtime
  .database(SqliteDatabase({ filename: "mira.db" }))                // required — SQLite backend
  .storage(LocalFileStorage({ directory: "./uploads" }))            // required — local disk storage
  .collections([Users, Posts])                                      // required — your collections
  .crons([/* CronDef definitions */])                               // optional — cron jobs
  .telemetry(makeSqliteTelemetryLayer({ dbPath: "logs.db" }))       // optional — SQLite telemetry
  .build()                                                          // produces MiraApp
  .extend(MiraDashboard)                                            // optional — register plugins
  .serve({ port: 3000 })                                            // starts the HTTP server
```

| Step | Required | Description |
|---|---|---|
| `.platform(p)` | yes | Runtime environment. Currently `NodePlatform`. |
| `.database(d)` | yes | SQL backend. Currently `SqliteDatabase({ filename })`. |
| `.storage(s)` | yes | File storage. Currently `LocalFileStorage({ directory })`. |
| `.collections(c)` | yes | Array of collection definitions. |
| `.crons(c)` | no | Array of `CronDef` — scheduled tasks using Effect `Schedule`. |
| `.telemetry(l)` | no | Telemetry layer. Defaults to `ConsoleTelemetryLayer` (stdout JSON). |
| `.build()` | — | Produces `MiraApp`. Fails at compile time if any required step is missing. |
| `.extend(plugin)` | — | Called on `MiraApp` after `.build()`. Registers a `MiraPlugin`. |
| `.serve(opts?)` | — | Starts the HTTP server. Optional `{ port }` overrides `AppConfig`. |

---

## Collection definitions

Collections are the schema of your data. Every collection generates a set of REST endpoints automatically.

### BaseCollection

A standard CRUD collection. System fields `id` (random base64url string), `seqId` (auto-increment integer), `created` (ISO timestamp), and `updated` (ISO timestamp) are injected automatically and are never exposed in user input.

```typescript
import { BaseCollection, Bytes, Field, Rule } from "@gettersethya/mira-collection"

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
  I.on("authorId"),              // non-unique index
  I.on("authorId", "published"), // composite index
  I.unique("slug"),              // unique constraint
])
.rules((R) => ({
  list:   R.field("published").eq(R.literal(true)),
  view:   R.or(
    R.field("published").eq(R.literal(true)),
    R.field("authorId").eq(R.authId(Users))
  ),
  create: R.authId(Users).neq(R.literal(null)),
  update: R.field("authorId").eq(R.authId(Users)),
  delete: R.field("authorId").eq(R.authId(Users)),
}))
```

Generated endpoints:

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/collections/posts` | List with cursor pagination, filtering, sorting |
| `GET` | `/api/collections/posts/:id` | Single record |
| `POST` | `/api/collections/posts` | Create |
| `PATCH` | `/api/collections/posts/:id` | Update |
| `DELETE` | `/api/collections/posts/:id` | Delete |

### AuthCollection

An `AuthCollection` extends `BaseCollection` with three extra system fields: `email` (unique, required), `password` (bcrypt-hashed, hidden from API responses), and `emailVerified` (boolean). It also adds a login endpoint.

```typescript
import { AuthCollection, Field, Rule } from "@gettersethya/mira-collection"

const Users = AuthCollection.define("users", {
  displayName: Field.text(),
  username:    Field.text({ unique: true }),
  bio:         Field.text({ required: false }),
  role:        Field.literalText({ literal: ["user", "admin"], default: "user" }),
})
.indexes((I) => [I.unique("username")])
.rules((R) => ({
  list:   R.public(),
  view:   R.public(),
  create: R.public(),
  update: R.selfId().eq(R.authId(Users)),
  // delete is omitted → always denied
}))
```

Additional endpoints:

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/collections/users/auth-with-password` | Login with `{ email, password }`, returns `{ token, record }` |
| `POST` | `/api/auth/logout` | Clears the server-side session |

`R.selfId()` inside an auth collection rule refers to the record's own `id`. It is equivalent to "the user is editing their own profile".

### ViewCollection

A read-only collection backed by a SQL `VIEW`. Use it to expose joined or aggregated data without running the JOIN on every request. Only `list` and `view` rules are supported. Every field must be marked `.view()`. `id` and `seqId` must be declared explicitly because they come from the SQL query, not from auto-injection.

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

The `VIEW` is created in SQLite during auto-migration. If the SQL body or field list changes, the view is dropped and recreated. View collections are read-only — `create`, `update`, `delete` return `405 Method Not Allowed`.

---

## Field types

All field builders return a `FieldDef` with a `.view()` method for use in `ViewCollection`. Every field inherits these base options:

| Option | Type | Default | Description |
|---|---|---|---|
| `required` | `boolean` | `true` (unless `default` is set) | Whether the field must be present when creating a record |
| `default` | `any` | — | Default value used when the field is omitted on create |
| `unique` | `boolean` | `false` | Creates a unique index on this field |
| `indexed` | `boolean` | `false` | Creates a non-unique index on this field |
| `name` | `string` | key name | Alternative column name in the database |
| `error` | `(kind) => string \| undefined` | — | Callback for custom validation error messages |

### `Field.text(opts?)`

UTF-8 string. Stored as `TEXT` in SQLite.

```typescript
Field.text()
Field.text({ maxLength: 200 })
Field.text({ minLength: 3, maxLength: 100, default: "untitled" })
Field.text({ required: false, unique: true })
Field.text({ error: (kind) => kind === "maxLength" ? "Title is too long" : undefined })
```

| Option | Type | Description |
|---|---|---|
| `minLength` | `number` | Minimum string length |
| `maxLength` | `number` | Maximum string length |

### `Field.literalText(opts)`

A text field restricted to a fixed set of string values. The TypeScript type narrows to the exact literal union so filters and client SDK calls are type-checked against the allowed values. The server rejects values outside the set on create and update.

```typescript
Field.literalText({ literal: ["draft", "published"] })
Field.literalText({ literal: ["draft", "published"], default: "draft" })
Field.literalText({ literal: ["admin", "agent", "readonly"], required: false })
```

| Option | Type | Description |
|---|---|---|
| `literal` | `readonly string[]` | The allowed values (required, narrowed via `const` type param) |
| `default` | `literal[number]` | Default value — must be one of the allowed values |

### `Field.integer(opts?)`

Whole number. Stored as `INTEGER` in SQLite.

```typescript
Field.integer()
Field.integer({ min: 0, default: 0 })
Field.integer({ min: 1, max: 5 })
```

| Option | Type | Description |
|---|---|---|
| `min` | `number` | Minimum value (inclusive) |
| `max` | `number` | Maximum value (inclusive) |

### `Field.number(opts?)`

Floating-point number. Stored as `REAL` in SQLite.

```typescript
Field.number()
Field.number({ min: 0, max: 100 })
```

| Option | Type | Description |
|---|---|---|
| `min` | `number` | Minimum value (inclusive) |
| `max` | `number` | Maximum value (inclusive) |

### `Field.boolean(opts?)`

True/false. Stored as `INTEGER` (0/1) in SQLite. Default is `false` unless overridden.

```typescript
Field.boolean({ default: false })
Field.boolean({ default: true })
```

### `Field.date(opts?)`

Date/time stored as an ISO 8601 string (`TEXT` in SQLite). The server stores values verbatim — no parsing or transformation is applied. Use ISO 8601 strings in your client code.

```typescript
Field.date()
Field.date({ required: false })
```

### `Field.email(opts?)`

A text field with built-in email format validation. Stored as `TEXT`. The server validates the format on create and update.

```typescript
Field.email()
Field.email({ required: false, unique: true })
```

### `Field.json(opts?)`

Arbitrary structured data. Serialized to a JSON string and stored as `TEXT`. The server serializes on write and deserializes on read.

```typescript
Field.json()
Field.json({ required: false })
```

### `Field.file(opts?)`

An uploaded file. Stores the filename as `TEXT` in SQLite. The actual bytes are stored in the file storage backend (local disk or S3). Files are served at `/api/files/:collection/:id/:filename`.

```typescript
Field.file()
Field.file({ maxSize: Bytes.fromMB(5), mimeTypes: ["image/jpeg", "image/png"] })
Field.file({ protected: true, maxSize: Bytes.fromGB(1) })   // requires auth token to download
```

| Option | Type | Description |
|---|---|---|
| `maxSize` | `number` | Maximum upload size in bytes. Use `Bytes.*` helpers |
| `mimeTypes` | `string[]` | Allowed MIME types. Supports wildcards like `"image/*"` |
| `protected` | `boolean` | If `true`, downloads require a short-lived JWT file token |

Byte size helpers:

```typescript
Bytes.fromKB(100)   // 102400
Bytes.fromMB(5)     // 5242880
Bytes.fromGB(1)     // 1073741824
Bytes.fromTB(1)     // 1099511627776
```

### `Field.relation(collection, opts?)`

A foreign key referencing another collection's record. Stores the target record's `id` (or another specified field) as `TEXT`. The `_target` phantom property is used by the client SDK's `WithExpand` type inference at compile time only — it is not serialized.

```typescript
Field.relation(Users)                     // stores Users.id
Field.relation(Users, { field: "email" }) // stores Users.email instead
```

| Option | Type | Description |
|---|---|---|
| `field` | `keyof C["fields"] \| "id" \| "created" \| "updated"` | Which field of the target to store. Defaults to `"id"` |

---

## Index examples

Indexes can be defined at the field level (for single-column cases) or in the `.indexes()` callback (for composite indexes or explicit unique constraints).

```typescript
// Field-level shortcuts
Field.text({ unique: true })     // UNIQUE index on this column
Field.text({ indexed: true })    // non-unique index on this column

// Callback — prefer this for composite indexes
.indexes((I) => [
  I.on("authorId"),                       // single non-unique index
  I.on("authorId", "published"),          // composite index
  I.unique("slug"),                       // single unique constraint
  I.unique("teamId", "userId"),           // composite unique constraint
])
```

---

## Rule system

Rules are TypeScript expressions evaluated server-side on every request. They are compiled to SQL `WHERE` clauses and enforced at the database layer.

A missing rule for an action means **deny all** for that action. `Rule.public()` means allow all.

The `(R) => ({...})` callback receives a rule builder `R`. You must use `R.*` inside this callback — rule expressions cannot be created outside of it.

```typescript
.rules((R) => ({
  list:   /* rule */,
  view:   /* rule */,
  create: /* rule */,
  update: /* rule */,
  delete: /* rule */,
}))
```

### Allow / deny shorthands

```typescript
Rule.public()   // always allow (1 = 1)
// omit the key   // always deny
```

### Auth checks

```typescript
// Any logged-in user
R.authId(Users).neq(R.literal(null))

// Specific user owns the record
R.field("authorId").eq(R.authId(Users))

// Edit your own record (inside AuthCollection)
R.selfId().eq(R.authId(Users))

// Check an attribute of the authenticated user's record
R.auth(Users, "role").eq(R.literal("admin"))
```

### Field comparisons

```typescript
R.field("status").eq(R.literal("published"))
R.field("status").neq(R.literal("deleted"))
R.field("price").lt(R.literal(100))
R.field("price").lte(R.literal(100))
R.field("viewCount").gt(R.literal(0))
R.field("viewCount").gte(R.literal(0))
R.field("role").in(R.literal(["admin", "moderator"]))
R.field("title").startsWith(R.literal("Breaking:"))
R.field("body").contains(R.literal("effect"))
```

### Combining rules

```typescript
Rule.and(
  R.field("published").eq(R.literal(true)),
  R.authId(Users).neq(R.literal(null))
)

Rule.or(
  R.field("isPublic").eq(R.literal(true)),
  R.field("ownerId").eq(R.authId(Users))
)

Rule.not(R.field("archived").eq(R.literal(true)))
```

### Date arithmetic

```typescript
// Records created in the last 30 days
R.field("created").gte(Rule.dateAdd(Rule.now(), -30, "day"))

// Records expiring before today
R.field("expiresAt").lt(Rule.now())
```

Units accepted: `"day"`, `"hour"`, `"minute"`, `"second"`.

### Request values

```typescript
// Check a request header
Rule.request("header", "x-api-key").eq(R.literal("secret"))

// Check a query param
Rule.request("query", "preview").eq(R.literal("true"))
```

### Subqueries

Use a subquery to enforce membership — for example, only members of a team can view a resource.

```typescript
const Members = BaseCollection.define("members", {
  userId: Field.text(),
  teamId: Field.text(),
})

// A post's teamId must match a team the authenticated user belongs to
Rule.subquery(Members, "teamId").where(
  R.field("userId").eq(R.authId(Users))
)
```

`Rule.subquery(collection, field)` checks that the current record's `field` value exists in `collection` for at least one row matching the `.where()` condition.

---

## Filter system

Filters are used in client queries. They are type-checked at compile time against the collection's field types.

```typescript
// Equality / comparison
f.field("published").eq(true)
f.field("viewCount").gt(0)
f.field("viewCount").gte(100)
f.field("price").lt(50)
f.field("price").lte(100)

// Set membership
f.field("status").in(["draft", "published"])

// String patterns
f.field("title").like("%effect%")    // SQL LIKE

// Null checks
f.field("deletedAt").null()
f.field("deletedAt").notNull()

// Range
f.field("price").between(10, 100)

// Boolean logic
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

## Plugin system

Plugins are the extension point for Mira. A plugin can:

- Run code at server lifecycle events (bootstrap, serve, terminate)
- Intercept and modify record operations before they execute
- React to record operations after they complete (fire-and-forget)
- Register additional HTTP routes
- Add extra Effect service layers
- Register additional collections

Plugins are created with `MiraPlugin.define()` and registered with `app.extend()` before `.serve()`.

```typescript
import { MiraPlugin } from "@gettersethya/mira"
import { Effect } from "effect"

const myPlugin = MiraPlugin.define({
  onBootstrap: () => Effect.log("Server is starting..."),
  onServe:     () => Effect.log("Server is ready"),
  onTerminate: () => Effect.log("Server is shutting down"),

  onRecordCreateSuccess: {
    handler: (ctx) => Effect.log(`Created ${String(ctx.result["id"])} in ${ctx.collection.name}`)
  },
})

app.extend(myPlugin).serve()
```

### Wrapping a plain Effect Layer

If you have an existing Effect `Layer` and just want to run it as part of the app (e.g., a background job or a singleton service), wrap it with `MiraPlugin.fromLayer()`.

```typescript
import { MiraPlugin } from "@gettersethya/mira"
import { Layer, Effect, Schedule } from "effect"

// A background job that runs every minute
const backgroundJobLayer = Layer.scopedDiscard(
  Effect.forkScoped(
    Effect.repeat(
      Effect.log("background tick"),
      Schedule.fixed("1 minute")
    )
  )
)

app.extend(MiraPlugin.fromLayer(backgroundJobLayer)).serve()
```

---

### Lifecycle hooks

These hooks fire at server lifecycle moments and **block** the server from continuing until they complete.

```typescript
MiraPlugin.define({
  // Runs before the HTTP server starts accepting connections.
  // Has access to AppConfig and CollectionService via Effect context.
  onBootstrap: () =>
    Effect.gen(function* () {
      const cfg = yield* AppConfig
      yield* Effect.log(`Starting on port ${cfg.port}`)
    }),

  // Runs after the HTTP server is listening.
  onServe: () => Effect.log("Server is ready"),

  // Runs on shutdown.
  onTerminate: () => Effect.log("Shutting down"),
})
```

---

### Record lifecycle hooks

Every CRUD operation fires up to four hook slots per plugin. Hooks within the same slot across multiple plugins run **serially in registration order**.

| Hook name | Stage | Blocks? | Can modify ctx? |
|---|---|---|---|
| `onRecordCreate` | Pre — before validation | yes | yes |
| `onRecordCreateExecute` | Execute — after validation, before write | yes | yes |
| `onRecordCreateSuccess` | After successful write | no (fire-and-forget) | no |
| `onRecordCreateError` | After a failed write | no (fire-and-forget) | no |
| `onRecordUpdate` | Pre — before validation | yes | yes |
| `onRecordUpdateExecute` | Execute — after validation, before write | yes | yes |
| `onRecordUpdateSuccess` | After successful write | no (fire-and-forget) | no |
| `onRecordUpdateError` | After a failed write | no (fire-and-forget) | no |
| `onRecordDelete` | Pre — before delete | yes | yes |
| `onRecordDeleteExecute` | Execute — immediately before delete | yes | yes |
| `onRecordDeleteSuccess` | After successful delete | no (fire-and-forget) | no |
| `onRecordDeleteError` | After a failed delete | no (fire-and-forget) | no |
| `onRecordList` | Pre — before list query | yes | yes (filter/sort/select/expand) |
| `onRecordListSuccess` | After successful list | no (fire-and-forget) | no |
| `onRecordListError` | After a failed list | no (fire-and-forget) | no |
| `onRecordView` | Pre — before single-record fetch | yes | yes (select/expand) |
| `onRecordViewSuccess` | After successful view | no (fire-and-forget) | no |
| `onRecordViewError` | After a failed view | no (fire-and-forget) | no |

**Blocking hooks** (pre and execute) receive a context object, may modify it, and must return it. The returned context is passed to the next plugin's hook and eventually drives the operation. **Fire-and-forget hooks** (success and error) run in a daemon fiber — errors are logged but do not affect the HTTP response.

#### Context types

**`RecordHookContext`** — passed to `onRecordCreate`, `onRecordCreateExecute`, `onRecordUpdate`, `onRecordUpdateExecute`, `onRecordDelete`, `onRecordDeleteExecute`:

```typescript
interface RecordHookContext {
  collection: AnyCollectionDef      // the collection being operated on
  data:       RepoRecord            // the input data (request body fields)
  record:     RepoRecord | undefined // existing record; undefined on create
  auth:       AuthContext | undefined
}

interface AuthContext {
  collection: string     // the auth collection name (e.g. "users")
  record:     RepoRecord // the authenticated user's full record
}
```

**`RecordResultContext`** — passed to `onRecordCreateSuccess`, `onRecordUpdateSuccess`, `onRecordDeleteSuccess`. Extends `RecordHookContext`:

```typescript
interface RecordResultContext extends RecordHookContext {
  result: RepoRecord   // the record as it exists after the operation
}
```

**`ListHookContext`** — passed to `onRecordList`. Fields can be mutated to modify the query before it runs:

```typescript
interface ListHookContext {
  collection: AnyCollectionDef
  filter:     FilterNode | undefined         // modify to add extra filters
  sort:       SortOrder | undefined          // modify to change sort direction
  select:     ReadonlyArray<string> | null | undefined  // restrict returned fields
  expand:     ReadonlyArray<string> | null | undefined  // which relations to expand
  cursor:     number | null
  limit:      number
  auth:       AuthContext | undefined
}
```

**`ListResultContext`** — passed to `onRecordListSuccess`. Extends `ListHookContext`:

```typescript
interface ListResultContext extends ListHookContext {
  items:       ReadonlyArray<RepoRecord>
  nextCursor:  number | null
}
```

**`ViewHookContext`** — passed to `onRecordView`:

```typescript
interface ViewHookContext {
  collection: AnyCollectionDef
  id:         string                                    // the record id being fetched
  select:     ReadonlyArray<string> | null | undefined
  expand:     ReadonlyArray<string> | null | undefined
  auth:       AuthContext | undefined
}
```

**`ViewResultContext`** — passed to `onRecordViewSuccess`. Extends `ViewHookContext`:

```typescript
interface ViewResultContext extends ViewHookContext {
  result: RepoRecord   // the fetched record
}
```

**`HookErrorContext`** — passed to all error hooks (`onRecordCreateError`, etc.):

```typescript
interface HookErrorContext {
  collection: AnyCollectionDef
  action:     string        // "create" | "update" | "delete" | "list" | "view"
  error:      unknown
  auth:       AuthContext | undefined
}
```

---

### Hook examples

#### Audit log (all collections)

```typescript
MiraPlugin.define({
  onRecordCreateSuccess: {
    handler: (ctx) =>
      Effect.log(`audit: created ${String(ctx.result["id"])} in ${ctx.collection.name}`)
  },
  onRecordUpdateSuccess: {
    handler: (ctx) =>
      Effect.log(`audit: updated ${String(ctx.result["id"])} in ${ctx.collection.name}`)
  },
  onRecordDeleteSuccess: {
    handler: (ctx) =>
      Effect.log(`audit: deleted ${String(ctx.result["id"])} in ${ctx.collection.name}`)
  },
})
```

#### Target specific collections

Pass a `collections` array to any hook to make it fire **only** when the operation is on one of those collections. Without `collections`, the hook fires for every collection.

```typescript
import { onCollection, onCollectionSuccess } from "@gettersethya/mira"

MiraPlugin.define({
  // Only fires for creates on "orders" and "line_items"
  onRecordCreateSuccess: onCollectionSuccess(
    ["orders", "line_items"],
    (ctx) => Effect.log(`New record in ${ctx.collection.name}: ${String(ctx.result["id"])}`)
  ),

  // Only fires for list queries on "posts"
  onRecordList: onCollection(
    ["posts"],
    (ctx) => Effect.succeed({ ...ctx, limit: Math.min(ctx.limit, 50) }) // cap limit
  ),
})
```

`onCollection(collections, handler)` builds a `RecordHook` / `ListHook`. `onCollectionSuccess(collections, handler)` builds a `RecordSuccessHook` / `ListSuccessHook`.

You can also set `collections` inline:

```typescript
MiraPlugin.define({
  onRecordCreateSuccess: {
    collections: ["orders"],
    handler: (ctx) => sendOrderConfirmationEmail(ctx.result),
  },
})
```

#### Modify list queries in a pre-hook

Pre-hooks on `onRecordList` can modify the query before it is executed. The hook must return the (optionally modified) context.

```typescript
MiraPlugin.define({
  // Force all list queries on "posts" to exclude archived posts
  onRecordList: {
    collections: ["posts"],
    handler: (ctx) => {
      const archivedFilter = Filter.field("archived").eq(false)
      const merged = ctx.filter
        ? Filter.and(ctx.filter, archivedFilter)
        : archivedFilter
      return Effect.succeed({ ...ctx, filter: merged })
    }
  },
})
```

#### Inject data in a pre-hook

```typescript
MiraPlugin.define({
  // Automatically set authorId to the authenticated user on create
  onRecordCreate: {
    collections: ["posts"],
    handler: (ctx) =>
      Effect.succeed({
        ...ctx,
        data: { ...ctx.data, authorId: ctx.auth?.record["id"] ?? null }
      })
  },
})
```

#### Abort an operation from an execute hook

Execute-hooks run after validation but before the write. If you `Effect.die` (or `Effect.fail`) from an execute hook, the operation is aborted and the error is returned to the client.

```typescript
MiraPlugin.define({
  onRecordCreateExecute: {
    collections: ["payments"],
    handler: (ctx) =>
      Effect.gen(function* () {
        const amount = ctx.data["amount"] as number
        if (amount > 10_000) {
          yield* Effect.die(new Error("Amount exceeds limit"))
        }
        return ctx
      })
  },
})
```

#### Add custom routes

Plugins can expose HTTP routes that are merged into the server router. Routes have access to the full service stack (`AppConfig`, `Repository`, `CollectionService`, `AuthService`, `SqlClient`, `FileSystem`, `Path`).

```typescript
import { HttpRouter, HttpServerResponse } from "@effect/platform"

MiraPlugin.define({
  routes: HttpRouter.get(
    "/api/health",
    HttpServerResponse.json({ status: "ok" })
  ),
})
```

#### Add extra collections

Plugins can register additional collections. These are auto-migrated on boot alongside the app's own collections.

```typescript
const AuditLogs = BaseCollection.define("audit_logs", {
  action:       Field.text(),
  collectionName: Field.text(),
  recordId:     Field.text(),
  actorId:      Field.text({ required: false }),
})

MiraPlugin.define({
  collections: [AuditLogs],
  onRecordCreateSuccess: {
    handler: (ctx) =>
      // Write to the extra collection via a service or custom route
      Effect.void
  },
})
```

---

## Cron jobs

Mira includes a built-in cron subsystem for scheduling recurring tasks. Crons are defined as `CronDef` objects with an Effect `Schedule` and a `handler` Effect, and are registered via the builder's `.crons()` method.

```typescript
import { Effect, Schedule } from "effect"
import { CronService } from "@gettersethya/mira"

const app = Mira.builder()
  .platform(NodePlatform)
  .database(SqliteDatabase({ filename: "mira.db" }))
  .storage(LocalFileStorage({ directory: "./uploads" }))
  .collections([Users, Posts])
  .crons([
    {
      name: "cleanup-expired-tokens",
      schedule: Schedule.fixed("1 hour"),
      handler: () => Effect.log("[cron] cleaning expired tokens..."),
    },
    {
      name: "sync-external-service",
      schedule: Schedule.cron("0 */6 * * *"),  // every 6 hours
      handler: () => Effect.log("[cron] syncing..."),
    },
  ])
  .build()
  .serve()
```

Cron names must be globally unique across all crons (including those registered by plugins). Duplicate names cause the server to fail at layer construction.

### CronDef

| Property | Type | Description |
|---|---|---|
| `name` | `string` | Unique cron identifier |
| `schedule` | `Schedule.Schedule<unknown, unknown, never>` | Effect Schedule — use `Schedule.fixed`, `Schedule.cron`, `Schedule.spaced`, etc. |
| `handler` | `() => Effect.Effect<void, unknown, R>` | The task to run. Default context includes `PlatformServices`, `AppConfig`, `Repository`, and `CollectionService`. |

### CronService

The `CronService` tag exposes methods for runtime interaction:

| Method | Returns | Description |
|---|---|---|
| `getAll()` | `Effect<CronState[]>` | Returns the current state of every registered cron |
| `runNow(name)` | `Effect<void, CronNotFoundError>` | Manually trigger a cron run outside its schedule |

`CronState` includes `name`, `status` (`"standby"` / `"running"`), `lastRunAt`, `lastStatus`, `lastDurationMs`, and `lastError`.

### Cron hooks in plugins

Plugins can declare crons and hook into cron lifecycle events via the `MiraPlugin` interface:

| Hook | Signature | Description |
|---|---|---|
| `crons` | `CronDef[]` | Additional cron definitions merged with the app's own |
| `onCronStart` | `CronHook<CronContext>` | Before a cron tick begins — blocking, can modify context |
| `onCronExecute` | `CronHook<CronContext>` | After start hooks run, before the handler — blocking |
| `onCronSuccess` | `CronObserverHook<CronResultContext>` | After a successful run — fire-and-forget |
| `onCronError` | `CronObserverHook<CronErrorContext>` | After a failed run — fire-and-forget |
| `onCronFinished` | `CronObserverHook<CronFinishedContext>` | After any run (success or error) — fire-and-forget |

```typescript
MiraPlugin.define({
  crons: [
    {
      name: "nightly-report",
      schedule: Schedule.cron("0 2 * * *"),
      handler: () => Effect.log("Generating nightly report..."),
    },
  ],

  onCronSuccess: {
    crons: ["nightly-report"],
    handler: (ctx) => Effect.log(`Report ran in ${ctx.durationMs}ms`),
  },

  onCronError: {
    crons: ["nightly-report"],
    handler: (ctx) => Effect.log(`Report failed: ${String(ctx.error)}`),
  },
})
```

The `crons` filter on cron hooks works like `collections` on record hooks — omit it to match all crons, or pass an array of names to target specific ones. Cron hooks run serially within each slot, matching record hook semantics.

## Admin dashboard

The `@gettersethya/mira-dashboard` package is a ready-made plugin that adds an admin UI at `/_dashboard/`. It includes:

- Collection browser with record list, create, edit, and delete
- Logs and span viewer (works best with `makeSqliteTelemetryLayer`)
- App config display
- Superadmin account management
- Cron job listing and manual run trigger

```typescript
import { Mira, NodePlatform, SqliteDatabase, LocalFileStorage } from "@gettersethya/mira"
import { MiraDashboard } from "@gettersethya/mira-dashboard"
import { Posts, Users } from "./collections.js"

const app = Mira.builder()
  .platform(NodePlatform)
  .database(SqliteDatabase({ filename: "mira.db" }))
  .storage(LocalFileStorage({ directory: "./uploads" }))
  .collections([Users, Posts])
  .build()

app.extend(MiraDashboard).serve()
```

On first boot the dashboard prints a one-time registration URL to stdout:

```
[dashboard] Register at: http://localhost:8080/_dashboard/register?token=<token>
```

Open that URL to create the first superadmin account. Once an account exists, subsequent boots print the regular login URL instead.

The dashboard registers a `SuperAdminCollection` (an `AuthCollection` with deny-all rules) under the name `_superadmins`. This collection is separate from your app's own user collection.

The dashboard also exposes cron management endpoints:

| Method | Path | Description |
|---|---|---|
| `GET` | `/_dashboard/api/crons` | List all registered cron jobs with their current state |
| `POST` | `/_dashboard/api/crons/:name/run` | Trigger immediate execution of a cron job |

---

## Telemetry

By default Mira uses `ConsoleTelemetryLayer`, which prints JSON trace spans to stdout:

```
[trace] {"span":"collection.list","traceId":"...","spanId":"...","durationMs":3.2,"status":"ok","attributes":{"collection":"posts","cache.hit":true}}
```

To persist logs and spans to a SQLite database instead, use `makeSqliteTelemetryLayer`:

```typescript
import { Mira, NodePlatform, SqliteDatabase, LocalFileStorage, makeSqliteTelemetryLayer } from "@gettersethya/mira"

const app = Mira.builder()
  .platform(NodePlatform)
  .database(SqliteDatabase({ filename: "mira.db" }))
  .storage(LocalFileStorage({ directory: "./uploads" }))
  .collections([Users, Posts])
  .telemetry(makeSqliteTelemetryLayer({
    dbPath:     "mira-logs.db",   // defaults to "mira-logs.db"
    logConsole: true,             // also print to stdout (default: false)
  }))
  .build()
```

The telemetry layer writes to two collections in a dedicated SQLite database (separate from your main database to avoid write contention):

- **`logs`** — structured log entries from `Effect.log()`. Fields: `level`, `message`, `traceId?`, `spanId?`, `created`, `updated`.
- **`spans`** — completed Effect spans. Fields: `name`, `traceId`, `spanId`, `parentSpanId?`, `kind`, `durationMs`, `status`, `error?`, `attributes`, `created`, `updated`.

The dashboard's log/span viewer reads from these collections when `makeSqliteTelemetryLayer` is used.

---

## Schema introspection

`GET /api/_schema` returns all collection schemas registered with the server. Requires a valid `Authorization: Bearer <token>` header.

```json
{
  "collections": [
    {
      "name": "posts",
      "schema": { ... }
    }
  ]
}
```

This endpoint is the foundation for future schema codegen tooling.

---

## Client usage (browser)

```typescript
import { createMiraClient } from "@gettersethya/mira-client"
import { Posts, Users } from "./collections.js"

const mira = createMiraClient("/").withCollections({ posts: Posts, users: Users })
```

For browser clients, the server sets an HttpOnly `mira_token` cookie on successful login. The browser sends it automatically on every same-origin request — the client never reads or writes the token directly. Call `mira.auth.refresh()` once on app startup to restore login state after a page reload.

### Queries

Every query method returns a `ClientHandler<TData>` with two execution styles:

- `.raw()` — returns a `Promise<TData>`. Throws `MiraError` on failure.
- `.toEffect()` — returns an `Effect.Effect<TData, MiraError, HttpClient>` for use in Effect pipelines.

```typescript
// Paginated list — returns { items: Post[], nextCursor: number | null }
const { items, nextCursor } = await mira.posts.getList({
  filter: (f) => f.field("published").eq(true),
  sort:   "created",
  order:  "desc",
  limit:  10,
  cursor: null,          // pass nextCursor to fetch the next page
  expand: ["authorId"],  // joins the related Users record inline
  select: ["id", "title", "authorId"],  // restrict returned fields
}).raw()

// Single record by id — throws if not found
const post = await mira.posts.getOne("post-id").raw()

// First match or nothing — returns Option<Post> (never throws 404)
const latest = await mira.posts.getFirstOrNone({
  filter: (f) => f.field("published").eq(true),
  sort:   "created",
  order:  "desc",
}).raw()

// All records as a flat array — fetches all pages internally
const all = await mira.posts.getFullList({ limit: 5000 }).raw()
```

### Mutations

Mutations follow a two-call pattern: `.create()` returns a handler, then `.raw(data)` executes it. This allows the handler to be stored in TanStack mutation options without executing immediately.

```typescript
// Create a record
const post = await mira.posts.create().raw({
  title:     "Hello world",
  published: false,
})

// Create with file upload — pass a File or Blob for file fields
const post = await mira.posts.create().raw({
  title:     "With image",
  thumbnail: new File([bytes], "cover.png", { type: "image/png" }),
})

// Update (partial patch)
const updated = await mira.posts.update().raw(["post-id", { title: "Updated title" }])

// Delete
await mira.posts.delete().raw("post-id")
```

### Authentication

```typescript
// Login — server sets an HttpOnly cookie; browser sends it on every subsequent request
const { record } = await mira.users.authWithPassword().raw({
  email:    "user@example.com",
  password: "password123",
})

// On app startup (e.g. in onMount / useEffect) — restore session from persisted cookie
const loggedIn = await mira.auth.refresh()

// Check login state (synchronous — reflects last known state)
mira.auth.isLoggedIn()   // boolean

// Logout — clears the server cookie and resets the in-memory flag
mira.auth.clear()
```

### Effect-based usage

```typescript
import { Effect } from "effect"

Effect.gen(function* () {
  const { items } = yield* mira.posts.getList({ limit: 10 }).toEffect()
  const post      = yield* mira.posts.getOne("post-id").toEffect()
  const created   = yield* mira.posts.create().toEffect({ title: "New", published: false })
})
```

---

## Client usage (server-to-server)

When calling Mira from a server context (SSR, API routes, background scripts), use `{ type: "server" }`. The token is managed manually instead of being auto-stored.

```typescript
import { createMiraClient } from "@gettersethya/mira-client"
import { Posts, Users } from "./collections.js"

const mira = createMiraClient("http://localhost:3000", { type: "server" })
  .withCollections({ posts: Posts, users: Users })

// Obtain a token (e.g., service account credentials)
const { token } = await mira.users.authWithPassword().raw({
  email:    "service@example.com",
  password: "secret",
})

mira.auth.setToken(token)

// All subsequent calls include the Bearer token
const { items } = await mira.posts.getList({ limit: 100 }).raw()
```

---

## TanStack Query adapter

The TanStack adapter wraps `CollectionClient` methods in `queryOptions` and `mutationOptions` objects compatible with TanStack Query's `useQuery` and `useMutation` hooks.

```typescript
// setup.ts
import { createMiraClient } from "@gettersethya/mira-client"
import { collectionAdapter } from "@gettersethya/mira-tanstack-adapter/react"
import { Posts } from "./collections.js"

const mira     = createMiraClient("/api").withCollections({ posts: Posts })
const postsApi = collectionAdapter(mira, "posts")

export { mira, postsApi }
```

### React

```tsx
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
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
    <button onClick={() => create.mutate({ title: "New post", published: false })}>
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

The API is identical across all three adapters — only the import path changes.

### Query key structure

The adapter uses a structured three-part key format. This lets you invalidate at any granularity.

```typescript
// ["posts", "getList",        { limit, filter, sort, order, cursor, select, expand }]
// ["posts", "getOne",         "post-id"]
// ["posts", "getFirstOrNone", { filter, sort, order, select, expand }]
// ["posts", "getFullList",    { limit, filter, sort, order, select, expand }]

// Invalidate all queries for "posts"
queryClient.invalidateQueries({ queryKey: ["posts"] })

// Invalidate only list queries
queryClient.invalidateQueries({ queryKey: ["posts", "getList"] })

// Invalidate a specific record
queryClient.invalidateQueries({ queryKey: ["posts", "getOne", "post-id"] })
```

`postsApi.invalidateAll(queryClient)` is a shortcut for invalidating all queries under `["posts"]`.
`postsApi.invalidateOne(queryClient, id)` is a shortcut for invalidating `["posts", "getOne", id]`.

---

## File serving

Files are served at `/api/files/:collection/:id/:filename`.

**Public files** — no auth required. Upload and download work immediately.

**Protected files** — `Field.file({ protected: true })` requires a short-lived JWT token to download. Obtain a token from `POST /api/files/token` (requires a valid Bearer token). Tokens expire in 5 minutes.

```typescript
// Step 1: request a file access token
const res = await fetch("/api/files/token", {
  method:  "POST",
  headers: {
    Authorization:  `Bearer ${token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ collection: "posts" }),
})
const { token: fileToken, expiresAt } = await res.json()

// Step 2: pass it as a query param to download the file
const file = await fetch(`/api/files/posts/${recordId}/thumb.png?token=${fileToken}`)
```

File tokens are scoped to a single collection. A token issued for `"posts"` cannot access files from `"invoices"`.

---

## Commands

```bash
# Build all packages in dependency order (client → mira → adapter)
pnpm build

# Typecheck all packages (client must be built first)
pnpm -r typecheck

# Run all tests across all packages
pnpm -r test

# Build individual packages
pnpm --filter @gettersethya/mira-client build
pnpm --filter @gettersethya/mira build
pnpm --filter @gettersethya/mira-tanstack-adapter build
```

> Build order matters: `@gettersethya/mira-client` must be built before running typecheck or tests in `@gettersethya/mira` or `@gettersethya/mira-tanstack-adapter`.
