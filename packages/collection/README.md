# @gettersethya/mira-collection

[![npm](https://img.shields.io/npm/v/@gettersethya/mira-collection)](https://www.npmjs.com/package/@gettersethya/mira-collection)

> **Early pre-alpha.** Breaking changes may occur without notice.

Collection definitions, filter DSL, and access rule builder for [Mira](https://github.com/gettersethya/mira). Shared between server and client — isomorphic, no runtime dependencies beyond `effect`.

## Installation

```bash
npm install @gettersethya/mira-collection effect
# or
pnpm add @gettersethya/mira-collection effect
```

## Collection types

### Base collection

Standard CRUD collection. System fields `id`, `seqId`, `created`, and `updated` are added automatically.

```typescript
import { BaseCollection, Bytes, Field, Rule } from "@gettersethya/mira-collection"

const Posts = BaseCollection.define("posts", {
  title:     Field.text({ maxLength: 200 }),
  slug:      Field.text({ unique: true }),
  content:   Field.text(),
  published: Field.boolean({ default: false }),
  authorId:  Field.relation(Users),
  thumbnail: Field.file({ maxSize: Bytes.fromMB(5), mimeTypes: ["image/*"] }),
})
.indexes((I) => [
  I.on("authorId"),
  I.unique("slug"),
])
.rules((R) => ({
  list:   R.field("published").eq(R.literal(true)),
  view:   Rule.or(R.field("published").eq(R.literal(true)), R.field("authorId").eq(R.authId(Users))),
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
  role:        Field.text({ default: "user" }),
})
.rules((R) => ({
  list:   Rule.public(),
  view:   Rule.public(),
  create: Rule.public(),
  update: R.selfId().eq(R.authId(Users)),  // users can only edit themselves
}))
```

### View collection

Read-only, backed by a SQL `VIEW`. Supports `list` and `view` only. Every field must be marked `.view()`.

```typescript
import { Field, Rule, ViewCollection } from "@gettersethya/mira-collection"

const PostsWithAuthors = ViewCollection.define(
  "posts_with_authors",
  `SELECT p.id, p.seqId, p.title, u.displayName AS authorName
   FROM posts p LEFT JOIN users u ON p.authorId = u.id`,
  {
    id:         Field.text().view(),
    seqId:      Field.integer().view(),
    title:      Field.text().view(),
    authorName: Field.text().view(),
  }
)
.rules((R) => ({ list: Rule.public(), view: Rule.public() }))
```

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

// File size helpers
Bytes.fromKB(n)
Bytes.fromMB(n)
Bytes.fromGB(n)
```

## Indexes

```typescript
// Field-level (single column)
Field.text({ unique: true })   // unique index
Field.text({ indexed: true })  // non-unique index

// Callback (composite or explicit)
.indexes((I) => [
  I.on("authorId"),                 // non-unique
  I.on("authorId", "published"),    // composite
  I.unique("slug"),                 // unique constraint
  I.unique("teamId", "userId"),     // composite unique
])
```

## Rules

Rules are evaluated server-side on every request. A missing key means **deny all** for that action.

```typescript
Rule.public()                                        // allow all
R.authId(Users).neq(R.literal(null))                // logged-in users only
R.field("ownerId").eq(R.authId(Users))              // owner-only
R.field("role").in(R.literal(["admin", "mod"]))     // role check
R.auth(Users, "role").eq(R.literal("admin"))        // check a field on the auth record
Rule.not(R.field("archived").eq(R.literal(true)))   // negation
Rule.or(R.field("isPublic").eq(R.literal(true)), R.field("ownerId").eq(R.authId(Users)))
Rule.and(R.field("published").eq(R.literal(true)), R.field("ownerId").eq(R.authId(Users)))

// Date arithmetic
R.field("created").gte(Rule.dateAdd(Rule.now(), -30, "day"))

// Request values (header, query param, or body field)
Rule.request("header", "x-api-key").eq(R.literal("secret"))

// Subquery membership check
Rule.subquery(Members, "teamId").where(R.field("userId").eq(R.authId(Users)))
```

## Filters

Used in client queries. Type-checked against the collection's field types.

```typescript
f.field("published").eq(true)
f.field("viewCount").gte(100)
f.field("status").in(["draft", "published"])
f.field("title").like("%effect%")
f.field("deletedAt").null()
f.field("price").between(10, 100)

f.and(f.field("published").eq(true), f.field("viewCount").gte(100))
f.or(f.field("category").eq("tech"), f.field("category").eq("science"))
f.not(f.field("archived").eq(true))
```

## More

See the [Mira root README](https://github.com/gettersethya/mira) for full documentation.
