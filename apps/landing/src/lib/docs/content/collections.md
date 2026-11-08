A collection is the schema source of truth: you declare it in TypeScript, and Mira serializes it to JSON Schema with `x-` annotations that drive validation, rules, routes, and tables. This page covers the three collection kinds, field builders and options, indexes, relations, files, system fields, and the serialized form. Auth credential fields live on the [auth page](../auth/); filtering lives on the [querying page](../querying/).

## Collection kinds

### Base collections

`BaseCollection.define(name, fields)` returns a `BaseCollectionBuilder` for a physical table with full create, read, update, and delete support. Use it for the records your app owns. You supply only your own fields; `id` and `seqId` are rejected in the field map because the system set is injected. Chain `.indexes()` to add collection-level indexes.

```ts
const Posts = BaseCollection.define("posts", {
  title: Field.text(),
  published: Field.boolean({ default: false }),
})
```

### Auth collections

`AuthCollection.define(name, extraFields)` returns an auth collection with `email` and `emailVerified` in its public field map plus a hidden, write-only `password` field in the serialized schema, and a unique index on `email`. Use one when records sign in. Only extra fields are yours, and every system field name is rejected in `extraFields`. Auth collections are base collections at runtime: full CRUD, rules, and indexes apply. See [auth](../auth/) for the credential lifecycle.

### View collections

`ViewCollection.define(name, query, fields)` returns a read-only collection backed by a raw SQL query. Use it to expose a join or projection without duplicating rows. It has no physical table of its own and no `.indexes()`. The migrator turns the query into a SQL `VIEW`, so listing a view collection reads from the query result. Writes fail with `405`, and a view collection's rule map only accepts `list` and `view`.

## Fields

`Field.*` builders return a `FieldDef`. Every builder except `Field.seqId` also exposes `.view()`.

| Builder | Value | Kind-specific options |
|---|---|---|
| `Field.text` | string | `minLength`, `maxLength` |
| `Field.literalText` | string union | `literal` (required) |
| `Field.number` | number | `min`, `max` |
| `Field.integer` | integer | `min`, `max` |
| `Field.boolean` | boolean | `default` |
| `Field.date` | string | none; stored as provided (not parsed as a date) |
| `Field.email` | email string | none; format validated |
| `Field.json` | arbitrary JSON | none; serialized by the server |
| `Field.file` | filename string | `maxSize`, `mimeTypes`, `protected` |
| `Field.relation` | target record value | `field` (defaults to `"id"`) |
| `Field.seqId` | integer | system-managed, no `.view()` |

The shared options are `name` (override the column name), `required`, `default`, `hidden`, `unique`, `indexed`, and `error` (a callback that maps a constraint kind to your own validation message). A field is required unless `required: false` or a `default` is set. `hidden: true` keeps the field out of non-admin responses and out of `select` at the type level.

A complete definition, with a relation to `Users` from the [auth page](../auth/):

```ts
import { BaseCollection, Bytes, Field } from "@gettersethya/mira-collection"
import { Users } from "./auth.js"

export const Posts = BaseCollection.define("posts", {
  title: Field.text({ minLength: 1, maxLength: 200 }),
  slug: Field.text({ unique: true }),
  status: Field.literalText({ literal: ["draft", "published"], default: "draft" }),
  body: Field.text({ required: false }),
  viewCount: Field.integer({ min: 0, default: 0 }),
  meta: Field.json({ required: false }),
  cover: Field.file({ maxSize: Bytes.fromMB(5), mimeTypes: ["image/jpeg", "image/png"] }),
  publishedAt: Field.date({ required: false }),
  author: Field.relation(Users),
}).indexes((I) => [I.on("status"), I.unique("author", "slug")])
```

Use `Bytes.fromKB`, `fromMB`, `fromGB`, or `fromTB` for `maxSize`; they resolve to plain byte numbers. A file field stores the filename only, with the bytes in your configured storage backend. `protected: true` requires a short-lived file token when the file is served; see the [HTTP API page](../http-api/) for the file routes.

## Indexes

There are two ways to declare an index. Field-level flags are shorthand for a single-column index:

```ts
slug: Field.text({ unique: true }),
author: Field.relation(Users, { indexed: true }),
```

Collection-level indexes use the typed `I` callback, which only accepts field names that exist on the collection; the example above passes `I.on("status")` and `I.unique("author", "slug")`.

`Index.on(...fields)` makes a non-unique index and `Index.unique(...fields)` makes a unique one; composite column order matters. The flags and the callback both end up in the same serialized index list. Auth collections already carry a unique index on `email`, and view collections have no indexes.

## Relations

`Field.relation(Target, { field })` stores another collection's field value, defaulting to the target's `id`. Only the target collection name and target field are serialized; the collection object itself is a compile-time phantom used to type `expand` results. Relation values are validated as strings on write, and `expand` joins the target record at read time, subject to the target's `view` rule.

```ts
author: Field.relation(Users),                    // stores users.id
ownerEmail: Field.relation(Users, { field: "email" }),
```

## System fields and serialization

Base and auth collections gain `id`, `seqId`, `created`, and `updated`; all four carry `x-generated`, so the server rejects them in create and update payloads. `seqId` is the cursor column, hidden from responses, and monotonic. View collections inherit none of them; their values come from the query.

Serialization adds the annotations for you; you never write `x-*` keys yourself. The internal serialized schema uses `x-*` properties. `GET /api/_schema` is admin-gated and returns a normalized view of each collection (top-level `kind`, `fields`, `indexes`, `rules`, `viewQuery`), so do not assume the raw `x-*` names appear there unchanged. Inspect the endpoint's response instead.

- `x-collection-kind` — `"base"`, `"auth"`, or `"view"`.
- `x-system` and `x-generated` — server-managed fields.
- `x-hidden` — stripped from non-admin responses (auth `password`).
- `x-view-only` — a field produced by a view query rather than a physical column.
- `x-kind` — per-field discriminator such as `"json"`, `"date"`, `"file"`, `"relation"`, `"literalText"`, `"seqId"`, `"password"`.
- `x-literal` — allowed values for `literalText`.
- `x-collection` / `x-field` — relation target and target field.
- `x-maxSize` / `x-mimeTypes` / `x-protected` — file constraints.
- `x-indexes` — normalized unique and non-unique indexes; `unique` and `indexed` never appear as property flags.
- `x-view-query` — the raw SQL for a view collection.

## View collections in full

A view collection requires `id` and `seqId` in its field map, both declared with `.view()`; `define()` throws if either is missing or declared without it. List the exact columns your query returns.

```ts
import { Field, ViewCollection } from "@gettersethya/mira-collection"

const PublishedPosts = ViewCollection.define(
  "published_posts",
  `SELECT p.id AS id, p.seqId AS seqId, p.title AS title, p.publishedAt AS publishedAt
   FROM posts p
   WHERE p.status = 'published'`,
  {
    id: Field.text().view(),
    seqId: Field.integer().view(),
    title: Field.text().view(),
    publishedAt: Field.date().view(),
  },
)
```

Because `seqId` drives cursor pagination, the query must return a monotonic integer per row. `id` must be unique. Filters, sort, select, and expand work; create, update, and delete return `405`.

## Next steps

- [Auth collections and sessions](../auth/) for users, passwords, and sessions.
- [Querying and pagination](../querying/) for filters, sort, select, and expand.
- [Access rules](../rules/) to gate `list`, `view`, and the write actions.
