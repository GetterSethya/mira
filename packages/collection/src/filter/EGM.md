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
- `filterNodeToWhereClause(node, schema, collectionName, options?)` — validates and compiles a node into `WhereClause`, failing with `ValidationError` — [compiler.ts:filterNodeToWhereClause].
- `FilterNodeSchema` — exported alias of the recursive `_filterNodeSchema` codec used to decode HTTP filter params — [types.ts:FilterNodeSchema].

Types:

- `FieldFilterOperand<V>` (type) — comparison surface produced by `Filter.field`: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`, `like`, `null`, `notNull`, `between` — [builder.ts:FieldFilterOperand].
- `FilterBuilder<F>` (type) — typed DSL: `field<K>` is constrained to `keyof F` and returns `FieldFilterOperand<InferFieldValue<F[K]>>` — [builder.ts:FilterBuilder].
- `FilterCompileOptions` (type) — `{ allowHiddenFields?: boolean }` controlling `x-hidden` access — [compiler.ts:FilterCompileOptions].
- `FilterNode` (type) — discriminated union of comparison, `in`, `like`, null, logical, and negation variants — [types.ts:FilterNode].
- `WhereClause` (type) — `{ sql, params }` with positional `?` placeholders — [types.ts:WhereClause].

Barrel: `index.ts` forwards `Filter`, `filterNodeToWhereClause`, `FilterNodeSchema` and the four types — [index.ts:Filter]; `FilterCompileOptions` is exported from `compiler.ts` but not re-exported by the barrel.

## Invariants

- A `FilterNode` is exactly one of: value comparison (`eq`/`neq`/`gt`/`gte`/`lt`/`lte`), `in`, `like`, `null`/`not_null`, `and`/`or`, or `not` — [types.ts:FilterNode].
- `FilterNodeSchema` is self-referential via `Schema.suspend`, so nested `and`/`or`/`not` trees decode recursively — [types.ts:FilterNodeSchema].
- Field validation uses `Object.hasOwn`, so keys inherited from `Object.prototype` (`constructor`, `__proto__`, `toString`) are rejected as unknown fields — [compiler.ts:validateField].
- Hidden fields (`x-hidden: true`) are rejected unless `options.allowHiddenFields === true` — [compiler.ts:validateField].
- Comparison values must be `string`, `number`, or `null`; arrays, objects, and booleans are rejected — [compiler.ts:validateScalar].
- An empty `in` list compiles to `1 = 0` rather than invalid `IN ()` SQL — [compiler.ts:compileIn].
- Every compiled column reference is double-quoted and prefixed with the hardcoded alias `t` — [compiler.ts:compileComparison].
- `like` passes its pattern through unchanged; the caller owns `%` wildcards — [compiler.ts:compileLike].
- Logical nodes parenthesize both operands and concatenate params left-then-right — [compiler.ts:compileLogical].
- `between(lo, hi)` desugars into `and(gte(lo), lte(hi))` — [builder.ts:toFieldOperand].
- `Filter.field` produces `FieldFilterOperand<unknown>`; typed narrowing only happens through `FilterBuilder<F>` — [builder.ts:FilterBuilder].

## Side Effects

- `types.ts` constructs the recursive `_filterNodeSchema` codec once at module load — [types.ts:FilterNodeSchema].
- `filterNodeToWhereClause` builds SQL strings and parameter arrays inside an `Effect`; it performs no I/O and never touches a database — [compiler.ts:filterNodeToWhereClause].
- `toFieldOperand` closes over a field name and returns fresh node objects per call; no shared mutable state — [builder.ts:toFieldOperand].

## Verification

- Run: `pnpm --filter @gettersethya/mira-collection test`
- Typecheck: `pnpm --filter @gettersethya/mira-collection typecheck`
