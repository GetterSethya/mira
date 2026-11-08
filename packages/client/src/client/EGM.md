# Client SDK Implementation (`packages/client/src/client`)

## Overview

This directory is the runtime core of `@gettersethya/mira-client`: an isomorphic (browser and Node/SSR) typed SDK for a Mira server. It exposes one collection client per collection definition, a factory that wires authentication plus HTTP execution, file-field URL helpers, a telemetry client, and the structural types adapters (for example `@gettersethya/mira-tanstack-adapter`) use to enrich handlers with query/mutation metadata.

Every operation is a `ClientHandler`: the data payload lives at the call site for mutations and the terminal call is either Promise-based (`raw`) or Effect-based (`toEffect`). HTTP work is performed through an injected `ExecuteFn`, so the same collection code runs against `FetchHttpClient` in `.raw()` or a caller-supplied `HttpClient` via `.toEffect()`.

## Interface

### Errors

- `MiraError` — `Data.TaggedError("MiraError")` carrying `status: number` and `body: unknown`; thrown by `.raw()` and present in the Effect error channel. [errors.ts:MiraError]

### Handlers

- `ClientHandler<TData, TInput = void>` (type) — conditional handler shape: `TInput extends void` gives zero-argument `raw()`/`toEffect()`, otherwise `raw(input)`/`toEffect(input)`. [handler.ts:ClientHandler]
- `ExecuteFn` (type) — `<T>(req: HttpClientRequest) => Effect<T, MiraError, HttpClient>` request executor threaded through every client. [handler.ts:ExecuteFn]
- `makeClientHandler` — builds a query handler; `.raw()` provides `FetchHttpClient.layer`, `.toEffect()` leaves the `HttpClient` requirement to the caller. [handler.ts:makeClientHandler]
- `makeMutationHandler` — builds a mutation handler from `(input) => Effect`, applying the same raw/effect split. [handler.ts:makeMutationHandler]

### Collection client

- `RetryOptions` (type) — optional `{ schedule?: Schedule<unknown, MiraError, never> }`. [collection.ts:RetryOptions]
- `GetListOptions<F>` (type) — filter callback, sort/order, cursor, limit, select, expand, retry options. [collection.ts:GetListOptions]
- `GetOneOptions<F>` (type) — select, expand, retry options for single-record reads. [collection.ts:GetOneOptions]
- `FilterBuilder<F>` (type) — typed `field`/`and`/`or`/`not` builder used by filter callbacks. [collection.ts:FilterBuilder]
- `RawCollectionClient<F, K>` (type) — the full collection surface: `getList`, `getFirstOrNone`, `getFullList`, `getOne`, `create`, `update`, `delete`, optional auth methods, and `fields`. [collection.ts:RawCollectionClient]
- `CollectionClient<F, K>` (type) — `RawCollectionClient<F, K> & AuthByKind<F>[K]`, so auth methods are required only when `K = "auth"`. [collection.ts:CollectionClient]
- `AuthByKind<F>` (type) — per-kind lookup map guaranteeing `authWithPassword`, `register`, and `me` for auth collections and nothing extra for base/view collections. [collection.ts:AuthByKind]
- `AdaptedAuthByKind<F>` (type) — the same per-kind map after adapter enrichment (enriched mutation/query handlers). [collection.ts:AdaptedAuthByKind]
- `QueryKey` (type) — `ReadonlyArray<unknown>` used as the framework query key. [collection.ts:QueryKey]
- `AdaptedQueryOptions<T>` (type) — structural `{ queryKey, queryFn }` object independent of any TanStack runtime. [collection.ts:AdaptedQueryOptions]
- `AdaptedMutationOptions<TData, TInput>` (type) — structural `{ mutationFn }` object. [collection.ts:AdaptedMutationOptions]
- `AdaptedCollectionClient<F, K>` (type) — `AdaptedCommon<F, K> & AdaptedAuthByKind<F>[K]`; the accessor shape returned by `withCollections(map, { adapter })`. [collection.ts:AdaptedCollectionClient]
- `AdaptedCommon<F, K>` (type) — kind-independent adapted members, including `invalidateAll`/`invalidateOne` query-cache helpers. [collection.ts:AdaptedCommon]
- `makeCollectionClient` — internal factory that builds a `RawCollectionClient` from a collection definition, `ExecuteFn`, base URL, and mutable auth/file-token refs. [collection.ts:makeCollectionClient]

The adapter-enriched handler shapes are the non-exported `EnrichedQueryHandler` and `EnrichedMutationHandler`: a handler plus `{ queryKey, queryOptions }` or `{ mutationOptions }`. [collection.ts:EnrichedQueryHandler] [collection.ts:EnrichedMutationHandler]

### Factory

- `createMiraClient` — overloaded factory: default/browser mode returns a client with `BrowserAuth`, `{ type: "server" }` returns one with `ServerAuth`. The returned client exposes `collection(def)`, `auth`, `telemetry`, and `withCollections(map, opts?)`. [factory.ts:createMiraClient]

