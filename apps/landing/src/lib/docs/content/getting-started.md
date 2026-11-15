This page takes you from an empty directory to a running Mira server that answers three `curl` commands. It is the only page you need for a first result; every other page builds on what you create here.

## Before you start

You need Node 20 or newer (or Bun 1.3.14 or newer), plus `pnpm`, in an empty directory. When you split code into your own modules, relative imports end in `.js` even though the file on disk is `.ts`; ESM resolution requires the extension, and `tsx` maps it back to the source.

## Where this path goes

- [Run it — getting-started](../getting-started/) — a server, three curls, and one row.
- [Shape data — collections](../collections/) — a table with typed fields and indexes.
- [Decide access — rules](../rules/) — who can read or write each row.
- [Consume it — client-sdk](../client-sdk/) — typed calls from a frontend.

`auth`, `querying`, and the remaining pages branch off these four.

## 1. Install

```install
pnpm init
pnpm pkg set type=module
pnpm add @gettersethya/mira effect@4.0.0
pnpm add -D tsx
```

`@gettersethya/mira` pulls the client and collection packages with it, so one install covers the server. `effect` is a peer dependency in the `~4.0.0` range for this alpha, so install `effect@4.0.0` explicitly.

## 2. Write one file

Save this as `server.ts`. It is the whole app.

```ts
import {
  BaseCollection,
  Field,
  defineRule,
  LocalFileStorage,
  Mira,
  NodePlatform,
  SqliteDatabase
} from "@gettersethya/mira"

const Posts = BaseCollection.define("posts", {
  title: Field.text({ required: true }),
  published: Field.boolean({ default: false })
})

// Rules are server-only. Collections shows the two-module split.
const postsRules = defineRule(Posts, (R) => ({
  list: R.public(),
  view: R.public(),
  create: R.public()
}))

Mira.builder()
  .platform(NodePlatform)
  .database(SqliteDatabase({ filename: "mira.db" }))
  .storage(LocalFileStorage({ directory: "./uploads" }))
  .collections([Posts])
  .rules([postsRules])
  .build()
  .serve()
```

`BaseCollection.define()` adds `id`, `seqId`, `created`, and `updated`, so the field map lists only your own fields. The three rules open reads and creates; `update` and `delete` have no entry, so a caller cannot reach them.

## 3. Run it

```bash
pnpm tsx server.ts
```

The process stays on port `8080`, the `_config` default, and prints no URL when the bind succeeds. If the port is already taken, a warning names the fallback port it moved to instead. `serve()` blocks, so run the commands below in a second terminal.

## 4. Create and read a post

List the collection before it holds anything:

```bash
curl http://localhost:8080/api/collections/posts
```

You should see `{"items":[],"nextCursor":null}`. The `list` rule answered with an empty page instead of `403`.

Create a post:

```bash
curl -X POST http://localhost:8080/api/collections/posts \
  -H "content-type: application/json" \
  -d '{"title":"Hello"}'
```

You should see the post you sent plus the server-managed `id`, `created`, and `updated`. The create response echoes what it wrote and does not re-read the row, so the `published` default shows up on the next read.

List again:

```bash
curl http://localhost:8080/api/collections/posts
```

You should see one item in `items`: `title` `"Hello"`, `published` `false`, and the same `id`, `created`, and `updated`. Pass `nextCursor` as `?after=` to fetch the next page; the item itself carries no cursor field.

## What Mira just did

- `BaseCollection.define()` produced a **collection definition**: plain data describing the fields, not a class you extend.
- The definition already carried its JSON Schema; boot recorded that `x-*`-annotated schema in `_collections`.
- The migrator created the `posts` table, and the router mounted `/api/collections/posts`, both from the same schema.
- `postsRules` gave three actions a rule; the `list` rule compiled to a SQL `WHERE` fragment.
- The collection service validated each body, enforced the rule, and stripped fields the caller may not see.
- The repository ran the statements through the active `SqlClient`.

[How Mira works](../how-mira-works/) traces one request through all six parts in order.

## Common mistakes

- **`403` on `GET`.** The collection has no `list` rule. A missing rule denies the action, so add one before you retry.
- **Connection refused on `8080`.** Nothing is listening there. The busy-port warning names the port the server bound instead; retry against that port, since the configured value in `_config` stays as it was.
- **`Cannot find module` on a `.ts` import.** A relative import is missing its `.js` extension. Write `./posts.js` even when the file on disk is `posts.ts`.

## Next

- [How Mira works](../how-mira-works/) — the six parts and what one request does with them.
- [Collections](../collections/) — fields, relations, indexes, auth collections, and view collections.
- [Access rules](../rules/) — replace the public rules with owner checks and see the evaluation order.
