See how a collection definition becomes a table and a route, and what happens to one request. A Mira app is collection definitions plus rules. The server derives the schema and the HTTP surface from them.

## The six parts

| Part | What it is | Where it lives |
|---|---|---|
| Collection definition | The `BaseCollection`/`AuthCollection`/`ViewCollection` builder result | `packages/collection/src/collection/` |
| Serialized schema | JSON Schema with `x-*` annotations, stored per collection | `_collections` table, written through `packages/mira/src/migrator/` |
| Table and routes | DDL from the schema. REST handlers from the same schema | `packages/mira/src/migrator/`, `packages/mira/src/http/router.ts` |
| Rule | Per-action expression compiled to a SQL `WHERE` fragment | `packages/mira/src/rule/` |
| Collection service | Validation, rule enforcement, encoding, hidden-field stripping | `packages/mira/src/collection-service/collection-service.ts` |
| Repository | Schema-agnostic CRUD over `SqlClient` | `packages/mira/src/repository/repository.ts` |

Source paths are for contributors. App code never imports them. The [API reference](../api/) owns the package map and the contract links.

## One request

Take `GET /api/collections/posts`.

1. **Route match.** The router maps the path to the `posts` collection and the `list` action.
2. **Session.** Auth middleware reads `Authorization: Bearer` first, then the `mira_token` cookie, and resolves the session.
3. **Context.** The request becomes a `RequestCtx` with the session user, headers, query, and `admin` for a plugin-declared admin collection.
4. **Rule.** The rule compiles to a SQL `WHERE` fragment and is ANDed with the caller's filter and the cursor clause.
5. **Service.** The service validates the payload, checks credentials, encodes and decodes dialect values, and strips hidden fields.
6. **Repository.** The repository executes the statement through `SqlClient`, and the service decodes the rows.

```text
definition ──► serialized schema ──► table and routes
                                            │
                                          request
                                            ▼
                        rule ──► service ──► repository ──► SQL row
```

## What you do not write

No controllers: the router is generated from the collection set. No DTOs: the field map is the input contract and the source of validation. No migration files: auto-migration compares the stored schema with the definitions at boot, a sequence the [server page](../server/) owns. No route tables: every collection gets the same REST surface.

## Next

- [Collections](../collections/): the fields, relations, and indexes behind a table.
- [Rules](../rules/): which rows each caller may read or write.
- [HTTP API and files](../http-api/): the generated routes, status codes, and file rules.
