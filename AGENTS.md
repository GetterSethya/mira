# AGENTS.md — Mira

**Mira** is a self-hosted backend in TypeScript using Effect.

EGM artifact directory: .egm


## Current state

See `.plans/current-state.md` for the implemented milestone log, plan index, implementation history, and known gaps. Read it on demand; it is intentionally not loaded automatically.

## Stack

**Effect v4** — the project is on `effect@4` with vitest 5. Platform/SQL/RPC are consolidated into the `effect` package; only platform/provider packages remain separate.

| Layer | Package |
|---|---|
| Core | `effect` ^4.0 |
| HTTP | `effect/http` (module in `effect` core) |
| Node runtime | `@effect/platform-node` ^4.0 |
| SQL | `effect/sql` + `@effect/sql-sqlite-node` ^4.0 |
| Testing | `@effect/vitest` ^4.0 + `vitest` ^5.0 |

## Commands

| Command | Purpose |
|---|---|
| `pnpm -r typecheck` | Typecheck all packages (requires collection + client built first) |
| `pnpm -r test` | Run all tests across all packages |
| `pnpm --filter @gettersethya/mira-collection build` | Build collection package (must run before client) |
| `pnpm --filter @gettersethya/mira-client build` | Build client package (must run before typechecking mira/adapter/dashboard) |
| `pnpm --filter @gettersethya/mira build` | Build server package |
| `pnpm --filter @gettersethya/mira-tanstack-adapter build` | Build adapter package |
| `pnpm build` | Build all packages in dependency order (collection → client → mira → adapter → dashboard server) |
| `pnpm build:ui` | Rebuild the dashboard SPA into `packages/dashboard/ui/dist` (NOT included in `pnpm build`) |
| `pnpm release:alpha --dry-run` | Show the next alpha version without bumping or tagging |
| `pnpm --filter @gettersethya/mira-landing docs:api` | Regenerate the landing API reference with TypeDoc |
| `pnpm --filter @gettersethya/mira-landing check:docs` | Validate the docs manifest and content parity |
| `pnpm benchmark:platforms` | Run the Node vs Bun HTTP benchmark and refresh `apps/landing/src/lib/benchmarks.json` |

**Build order matters:** `@gettersethya/mira-collection` must be built before `@gettersethya/mira-client`, and both must be built before running typecheck or tests in `@gettersethya/mira`, `@gettersethya/mira-tanstack-adapter`, or `@gettersethya/mira-dashboard`. The collection and client builds use `tsc && tsc-alias` to rewrite `@/` path aliases to relative imports in the dist output.

**Dashboard UI is a separate static build.** `makeDashboardSpaRoute` serves `packages/dashboard/ui/dist` — a prebuilt SvelteKit bundle that `pnpm build` does **not** regenerate. After changing anything under `packages/dashboard/ui/src`, run `pnpm build:ui` or the browser keeps running stale JS (`ui/dist` is gitignored). Browser code must never import from `packages/dashboard/src/*` files that reach `@gettersethya/mira` (Node-only) — `packages/dashboard/src/collection.ts` exists as the browser-safe home for collection definitions for exactly this reason.

**Never run any dev server.** It spawns a long-lived watch process that is hard to stop (requires Task Manager). Only validate work with `typecheck`, `test`, or lint commands.

## Version bumps and changelog

`CHANGELOG.md` is part of the release, not an afterthought. Before tagging:

1. Run `pnpm release:alpha --dry-run` (or `pnpm release:stable --dry-run`) to see the next version.
2. Move the relevant `## [Unreleased]` entries into a new `## [<version>] - <YYYY-MM-DD>` section at the top of `CHANGELOG.md`, and leave a fresh `## [Unreleased]` with `### Added`, `### Changed`, and `### Fixed` headings. The release section must be non-empty: it becomes the GitHub release body.
3. Commit the changelog change. `scripts/release.ts` refuses to run on a dirty tree, so the changelog commit must come first.
4. Run `pnpm release:alpha` (or `pnpm release:stable`) and push with `git push origin HEAD --follow-tags`. The release helper refuses to tag when the matching `## [<version>]` section is missing or empty.
5. The Publish workflow extracts that section with `scripts/release-notes.ts` and uses it as the GitHub release notes. Do not rely on `--generate-notes`, which renders only "Full Changelog" when it cannot infer notes from PRs.
6. The landing `/changelog` page reads `CHANGELOG.md` from GitHub at build time; no separate landing edit is needed once the changelog is pushed.

