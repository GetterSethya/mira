# Rule

## Overview

Server-side compiler and enforcer for the rule DSL (`ExprNode` / `OperandNode`
produced by `Rule.*` in `@gettersethya/mira-client`).

`compiler.ts` is a pure tree walk that renders an expression into a SQL WHERE
fragment using the active `Dialect` capability object. It has no database
access: literal values are allocated placeholders and written into a
caller-supplied `params` record, while authorization and request references are
emitted as named placeholders (`@auth_<field>`, `@request_<source>_<key>`) that
the caller resolves later. Identifiers, current time, date arithmetic, date
difference, and case-insensitive LIKE are dialect-rendered.

`enforcer.ts` adapts that output to Effect SQL: it rewrites the generated
`@pN` placeholders to `?` through the quote-aware SQL scanner and returns them
in numeric order. `payloadEnforcerForAction` compiles create and manage
pre-checks with typed `@field_<type>_<token>@` markers that `resolveFieldRefs`
binds to payload values. `enforcerForAction`
is the policy entry point â€” it looks a rule up by action on a collection schema
and returns `null` when the rule is missing, which callers must treat as
deny-by-default.

## Interface

- (type) `CompileCtx` â€” column mapping, optional table alias, placeholder generator, param accumulator, collection schema map, and auth collection name [compiler.ts:CompileCtx]
- `compile(node, ctx, dialect)` â€” compiles an `ExprNode` into a WHERE-clause string, mutating `ctx.params` [compiler.ts:compile]
- `compileOperand(node, ctx, dialect, typeHint?)` â€” compiles an `OperandNode` (field, literal, auth, authId, authCollection, request, now, subquery, dateAdd, dateDiff) into SQL [compiler.ts:compileOperand]
- (type) `EnforceResult` â€” `{ sql, params }` with `?` placeholders [enforcer.ts:EnforceResult]
- (type) `EnforcementCtx` â€” the runtime values a rule may reference (`auth`, `headers`, `query`); declared but not referenced by `enforceRule` today [enforcer.ts:EnforcementCtx]
- `enforceRule(rule, dialect, overrides?)` â€” compiles a rule with a default alias of `t` and returns `?`-style SQL plus ordered params [enforcer.ts:enforceRule]
- `enforcerForAction(collection, action, dialect)` â€” resolves `collection["x-rules"][action]` and compiles it; returns `null` when `x-rules` or the action's rule is absent [enforcer.ts:enforcerForAction]

## Invariants

- `compile` is total over the `ExprNode` operations: `public`, `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`, `and`, `or`, `not`, `startsWith`, `contains` [compiler.ts:compile]
- `Rule.public()` compiles to the literal `1 = 1` and never to a placeholder [compiler.ts:compile]
- Every literal operand allocates a fresh placeholder via `ctx.nextParam()` and stores its value in `ctx.params`; no literal is ever inlined into SQL [compiler.ts:compileOperand]
- `in` with an empty literal array compiles to `1 = 0` (deny), never to a syntactically invalid `IN ()` [compiler.ts:compile]
- `in` with a non-empty literal array emits one placeholder per element, preserving element order [compiler.ts:compile]
- `and`/`or`/`not` always parenthesise their sub-expressions, so precedence never depends on the surrounding SQL [compiler.ts:compile]
- `startsWith` and `contains` compile through `RuleSqlDialect.caseInsensitiveLike`; SQLite renders `LIKE ... ESCAPE '\'`, PostgreSQL renders `ILIKE ... ESCAPE E'\\'`, and the pattern value is concatenated rather than escaped [compiler.ts:compile] [dialect-sqlite.ts:caseInsensitiveLikeSql] [dialect-postgres.ts:postgresRuleSql]
- Auth and request operands are emitted as placeholders (`@auth_<field>`, `@auth_id`, `@auth_collection`, `@request_<source>_<key>`) and are bound by the caller, not by the compiler [compiler.ts:compileOperand]
- A field operand is quoted through `RuleSqlDialect.quoteIdentifier`; it is prefixed with the table alias only when `ctx.tableAlias` is set and the operand names no explicit collection. Payload mode emits a typed marker instead [compiler.ts:compileOperand]
- A subquery operand strips `tableAlias` before compiling its `where`, so inner field references are not prefixed with the outer alias [compiler.ts:compileOperand]
- `enforceRule` rewrites `@pN` to `?` through `transformSqlCode` and returns params in ascending `N` order, matching Effect SQL's positional binding [enforcer.ts:enforceRule] [sql-text.ts:transformSqlCode]
- `enforceRule`'s default context uses alias `t`, `columnOfField` as identity, and an empty `collectionSchemas` map; `overrides` may replace any of them [enforcer.ts:enforceRule]
- `enforcerForAction` returns `null` â€” not an allow-everything clause â€” when `x-rules` or the requested action rule is missing; the caller owns deny-by-default [enforcer.ts:enforcerForAction]

