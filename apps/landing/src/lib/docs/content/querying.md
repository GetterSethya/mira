Ask a list route for exactly the rows you want, and walk a whole collection without skipping one. Every list route shares one query model (a filter expression, one sort field, a field projection, optional relation expansion, and cursor pagination) and always answers with `{ items, nextCursor }`.

## Filters

`Filter` builds `FilterNode` values. Inside a client callback you get a `FilterBuilder<F>` with the same methods, narrowed to the collection's field names and each field's value type.

```ts
import { Filter } from "@gettersethya/mira"

Filter.field("status").eq("published")
Filter.field("viewCount").gte(100)
Filter.field("viewCount").between(10, 100)
Filter.field("status").in(["draft", "review"])
Filter.field("title").like("%effect%")
Filter.field("deletedAt").null()
Filter.field("deletedAt").notNull()

Filter.and(
  Filter.field("status").eq("published"),
  Filter.or(
    Filter.field("viewCount").gte(100),
    Filter.not(Filter.field("title").like("%draft%"))
  )
)
```

The comparison surface is `.eq`, `.neq`, `.gt`, `.gte`, `.lt`, `.lte`, `.in`, `.like`, `.null`, `.notNull`, and `.between`. `.between(lo, hi)` is sugar for `.gte(lo)` and `.lte(hi)`. There is no `contains` or `startsWith` helper here: `.like` passes your pattern through untouched, so add the `%` wildcards yourself.

Comparison values must be a string, a number, or `null`. Boolean values are rejected by the filter compiler. An empty `.in([])` list compiles to `1 = 0` and matches nothing. Unknown fields fail with 422. The same applies to fields marked hidden, unless the caller is an admin.

## Raw JSON shape

The `filter` query parameter is one JSON-encoded `FilterNode`:

- comparison: `{ "op": "eq", "field": "status", "value": "published" }`: `op` is `eq`, `neq`, `gt`, `gte`, `lt`, or `lte`
- membership: `{ "op": "in", "field": "status", "values": ["draft", "review"] }`
- pattern: `{ "op": "like", "field": "title", "value": "%effect%" }`
- null check: `{ "op": "null", "field": "deletedAt" }` or `{ "op": "not_null", "field": "deletedAt" }`
- combinator: `{ "op": "and", "left": <node>, "right": <node> }`: same for `or`
- negation: `{ "op": "not", "node": <node> }`

A nested example:

```json
{
  "op": "and",
  "left": { "op": "eq", "field": "status", "value": "published" },
  "right": { "op": "like", "field": "title", "value": "%effect%" }
}
```

If the JSON does not decode to a valid node the request fails with 422, so build the string with a JSON encoder rather than string concatenation.

## Query parameters

| Parameter | Shape | Notes |
| --- | --- | --- |
| `filter` | JSON `FilterNode` | ANDed with the collection's `list` rule |
| `sort` | one field name | unknown names are ignored and the default order stays |
| `order` | `asc` or `desc` | defaults to `asc`. Only applies when `sort` is set |
| `select` | comma-separated field names | allowlist. Unknown or hidden names are dropped |
| `expand` | comma-separated relation names | one `LEFT JOIN` per relation |
| `after` | non-negative safe integer or canonical decimal string | the opaque `seqId` cursor from the previous page |
| `limit` | integer | defaults to 30, clamped to 100 |

Sorting uses the collection schema as an allowlist. A non-admin caller cannot sort by a hidden field (that request is a 422), while an unknown field name is silently ignored and the list keeps its default order. `select` is also an allowlist. For base and auth collections, `id`, `created`, and `updated` are returned whether or not you name them. View collections only return the columns their query exposes. Hidden fields are never selected for ordinary callers.

`expand` fills in related records that a plain join would leave as bare ids. The related row arrives under `expand.<field>`, and a relation that does not resolve is absent. A left-join miss and a denied read look the same. For non-admin callers the target collection's `view` rule is applied to the join, so expanding a record you cannot read yields nothing rather than a leak.