## Grill

Interview the user relentlessly about every aspect of this plan until we reach a shared understanding. resolving dependencies between decision one-by-one. For each question, provide your recommended answer. Ask the question one at a time. If a question can be answered by exploring the codebase, explore the codebase instead.

## Handover

When asked to hand over work, create a summary covering:
- What you were trying to do
- What implementation is already done
- What is still missing
- What tools you used
- What files you changed
- How to continue

Include your agent identity, provider, knowledge cutoff, whether thinking is enabled, and the effort level (default/low/medium/high/ultra).

Store handover documents in `.handovers/*-[TIMESTAMP]-handover.md`.

## TypeScript quirks

- `"module": "NodeNext"` + `"moduleResolution": "NodeNext"` — **all local imports must include `.js` extension** (e.g., `import { Foo } from "./bar.js"`).
- `"exactOptionalPropertyTypes": true` — `undefined` is not equivalent to absent. Use `?` or explicit omission for optional properties.
- `"declaration": true` + `"declarationMap": true` — generates `.d.ts` files.

## Architecture

```
HTTP Layer (effect/http HttpRouter)
  → Collection Route Handlers (auto-generated per collection)
    → Collection Service (validation, business logic)
      → Repository Layer (CRUD abstraction)
        → SqlClient (Effect SQL) ← injected as Effect Layer
          → SQLite (swappable)
```

Collection definitions are code-first TypeScript (`BaseCollection.define()` etc.) serialized to JSON Schema with `x-` extensions, stored in SQLite `_collections` table. The JSON Schema is the source of truth; TypeScript is just a typed way to produce it.

## Design conventions

- `Field.*` builders return `ViewableFieldDef` (`FieldDef & { view(): FieldDef & { viewOnly: true } }`) with `_tag: "FieldDef"`. Exception: `Field.seqId` returns plain `FieldDef` — it is always a physical column and does not expose `.view()`. Users never construct `FieldDef` directly.
- `unique`/`indexed` on fields are TypeScript-only; normalized into `x-indexes` during serialization. They never appear on properties.
- `Index.on()` / `Index.unique()` use `<const K extends string>` for type-safe field name validation. **Must be used within `indexes: (I) => [...]` callback for auto-completion.**
- `Field.relation()` resolves collection names at call time — only the name string survives into `FieldDef`.
- `AuthCollection.define()` uses `extraFields` (not `fields`). TypeScript prevents defining system field names.
- `ViewCollection.define()` requires both `id` and `seqId` in fields, both declared with `.view()` (enforced at type level and by a runtime guard). No `indexes`. Read-only. View collections do not auto-inject system `id`/`seqId` — the user must declare them explicitly in the field map because they come from the SQL query.
- System fields use `x-system: true`. Server-managed fields (`id`, `seqId`, `created`, `updated`) additionally carry `x-generated: true` — this (not a hardcoded name list) is what excludes them from input schemas (`buildInputSchemas`) and triggers `rejectSystemFields`. `x-hidden: true` fields are stripped from non-admin API responses (list/view and now create/update/`/api/auth/me`). Auth `password` is `x-hidden: true` + `x-kind: "password"` (write-only; surfaced to the dashboard schema so forms can render it).
- `Bytes` helpers (`fromKB`, `fromMB`, `fromGB`, `fromTB`) resolve to plain `number` — use instead of raw byte values.
- `Rule.*` builders return plain objects or `FieldOperand` (intersection of `OperandNode` + fluent methods like `.eq()`). **Must be used within `rules: (R) => ({...})` callback for auto-completion.**

