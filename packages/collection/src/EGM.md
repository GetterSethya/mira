# collection src

## Overview

`src` is the package entry surface. Its only file, `index.ts`, is a pure re-export barrel:
four statements forward the `collection` component barrel, the full `collection/types.ts`
type surface, the `filter` component barrel, and the `rule` component barrel. No runtime
logic, state, or symbol is declared here.

## Interface

This directory defines no symbols of its own; it re-exports the three component packages:

- [collection/EGM.md](./collection/EGM.md) — collection builders, field/index/byte helpers, schema serialization, and inference types. Forwarded symbols include `BaseCollection` — [collection/index.ts:BaseCollection], `AuthCollection` — [collection/index.ts:AuthCollection], `ViewCollection` — [collection/index.ts:ViewCollection], `Field` — [collection/index.ts:Field], `Index` — [collection/index.ts:Index], `Bytes` — [collection/index.ts:Bytes], and `ValidationError` — [collection/index.ts:ValidationError].
- [filter/EGM.md](./filter/EGM.md) — filter AST, DSL, and SQL compiler. Forwarded symbols: `Filter` — [filter/index.ts:Filter], `filterNodeToWhereClause` — [filter/index.ts:filterNodeToWhereClause], `FilterNodeSchema` — [filter/index.ts:FilterNodeSchema].
- [rule/EGM.md](./rule/EGM.md) — rule AST and DSL. Forwarded symbols: `Rule` — [rule/builder.ts:Rule], `makeRuleBuilder` — [rule/builder.ts:makeRuleBuilder], `toChainable` — [rule/builder.ts:toChainable].
- Type-only re-exports: `CollectionSchema` — [collection/types.ts:CollectionSchema], `FieldDef` — [collection/types.ts:FieldDef], `FieldsMap` — [collection/types.ts:FieldsMap], `AnyCollectionDef` — [collection/types.ts:AnyCollectionDef], `FilterNode` — [filter/types.ts:FilterNode], `WhereClause` — [filter/types.ts:WhereClause], `ExprNode` — [rule/types.ts:ExprNode], `RuleMap` — [rule/types.ts:RuleMap].

## Invariants

- Every runtime value reachable from the package entry point is defined inside one of the three components; the barrel contributes none of its own — [collection/index.ts:Field], [filter/index.ts:Filter], [rule/builder.ts:Rule].
- Type-only names are re-exported with `export type`, so they are erased at runtime and cannot be imported as values — [collection/types.ts:CollectionSchema].
- The child barrels are the only supported component boundaries; files inside a component are not reachable through the package `"."` export — [../package.json:exports].

## Side Effects

- Importing the barrel evaluates the three child modules, which builds the recursive `FilterNodeSchema` codec once — [filter/types.ts:FilterNodeSchema].
- Importing the rule builder captures the `Rule` object literal and its methods once — [rule/builder.ts:Rule].
- The barrel itself adds no I/O: importing it only triggers each child module's own module-level construction (`FilterNodeSchema`, the `Rule` object, and the collection serialization constants) — [collection/serialize.ts:ID_PROPERTY].

## Verification

- Run: `pnpm --filter @gettersethya/mira-collection test`
- Typecheck: `pnpm --filter @gettersethya/mira-collection typecheck`
