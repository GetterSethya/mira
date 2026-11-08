# Rule

## Overview

Server-side compiler and enforcer for the rule DSL (`ExprNode` / `OperandNode`
produced by `Rule.*` in `@gettersethya/mira-client`).

`compiler.ts` is a pure tree walk that renders an expression into a SQL WHERE
fragment. It has no database access: literal values are allocated
placeholders and written into a caller-supplied `params` record, while
authorization and request references are emitted as named placeholders
(`@auth_<field>`, `@request_<source>_<key>`) that the caller resolves later.

`enforcer.ts` adapts that output to Effect SQL: it rewrites the generated
`@pN` placeholders to `?` and returns them in numeric order. `enforcerForAction`
is the policy entry point — it looks a rule up by action on a collection schema
and returns `null` when the rule is missing, which callers must treat as
deny-by-default.

## Interface

- (type) `CompileCtx` — column mapping, optional table alias, placeholder generator, param accumulator, collection schema map, and auth collection name [compiler.ts:CompileCtx]
- `compile(node, ctx)` — compiles an `ExprNode` into a WHERE-clause string, mutating `ctx.params` [compiler.ts:compile]
- `compileOperand(node, ctx)` — compiles an `OperandNode` (field, literal, auth, authId, authCollection, request, now, subquery, dateAdd, dateDiff) into SQL [compiler.ts:compileOperand]
- (type) `EnforceResult` — `{ sql, params }` with `?` placeholders [enforcer.ts:EnforceResult]
- (type) `EnforcementCtx` — the runtime values a rule may reference (`auth`, `headers`, `query`); declared but not referenced by `enforceRule` today [enforcer.ts:EnforcementCtx]
- `enforceRule(rule, overrides?)` — compiles a rule with a default alias of `t` and returns `?`-style SQL plus ordered params [enforcer.ts:enforceRule]
- `enforcerForAction(collection, action)` — resolves `collection["x-rules"][action]` and compiles it; returns `null` when `x-rules` or the action's rule is absent [enforcer.ts:enforcerForAction]

## Invariants

- `compile` is total over the `ExprNode` operations: `public`, `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`, `and`, `or`, `not`, `startsWith`, `contains` [compiler.ts:compile]
- `Rule.public()` compiles to the literal `1 = 1` and never to a placeholder [compiler.ts:compile]
- Every literal operand allocates a fresh placeholder via `ctx.nextParam()` and stores its value in `ctx.params`; no literal is ever inlined into SQL [compiler.ts:compileOperand]
- `in` with an empty literal array compiles to `1 = 0` (deny), never to a syntactically invalid `IN ()` [compiler.ts:compile]
- `in` with a non-empty literal array emits one placeholder per element, preserving element order [compiler.ts:compile]
- `and`/`or`/`not` always parenthesise their sub-expressions, so precedence never depends on the surrounding SQL [compiler.ts:compile]
- `startsWith` and `contains` compile to `LIKE` with a concatenated `%` pattern rather than escaped literal text [compiler.ts:compile]
- Auth and request operands are emitted as placeholders (`@auth_<field>`, `@auth_id`, `@auth_collection`, `@request_<source>_<key>`) and are bound by the caller, not by the compiler [compiler.ts:compileOperand]
- A field operand is prefixed with the table alias only when `ctx.tableAlias` is set **and** the operand names no explicit collection [compiler.ts:compileOperand]
- A subquery operand strips `tableAlias` before compiling its `where`, so inner field references are not prefixed with the outer alias [compiler.ts:compileOperand]
- `enforceRule` rewrites `@pN` to `?` and returns params in ascending `N` order, matching Effect SQL's positional binding [enforcer.ts:enforceRule]
- `enforceRule`'s default context uses alias `t`, `columnOfField` as identity, and an empty `collectionSchemas` map; `overrides` may replace any of them [enforcer.ts:enforceRule]
- `enforcerForAction` returns `null` — not an allow-everything clause — when `x-rules` or the requested action rule is missing; the caller owns deny-by-default [enforcer.ts:enforcerForAction]

## Side Effects

- None. Both modules only build strings and parameter arrays; `compile` mutates the caller's `ctx.params` object in memory, and `enforceRule` allocates a local parameter record. No SQL is executed, no I/O, no environment access. [compiler.ts:compile], [enforcer.ts:enforceRule]

## Verification

- Run: `pnpm --filter @gettersethya/mira test`
- Typecheck: `pnpm --filter @gettersethya/mira typecheck`