- `Rule.field()` and `Rule.request()` return chainable `FieldOperand` with `.eq()`, `.neq()`, `.gt()`, `.gte()`, `.lt()`, `.lte()`, `.in()`, `.startsWith()`, `.contains()`.
- `Rule.subquery()` returns `{ where: (expr) => OperandNode }` — call `.where()` to finish.
- `RuleMap` (on `CollectionSchema["x-rules"]`) stores rules per action: `list`, `view`, `create`, `update`, `delete`.
- Compiler outputs `?`-style placeholders for Effect SQL compatibility. Wrap enforcer output with `Statement.literal(w.sql, w.params)` from `effect/sql/Statement` and splice into a template literal — do not pass to `sql.unsafe`.
- `SqlClient` is a callable template-literal tag — use `sql\`...\`` for all DML. `sql(name)` produces a quoted identifier for dynamic table/column names. See the `sql.unsafe` rule below.
- No rule → no `x-rules` key → deny all at runtime. `Rule.public()` → `1 = 1` (always allow).

- `MiraPlugin` interface has `_tag: "MiraPlugin"`. All hook properties are optional. `fromLayer(layer)` wraps a plain `Layer<never, never, never>` as a `MiraPlugin`. `MiraApp.extend(plugin)` only accepts `MiraPlugin` — use `fromLayer()` for plain layers.
- `MiraPlugin.adminCollections?: ReadonlyArray<AnyCollectionDef>` is how a plugin declares a rule-bypassing admin collection (the dashboard declares its `SuperAdminCollection` there). Those definitions are automatically merged into the app's collection set by `MiraApp.#getAllCollections()` (deduped by name; app config takes precedence), and their names are passed to `makeCollectionRouter(collections, adminNames)` so a valid JWT whose `payload.col` is in that set yields `RequestCtx.admin = true` (bypassing all rule enforcement and hidden-field stripping, and permitting protected file downloads in `makeFileServeRoute`). An app with no such plugin has an empty admin set — no bypass, rules enforced for everyone. This is a plugin concern only; the app builder has no admin config.
- Pre-hooks (`onRecordCreate`, `onRecordUpdate`, `onRecordDelete`, `onRecordList`, `onRecordView`) are serial and **block** the parent effect. Execute-hooks (`onRecordCreateExecute`, etc.) are also serial and blocking. Success/error hooks are fire-and-forget via `Effect.forkDaemon` — parent doesn't wait, errors are logged but don't affect the operation.
- Hook context types (`RecordHookContext`, `ListHookContext`, `ViewHookContext`) use `Type | undefined` (not `prop?: Type`) due to `exactOptionalPropertyTypes: true`.
- `HookCollectionService` wraps `CollectionService` using the decorator pattern (same as `CachedCollectionService`). Layer stack: `hookCollectionServiceLayer → cachedCollectionServiceLayer → collectionServiceLayer`.
- `SqliteTelemetryLayer` persists all `Effect.log()` output to a `logs` table in a separate SQLite database. Use `makeSqliteTelemetryLayer({ sqlLayer: SqliteClient.layer({ filename: "mira-logs.db" }), logConsole: true })` in the builder's `.telemetry()` step. The caller supplies the SQLite driver layer (`@effect/sql-sqlite-node` on Node, `@effect/sql-sqlite-bun` on Bun); the telemetry core has no driver dependency.
- `GET /api/_schema` returns all collection schemas (introspection endpoint).

## Prefer inferred return types

**Do not annotate return types unless necessary to shape the type.** Let TypeScript infer them. Only add an explicit return type when inference produces something too wide or wrong — for example, to narrow a union, to expose a public API surface, or to constrain what callers see.

```typescript
// ✗ Redundant — TypeScript already knows this
function add(a: number, b: number): number { return a + b }

// ✓ Inferred
function add(a: number, b: number) { return a + b }

// ✓ Explicit return type needed — narrows the inferred union to a specific shape
function parse(raw: unknown): ParsedResult { ... }
```

## No inline import() type expressions

**Never use inline `import()` expressions in type positions** (e.g. `import("@effect/platform").HttpClientRequest.HttpClientRequest`).
Always declare a top-level `import type { ... } from "..."` instead.

