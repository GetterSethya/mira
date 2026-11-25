# filter

## Overview

The filter component is Mira's query-filter DSL and its compiler. `builder.ts` defines the
`FilterNode` AST constructors (`Filter.field(...).eq(...)`, `Filter.and/or/not`) plus the
typed `FilterBuilder<F>` variant used inside collection-client callbacks. `compiler.ts`
validates a `FilterNode` against a `CollectionSchema` and renders it into a `WhereClause`
of `?`-placeholders with a hardcoded `t` table alias. `types.ts` holds the AST union and its
recursive Effect Schema codec. Nothing here executes SQL — the caller splices the returned
fragment into a query.

## Interface

Values:

- `Filter` — untyped DSL entry point; field names are plain strings and comparison values are `unknown` — [builder.ts:Filter].
  - `Filter.field(name)` — starts a chain and returns a `FieldFilterOperand` — [builder.ts:Filter.field].
  - `Filter.and(left, right)` — builds an `{ op: "and" }` node — [builder.ts:Filter.and].
  - `Filter.or(left, right)` — builds an `{ op: "or" }` node — [builder.ts:Filter.or].
  - `Filter.not(node)` — builds an `{ op: "not" }` node — [builder.ts:Filter.not].
- `filterNodeToWhereClause(node, schema, collectionName, options)` - validates and compiles a node into `WhereClause`, failing with `ValidationError`. `options` is required and carries the identifier quoter and the pattern renderer - [compiler.ts:filterNodeToWhereClause].
- `FilterNodeSchema` — exported alias of the recursive `_filterNodeSchema` codec used to decode HTTP filter params — [types.ts:FilterNodeSchema].

Types:

- `FieldFilterOperand<V>` (type) — comparison surface produced by `Filter.field`: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`, `like`, `null`, `notNull`, `between` — [builder.ts:FieldFilterOperand].
- `FilterBuilder<F>` (type) — typed DSL: `field<K>` is constrained to `keyof F` and returns `FieldFilterOperand<InferFieldValue<F[K]>>` — [builder.ts:FilterBuilder].
- `FilterValueType` (type) - the scalar type a comparison value is cast to: `"text" | "integer" | "number" | "boolean" | "bigint"` - [types.ts:FilterValueType].
- `FilterCompileOptions` (type) - required options for compilation: `allowHiddenFields?: boolean` controlling `x-hidden` access, `quoteIdentifier` for column references, the required `caseInsensitivePattern(left, right)` renderer that chooses `LIKE` or `ILIKE`, optional `castValue(expr, type)` for type-aware casts, and optional `encodeValue(field, value)` for storage encoding - [compiler.ts:FilterCompileOptions].
- `FilterNode` (type) — discriminated union of comparison, `in`, `like`, null, logical, and negation variants — [types.ts:FilterNode].
- `WhereClause` (type) — `{ sql, params }` with positional `?` placeholders — [types.ts:WhereClause].

Barrel: `index.ts` forwards `Filter`, `filterNodeToWhereClause`, `FilterNodeSchema` and all five types, including `FilterCompileOptions` as a type re-export from `compiler.ts` - [index.ts:Filter].

## Invariants

- A `FilterNode` is exactly one of: value comparison (`eq`/`neq`/`gt`/`gte`/`lt`/`lte`), `in`, `like`, `null`/`not_null`, `and`/`or`, or `not` — [types.ts:FilterNode].
- `FilterNodeSchema` is self-referential via `Schema.suspend`, so nested `and`/`or`/`not` trees decode recursively — [types.ts:FilterNodeSchema].
- Field validation uses `Object.hasOwn`, so keys inherited from `Object.prototype` (`constructor`, `__proto__`, `toString`) are rejected as unknown fields — [compiler.ts:validateField].
- Hidden fields (`x-hidden: true`) are rejected unless `options.allowHiddenFields === true` — [compiler.ts:validateField].
- Comparison values must be `string`, `number`, `boolean`, or `null`; arrays and objects are rejected — [compiler.ts:validateScalar].
- An empty `in` list compiles to `1 = 0` rather than invalid `IN ()` SQL — [compiler.ts:compileIn].
- Every compiled column reference is double-quoted and prefixed with the hardcoded alias `t` — [compiler.ts:compileComparison].
- `like` passes its pattern through unchanged as a bound parameter; the caller owns `%` wildcards. The required `caseInsensitivePattern` renderer chooses `LIKE ... ESCAPE '\'` or `ILIKE ... ESCAPE E'\\'`, and must not add wildcards or transform the value, so the collection package stays dialect-free - [compiler.ts:compileLike].
- Logical nodes parenthesize both operands and concatenate params left-then-right — [compiler.ts:compileLogical].
- `between(lo, hi)` desugars into `and(gte(lo), lte(hi))` — [builder.ts:toFieldOperand].
- `Filter.field` produces `FieldFilterOperand<unknown>`; typed narrowing only happens through `FilterBuilder<F>` — [builder.ts:FilterBuilder].

## PostgreSQL filter parity (issue #29)

- Schema property types map to `FilterValueType`: `"string"` to `"text"`, `"integer"` to `"integer"`, `"number"` to `"number"`, `"boolean"` to `"boolean"`, and `x-kind: "seqId"` to `"bigint"`. A property with no scalar type is not comparison-filterable [compiler.ts:fieldFilterType].
- Comparison and `IN` placeholders are cast to the field type through `castValue`. PostgreSQL casts to the column type and SQLite leaves the placeholder uncast, so SQLite SQL is unchanged [compiler.ts:compileComparison].
- `like` casts the pattern placeholder to text and casts a non-text column to text before the pattern match. The expected PostgreSQL SQL is `t."field"::text ILIKE $1::text ESCAPE E'\\'` for a non-text field and `t."field" ILIKE $1::text ESCAPE E'\\'` for a text field [compiler.ts:compileLike].
- `isScalar` accepts booleans, and `encodeValue` encodes a boolean to `0`/`1` when the collection dialect stores booleans as integers. On PostgreSQL the value stays a boolean. This makes `Filter.field("published").eq(true)` work on both engines [compiler.ts:validateScalar].
- For a bigint field, a JavaScript number must be a safe integer; a larger value must be a decimal string or the request returns 422. String values for integer, number, boolean, and bigint fields are validated before execution with these messages:
  - `Filter value for "<field>" must be an integer`
  - `Filter value for "<field>" must be a number`
  - `Filter value for "<field>" must be a boolean`
  - `Filter value for "<field>" must be a bigint`
  - `Filter value for "<field>" must be a string, number, boolean, or null`
- `null` values keep the existing `null`/`not_null` path and are not comparison values [compiler.ts:compileComparison].

## Side Effects

- `types.ts` constructs the recursive `_filterNodeSchema` codec once at module load — [types.ts:FilterNodeSchema].
- `filterNodeToWhereClause` builds SQL strings and parameter arrays inside an `Effect`; it performs no I/O and never touches a database — [compiler.ts:filterNodeToWhereClause].
- `toFieldOperand` closes over a field name and returns fresh node objects per call; no shared mutable state — [builder.ts:toFieldOperand].

## Verification

- Run: `pnpm --filter @gettersethya/mira-collection test`
- Typecheck: `pnpm --filter @gettersethya/mira-collection typecheck`
