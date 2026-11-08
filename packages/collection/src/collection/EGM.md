# collection

## Overview

The collection component is Mira's schema authoring surface. `BaseCollection`,
`AuthCollection`, and `ViewCollection` each return a builder that already satisfies
`AnyCollectionDef` (`name`, `fields`, `schema`), computing its JSON Schema lazily on the
first `.schema` read. `Field`, `Index`, and `Bytes` are the ergonomic helpers consumed by
those builders, `serialize.ts` is the single place where TypeScript field definitions become
`x-`-annotated JSON Schema, and `infer.ts` derives the record/input/select types that client
SDKs use. Everything is in-memory object construction: no I/O and no server dependency.

## Interface

Values:

- `BaseCollection` — `define(name, fields)` returns a `BaseCollectionBuilder`; `.indexes(cb)` adds collection-level indexes — [base.ts:BaseCollection].
- `BaseCollectionBuilder<F>` (type) — `{ name, fields, schema, indexes(cb) }`, immediately usable as an `AnyCollectionDef` — [base.ts:BaseCollectionBuilder].
- `AuthCollection` — `define(name, extraFields)` returns an `AuthCollectionBuilder` with system fields pre-merged — [auth.ts:AuthCollection].
- `AuthCollectionBuilder<F>` (type) — `fields` is `F & AuthPublicFieldDefs` (always includes `email` and `emailVerified`) and `schema` is narrowed to the auth kind — [auth.ts:AuthCollectionBuilder].
- `ViewCollection` — `define(name, query, fields)` returns a `ViewCollectionBuilder` and validates the view fields — [view.ts:ViewCollection].
- `ViewCollectionBuilder<F>` (type) — `{ name, fields, schema }` with kind `"view"`; no `.indexes()` — [view.ts:ViewCollectionBuilder].
- `validateViewFields(name, fields)` — runtime guard that `id` and `seqId` exist and carry `viewOnly: true`; exported for tests (`@internal`) — [view.ts:validateViewFields].
- `Field` — builder namespace; each member returns a chainable `FieldDef` (except `seqId`) — [field.ts:Field].
  - `Field.text` — string field with optional `minLength` / `maxLength` — [field.ts:Field.text].
  - `Field.literalText` — string field constrained to a `const` literal union; stores both `literal` and `_literal` — [field.ts:Field.literalText].
  - `Field.number` — floating-point field with optional `min` / `max` — [field.ts:Field.number].
  - `Field.integer` — integer field with optional `min` / `max` — [field.ts:Field.integer].
  - `Field.boolean` — boolean field, usually given a `default` — [field.ts:Field.boolean].
  - `Field.date` — ISO-8601 string stored verbatim — [field.ts:Field.date].
  - `Field.email` — string field with email format validation — [field.ts:Field.email].
  - `Field.json` — arbitrary structured data serialized by the server — [field.ts:Field.json].
  - `Field.seqId` — auto-increment sequence id; returns a plain `FieldDef` with no `.view()` — [field.ts:Field.seqId].
  - `Field.file` — filename string plus `maxSize` / `mimeTypes` / `protected` metadata — [field.ts:Field.file].
  - `Field.relation` — stores `targetCollection` + `targetField` and a compile-time `_target` phantom — [field.ts:Field.relation].
- `Index` — index namespace; results are fed to a collection's `indexes` callback — [index-builder.ts:Index].
  - `Index.on(...fields)` — non-unique index (`unique: false`) — [index-builder.ts:Index.on].
  - `Index.unique(...fields)` — unique index (`unique: true`) — [index-builder.ts:Index.unique].
- `IndexEntry<K>` (type) — `{ readonly fields: Array<K>; readonly unique: boolean }` — [index-builder.ts:IndexEntry].
- `IndexBuilder<K>` (type) — field-name-narrowed `on` / `unique` used as the `indexes` callback argument — [index-builder.ts:IndexBuilder].
- `Bytes` — byte-size helpers used by `Field.file({ maxSize })` — [bytes.ts:Bytes].
  - `Bytes.fromKB` — [bytes.ts:Bytes.fromKB].
  - `Bytes.fromMB` — [bytes.ts:Bytes.fromMB].
  - `Bytes.fromGB` — [bytes.ts:Bytes.fromGB].
  - `Bytes.fromTB` — [bytes.ts:Bytes.fromTB].
