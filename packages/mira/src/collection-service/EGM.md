# Collection Service

## Overview

The business-logic layer between the HTTP router and schema-agnostic `Repository`. Every operation validates input against Effect Schema codecs generated from the collection's JSON Schema, compiles and binds `x-rules`, manages system fields (`seqId`, `created`, `updated`), encodes/decodes dialect-specific storage representations (SQLite booleans), strips `x-hidden` fields for non-admin callers, paginates by `seqId` cursor, enforces auth-collection credential rules (hashing, `passwordConfirm`, `oldPassword`, `emailVerified`, additive `manage` rule), resolves relation `expand`s with the target's `view` rule, and best-effort deletes replaced/removed files and their thumbnails. It is parameterised per collection set by `makeCollectionServiceLayer(allCollections)`.

## Interface

- `CollectionService` — service tag with `list`, `view`, `create`, `createMany`, `update`, `delete`: `[collection-service.ts:CollectionService]`
- `CollectionService.list(collection, cursor, perPage, ctx, filter?, sort?, select?, expand?)` — returns `CursorPage` (items + `nextCursor`): `[collection-service.ts:CollectionService]`
- `CollectionService.view(collection, id, ctx, select?, expand?)` — returns one `RepoRecord` or `NotFoundError`: `[collection-service.ts:CollectionService]`
- `CollectionService.create(collection, data, ctx)` / `update(collection, id, data, ctx)` / `delete(collection, id, ctx)`: `[collection-service.ts:CollectionService]`
- `CollectionService.createMany(collection, records, ctx)` — inserts every record through the `create` path inside one `sql.withTransaction`; returns the created rows in input order: `[collection-service.ts:CollectionService]`
- `CollectionService.updateMany(collection, updates, ctx)` — updates `{ id, data }` entries through the `update` path inside one transaction; returns updated rows in input order: `[collection-service.ts:CollectionService]`
- `CollectionService.deleteMany(collection, ids, ctx)` — deletes every id through the `delete` path inside one transaction; returns the ids deleted, in input order: `[collection-service.ts:CollectionService]`
- `MAX_BULK_RECORDS` — 1 000; the shared maximum batch size for bulk create/update/delete. `MAX_BULK_CREATE_RECORDS` remains as a deprecated alias: `[collection-service.ts:MAX_BULK_RECORDS]`
- `makeCollectionServiceLayer(allCollections)` — builds the layer; requires `Repository`, `SqlClient`, `FileStorage`, `Dialect`, `AuthService`: `[collection-service.ts:makeCollectionServiceLayer]`
- `CollectionServiceLive` — deprecated empty-collection layer kept for compatibility: `[collection-service.ts:CollectionServiceLive]`
- `RequestCtx` (type) — `auth?`, `headers`, `query`, `body?`, `admin?`: `[context.ts:RequestCtx]`
- `CursorPage` (type) — `items`, `nextCursor`: `[context.ts:CursorPage]`
- `NotFoundError` — tagged 404 error (`collection`, `id`): `[errors.ts:NotFoundError]`
- `ForbiddenError` — tagged 403 error (`collection`, `action`): `[errors.ts:ForbiddenError]`
- `ReadOnlyError` — tagged 405 error raised by view collections: `[errors.ts:ReadOnlyError]`
- `PayloadTooLargeError` — tagged 413 error (`limit`, `detail`): `[errors.ts:PayloadTooLargeError]`
- `CollectionError` (type) — union of the above plus `ValidationError` and `SqlError`: `[errors.ts:CollectionError]`
- `ValidationError` — re-exported from the client package: `[errors.ts:ValidationError]`
- `makeRowDecoder` / `makeRowEncoder` — dialect-gated `0`/`1` ⇄ boolean conversion: `[decode.ts:makeRowDecoder]`
- `makeProjectedListRowMapper(schema, storesBooleanAsInteger, projection)` — maps a list row in SELECT order, skips `seqId`, and preserves only projected keys plus `expand`: `[decode.ts:makeProjectedListRowMapper]`
- `RowDecoder`, `RowEncoder` (types) — decoder returns an `Effect`, encoder is pure: `[decode.ts:RowDecoder]`
- `stripHiddenFields(schema, record)` — allowlist filter dropping `x-hidden` and unknown keys: `[decode.ts:stripHiddenFields]`
- `toPublicRecord(schema, storesBooleanAsInteger, record)` — decode + strip for direct-read responses: `[decode.ts:toPublicRecord]`
- `InputSchemas` (type) — `create` and `update` Effect Schema codecs: `[input-schema.ts:InputSchemas]`
- `buildInputSchemas(colDef)` — derives create/update codecs from JSON Schema + field error callbacks: `[input-schema.ts:buildInputSchemas]`
- `parseErrToValidationError(collection)` — formats `Schema.SchemaError` into issue strings: `[input-schema.ts:parseErrToValidationError]`
- `andWhere(a, b)` — AND-combines two `WhereClause`s and concatenates params: `[where.ts:andWhere]`
- `idClause(id)` — `t.id = ?`: `[where.ts:idClause]`
- `cursorClause(after)` — `t.seqId > ?`: `[where.ts:cursorClause]`
- `resolveCtxPlaceholders(result, ctx, collection, action)` — binds `@auth_*` / `@request_*` placeholders: `[where.ts:resolveCtxPlaceholders]`
- `extractCtxRefs(sql)` — reports exactly which ctx fields a rule references: `[where.ts:extractCtxRefs]`
- `CtxRefs` (type) — `authFields`, `queryKeys`, `headerKeys`, `bodyKeys`: `[where.ts:CtxRefs]`
- `resolveFieldRefs(clause, record)` — replaces `t.<field>` with bound payload values: `[where.ts:resolveFieldRefs]`
- Barrel re-exports (`CollectionService`, `CollectionServiceLive`, `makeCollectionServiceLayer`, `CursorPage`, `RequestCtx`, `CollectionError`, `ForbiddenError`, `NotFoundError`, `ReadOnlyError`, `ValidationError`): `[index.ts:CollectionService]`

