# HTTP Layer

## Overview

The public API surface of a Mira server, built on `effect/http`: per-collection CRUD routes, auth collection login/logout/me, file upload/serve/token routes, schema introspection, and telemetry read routes. Route handlers resolve an optional session token (Bearer header or `mira_token` cookie), build a `RequestCtx`, mark admin-plugin collections as `admin: true`, and delegate to `CollectionService`. Domain errors are mapped to HTTP responses by `catchCollectionErrors`. Cross-cutting middleware: CORS (`makeCorsMiddleware`), client-IP span annotation (`ipAnnotationMiddleware`), port-retry server binding, and fail-closed session authentication backed by a durable `TokenStore` (JWT deny-list plus per-user generation), with `pwf` credential binding so password changes invalidate sessions.

## Interface

### Routes (registered in `makeCollectionRouter`)

- `GET /api/collections/:name` — list with `filter`, `sort`, `order`, `select`, `expand`, `after`, `limit`: `[router.ts:listRoute]`
- `POST /api/collections/:name` — create (JSON or multipart), 201: `[router.ts:createRoute]`
- `GET /api/collections/:name/:id` — view one record with `select`/`expand`: `[router.ts:viewRoute]`
- `PATCH /api/collections/:name/:id` — update: `[router.ts:updateRoute]`
- `DELETE /api/collections/:name/:id` — delete, 204: `[router.ts:deleteRoute]`
- `POST /api/collections/:name/auth-with-password` — auth-collection login, returns `{ token, record }` and sets the session cookie: `[router.ts:authRoute]`
- `POST /api/auth/logout` — revokes the presented token's `jti` and clears the cookie: `[router.ts:logoutRoute]`
- `POST /api/auth/logout-all` — bumps the user's generation and clears the cookie: `[router.ts:logoutAllRoute]`
- `GET /api/auth/me` — authenticated record with hidden fields stripped and booleans decoded: `[router.ts:meRoute]`
- `GET /api/files/:collection/:id/:filename` — serve a file; `token` query param required for protected fields; optional `thumb` spec: `[file-serve.ts:makeFileServeRoute]`
- `POST /api/files/token` — mint a 5-minute short-lived file token for `{ collection }`: `[file-token.ts:makeFileTokenRoute]`
- `GET /api/_schema` — admin-gated collection schema introspection: `[router.ts:schemaRoute]`
- `GET /api/_telemetry/logs` — admin-gated persisted log query (`filter`, `after`, `limit`): `[router.ts:telemetryLogs]`
- `GET /api/_telemetry/spans` — admin-gated span query (`filter`, `after`, `limit`, `traceId`): `[router.ts:telemetrySpans]`

### Exports