- `ValidationError` — `Data.TaggedError("ValidationError")` carrying `{ collection, issues }`; raised by filter compilation and server-side validation — [errors.ts:ValidationError].
- `toJSONSchema(kind, name, fields, options)` — the single serializer from field maps to `CollectionSchema & { "x-collection-kind": K }`; exported from this folder but not re-exported by the component barrel — [serialize.ts:toJSONSchema].

Types from `types.ts`:

- `ConstraintKind` (type) — union of all validation failure kinds passed to a field's `error` callback — [types.ts:ConstraintKind].
- `TextConstraintKind` (type) — `type | required | minLength | maxLength` — [types.ts:TextConstraintKind].
- `EmailConstraintKind` (type) — `type | required | email` — [types.ts:EmailConstraintKind].
- `NumberConstraintKind` (type) — `type | required | minimum | maximum` — [types.ts:NumberConstraintKind].
- `IntegerConstraintKind` (type) — adds `int` to the number set — [types.ts:IntegerConstraintKind].
- `LiteralTextConstraintKind` (type) — `type | required | literal` — [types.ts:LiteralTextConstraintKind].
- `SimpleConstraintKind` (type) — `type | required` for boolean/date/json/file/relation — [types.ts:SimpleConstraintKind].
- `FieldKind` (type) — the 11 supported field kinds — [types.ts:FieldKind].
- `FieldDef` (type) — the normalized field description produced by `Field.*`; never constructed directly — [types.ts:FieldDef].
- `IndexDef` (type) — `{ fields, unique }` stored under `x-indexes` — [types.ts:IndexDef].
- `CollectionSchema` (type) — the serialized JSON Schema document with `x-collection-kind`, `x-indexes`, `x-rules`, `x-view-query` — [types.ts:CollectionSchema].
- `JsonSchemaProperty` (type) — one property entry including `x-kind`, `x-system`, `x-hidden`, `x-view-only`, `x-generated` — [types.ts:JsonSchemaProperty].
- `FieldsMap` (type) — `Record<string, FieldDef>` — [types.ts:FieldsMap].
- `AnyCollectionDef` (type) — `{ name, fields, schema }`, the common shape of all three collection kinds — [types.ts:AnyCollectionDef].
- `FieldKindToType` (type) — maps each field kind to its TypeScript scalar type — [types.ts:FieldKindToType].
- `InferFieldValue<T>` (type) — value type of a `FieldDef`, narrowing `literalText` to its literal union — [types.ts:InferFieldValue].

Types from `infer.ts`:

- `AnyAuthCollectionDef` (type) — `AnyCollectionDef` whose schema kind is `"auth"` — [infer.ts:AnyAuthCollectionDef].
- `InferMutationInput<F>` (type) — create/update input where file fields are `File | Blob` — [infer.ts:InferMutationInput].
- `InferRecord<F>` (type) — server record: always `id`/`created`/`updated`, `seqId` excluded, `required: false` fields become `T | null` — [infer.ts:InferRecord].
- `InferCreateInput<F>` (type) — create input excluding `seqId` and view-only fields — [infer.ts:InferCreateInput].
- `RelationKeys<F>` (type) — field names whose kind is `"relation"` — [infer.ts:RelationKeys].
- `FileKeys<F>` (type) — field names whose kind is `"file"` — [infer.ts:FileKeys].
- `WithExpand<F, E>` (type) — `InferRecord` plus an `expand` object typed from each relation's `_target` — [infer.ts:WithExpand].
- `SelectableKeys<F>` (type) — field names excluding those declared `hidden: true` — [infer.ts:SelectableKeys].
- `WithSelect<F, S, E>` (type) — narrows the record to selected fields plus system fields and expanded relation ids — [infer.ts:WithSelect].
- `CollectionKind` (type) — `"base" | "auth" | "view"` — [infer.ts:CollectionKind].
- `AuthCreateExtras` (type) — `password`, `passwordConfirm`, optional `emailVerified` — [infer.ts:AuthCreateExtras].
- `AuthUpdateCreds` (type) — optional `password`, `passwordConfirm`, `oldPassword`, `emailVerified` — [infer.ts:AuthUpdateCreds].
- `CreateInput<F, K>` (type) — kind-aware create input; auth adds credential fields — [infer.ts:CreateInput].
- `UpdateInput<F, K>` (type) — `{ id, data }`; auth `data` adds credential fields — [infer.ts:UpdateInput].
- `AuthCreateInput<F>` (type) — `CreateInput<F, "auth">` — [infer.ts:AuthCreateInput].
- `AuthUpdateInput<F>` (type) — `UpdateInput<F, "auth">` — [infer.ts:AuthUpdateInput].
- `RegisterInput<F>` (type) — self-signup input requiring `email`, `password`, matching `passwordConfirm` — [infer.ts:RegisterInput].

