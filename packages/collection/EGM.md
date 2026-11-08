# @gettersethya/mira-collection Blueprint

## System Overview

`@gettersethya/mira-collection` is the isomorphic definition layer of Mira. It has no
server runtime, no database access, and no Node.js built-ins: it turns fluent TypeScript
builders into portable artifact types that the server consumes.

Three concerns live here. The **collection** component compiles `BaseCollection` /
`AuthCollection` / `ViewCollection` builders into a `CollectionSchema` (JSON Schema with
`x-` extensions) plus a generic type-level projection of that schema (`InferRecord`,
`InferCreateInput`, …). The **filter** component produces and compiles a `FilterNode` AST
into a `WhereClause` of `?`-placeholder SQL. The **rule** component produces an
`OperandNode` / `ExprNode` access-control AST stored under `x-rules`. All three are
re-exported from a single package entry point so client SDKs, adapters, and the server
share one definition vocabulary.

## Subdirectories & System Boundaries

- `src`: [./src/EGM.md](./src/EGM.md) — barrel entry point plus the three definition components (`collection`, `filter`, `rule`); every runtime symbol published by the package is defined in one of them.

## Global Invariants

- The package exposes exactly one runtime entry point, `"."`, mapping to `dist/index.js` with `dist/index.d.ts` types — [package.json:exports].
- The triple of definition systems is what the entry point forwards: collection values (`BaseCollection`, `Field`, …) — [src/collection/index.ts:BaseCollection], filter values (`Filter`, `filterNodeToWhereClause`, `FilterNodeSchema`) — [src/filter/index.ts:Filter], and rule values (`Rule`, defined in `src/rule/builder.ts`) — [src/rule/builder.ts:Rule].
- A serialized collection carries rules only under the optional `x-rules` key of type `RuleMap`; an absent key therefore means no rule was declared — [src/collection/types.ts:CollectionSchema].
- `manage` is an auth-collections-only rule: the base-collection rule map types it as `never` so passing it to a base/view `rules` callback is a compile error — [src/rule/types.ts:BaseRuleMap].
- `BaseCollection.define()` forbids `id` and `seqId` in the user field map at the type level, because those columns are injected by serialization — [src/collection/base.ts:BaseForbiddenField].
- `AuthCollection.define()` forbids every system field name (`id`, `email`, `password`, `emailVerified`, `created`, `updated`, `seqId`) in `extraFields` — [src/collection/auth.ts:AuthSystemField].
- A `ViewCollection` is only valid when both `id` and `seqId` are declared with `.view()` — [src/collection/view.ts:validateViewFields].
- The only runtime dependency is `effect` (peer), so the package stays usable from browser, server, and edge bundles — [package.json:peerDependencies].

## Global Side Effects

- Importing the package evaluates the recursive `FilterNodeSchema` codec once at module load — [src/filter/types.ts:FilterNodeSchema].
- Collection schemas are computed lazily and memoized per builder instance, so the first `.schema` read mutates builder-local state — [src/collection/base.ts:makeBaseBuilder].
- There is no disk access, network call, environment read, timer, or global registry anywhere in this package; all other construction is pure object creation — [src/rule/builder.ts:Rule].

## System Verification

- Run: `pnpm --filter @gettersethya/mira-collection test`
- Typecheck: `pnpm --filter @gettersethya/mira-collection typecheck`