Expansion joins the target's `id` column. A relation declared with a different target field, such as `Field.relation(Users, { field: "email" })`, stores and validates that value but is not expanded by the current join. Use the related record's `id` when you need `expand`.

## Cursor pagination

`after` is a cursor, not an offset: pass the opaque value from the previous `nextCursor`. The default order is `seqId` ascending. Sorted pagination is also supported: the server resolves the cursor row's sort value and continues with a `(sortField, seqId)` keyset, using `seqId` as a stable tie-breaker. The sort field must be non-nullable. A sorted request that uses `after` on a nullable field returns `422 validation_failed` rather than silently skipping rows. If the cursor row has been deleted, the server also returns `422` so you can restart from the first page. `nextCursor` is the last returned row's `seqId` when another page exists, and `null` when it does not. A final page with exactly `limit` rows returns `null`. Keep requesting until `nextCursor` is `null`.

The cursor is opaque. The shipped SQLite and libSQL presets return a JavaScript number. PostgreSQL returns a decimal string when `seqId` is a `BIGINT`, because a JSON number cannot represent every 64-bit value exactly. Pass the value back unchanged; do not convert a string cursor to a number.

```json
{
  "items": [
    { "id": "p_1", "title": "Hello", "status": "published", "created": "…", "updated": "…" }
  ],
  "nextCursor": 42
}
```

`nextCursor` is a number in this SQLite example. A PostgreSQL response can use a decimal string such as `"9007199254740993"`.

For ordinary list callers, `seqId` is not part of the response payload. Admin contexts and some write responses can expose it. The next request is `?after=42&limit=10`.

## Worked client query

The client SDK is a separate install for browser code:

```install
pnpm add @gettersethya/mira-client
```

```ts
import { createMiraClient } from "@gettersethya/mira-client"
import { Posts } from "./collections.js"

const mira = createMiraClient("http://localhost:8080").withCollections({ posts: Posts })

const { items, nextCursor } = await mira.posts
  .getList({
    filter: (f) =>
      f.and(
        f.field("status").eq("published"),
        f.field("title").like("%effect%")
      ),
    limit: 10,
    select: ["title", "status"],
    expand: ["author"]
  })
  .raw()
```

This query keeps the default `seqId` order, so following `nextCursor` visits every row once.

The client serializes the filter callback to the same JSON node shown above and maps `cursor` to `after`. A typed callback rejects unknown field names and mismatched value types at compile time. To fetch the next page, call `getList({ cursor: nextCursor, limit: 10 }).raw()`.

## Raw HTTP

```bash
# Obtain $TOKEN from the login route; see ../auth/.
curl -G "http://localhost:8080/api/collections/posts" \
  -H "Authorization: Bearer $TOKEN" \
  --data-urlencode 'filter={"op":"and","left":{"op":"eq","field":"status","value":"published"},"right":{"op":"like","field":"title","value":"%effect%"}}' \
  --data-urlencode 'sort=created' \
  --data-urlencode 'order=desc' \
  --data-urlencode 'select=title,status' \
  --data-urlencode 'expand=author' \
  --data-urlencode 'limit=10'
```

The response is the `{ items, nextCursor }` envelope. `--data-urlencode` matters: the filter is JSON and must be percent-encoded, and an unencoded brace or quote in the query string will break the request before it reaches the parser.

## Authorization and caching

Filters never widen access. A collection's `list` rule is ANDed with your filter, so records you are not allowed to see are omitted from the page. A `view` of such a record is a 404, not a 403. See [rules](../rules/). Hidden fields are stripped from responses and refused in `filter` and `sort` for non-admin callers.

List and record reads pass through an in-memory cache: list entries live 10 seconds and record entries 30 seconds by default, and every key is suffixed with exactly the auth, query, header, and body values the compiled rule references. Two callers with different authorization therefore cannot share a cached page. Writes nuke the collection's list entries and invalidate the affected record. Reads that request `expand` bypass the cache entirely.

## Next

- [Client SDK and TanStack](../client-sdk/) for handlers, `getFirstOrNone`, `getFullList`, and the Effect path.
- [HTTP API and files](../http-api/) for parameter parsing, encoding details, and the full status-code mapping.