Inline `import()` is only appropriate in `.d.ts` declaration files or to break a genuine
circular dependency. In regular source files it hides dependencies, makes imports harder to
trace, and is never necessary.

```typescript
// ✗ Never — hides the import, hard to trace
type Foo = import("some-package").Foo

// ✓ Correct — explicit top-level import
import type { Foo } from "some-package"
```

## No reading from node_modules

**Reading directly from `node_modules/` is strictly prohibited.** To understand any package's API, use the reference source at `.references/effect/` (for Effect packages) or read `.d.ts` type declaration files via the TypeScript compiler output. Any attempt to read files under `node_modules/` will result in immediate shutdown.

## TypeScript-only rule

**No plain JavaScript.** Every file must be `.ts` (or `.tsx`). No `.js` or `.mjs` source files.

## No type assertions

**Never use `as any`, `as unknown`, `as never`, or any other type assertion (`as Whatever`).**
**Never use the non-null assertion operator (`!`).** Both bypass type safety and are forbidden.

If you believe `!` is necessary, the call site is wrong — fix how you are calling the code, not the type. The type is correct; your usage pattern is not.

```typescript
// ✗ Never — non-null assertion papering over a wrong call site
client.authWithPassword!().raw(...)

// ✓ Correct — call it the right way; the type already permits this
client.authWithPassword().raw(...)
```

If you need to satisfy the type system, use proper type narrowing, branded types, or explicit type annotations instead.

## Tagged errors only — never use `new Error()` in Effect code

**Every error raised inside an Effect or effectful operation must be a tagged error.**
Use `Data.TaggedError` or `Schema.TaggedError` — never the plain JavaScript `Error` class
or any untagged subclass.

```typescript
// ✗ Never — plain Error loses the type in the Effect error channel
Effect.fail(new Error("not found"))
Effect.tryPromise({ try: () => fetch(url), catch: (e) => new Error(String(e)) })

// ✓ Correct — tagged error keeps the type precise and catchable by tag
class NotFoundError extends Data.TaggedError("NotFoundError")<{ id: string }> {}
class FetchError    extends Data.TaggedError("FetchError")<{ cause: unknown }> {}

Effect.fail(new NotFoundError({ id }))
Effect.tryPromise({ try: () => fetch(url), catch: (e) => new FetchError({ cause: e }) })
```

Plain `Error` widens the error channel to `Error` (or `unknown`), destroying the
discriminated union that `Effect.catchTag` / `Effect.catchTags` rely on. Tagged errors
keep each failure arm individually named and catchable without `instanceof` checks.

## Effect error narrowing — never use `instanceof`, use `Effect.catchTag` / `Effect.catchTags`

**Never use `instanceof SomeError` to narrow errors that come from the Effect error channel.** Use the Effect tag-dispatch APIs instead:

| Need | ✗ Never | ✓ Use instead |
|---|---|---|
| Handle one error tag | `if (e instanceof NotFoundError)` | `Effect.catchTag("NotFoundError", ...)` |
| Handle multiple error tags | `if (e instanceof X \|\| e instanceof Y)` | `Effect.catchTags({ NotFoundError: ..., ValidationError: ... })` |
| Map all errors to responses | `Effect.either` + `instanceof` chain | `.pipe(catchCollectionErrors)` (defined in `src/http/errors.ts`) |

Keep errors in the Effect error channel and let `Effect.catchTag`/`Effect.catchTags` dispatch on `_tag` through the Effect API — never extract to `Result` just to do manual `instanceof` checks. Route handlers should be `Effect.gen` generators that `yield*` service calls piped through the appropriate catcher.

## Result and Option — never use `_tag` directly

**Never access `._tag` on `Result` or `Option` values.** Use the type-safe predicate methods instead:

| Type | ✗ Never | ✓ Use instead |
|---|---|---|
| `Result` | `x._tag === "Failure"` | `Result.isFailure(x)` |
| `Result` | `x._tag === "Success"` | `Result.isSuccess(x)` |
| `Option` | `x._tag === "Some"` | `Option.isSome(x)` |
| `Option` | `x._tag === "None"` | `Option.isNone(x)` |

