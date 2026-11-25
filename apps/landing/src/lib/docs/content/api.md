The generated API reference lists every public symbol in every Mira package with its signature, documentation comment, and source location. Use it when a guide names an export and you need the exact type.

[Open the generated API reference](../../api/)

## Packages

| Package | Entry point | What it owns |
|---|---|---|
| [`@gettersethya/mira-collection`](../../api/modules/_gettersethya_mira-collection.html) | `packages/collection/src/index.ts` | Collection builders, fields, indexes, filter DSL, rule DSL, and inferred record types. Isomorphic. No server-only dependencies. |
| [`@gettersethya/mira-client`](../../api/modules/_gettersethya_mira-client.html) | `packages/client/src/index.ts` | Typed client SDK, browser/server auth helpers, file clients, and schema types. Re-exports the collection package. |
| [`@gettersethya/mira`](../../api/modules/_gettersethya_mira.html) | `packages/mira/src/index.ts` | Server library: `Mira.builder()`, platform presets, SQLite, libSQL, PostgreSQL, storage, HTTP routing, auth, email, rate limits, thumbnails, and plugins. |
| [`@gettersethya/mira/bun`](../../api/modules/_gettersethya_mira.index.bun.html) | `packages/mira/src/index.bun.ts` | The Bun entry point: `BunPlatform`, `BunSqliteDatabase`, `PostgresDatabase`, `BunPortablePlatform`, native crypto, Argon2id, and `Bun.Image` thumbnail services. |
| [`@gettersethya/mira-tanstack-adapter`](../../api/modules/_gettersethya_mira-tanstack-adapter.html) | `packages/tanstack-adapter/src/index.ts` | Framework-agnostic TanStack Query adapter. Produces plain query/mutation option objects for React, Svelte, Solid, or Vue. |
| [`@gettersethya/mira-dashboard`](../../api/modules/_gettersethya_mira-dashboard.html) | `packages/dashboard/src/index.ts` | Admin dashboard plugin: `MiraDashboard`, the superadmin collection, the registration route, and the schema-driven UI assets. |

To see how one request travels from a collection definition through rules and the collection service to SQL, read [How Mira works](../how-mira-works/).

## Start with these exports

- **App:** `Mira`, `MiraBuilder`, `MiraApp`, `MiraPlatform`, `MiraDatabase`, `MiraStorage`
- **Collections:** `BaseCollection`, `AuthCollection`, `ViewCollection`, `Field`, `Index`
- **Querying:** `Filter`, `FilterBuilder`, `filterNodeToWhereClause`
- **Rules:** `Rule`, `defineRule`, `applyRulesToCollections`
- **Client:** `createMiraClient`, `CollectionClient`, `BrowserAuth`, `ServerAuth`
- **Adapter:** `collectionAdapter`, `createCollectionAdapter`, `withCollections`
- **Runtime:** `NodePlatform`, `SqliteDatabase`, `LibsqlDatabase`, `PostgresDatabase`, `BunPlatform`, `BunSqliteDatabase`
- **Operations:** `SmtpEmail`, `RateLimiter`, `ThumbnailService`, `makeTelemetryLayer`

## Source and contracts

The reference is generated from `packages/*/src`. TypeDoc follows the source entry points, so a missing export is a missing API, not a documentation gap. The hand-written guides under `/docs` cover the decisions and trade-offs. The generated reference is the exhaustive index of names, signatures, and comments.

The generated HTML is published alongside the docs under `/api/`. It is rebuilt with:

```bash
pnpm --filter @gettersethya/mira-landing docs:api
```

The landing build runs the same command automatically, so the reference cannot drift from the source unless the landing build itself is skipped.

## Next

Start with [Getting started](../getting-started/) for a working app, or use [HTTP API and files](../http-api/) to find the route behind an export.