- `makeCollectionRouter(collections, adminCollections?)` — builds the full route array; exported: `[router.ts:makeCollectionRouter]`
- `catchCollectionErrors` — maps `CollectionError`/`FileStorageError` to JSON responses (404/403/422/405/413/502/500): `[errors.ts:catchCollectionErrors]`
- `parseFilterParam`, `parseSortParam`, `parsePaginationParam`, `parseSelectParam`, `parseExpandParam` — query-param parsing: `[params.ts:parseFilterParam]`
- `CorsConfig` (type) — origin list/predicate, methods, headers, exposed headers, max-age, credentials: `[cors.ts:CorsConfig]`
- `defaultCorsConfig` — permissive development default (reflecting predicate + credentials): `[cors.ts:defaultCorsConfig]`
- `assertValidCorsConfig` — throws on wildcard + credentials: `[cors.ts:assertValidCorsConfig]`
- `makeCorsMiddleware` — maps `CorsConfig` onto `HttpMiddleware.cors`: `[cors.ts:makeCorsMiddleware]`
- `ipAnnotationMiddleware` — annotates the root span with `http.forwarded_for` from `x-forwarded-for` / `x-real-ip`; this is observability only, not the enforcement key: `[ip-middleware.ts:ipAnnotationMiddleware]`
- `AuthService` — service tag with `hashPassword` / `verifyPassword`: `[auth.ts:AuthService]`
- `hashPassword`, `verifyPassword` — service-delegating helpers: `[auth.ts:hashPassword]`
- `signJwt`, `verifyJwt` — session JWTs (`typ: "session"`, HS256, 72 h), carrying `jti`, `exp`, `pwf`, `gen`: `[auth.ts:signJwt]`
- `signFileToken`, `verifyFileToken` — file JWTs (`typ: "file"`, 5 m, `sub`/`col`/`filecol`): `[auth.ts:signFileToken]`
- `computePwf` — HMAC-SHA-256 (WebCrypto) of the stored password hash: `[auth.ts:computePwf]`
- `authenticateSession(rawToken, isAuthCollection)` — the shared fail-closed session decision: `[auth.ts:authenticateSession]`
- `isAuthCollectionName(collections)` — predicate factory over auth collections: `[auth.ts:isAuthCollectionName]`
- `JwtPayload`, `FileTokenPayload`, `VerifiedJwt`, `SessionTokenOptions`, `SessionAuth` (types) and the `AuthError` class: `[auth.ts:JwtPayload]`
- `NodeAuthServiceLayer` — scrypt `hashPassword` / `verifyPassword` implementation: `[auth-node.ts:NodeAuthServiceLayer]`
- `FileServeServices` (type) — `Repository | FileStorage | ThumbnailService | AppConfig`: `[file-serve.ts:FileServeServices]`
- `makeFileKey`, `processMultipartUpload`, `uploadBudget`: `[files.ts:processMultipartUpload]`
- `DEFAULT_MAX_FILE_SIZE`, `GLOBAL_MAX_UPLOAD_BYTES`, `CONTENT_OVERHEAD_BYTES`, `MAX_MULTIPART_PARTS`, `MAX_FIELD_SIZE` — size/count limits: `[files.ts:DEFAULT_MAX_FILE_SIZE]`
- `makePortRetryServerLayer(factory, port, maxAttempts?, onBoundPort?)` — retries `EADDRINUSE` on incrementing ports: `[port-retry.ts:makePortRetryServerLayer]`
- `HttpServerFactory` — service tag whose `makeLayer(port)` builds the platform server layer: `[server-factory.ts:HttpServerFactory]`
- `NodeHttpServerFactoryLayer` — Node implementation: `[server-factory-node.ts:NodeHttpServerFactoryLayer]`
- `TokenStore` — `Context.Reference` with an in-memory default: `[token-store.ts:TokenStore]`
- `TokenStoreLive` — SQLite-backed durable implementation: `[token-store.ts:TokenStoreLive]`
- `inMemoryTokenStore`, `TokenStoreShape` (type): `[token-store.ts:inMemoryTokenStore]`
- `makeSchemaRoute` — returns `name`, `kind`, `fields`, `required`, `indexes`, `viewQuery` per collection: `[schema.ts:makeSchemaRoute]`
- Barrel re-exports (`FileTokenPayload`, `JwtPayload`, `AuthService`, `hashPassword`, `signFileToken`, `signJwt`, `verifyFileToken`, `verifyJwt`, `verifyPassword`, `CorsConfig`, `assertValidCorsConfig`, `defaultCorsConfig`, `makeCorsMiddleware`, `catchCollectionErrors`, `FileServeServices`, `makeFileServeRoute`, `makeFileTokenRoute`, `makeFileKey`, `processMultipartUpload`, `makeCollectionRouter`, `HttpServerFactory`, `telemetryLogsRoute`, `telemetrySpansRoute`): `[index.ts:makeCollectionRouter]`

## Invariants

