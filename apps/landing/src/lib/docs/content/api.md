The generated reference is built from the TypeScript source on every landing build with
[TypeDoc](https://typedoc.org). Every exported class, interface, function, type, and
variable is listed with its signature, documentation comment, and the file and line where
it is defined.

[Open the generated API reference](../../api/)

## Packages

| Package | Entry point | What it owns |
|---|---|---|
| [`@gettersethya/mira-collection`](../../api/modules/_gettersethya_mira-collection.html) | `packages/collection/src/index.ts` | Collection builders, fields, indexes, filter DSL, rule DSL, and inferred record types. Isomorphic; no server-only dependencies. |
| [`@gettersethya/mira-client`](../../api/modules/_gettersethya_mira-client.html) | `packages/client/src/index.ts` | Typed client SDK, browser/server auth helpers, file clients, and schema types. Re-exports the collection package. |
| [`@gettersethya/mira`](../../api/modules/_gettersethya_mira.html) | `packages/mira/src/index.ts` | Server library: `Mira.builder()`, platform presets, SQLite, storage, HTTP routing, auth, email, rate limits, thumbnails, and plugins. |
| [`@gettersethya/mira/bun`](../../api/modules/_gettersethya_mira.index.bun.html) | `packages/mira/src/index.bun.ts` | The Bun entry point: `BunPlatform`, `BunSqliteDatabase`, `BunPortablePlatform`, native crypto, Argon2id, and `Bun.Image` thumbnail services. |
| [`@gettersethya/mira-tanstack-adapter`](../../api/modules/_gettersethya_mira-tanstack-adapter.html) | `packages/tanstack-adapter/src/index.ts` | Framework-agnostic TanStack Query adapter. Produces plain query/mutation option objects for React, Svelte, Solid, or Vue. |
| [`@gettersethya/mira-dashboard`](../../api/modules/_gettersethya_mira-dashboard.html) | `packages/dashboard/src/index.ts` | Admin dashboard plugin: `MiraDashboard`, the superadmin collection, the registration route, and the schema-driven UI assets. |

## How a request moves

The server is a layer stack. The public API is small; the modules below it are what the
generated reference documents in detail.

1. **`Mira.builder()`** collects the platform, database, storage, email, rate-limit,
   collection, and plugin choices. The builder's phantom type enforces the required
   steps at compile time.
2. **`MiraApp.buildLayer()`** assembles the Effect layers: platform services, SQL client,
   migrator, repository, collection service, cache, hooks, rate limiter, email, and the
   HTTP server factory.
3. **The HTTP router** mounts `/api/collections/:collection`, auth routes, file routes,
   and plugin routes. Auth middleware resolves the session and annotates the request
   context.
4. **`CollectionService`** validates the payload, evaluates access rules, strips hidden
   fields, and encodes/decodes dialect-specific values such as booleans.
5. **`Repository`** executes SQL through the active `SqlClient`. The dialect owns naming,
   DDL, and boolean storage.
6. **Plugins and hooks** wrap the collection service. Pre/execute hooks are serial and
   blocking; success/error hooks are fire-and-forget daemon fibers.
7. **The client SDK** mirrors the HTTP surface with typed handlers. The TanStack adapter
   turns query handlers into `{ queryKey, queryFn }` and mutations into `{ mutationFn }`.

## Start with these exports

- **App:** `Mira`, `MiraBuilder`, `MiraApp`, `MiraPlatform`, `MiraDatabase`, `MiraStorage`
- **Collections:** `BaseCollection`, `AuthCollection`, `ViewCollection`, `Field`, `Index`
- **Querying:** `Filter`, `FilterBuilder`, `filterNodeToWhereClause`
- **Rules:** `Rule`, `defineRule`, `applyRulesToCollections`
- **Client:** `createMiraClient`, `CollectionClient`, `BrowserAuth`, `ServerAuth`
- **Adapter:** `collectionAdapter`, `createCollectionAdapter`, `withCollections`
- **Runtime:** `NodePlatform`, `SqliteDatabase`, `BunPlatform`, `BunSqliteDatabase`
- **Operations:** `SmtpEmail`, `RateLimiter`, `ThumbnailService`, `makeSqliteTelemetryLayer`

## Source and contracts

The reference is generated from `packages/*/src`. TypeDoc follows the source entry
points, so a missing export is a missing API, not a documentation gap. The hand-written
guides under `/docs` cover the decisions and trade-offs; the generated reference is the
exhaustive index of names, signatures, and comments.

The generated HTML is published alongside the docs under `/api/`. It is rebuilt with:

```bash
pnpm --filter @gettersethya/mira-landing docs:api
```

The landing build runs the same command automatically, so the reference cannot drift from
the source unless the landing build itself is skipped.