Barrel:

- `index.ts` re-exports the builders/helpers as values (`Field`, `Index`, `AuthCollection`, `BaseCollection`, `ViewCollection`, `Bytes`, `ValidationError`) and only a subset of the type list above: the infer types plus `AnyCollectionDef`, `CollectionSchema`, `FieldDef`, `FieldsMap`, and `LiteralTextConstraintKind` — [index.ts:Field], [index.ts:Index], [index.ts:CollectionSchema]. `IndexEntry` and `IndexBuilder` are declared in `index-builder.ts` but are not re-exported by this barrel or reachable from the package entry; `toJSONSchema` and `validateViewFields` are also deliberately omitted.

## Invariants

- `Field.seqId` is the only builder that returns a bare `FieldDef` without `.view()`; every other builder attaches `.view()` — [field.ts:Field.seqId], [field.ts:withView].
- `.view()` returns a new object with `viewOnly: true`; it never mutates the original definition — [field.ts:withView].
- `BaseCollection.define()` rejects `id` / `seqId` keys in the field map at the type level — [base.ts:BaseForbiddenField].
- `AuthCollection.define()` rejects every system field name in `extraFields` at the type level — [auth.ts:AuthSystemField].
- Auth collections always gain a unique index on `email` — [auth.ts:AUTH_SYSTEM_INDEXES].
- Auth system properties are fixed: `email` (system), `password` (system + hidden + `x-kind: "password"`), `emailVerified` (system, default `false`) — [auth.ts:AUTH_SYSTEM_PROPERTIES].
- `schema` is lazily computed once per builder and memoized in a local `_schema` binding — [base.ts:makeBaseBuilder], [auth.ts:makeAuthBuilder], [view.ts:makeViewBuilder].
- `.indexes(cb)` returns a fresh builder and leaves the receiver unchanged — [base.ts:makeBaseBuilder], [auth.ts:makeAuthBuilder].
- `toJSONSchema` injects `id`, `seqId`, `created`, `updated` for `base`/`auth` kinds and skips all four for `view` — [serialize.ts:toJSONSchema].
- `required` contains every user field whose `required` is not `false` and whose `default` is `undefined`, plus system fields without a default — [serialize.ts:toJSONSchema].
- `unique` / `indexed` never appear as property flags; they are normalized into `x-indexes` alongside `options.indexes` — [serialize.ts:toJSONSchema].
- `hidden: true` serializes to `x-hidden`; `viewOnly` serializes to `x-view-only` — [serialize.ts:fieldToProperty].
- `Field.relation` persists only `targetCollection` and `targetField`; the collection definition itself survives only as the compile-time `_target` phantom — [field.ts:Field.relation].
- `Field.literalText` keeps the allowed values under both `literal` and `_literal` so inference can recover the union — [field.ts:Field.literalText].
- A view collection must declare `id` and `seqId` with `.view()` or `define()` throws — [view.ts:validateViewFields].
- `InferRecord` drops `seqId` and widens optional fields to `T | null` — [infer.ts:InferRecord].
- `InferCreateInput` drops `seqId` and any `viewOnly` field — [infer.ts:InferCreateInput].
- `SelectableKeys` excludes fields declared `hidden: true` — [infer.ts:SelectableKeys].

## Side Effects

- First read of a builder's `schema` memoizes the generated schema into the builder's closure state — [base.ts:makeBaseBuilder], [auth.ts:makeAuthBuilder], [view.ts:makeViewBuilder].
- Module load creates the module-level constant objects `ID_PROPERTY` / `SEQID_PROPERTY` and `AUTH_SYSTEM_PROPERTIES` / `AUTH_SYSTEM_INDEXES` once — [serialize.ts:ID_PROPERTY], [auth.ts:AUTH_SYSTEM_PROPERTIES].
- No disk access, network calls, environment reads, timers, or global registries; `toJSONSchema` is a pure transformation returning a new object — [serialize.ts:toJSONSchema].

## Verification

- Run: `pnpm --filter @gettersethya/mira-collection test`
- Typecheck: `pnpm --filter @gettersethya/mira-collection typecheck`