- Status mapping: `NotFoundError` 404, `ForbiddenError` 403, `ValidationError` 422, `ReadOnlyError` 405, `PayloadTooLargeError` 413, `FileStorageError` 502, `SqlError` 500: `[errors.ts:catchCollectionErrors]`
- Auth email mapping: `RateLimitedError`/`TooManyAttemptsError` 429 with `Retry-After`, `RateLimitUnavailableError`/`EmailNotConfiguredError`/`EmailUnavailableError`/`EmailSendError` 503, `EmailFlowDisabledError` 404, `InvalidCodeError`/`InvalidResetTokenError` 400: `[errors.ts:catchAuthEmailErrors]`
- Auth email request order: feature and transport check -> cooldown -> request limits (IP, recipient) -> user lookup -> challenge -> send. The cooldown and pre-lookup checks are account-agnostic: `[auth-email.ts:consumeEmailRequestLimits]`
- JSON request bodies over 32 MiB are rejected from `Content-Length` before reading: `[router.ts:MAX_JSON_BODY_BYTES]`
- Multipart budget = `min(64 MiB, 1 MiB overhead + Σ per-file x-maxSize)`, defaulting each file field to 8 MiB; per-file overflow drains the rest of the stream and then 422s: `[files.ts:uploadBudget]`
- At most 64 multipart parts and 64 KiB per non-file field; unknown fields and non-file fields are rejected: `[files.ts:processMultipartUpload]`
- File MIME types must be in the field's `x-mimeTypes` allowlist when declared: `[files.ts:processMultipartUpload]`
- Every file key allocated during an upload is deleted if parsing fails or is interrupted: `[files.ts:processMultipartUpload]`
- File keys are `<uuid>.<ext>` derived from the original filename, or `.bin` when extensionless: `[files.ts:makeFileKey]`
- A served `filename` must be a plain segment (no `/`, `\`, `..`, NUL) or the route 404s: `[file-serve.ts:isSafeFilenameSegment]`
- The served filename must equal the stored value of a file field on the record, otherwise 404: `[file-serve.ts:serveFile]`
- Protected file fields require a valid file token whose `filecol` matches the route collection, and the requester must pass the collection's `view` rule; admin-plugin tokens bypass the rule: `[file-serve.ts:serveFile]`
- Thumbnail responses are served from `_thumbs/<filename>/<spec>` when present, otherwise generated (falling back to the original on error) and cached best-effort: `[file-serve.ts:serveFile]`
- Session authentication fails closed: session `typ`, non-revoked `jti`, existing auth record, matching `pwf`, and matching generation; any store error denies: `[auth.ts:authenticateSession]`
- Tokens are extracted from `Authorization: Bearer` first, then the `mira_token` cookie: `[router.ts:extractToken]`
- Login requires the collection to be auth-kind (else 405) and a JSON `{ email, password }` body; malformed or missing bodies return 422, while credential failures return 403 without distinguishing cause: `[router.ts:authRoute]`
- Login sets an `httpOnly`, `sameSite: "strict"`, 72-hour `mira_token` cookie and returns the public (decoded, hidden-stripped) record: `[router.ts:authRoute]`
- Logout revokes the presented `jti` best-effort and always clears the cookie: `[router.ts:logoutRoute]`; logout-all requires a valid session then bumps the user's generation: `[router.ts:logoutAllRoute]`
- `/api/_schema` and telemetry routes require a valid session whose collection is in the admin set; non-admin authenticated sessions get 403: `[router.ts:requireApiAuth]`
- Admin bypass for generic collection routes is granted only when the token's collection is in `adminCollections`: `[router.ts:buildRequestCtx]`
- Sorting only accepts a field present in the schema (via `Object.hasOwn`); `order` defaults to `asc`: `[params.ts:parseSortParam]`
- Pagination defaults `limit` to 30 and clamps it to 100; `after` must be a non-negative integer: `[params.ts:parsePaginationParam]`
- `filter` must JSON-decode to a `FilterNode` or the request 422s: `[params.ts:parseFilterParam]`
- CORS rejects `credentials: true` with a wildcard/omitted origin list: `[cors.ts:assertValidCorsConfig]`
- Port retry only retries `EADDRINUSE`; the starting port is attempted first; other serve errors fail immediately. `Bun.serve` throws bind errors as defects, so `serveErrorFromCause` normalizes typed `ServeError` failures and `EADDRINUSE` defects: `[port-retry.ts:serveErrorFromCause]`
- Password hashes are stored as `scrypt$<salt>$<hash>` with random 16-byte salts: `[auth-node.ts:NodeAuthServiceLayer]`
- Telemetry logs cap `limit` at 1000 and page backward by `seqId`; spans clamp `limit` to 1–200, group by trace without a filter, and return all spans for `traceId`: `[telemetry-routes.ts:telemetryLogsRoute]`
- Schema introspection deliberately preserves `x-system`/`x-hidden`/`x-generated`/`x-kind` annotations: `[schema.ts:makeSchemaRoute]`

## Side Effects

- HTTP: binds a server (port retry) and answers every route above: `[router.ts:makeCollectionRouter]`
- HTTP: writes/clears the `mira_token` cookie and signs JWTs: `[auth.ts:signJwt]`
- SQL: `TokenStoreLive` creates `_revoked_tokens` (+ expiry index) and `_auth_generations` and reads/writes both: `[token-store.ts:TokenStoreLive]`
- SQL: auth login and session checks read the auth collection row via `Repository.viewFilter`: `[auth.ts:authenticateSession]`
- SQL: telemetry routes query the `logs` and `spans` tables: `[telemetry-routes.ts:telemetryLogsRoute]`
- SQL: file serving reads record rows to locate the file field and enforce the view rule: `[file-serve.ts:serveFile]`
- Filesystem: multipart uploads write files through `FileStorage`; failed uploads delete their keys: `[files.ts:processMultipartUpload]`
- Filesystem: file serve reads originals/thumbnails and may write a thumbnail cache entry: `[file-serve.ts:serveFile]`
- Caches: `TokenStore` default keeps revoked-jti and generation maps in process memory: `[token-store.ts:inMemoryTokenStore]`
- Caches: thumbnails are persisted under `_thumbs/<filename>/<spec>`: `[file-serve.ts:serveFile]`
- Logging/tracing: `http.handler`, `http.auth`, `http.session-auth`, `http.body.parse` spans; port retry warnings/info: `[router.ts:makeCollectionRouter]`
- CPU/randomness: scrypt password hashing and salt generation: `[auth-node.ts:NodeAuthServiceLayer]`

## Verification

- Run: `pnpm --filter @gettersethya/mira test`
- Typecheck: `pnpm --filter @gettersethya/mira typecheck`
