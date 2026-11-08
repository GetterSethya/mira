Every list route in Mira shares one query model: a filter expression, one sort field, a field projection, optional relation expansion, and cursor pagination. The typed client and raw HTTP speak the same parameters — the client renames `after` to `cursor` — and a list always answers with `{ items, nextCursor }`. There is no offset pagination and no `COUNT(*)`: a page is a window over the collection's internal `seqId` sequence.

## Filters

`Filter` builds `FilterNode` values. Inside a client callback you get a `FilterBuilder<F>` with the same methods, narrowed to the collection's field names and each field's value type.

```ts
import { Filter } from "@gettersethya/mira-client"

Filter.field("status").eq("published")
Filter.field("views").gte(100)
Filter.field("views").between(10, 100)
Filter.field("status").in(["draft", "review"])
Filter.field("title").like("%effect%")
Filter.field("deletedAt").null()
Filter.field("deletedAt").notNull()

Filter.and(
  Filter.field("status").eq("published"),
  Filter.or(
    Filter.field("views").gte(100),
    Filter.not(Filter.field("title").like("%draft%"))
  )
)
```

The comparison surface is `.eq`, `.neq`, `.gt`, `.gte`, `.lt`, `.lte`, `.in`, `.like`, `.null`, `.notNull`, and `.between`. `.between(lo, hi)` is sugar for `.gte(lo)` and `.lte(hi)`. There is no `contains` or `startsWith` helper here: `.like` passes your pattern through untouched, so add the `%` wildcards yourself.

Comparison values must be a string, a number, or `null`; boolean values are rejected by the filter compiler. An empty `.in([])` list compiles to `1 = 0` and matches nothing. Unknown fields — and fields marked hidden, unless the caller is an admin — fail with 422.

### Raw JSON shape

The `filter` query parameter is one JSON-encoded `FilterNode`:

- comparison: `{ "op": "eq", "field": "status", "value": "published" }` — `op` is `eq`, `neq`, `gt`, `gte`, `lt`, or `lte`
- membership: `{ "op": "in", "field": "status", "values": ["draft", "review"] }`
- pattern: `{ "op": "like", "field": "title", "value": "%effect%" }`
- null check: `{ "op": "null", "field": "deletedAt" }` or `{ "op": "not_null", "field": "deletedAt" }`
- combinator: `{ "op": "and", "left": <node>, "right": <node> }` — same for `or`
- negation: `{ "op": "not", "node": <node> }`

A nested example:

```json
{
  "op": "and",
  "left": { "op": "eq", "field": "status", "value": "published" },
  "right": { "op": "gte", "field": "views", "value": 100 }
}
```

If the JSON does not decode to a valid node the request fails with 422, so build the string with a JSON encoder rather than string concatenation.

## Query parameters

| Parameter | Shape | Notes |
| --- | --- | --- |
| `filter` | JSON `FilterNode` | ANDed with the collection's `list` rule |
| `sort` | one field name | unknown names are ignored and the default order stays |
| `order` | `asc` or `desc` | defaults to `asc`; only applies when `sort` is set |
| `select` | comma-separated field names | allowlist; unknown or hidden names are dropped |
| `expand` | comma-separated relation names | one `LEFT JOIN` per relation |
| `after` | non-negative integer | the `seqId` cursor from the previous page |
| `limit` | integer | defaults to 30, clamped to 100 |

Sorting uses the collection schema as an allowlist. A non-admin caller cannot sort by a hidden field — that request is a 422 — while an unknown field name is silently ignored and the list keeps its default order. `select` is also an allowlist; for base and auth collections, `id`, `created`, and `updated` are returned whether or not you name them. View collections only return the columns their query exposes. Hidden fields are never selected for ordinary callers.

`expand` fills in related records that a plain join would leave as bare ids. The related row arrives under `expand.<field>`, and a relation that does not resolve is simply absent — a left-join miss and a denied read look the same. For non-admin callers the target collection's `view` rule is applied to the join, so expanding a record you cannot read yields nothing rather than a leak.

Expansion joins the target's `id` column. A relation declared with a different target field, such as `Field.relation(Users, { field: "email" })`, stores and validates that value but is not expanded by the current join; use the related record's `id` when you need `expand`.

## Cursor pagination

`after` is a cursor, not an offset: pass the `seqId` of the last row you received, and the next query returns rows with a greater `seqId`. The default order is `seqId` ascending, which is exactly what makes the window monotonic; sorting by another field while paginating can skip or repeat rows, so walk in `seqId` order when you need a complete pass. `nextCursor` is the last row's `seqId` when the page is full, and `null` when it is not. A full page can still be the end of the data, so keep requesting until `nextCursor` is `null` and treat a final empty page as normal.

```json
{
  "items": [
    { "id": "p_1", "title": "Hello", "status": "published", "created": "…", "updated": "…" }
  ],
  "nextCursor": 42
}
```

For ordinary list callers, `seqId` is not part of the response payload; admin contexts and some write responses can expose it. The next request is `?after=42&limit=10`.

## Worked client query

```ts
import { createMiraClient } from "@gettersethya/mira-client"
import { Posts } from "./collections.js"

const mira = createMiraClient("http://localhost:3000").withCollections({ posts: Posts })

const { items, nextCursor } = await mira.posts
  .getList({
    filter: (f) =>
      f.and(
        f.field("status").eq("published"),
        f.field("views").gte(100)
      ),
    limit: 10,
    select: ["title", "views"],
    expand: ["author"]
  })
  .raw()
```

This example deliberately uses the default `seqId` order so the cursor walk stays complete. If you add `sort`, do it for a one-shot read rather than while paging; sorting by another field while using `after` can skip or repeat rows.

The client serializes the filter callback to the same JSON node shown above and maps `cursor` to `after`. A typed callback rejects unknown field names and mismatched value types at compile time. To fetch the next page, call `getList({ cursor: nextCursor, limit: 10 }).raw()`.

## Raw HTTP

```bash
# Obtain $TOKEN from the login route; see ../auth/.
curl -G "http://localhost:3000/api/collections/posts" \
  -H "Authorization: Bearer $TOKEN" \
  --data-urlencode 'filter={"op":"and","left":{"op":"eq","field":"status","value":"published"},"right":{"op":"gte","field":"views","value":100}}' \
  --data-urlencode 'sort=created' \
  --data-urlencode 'order=desc' \
  --data-urlencode 'select=title,views' \
  --data-urlencode 'expand=author' \
  --data-urlencode 'limit=10'
```

The response is the `{ items, nextCursor }` envelope. `--data-urlencode` matters: the filter is JSON and must be percent-encoded, and an unencoded brace or quote in the query string will break the request before it reaches the parser.

## Authorization and caching

Filters never widen access. A collection's `list` rule is ANDed with your filter, so records you are not allowed to see are omitted from the page; a `view` of such a record is a 404, not a 403 — see [rules](../rules/). Hidden fields are stripped from responses and refused in `filter` and `sort` for non-admin callers.

List and record reads pass through an in-memory cache: list entries live 10 seconds and record entries 30 seconds by default, and every key is suffixed with exactly the auth, query, header, and body values the compiled rule references. Two callers with different authorization therefore cannot share a cached page. Writes nuke the collection's list entries and invalidate the affected record; reads that request `expand` bypass the cache entirely.

## Where next

Handlers, `getFirstOrNone`, `getFullList`, and the Effect path are covered in [client-sdk](../client-sdk/). Parameter parsing, encoding details, and the full status-code mapping live in [http-api](../http-api/).