## Invariants

- View collections are read-only: `create`, `createMany`, `update`, `updateMany`, `delete`, and `deleteMany` fail with `ReadOnlyError`: `[collection-service.ts:create]`
- `createMany` runs each record through the same `createOne` pipeline (validation, rule pre-check, credential enforcement, password hashing, id/timestamp generation, hidden-field stripping) inside one transaction, so any failure rolls the whole batch back: `[collection-service.ts:CollectionService]`
- `updateMany` and `deleteMany` wrap `updateOne`/`deleteOne` in one transaction with concurrency 1; a missing id, rule denial or validation failure rolls back every earlier write in the batch, and `deleteMany` only returns ids after the commit: `[collection-service.ts:CollectionService]`
- Fields annotated `x-generated` may never be supplied by a caller: `[collection-service.ts:rejectSystemFields]`
- Non-admin calls with no rule for `list`/`view`/`create`/`update`/`delete` fail with `ForbiddenError`; `update`/`delete` check this before loading the row so absence is not leaked: `[collection-service.ts:compileRule]`
- `create` evaluates the rule against the validated payload (with `body` set) before inserting: `[collection-service.ts:create]`
- `update` evaluates the rule against `{ ...stored, ...patch }` and requires the row to pass the rule by id; `delete` requires the stored row to pass by id: `[collection-service.ts:update]`
- `admin: true` bypasses rule compilation entirely (validation still applies): `[collection-service.ts:create]`
- Input is validated by `Schema.decodeUnknownEffect` using the per-collection create/update codecs; failures become `ValidationError`: `[collection-service.ts:create]`
- Required keys are non-nullable; optional keys accept `null` only when DDL-nullable (non-required, non-`x-system`): `[input-schema.ts:buildInputSchemas]`
- `select` is an allowlist checked with `Object.hasOwn` against the collection's properties; `id`, `created`, `updated` are always included; hidden fields are excluded unless admin: `[collection-service.ts:resolveFields]`
- A non-admin sort on an `x-hidden` field fails with `ValidationError`; unknown sort fields fall back to default ordering: `[collection-service.ts:validateSort]`
- `list` always fetches `seqId`, derives `nextCursor` only when the page is full, and removes `seqId` from returned items: `[collection-service.ts:CollectionService]`
- Default visible fields are cached per schema identity and frozen; `seqId` is appended once through a second array cache. The no-select/no-expand list path reuses both arrays: `[collection-service.ts:resolveFields]`
- The default list uses `makeProjectedListRowMapper`, iterating the exact `fieldsForQuery` projection so response key set/order match the SELECT and non-projected keys are omitted; `select`/`expand` keep `makeListRowMapper`. A custom `Repository` that returns extra columns has them dropped on the default path: `[collection-service.ts:list]`
- `expand` only joins fields whose `x-kind` is `relation`; duplicates collapse; the target collection's `view` rule is applied unless admin; a target with no view rule or an auth-needing rule under an anonymous caller is silently not expanded: `[collection-service.ts:resolveExpand]`
- Hidden fields are stripped from `create`/`update` responses for non-admin callers (same contract as list/view): `[collection-service.ts:stripHidden]`
- Auth passwords are hashed at this single write chokepoint; on update an empty password is dropped so a blank edit form preserves the stored hash: `[collection-service.ts:hashAuthPassword]`
- Create credentials: a non-empty password requires `passwordConfirm` to match; non-managers cannot set `emailVerified: true`: `[collection-service.ts:enforceCreateCredentials]`
- Update credentials: password changes require `passwordConfirm`; non-managers changing password or email must pass `oldPassword`; non-managers cannot change `emailVerified`: `[collection-service.ts:enforceUpdateCredentials]`
- `manage` is additive: it only grants manager privileges when the base rule already allows the action, and the create-time check evaluates the payload with `emailVerified` forced to `false`: `[collection-service.ts:canManagePayload]`
- Booleans are encoded/decoded only when the active dialect reports `storesBooleanAsInteger`; otherwise both helpers are no-ops: `[decode.ts:makeRowDecoder]`
- `stripHiddenFields` drops keys with no schema property, so computed/joined columns never leak: `[decode.ts:stripHiddenFields]`
- Placeholder resolution fails closed: auth-referencing rules without an authenticated actor, and unknown request sources, produce `ForbiddenError`; field values are bound in one left-to-right pass to preserve param order: `[where.ts:resolveCtxPlaceholders]`
- On `update`/`delete`, replaced or removed file keys and their `_thumbs/<key>/` children are deleted best-effort; failures are swallowed: `[collection-service.ts:CollectionService]`
- `@request_body_*` in a `list`/`view`/`delete` rule can never match (bodiless actions); a one-time warning is logged per collection/action at layer build: `[collection-service.ts:makeCollectionServiceLayer]`