`_tag` is an internal implementation detail. The predicate methods are the public API and act as proper TypeScript type guards, narrowing the type so `.left`, `.right`, or `.value` are accessible without unsafe casts.

## No try/catch in Effect generators

**Never use `try/catch` blocks inside `Effect.gen` generator functions.** This is strictly prohibited.
Use Effect error-handling APIs instead: `Effect.catch`, `Effect.catchTag`, `Effect.try`, `Effect.tryPromise`. 
These preserve the error type in the Effect channel and compose properly with the Effect runtime.

## No async/await inside Effect generators

**Never use `async`/`await` inside `Effect.gen` generator functions.** `Effect.gen` takes a plain generator function (`function*`), not an async generator (`async function*`). Using `await` inside it is a syntax error or silently incorrect behavior.

Use `yield*` with Effect APIs instead:

| Need | Use |
|---|---|
| Delay / sleep | `yield* Effect.sleep(ms)` |
| Wrap a Promise | `yield* Effect.promise(() => somePromise())` |
| Wrap a Promise that can reject | `yield* Effect.tryPromise({ try: () => p, catch: (e) => new MyError(e) })` |
| Run another Effect | `yield* myEffect` |

```typescript
// ✗ Never — await inside Effect.gen
Effect.gen(function* () {
  await new Promise((r) => setTimeout(r, 100))
})

// ✓ Correct — yield* Effect.sleep
Effect.gen(function* () {
  yield* Effect.sleep(100)
})
```

## Testing Effect programs — always use `it.effect` from `@effect/vitest`

**Never use the standard `it` from `vitest` to test an Effect or Effectful program.** Effect values have no `.then()` method, so a vitest `it` callback that returns an Effect exits immediately without running any assertions — the test passes vacuously and silently.

Use `it.effect` (and `describe`) imported from `@effect/vitest` instead:

```typescript
// ✗ Never — test passes vacuously, assertions never run
import { describe, it, expect } from "vitest"
it("cache hit", () =>
  Effect.gen(function* () {
    const result = yield* cache.get("key")
    expect(result).toBeDefined()  // never executes
  }).pipe(Effect.provide(testLayer)))

// ✓ Correct — Effect is forked into a fiber and properly awaited
import { describe, it } from "@effect/vitest"
import { expect } from "vitest"
it.effect("cache hit", () =>
  Effect.gen(function* () {
    const result = yield* cache.get("key")
    expect(result).toBeDefined()  // executes correctly
  }).pipe(Effect.provide(testLayer)))
```

`it.effect` forks the Effect into a fiber, sets up cleanup via `ctx.onTestFinished`, joins the fiber, and surfaces any failures as test failures. `expect` still comes from `vitest`.

## Prefer Schema over JSON.parse/JSON.stringify

**Never use `JSON.parse` or `JSON.stringify` inside Effect code.** This is strictly prohibited.
Use `effect/schema` (`Schema.parseJson`, `Schema.decodeUnknown`, `Schema.encode`) instead.
These provide type-safe parsing with proper error channels and compose with the Effect runtime.

## Import paths

**Never use `../` or `../../` relative import paths.** All cross-directory imports must use the `@/` alias (e.g., `import { Foo } from "@/collection/types.js"`). Same-directory imports may use `./` (e.g., `import { bar } from "./bar.js"`). The `@/` alias maps to `src/` as configured in `tsconfig.json` and `vitest.config.ts`.

## Typed queries with `SqlSchema`

`effect/sql` exports a `SqlSchema` module for type-safe query execution. Prefer it
over raw template literals whenever a concrete result shape is known. It encodes the
request through a Schema, executes the query, and decodes all rows — surfacing
`ParseError` in the Effect error channel instead of requiring `as` casts.