The returned surface is described by the non-exported `BaseClient` type; `withCollections` has an adapter overload returning `AdaptedAccessors<M>` and a plain overload returning `CollectionAccessors<M>`. [factory.ts:BaseClient] [factory.ts:withCollections]

### File fields

- `buildFileUrl` — builds `{baseUrl}/api/files/{collection}/{id}/{filename}` and appends `token`/`thumb` only when provided. [file.ts:buildFileUrl]
- `PublicFileFieldClient` (type) — synchronous `url(id, filename, { thumb? })` with `isProtected: false`. [file.ts:PublicFileFieldClient]
- `ProtectedFileFieldClient` (type) — `url` with an explicit token, `asyncUrl` that acquires a token, and `getToken`, with `isProtected: true`. [file.ts:ProtectedFileFieldClient]
- `makeFileFields` — module export (not in the barrel) that maps every `x-kind: "file"` schema property to a public or protected file client. [file.ts:makeFileFields]
- `makeGetFileToken` — module export (not in the barrel) implementing the per-collection file-token cache. [file.ts:makeGetFileToken]

### Authentication

- `BrowserAuth` (type) — `isLoggedIn`, `refresh`, `ensureSession`, `clear`; cookie-based session state. [auth.ts:BrowserAuth]
- `ServerAuth` (type) — `token` getter/setter, `clear`, `isValid`; manual bearer-token state. [auth.ts:ServerAuth]
- `makeBrowserAuth` — module export (not in the barrel) constructing the browser auth helper around refs and a shared session memo. [auth.ts:makeBrowserAuth]
- `makeServerAuth` — module export (not in the barrel) constructing the server auth helper around the token and file-token refs. [auth.ts:makeServerAuth]

### Shared types

- `CollectionFileFields<F>` (type) — maps `file`-kind fields to `ProtectedFileFieldClient` when the field is protected, otherwise `PublicFileFieldClient`. [types.ts:CollectionFileFields]

This module also re-exports the collection DSL types (`InferRecord`, `CreateInput`, `UpdateInput`, `InferMutationInput`, `RegisterInput`, `WithSelect`, `WithExpand`, `SelectableKeys`, and related names) from `@gettersethya/mira-collection`; they are re-exports, not local definitions. [types.ts:@gettersethya/mira-collection]

### Telemetry

- `ApiFieldSchema` (type) — shape of one field in the `GET /api/_schema` payload, including `x-*` annotations. [telemetry.ts:ApiFieldSchema]
- `ApiCollectionSchema` (type) — one collection's schema entry (`name`, `kind`, `fields`, `required`, `indexes`, `rules`, `viewQuery`). [telemetry.ts:ApiCollectionSchema]
- `SpanRow` (type) — one completed span row (`traceId`, `spanId`, `parentSpanId`, `kind`, `durationMs`, `status`, `attributes`, ...). [telemetry.ts:SpanRow]
- `LogsResponse` (type) — `{ logs, total, limit, nextCursor }`. [telemetry.ts:LogsResponse]
- `SpansResponse` (type) — `{ spans, total, limit, nextCursor }`. [telemetry.ts:SpansResponse]
- `TelemetryClient` (type) — `getLogs`, `getSpans`, `getSchema` handlers. [telemetry.ts:TelemetryClient]
- `makeTelemetryClient` — builds a `TelemetryClient` over the shared `ExecuteFn`. [telemetry.ts:makeTelemetryClient]

### Barrel

- `index.ts` is the package-facing barrel for this directory: it exports the public types above plus `MiraError` [index.ts:MiraError], `makeCollectionClient` [index.ts:makeCollectionClient], `createMiraClient` [index.ts:createMiraClient], `makeClientHandler` [index.ts:makeClientHandler], `makeMutationHandler` [index.ts:makeMutationHandler], `buildFileUrl` [index.ts:buildFileUrl], and `makeTelemetryClient` [index.ts:makeTelemetryClient]. The module-level helpers marked "not in the barrel" are intentionally omitted. [index.ts:CollectionClient] [index.ts:TelemetryClient]

## Invariants