## Mutation batching

- Opt-in via `.batchMutation({ create, update, delete })`; each operation is present/enabled independently and the shared FIFO queue is created when at least one is enabled: `[mutation-batcher.ts:resolveBatchMutationConfig]`
- Create prepares validation/rules/hashing in the request fiber and queues only the insert. Update/delete prepare schema validation, then read the stored row, check the update/delete rule, `manage` rule and credentials inside the batch transaction: `[collection-service.ts:prepareUpdate]` `[collection-service.ts:executeUpdate]` `[collection-service.ts:executeDelete]`
- Update uses `Repository.viewWithAccess` when the update rule is fast-path-safe, returning the stored row plus the rule (and `manage`) result in one SELECT. A `@request_body_*` key present in the patch binds the patch value; an absent key that is a real non-generated field binds `t."<key>"` so the rule reads the stored row. Body-only keys, generated/system fields, subquery body rules, unknown request sources, and anonymous auth-requiring rules fall back to `view` + `viewFilter` + `canManageRecord`, preserving 404-before-403 and merged-body semantics `[collection-service.ts:executeUpdate]`
- Delete uses `Repository.viewWithAccess` when the rule has no body placeholder and no anonymous auth dependency, then `Repository.deleteExisting`; body-placeholder and anonymous-auth rules fall back to `view` + `viewFilter` + `delete` so 404-before-403 and body semantics stay exact. The delete result shape is selected by `Dialect.deleteResult` `[collection-service.ts:executeDelete]`
- One flusher runs entries in FIFO order, uses a savepoint per entry (single-entry fast path preserved), commits once, resolves deferreds after `COMMIT`, and hands post-commit file/challenge cleanup to a bounded worker: `[mutation-batcher.ts:makeMutationBatcherLayer]`
- Per-entry 404/403/422 failures isolate; a transaction-fatal failure fails the batch; a constraint failure at `COMMIT` maps to `BatchMutationConflictError` (409 `batch_conflict`) and is not a batcher defect: `[mutation-batcher.ts:collectionErrorOf]`
- `submitInline` bypasses every queue guard for a non-enabled operation and for `ctx.internal` auth flows: `[mutation-batcher.ts:MutationBatcher]`
- `updateMany`/`deleteMany` keep their all-or-nothing contract and bypass the queue; they call the same `updateOne`/`deleteOne` helpers with `deferCleanup: false`: `[collection-service.ts:updateMany]`

## Side Effects

- SQL reads/writes through `Repository` (`list`, `view`, `viewFilter`, `create`, `update`, `delete`): `[collection-service.ts:CollectionService]`
- SQL transaction around the whole `createMany`/`updateMany`/`deleteMany` batch (`BEGIN`/`COMMIT`, rolled back on any failure): `[collection-service.ts:CollectionService]`
- SQL rule pre-check `SELECT 1 AS ok WHERE <payload-bound rule>` before insert: `[collection-service.ts:create]`
- SQL rule check `SELECT 1 AS ok WHERE <ctx-bound manage rule>` for `canManagePayload`: `[collection-service.ts:canManagePayload]`
- Filesystem: file deletion and thumbnail-directory listing/deletion via `FileStorage`: `[collection-service.ts:CollectionService]`
- Logging: `Effect.logWarning` for body-referencing bodiless rules: `[collection-service.ts:makeCollectionServiceLayer]`
- Tracing: `collection.list` / `collection.view` / `collection.create` / `collection.update` / `collection.delete` spans with a `collection` attribute, created through `withSpanWhenEnabled` so tracing-off requests skip no-op spans: `[collection-service.ts:CollectionService]`
- CPU: password hashing/verification via `AuthService`: `[collection-service.ts:hashAuthPassword]`

## Verification

- Run: `pnpm --filter @gettersethya/mira test`
- Typecheck: `pnpm --filter @gettersethya/mira typecheck`