```typescript
import { SqlSchema } from "effect/sql"
import { Schema } from "effect"

// Returns Option<Post> — decodes the first row or None
const findPost = SqlSchema.findOne({
  Request: Schema.String,           // input: post id
  Result: PostSchema,               // output: decoded Post
  execute: (id) => sql`SELECT * FROM ${sql("posts")} t WHERE t.id = ${id} LIMIT 1`
})

// Returns ReadonlyArray<Post>
const listPosts = SqlSchema.findAll({
  Request: Schema.Void,
  Result: PostSchema,
  execute: () => sql`SELECT * FROM ${sql("posts")} t`
})

// Returns Post or fails with NoSuchElementException
const getPost = SqlSchema.single({ Request: ..., Result: PostSchema, execute: ... })

// Fire-and-forget (INSERT / UPDATE / DELETE with no return value)
const deletePost = SqlSchema.void({ Request: Schema.String, execute: (id) => sql`DELETE FROM ...` })
```

**When to use it:**
- At the Collection Service layer and above, where a concrete `Schema.Struct` for the
  collection is available.
- Avoid at the Repository layer — the repository is intentionally schema-agnostic
  (`RepoRecord = Record<string, unknown>`) and `SqlSchema` adds `ParseError` to the
  error channel without meaningful decode work at that level.

## Avoid `sql.unsafe`

**Never use `sql.unsafe` for DML (SELECT, INSERT, UPDATE, DELETE).** It bypasses the
query builder and couples raw strings to runtime values. Use the structured helpers
instead:

| Need | Use |
|---|---|
| Dynamic table / column name | `sql(name)` → dialect-quoted `Identifier` |
| INSERT | `` sql`INSERT INTO ${sql(table)} ${sql.insert(record)}` `` |
| UPDATE SET clause | `` sql`UPDATE ${sql(table)} SET ${sql.update(patch, omit)} WHERE …` `` |
| Pre-compiled WHERE (enforcer output) | `Statement.literal(w.sql, w.params)` from `effect/sql/Statement`, then interpolate |
| Raw SQL fragment (no params, trusted) | `sql.literal("…")` |
| IN list | `sql.in(values)` or `sql.in(column, values)` |
| AND / OR chains | `sql.and([…])` / `sql.or([…])` |

`sql.unsafe` is acceptable **only for DDL** (CREATE TABLE, ALTER TABLE, DROP TABLE,
CREATE INDEX, etc.) because DDL structure cannot be expressed through the template
literal API. The migrator uses it for this purpose. If you reach for `sql.unsafe`
outside of DDL, stop and check the table above first. If there genuinely is no
alternative, leave a comment explaining why.

```typescript
// ✗ Never — DML via sql.unsafe
yield* sql.unsafe(`SELECT * FROM "posts" WHERE id = ?`, [id])

// ✓ Correct — template literal + identifier helper
yield* sql`SELECT * FROM ${sql("posts")} t WHERE t.id = ${id} LIMIT 1`
```

## Dialect boundary (migrations)

The migrator never translates a step itself - it renders the whole plan through
`DialectType.translatePlan(steps, ctx)`, where `ctx.tables` maps each physical collection to
its `{ stored, desired }` `TableShapes`. `MigrationStep`, `schema-diff` and `Migrator.plan()`
therefore stay dialect-agnostic: a dialect that cannot express a step on its own coalesces
the affected table's steps *inside* `translatePlan` (SQLite has no `ALTER COLUMN`, so
`sqliteDialect` rebuilds the table there), and a dialect that can express every step uses
`perStepPlan(translate)`. `translate` remains the per-step primitive and must render at least
one statement per step. A plan is rendered and validated **inside** the migration transaction,
after `DialectType.migrationTransactionSetupSql` and before any plan DDL, so an impossible
plan fails with `UnsupportedMigrationStepError` / `InvalidMigrationStatementError` instead of
a driver error; PostgreSQL's transaction-scoped advisory lock serializes concurrent boots, and
`plan`/`status` take a non-blocking `migrationPreviewLockSql` and fail with
`MigrationBusyError` when a migration is running. Dialect-declared `cleanup` statements run
after the transaction on both the committed and the rolled-back path.

## Key principle

> CollectionDef (JSON Schema) is the source of truth. TypeScript is a typed way to produce it.
> `Field.*` builders are the ergonomic TypeScript interface to that format.


## Gaps

Known gaps are tracked in `.plans/current-state.md#gaps`.