- Query handlers accept their arguments at the call site and `.raw()` takes none; mutation handlers accept no call-site arguments and `.raw(input)` takes the payload. This split is encoded in the conditional `ClientHandler` type. [handler.ts:ClientHandler]
- `.raw()` executes with `FetchHttpClient.layer`; `.toEffect()` returns the unprovided Effect so callers can supply their own `HttpClient`. [handler.ts:makeClientHandler] [handler.ts:makeMutationHandler]
- `.raw()` rejects with the unwrapped `MiraError` (via `Cause.findErrorOption`), never a `FiberFailure` wrapper. [handler.ts:makeClientHandler]
- Transport and body-encoding failures are normalized to `MiraError`: `HttpClientError` uses `response?.status ?? 0`, and `HttpBodyError` becomes status `500`. [factory.ts:catchAllErrors]
- The base URL is prepended and `Authorization: Bearer <token>` is attached only when a token is present. [factory.ts:createExecute]
- Browser mode sends `credentials: "include"`; server/SSR mode authenticates only through the bearer token. [factory.ts:createExecute] [factory.ts:createMiraClientInternal]
- A `204 No Content` response resolves to `undefined` instead of attempting JSON decoding. [factory.ts:createExecute]
- Auth methods are attached at runtime only when the collection kind is `"auth"`: `...(isAuth ? { authWithPassword, register, me } : {})`. [collection.ts:makeCollectionClient]
- At the type level, auth methods are required only for `K = "auth"` through the `AuthByKind` lookup map. [collection.ts:AuthByKind]
- `me()` unwraps the `{ collection, record }` envelope and fails with a 401 `MiraError` when the session belongs to a different collection. [collection.ts:me]
- A successful `authWithPassword` writes the server token ref, sets the browser login flag, and clears the memoized session check so the next `ensureSession()` revalidates. [collection.ts:authWithPassword]
- `BrowserAuth.clear()` flips the login flag synchronously and pins the session memo to resolved `false`; the logout request is fire-and-forget. [auth.ts:makeBrowserAuth]
- `BrowserAuth.refresh()` always issues a fresh `GET /api/auth/me`, while `ensureSession()` reuses the memoized promise. [auth.ts:makeBrowserAuth]
- `ServerAuth.isValid()` checks only the JWT `exp` claim (no signature verification, no network call). [auth.ts:makeServerAuth]
- File tokens are cached per collection and reused only while `Date.now() < expiresAt - 30_000`; a miss performs `POST /api/files/token`. [file.ts:makeGetFileToken]
- `ProtectedFileFieldClient.url` requires an explicit token; only `asyncUrl`/`getToken` acquire one. [file.ts:ProtectedFileFieldClient]
- A mutation switches to `multipart/form-data` when any payload value is a `Blob`; otherwise it is sent as JSON. [collection.ts:hasFileOrBlob]
- The multipart serializer drops `null`/`undefined` values, so clearing a field and uploading a file cannot happen in one call; clear via a JSON update instead. [collection.ts:buildFormData]
- Retry precedence is per-call `retryOptions.schedule` then collection-level `defaultRetryOptions.schedule`; with neither, the operation is not retried. [collection.ts:withRetry]
- `getFirstOrNone` forces `limit: 1` and resolves to `Option` (`None` when no item is returned). [collection.ts:getFirstOrNone]
- `getFullList` uses a page size of `1000` by default and resolves to a flat array rather than a single page envelope. [collection.ts:getFullList]
- Cursor pagination is transmitted as the `after` query parameter, not `cursor`. [collection.ts:listHandler]
- `select` and `expand` are serialized as comma-separated query values; filters are encoded through `FilterNodeSchema`. [collection.ts:listHandler]
- `withCollections` stores accessors under the caller's map key, while the adapter and query keys receive `def.name`; accessors are attached to the base client with `Object.assign`. [factory.ts:withCollections]
- File-field clients are created only for properties with `x-kind === "file"`, and are protected only when `x-protected === true`. [file.ts:makeFileFields]

## Side Effects

- Performs HTTP requests to the configured `baseUrl` for every operation endpoint (`/api/collections/...`, `/api/auth/...`, `/api/files/...`, `/api/_schema`, `/api/_telemetry/...`). [factory.ts:createExecute]
- Resolves `HttpClient.HttpClient` from the Effect environment; `.raw()` supplies `FetchHttpClient.layer`, so requests use the runtime `fetch` implementation. [handler.ts:makeClientHandler]
- Creates and mutates per-client in-memory refs: `authTokenRef`, `loggedInRef`, `sessionMemoRef`, and `fileTokenCacheRef`. [factory.ts:createMiraClientInternal]
- Writes the file-token cache after a successful token request. [file.ts:makeGetFileToken]
- Mutates auth state on login (token ref, logged-in ref, session memo). [collection.ts:authWithPassword]
- Issues a fire-and-forget `POST /api/auth/logout` on browser sign-out. [auth.ts:makeBrowserAuth]
- Reads/sends the browser cookie jar through `FetchHttpClient.RequestInit` with `credentials: "include"`. [factory.ts:createExecute]
- Decodes JWT payloads with `globalThis.atob` to inspect `exp`. [auth.ts:decodeJwtExp]
- Retry schedules can delay between attempts (scheduling/timer behavior) when a `Schedule` is configured. [collection.ts:withRetry]
- No disk, database, `localStorage`, or environment-variable access; configuration is passed explicitly to `createMiraClient`. [factory.ts:createMiraClient]

## Verification

- Run: `pnpm --filter @gettersethya/mira-client test`
- Optional typecheck: `pnpm --filter @gettersethya/mira-client typecheck`