## Side Effects

- None. Both modules only build strings and parameter arrays; `compile` mutates the caller's `ctx.params` object in memory, and `enforceRule` allocates a local parameter record. No SQL is executed, no I/O, no environment access. [compiler.ts:compile], [enforcer.ts:enforceRule]

## Verification

- Run: `pnpm --filter @gettersethya/mira test`
- Typecheck: `pnpm --filter @gettersethya/mira typecheck`

## Dialect boundary (issue #45)

- compile(node, ctx, dialect) and compileOperand(node, ctx, dialect, typeHint?) render identifiers, current time, date add/diff, and case-insensitive LIKE through RuleSqlDialect [compiler.ts:compile] [compiler.ts:compileOperand].
- enforceRule(rule, dialect, overrides?) and enforcerForAction(schema, action, dialect) render normal column SQL. payloadEnforcerForAction(schema, action, dialect) renders typed payload markers for create and manage pre-checks [enforcer.ts:enforceRule] [enforcer.ts:payloadEnforcerForAction].
- The compiled-rule cache is keyed by schema, dialect, field-ref mode, and action. A SQLite rule can never be reused for a PostgreSQL dialect [enforcer.ts:compiledRuleCache].
- @pN and context placeholder replacement skip quoted identifiers and string literals through sql-text.ts [sql-text.ts:transformSqlCode] [sql-text.ts:forEachSqlCode].
- SQLite keeps the legacy date SQL. PostgreSQL rendering lives in dialect-postgres.ts as a pure `RuleSqlDialect` capability composed into `postgresDialect`, not a database preset [dialect-postgres.ts:postgresRuleSql] [dialect-postgres.ts:postgresDialect].

## PostgreSQL comparison casts (issue #29)

- `FieldValueType` adds `"bigint"`. `fieldTypeOf` maps `x-kind: "seqId"` to `"bigint"`, and `RuleSqlDialect.castValue` renders `::bigint` on PostgreSQL while SQLite `castValue` remains the identity [dialect.ts:FieldValueType] [enforcer.ts:fieldTypeOf] [dialect-postgres.ts:postgresRuleSql].
- `hintForComparison` uses the column type when one side is a known column and the other is a string literal. The literal is cast through `typedParam`, and the column stays uncast. PostgreSQL examples: `t."age" >= $1::integer`, `t."active" = $1::boolean`, `t."price" > $1::double precision`, and `t."seqId" > $1::bigint` [compiler.ts:hintForComparison].
- SQLite SQL is unchanged because its `castValue` is the identity. A string that cannot be parsed as the column type fails in PostgreSQL instead of comparing lexicographically [compiler.ts:hintForComparison] [dialect-sqlite.ts:sqliteDialect].
- A rule-bearing read or `renderRuleCheck` payload check that fails with SQLSTATE `22P02` (invalid text representation) or `22003` (numeric value out of range) becomes a 422 `ValidationError` in the collection service. `42883` (undefined operator or function) remains a 500 because it indicates a compiler or schema defect [collection-service.ts:CollectionService].
- `postgresRuleSql.caseInsensitiveLike` renders `ILIKE ... ESCAPE E'\\'`, and `postgresFilterSql.caseInsensitivePattern` does the same for user filters. SQLite renders `ESCAPE '\'`. Both engines treat backslash as the escape character for `%` and `_`, and the pattern stays a bound parameter [dialect-postgres.ts:postgresRuleSql] [dialect-sqlite.ts:sqliteDialect].
