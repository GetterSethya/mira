# rule

## Overview

The rule component is Mira's access-control DSL. It builds a serializable AST — an
`OperandNode` for values and an `ExprNode` for boolean expressions — which collections store
under `x-rules` and the server later compiles to SQL. `Rule` is the untyped entry point,
`makeRuleBuilder<F>()` produces the field-name-narrowed variant passed to `rules` callbacks
and subquery callbacks, and `types.ts` defines the AST unions plus the per-action `RuleMap`.
No SQL is produced or executed here; this component only constructs plain data.

## Interface

Values:

- `Rule` — rule builder namespace with chainable operands and boolean combinators — [builder.ts:Rule].
  - `Rule.field(name)` — record-field operand with fluent comparisons — [builder.ts:Rule.field].
  - `Rule.request(source, key)` — request header/query/body operand — [builder.ts:Rule.request].
  - `Rule.auth(collection, field)` — field from the authenticated user's record — [builder.ts:Rule.auth].
  - `Rule.authId(collection)` — id of the authenticated user — [builder.ts:Rule.authId].
  - `Rule.authCollection()` — collection name of the authenticated user — [builder.ts:Rule.authCollection].
  - `Rule.literal(value)` — literal operand preserving the value type — [builder.ts:Rule.literal].
  - `Rule.subquery(collection, field)` — returns `{ where(expr) }`, which produces a `subquery` operand; `where` also accepts a typed callback — [builder.ts:Rule.subquery].
  - `Rule.now()` — current-timestamp operand — [builder.ts:Rule.now].
  - `Rule.dateAdd(operand, amount, unit)` — date arithmetic operand — [builder.ts:Rule.dateAdd].
  - `Rule.dateDiff(left, right, unit)` — date-difference operand — [builder.ts:Rule.dateDiff].
  - `Rule.and(...exprs)` — n-ary conjunction left-folded into binary `and` nodes — [builder.ts:Rule.and].
  - `Rule.or(...exprs)` — n-ary disjunction left-folded into binary `or` nodes — [builder.ts:Rule.or].
  - `Rule.not(expr)` — negates a sub-expression — [builder.ts:Rule.not].
  - `Rule.public()` — always-true marker expression — [builder.ts:Rule.public].
- `toChainable(operand)` — attaches the fluent comparison methods to a raw operand via `Object.create`/`Object.assign` — [builder.ts:toChainable].
- `makeRuleBuilder<F>()` — returns a `RuleBuilder<F>` whose `field()` is constrained to `keyof F` and typed by `InferFieldValue` — [builder.ts:makeRuleBuilder].

Types:

- `FieldOperand<K, V>` (type) — `OperandNode<K, V>` intersected with `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`, `startsWith`, `contains` — [builder.ts:FieldOperand].
- `RuleBuilder<F>` (type) — the narrowed builder used in `rules` callbacks; adds typed `field` and typed `subquery` callbacks — [builder.ts:RuleBuilder].
- `OperandNode<K, V>` (type) — value union: `field`, `literal`, `auth`, `authId`, `authCollection`, `subquery`, `request`, `now`, `dateAdd`, `dateDiff` — [types.ts:OperandNode].
- `ExprNode<K>` (type) — expression union: comparisons, `in`, `and`/`or`/`not`, `startsWith`, `contains`, `public` — [types.ts:ExprNode].
- `RuleMap<K>` (type) — per-action rules `list` / `view` / `create` / `update` / `delete` plus the auth-only `manage` — [types.ts:RuleMap].
- `BaseRuleMap<K>` (type) — `RuleMap` without `manage`, and `manage?: never` so base/view collections cannot declare it — [types.ts:BaseRuleMap].

Barrel: `index.ts` re-exports `builder.ts` and `types.ts` wholesale, so every symbol above (including `Rule`) is available from the component barrel — [builder.ts:Rule].

## Invariants

- An `OperandNode` is exactly one of the ten documented kinds, from `field` through `dateDiff` — [types.ts:OperandNode].
- An `ExprNode` is exactly one of the comparison/logical/pattern/`public` variants; `not` wraps a nested `expr` rather than a left/right pair — [types.ts:ExprNode].
- `Rule.and` / `Rule.or` with zero arguments collapse to `{ op: "public" }`, with one argument return that argument unchanged, and otherwise left-fold into binary nodes — [builder.ts:Rule.and], [builder.ts:Rule.or].
- `RuleMap.manage` is evaluated in addition to `create` / `update`, never bypasses them, and has no effect on `list` / `view` / `delete` — [types.ts:RuleMap].
- `BaseRuleMap` types `manage` as `never` (not merely omitted) so a base/view rules callback is a compile error — [types.ts:BaseRuleMap].
- `Rule.subquery(...).where(cb)` evaluates the callback against a `RuleBuilder` scoped to the target collection's fields — [builder.ts:Rule.subquery].
- `toChainable` keeps the operand's own enumerable data and puts the methods on the prototype, so the result is still a plain operand node — [builder.ts:toChainable].
- `makeRuleBuilder` composes over `Rule` without mutating it — [builder.ts:makeRuleBuilder].
- `Rule.literal` preserves the caller's value type `V`, enabling type-checked comparisons through `RuleBuilder` — [builder.ts:Rule.literal].

## Side Effects

- Pure AST construction: `Rule.*` returns new object literals and performs no I/O — [builder.ts:Rule].
- `Rule.subquery` invokes its `where` callback eagerly at construction time and embeds the resulting expression node — [builder.ts:Rule.subquery].
- `toChainable` allocates one prototype object per operand; there is no shared mutable state, disk access, network call, or environment read — [builder.ts:toChainable].

## Verification

- Run: `pnpm --filter @gettersethya/mira-collection test`
- Typecheck: `pnpm --filter @gettersethya/mira-collection typecheck`
