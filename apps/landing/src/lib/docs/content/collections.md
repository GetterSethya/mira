Declare a collection once in TypeScript and Mira derives the table, the routes, and the schema from it. The definition is the source of truth: the server serializes it to JSON Schema with `x-` annotations, and validation, rules, routes, and tables all read that serialized form.

## Collection kinds

### Base collections

`BaseCollection.define(name, fields)` returns a `BaseCollectionBuilder` for a physical table with full create, read, update, and delete support. Use it for the records your app owns. You supply only your own fields. `id` and `seqId` are rejected in the field map because the system set is injected.

```ts
import { BaseCollection, Field } from "@gettersethya/mira"

const Posts = BaseCollection.define("posts", {
  title: Field.text(),
  published: Field.boolean({ default: false }),
})
```

### Auth collections

`AuthCollection.define(name, extraFields)` adds `email`, `emailVerified`, and a hidden, write-only `password` to the schema, plus a unique index on `email`. Use one when records sign in. Only extra fields are yours, and every system field name is rejected in `extraFields`. Auth collections are base collections at runtime, so full CRUD, rules, and indexes apply. See [auth](../auth/) for the credential lifecycle.

### View collections

`ViewCollection.define(name, query, fields)` returns a read-only collection backed by a raw SQL query. Use it to expose a join or projection without duplicating rows. It has no physical table of its own and no `.indexes()`, and the migrator turns the query into a SQL `VIEW`. Writes fail with `405`, and a view collection's rule map only accepts `list` and `view`.

## Where definitions and rules live

Keep collection definitions in a module that both the server and the client import, and keep rules in a module that only the server imports. A definition carries only data (names, fields, options), so a frontend can import it to type its client calls. `defineRule` ships in `@gettersethya/mira`, which is Node-only and must never reach a browser bundle.

## Fields

`Field.*` builders return a `FieldDef`. Every builder except `Field.seqId` also exposes `.view()`, which marks a field a view query produces rather than a table column.

| Builder | Value | Kind-specific options |
|---|---|---|
| `Field.text` | string | `minLength`, `maxLength` |
| `Field.literalText` | string union | `literal` (required) |
| `Field.number` | number | `min`, `max` |
| `Field.integer` | integer | `min`, `max` |
| `Field.boolean` | boolean | `default` |
| `Field.date` | string | none. Stored as provided (not parsed as a date) |
| `Field.email` | email string | none. Format validated |
| `Field.json` | arbitrary JSON | none. Serialized by the server |
| `Field.file` | filename string | `maxSize`, `mimeTypes`, `protected` |
| `Field.relation` | target record value | `field` (defaults to `"id"`) |
| `Field.seqId` | integer | system-managed, no `.view()` |

The shared options are `name` (override the column name), `required`, `default`, `hidden`, `unique`, `indexed`, and `error` (a callback that maps a constraint kind to your own validation message).

A field is required unless `required: false` or a `default` is set. `hidden: true` keeps the field out of non-admin responses and out of `select` at the type level.

A complete definition, with a relation to `Users` from the [auth page](../auth/):

```ts
import { BaseCollection, Bytes, Field } from "@gettersethya/mira"
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

Use `Bytes.fromKB`, `fromMB`, `fromGB`, or `fromTB` for `maxSize`. They resolve to plain byte numbers. A file field stores the filename only, with the bytes in your configured storage backend. `protected: true` requires a short-lived file token when the file is served. See the [HTTP API page](../http-api/) for the file routes.

## Indexes

There are two ways to declare an index. Field-level flags are shorthand for a single-column index:

```ts
slug: Field.text({ unique: true }),
author: Field.relation(Users, { indexed: true }),
```

Collection-level indexes use the typed `I` callback, which accepts only field names that exist on the collection. The complete definition above ends with `.indexes((I) => [I.on("status"), I.unique("author", "slug")])`.

`Index.on(...fields)` makes a non-unique index and `Index.unique(...fields)` makes a unique one. Composite column order matters. The flags and the callback both end up in the same serialized index list, so `unique` and `indexed` never appear on a property. Auth collections already carry a unique index on `email`, and view collections have no indexes.

## Relations

`Field.relation(Target, { field })` stores another collection's field value, defaulting to the target's `id`. Only the target collection name and target field are serialized. The collection object itself is a compile-time phantom used to type `expand` results. Relation values are validated as strings on write, and `expand` joins the target record at read time, subject to the target's `view` rule.

```ts
author: Field.relation(Users),                    // stores users.id
ownerEmail: Field.relation(Users, { field: "email" }),
```

## System fields

Base and auth collections gain `id`, `seqId`, `created`, and `updated`. All four carry `x-generated`, so the server rejects them in create and update payloads. `seqId` is the cursor column: hidden from responses, and monotonic. View collections inherit none of them. Their values come from the query.

## What gets serialized

Serialization adds the annotations for you. You never write `x-*` keys yourself. The internal serialized schema uses these `x-*` properties:

- `x-collection-kind`: `"base"`, `"auth"`, or `"view"`.
- `x-system` and `x-generated`: server-managed fields.
- `x-hidden`: stripped from non-admin responses (auth `password`).
- `x-view-only`: a field produced by a view query rather than a physical column.
- `x-kind`: per-field discriminator such as `"json"`, `"date"`, `"file"`, `"relation"`, `"literalText"`, `"seqId"`, `"password"`.
- `x-literal`: allowed values for `literalText`.
- `x-collection` / `x-field`: relation target and target field.
- `x-maxSize` / `x-mimeTypes` / `x-protected`: file constraints.
- `x-indexes`: normalized unique and non-unique indexes. `unique` and `indexed` never appear as property flags.
- `x-view-query`: the raw SQL for a view collection.

`GET /api/_schema` is admin-gated and returns a normalized view of each collection (top-level `kind`, `fields`, `indexes`, `rules`, `viewQuery`), so do not assume the raw `x-*` names appear there unchanged. Inspect the endpoint's response instead.

## View collections

A view collection requires `id` and `seqId` in its field map, both declared with `.view()`. `define()` throws if either is missing or declared without it. List the exact columns your query returns.

```ts
import { Field, ViewCollection } from "@gettersethya/mira"

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

Because `seqId` drives cursor pagination, the query must return a monotonic integer per row. `id` must be unique. Filters, sort, select, and expand work. Create, update, and delete return `405`.

## Common mistakes

- `define()` throws about `id` and `seqId`: a view collection's field map is missing one of them, or one is declared without `.view()`.
- `unique: true` or `indexed: true` does not appear on the serialized property: both are TypeScript-only and normalize into `x-indexes`. Check the index list, not the property, to confirm an index.

## Next

- [Access rules](../rules/) to decide which callers may read or write a row.
- [Auth collections and sessions](../auth/) for the credential side of a `Users` collection.
