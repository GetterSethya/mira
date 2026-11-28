# AGENTS.md - Mira

**Mira** is a self-hosted backend in TypeScript using Effect.

EGM artifact directory: .egm


## Current state

See `.plans/current-state.md` for the milestone log, plan index, implementation history, and known gaps. `.plans/` and `.egm/` are local, gitignored artifact directories, so a fresh clone will not have them.

Supported backends: SQLite (Node and Bun), libSQL/Turso, PostgreSQL, and MySQL 8.4+/MariaDB 11.4.6+.

## Stack

**Effect v4** - the project is on `effect@4` with vitest 5. Platform/SQL/RPC are consolidated into the `effect` package; only platform and driver packages remain separate.

| Layer | Package |
|---|---|
| Core | `effect` 4.0.0 |
| HTTP | `effect/http` (module in `effect` core) |
| Node runtime | `@effect/platform-node` 4.0.0 |
| Bun runtime | `@effect/platform-bun` 4.0.0 (Bun >=1.3.14) |
| SQL | `effect/sql` + `@effect/sql-sqlite-node`, `@effect/sql-sqlite-bun`, `@effect/sql-libsql`, `@effect/sql-pg`, `@effect/sql-mysql2` (all 4.0.0) |
| Testing | `@effect/vitest` 4.0.0 + `vitest` 5 |
| Tooling | TypeScript 6.0, pnpm 10.25, `@effect/tsgo` 0.74.1 + `oxlint` 1.94 + `oxlint-tsgolint` 7.0.2009 |

## Commands

| Command | Purpose |
|---|---|
| `pnpm lint` | Type-aware Effect oxlint over the workspace; warnings fail the gate |
| `pnpm -r typecheck` | Typecheck all packages (requires collection + client built first) |
| `pnpm -r test` | Run all tests across all packages |
| `pnpm --filter @gettersethya/mira-collection build` | Build collection package (must run before client) |
| `pnpm --filter @gettersethya/mira-client build` | Build client package (must run before typechecking mira/adapter/dashboard) |
| `pnpm --filter @gettersethya/mira build` | Build server package |
| `pnpm --filter @gettersethya/mira-tanstack-adapter build` | Build adapter package |
| `pnpm build` | Build all packages in dependency order (collection → client → mira → adapter → dashboard server) |
| `pnpm build:ui` | Rebuild the dashboard SPA into `packages/dashboard/ui/dist` (NOT included in `pnpm build`) |
| `pnpm bun:smoke` | Run the Bun example smoke app |
| `pnpm pack:smoke` | Pack the publishable packages and verify they install/resolve |
| `pnpm release:alpha --dry-run` | Show the next alpha version without bumping or tagging |
| `pnpm release:stable --dry-run` | Show the next stable version without bumping or tagging |
| `pnpm release:info <tag>` | Validate a tag against the package manifests |
| `pnpm --filter @gettersethya/mira-landing docs:api` | Regenerate the landing API reference with TypeDoc |
| `pnpm --filter @gettersethya/mira-landing check:docs` | Validate the docs manifest and content parity |
| `pnpm benchmark:platforms` | Run the Node vs Bun HTTP benchmark and refresh `apps/landing/src/lib/benchmarks.json` |
| `pnpm --filter mira-benchmarks perf:audit` | Run the load/profile audit (`AUDIT_MODE=load` or `AUDIT_MODE=profiles`) |
| `pnpm --filter mira-benchmarks bulk-create:audit` | Compare sequential creates with one transactional bulk create |
| `pnpm --filter mira-benchmarks create-batch:audit` | Measure the opt-in create batcher |

**Build order matters:** `@gettersethya/mira-collection` must be built before `@gettersethya/mira-client`, and both must be built before running typecheck, lint, or tests in `@gettersethya/mira`, `@gettersethya/mira-tanstack-adapter`, or `@gettersethya/mira-dashboard`. The collection and client builds run `clean-dist → tsc → tsc-alias → check-exports`, and `@gettersethya/mira`'s `tsconfig.json` maps `@gettersethya/mira-client` to `../client/dist/index.d.ts`, so the client dist is required for type resolution.

**Lint is a gate, not a suggestion.** `pnpm lint` runs `effect-tsgo oxlint -c .oxlintrc.json --deny-warnings .` after generating the landing SvelteKit types. It is type-aware (`oxlint-tsgolint`) and covers `src` and `tests` in every package. The config bans `any`, non-null assertions, type assertions, relative parent imports, and `JSON.parse`/`JSON.stringify`, and adds custom `mira/*` rules. `effecttsgo/lazy-effect` and `effecttsgo/unstable-api-usage` are off by design; `effecttsgo/any-unknown-in-error-context` applies everywhere, including tests - fix the source, do not add a test override.

`pnpm lint` generates `apps/landing/.svelte-kit/`. The telemetry API rename gate walks `apps/`, so remove that generated directory before `pnpm -r test` if it is present.

**Dashboard UI is a separate static build.** `makeDashboardSpaRoute` serves `packages/dashboard/ui/dist` - a prebuilt SvelteKit bundle that `pnpm build` does **not** regenerate. After changing anything under `packages/dashboard/ui/src`, run `pnpm build:ui` or the browser keeps running stale JS (`ui/dist` is gitignored). Browser code must never import from `packages/dashboard/src/*` files that reach `@gettersethya/mira` (Node-only) - `packages/dashboard/src/collection.ts` exists as the browser-safe home for collection definitions for exactly this reason.

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

- Each package has its own `tsconfig.json`. `"module": "NodeNext"` + `"moduleResolution": "NodeNext"` means **all local imports must include the `.js` extension** (e.g., `import { Foo } from "./bar.js"`).
- `"exactOptionalPropertyTypes": true`: `undefined` is not equivalent to absent. Use `?` or explicit omission for optional properties.
- `"declaration": true` + `"declarationMap": true` generates `.d.ts` files and maps.
- `paths` entries are relative and there is no `baseUrl` (the type-aware linter requires this): `@/*` -> `./src/*`, `@tests/*` -> `./tests/*`, and in `packages/mira` also `@gettersethya/mira-client` -> `../client/dist/index.d.ts`. `vitest.config.ts` mirrors the `@` and `@tests` aliases.
- Most packages target ES2022 with `NodeNext`; `packages/tanstack-adapter` uses `ESNext` + `bundler`. `packages/mira` includes the `node` and `bun` type libraries.

## Architecture

```
HTTP Layer (effect/http HttpRouter)
  → Collection Route Handlers (auto-generated per collection)
    → Collection Service (validation, rules, cache, batching, hooks)
      → Repository Layer (schema-agnostic CRUD)
        → SqlClient (Effect SQL) ← injected as an Effect Layer
          → SQLite / libSQL / PostgreSQL / MySQL / MariaDB
```

Collection definitions are code-first TypeScript (`BaseCollection.define()` etc.) serialized to JSON Schema with `x-` extensions, stored in the `_collections` table of the active database. The JSON Schema is the source of truth; TypeScript is just a typed way to produce it.

Database presets (`SqliteDatabase`, `BunSqliteDatabase`, `LibsqlDatabase`/`TursoDatabase`, `PostgresDatabase`, `MysqlDatabase`) live in `packages/mira/src/databases/`; dialect implementations live in `packages/mira/src/dialect/`. The main entry re-exports the Node SQLite, libSQL, PostgreSQL, and MySQL presets; `./bun` adds `BunSqliteDatabase` alongside the Bun platform. `@gettersethya/mira` also exposes `./postgres` and `./mysql` subpaths (`index.postgres.ts`, `index.mysql.ts`) so an app can avoid loading the SQLite/libSQL barrel it does not use.

## Design conventions

- `Field.*` builders (except `Field.seqId`) return `FieldDef & { view(): FieldDef & { viewOnly: true } }` with `_tag: "FieldDef"`. `Field.seqId` returns plain `FieldDef` - it is always a physical column and does not expose `.view()`. Users never construct `FieldDef` directly.
- `unique`/`indexed` on fields are TypeScript-only; normalized into `x-indexes` during serialization. They never appear on properties.
- `Index.on()` / `Index.unique()` use `<const K extends string>` for type-safe field name validation. **Must be used within `indexes: (I) => [...]` callback for auto-completion.**
- `Field.relation()` resolves collection names at call time - only the name string survives into `FieldDef`.
- `AuthCollection.define()` uses `extraFields` (not `fields`). TypeScript prevents defining system field names.
- `ViewCollection.define()` requires both `id` and `seqId` in fields, both declared with `.view()` (enforced at type level and by a runtime guard). No `indexes`. Read-only. View collections do not auto-inject system `id`/`seqId` - the user must declare them explicitly in the field map because they come from the SQL query.
- System fields use `x-system: true`. Server-managed fields (`id`, `seqId`, `created`, `updated`) additionally carry `x-generated: true` - this (not a hardcoded name list) is what excludes them from input schemas (`buildInputSchemas`) and triggers `rejectSystemFields`. `x-hidden: true` fields are stripped from non-admin API responses (list/view and now create/update/`/api/auth/me`). Auth `password` is `x-hidden: true` + `x-kind: "password"` (write-only; surfaced to the dashboard schema so forms can render it).
- `Bytes` helpers (`fromKB`, `fromMB`, `fromGB`, `fromTB`) resolve to plain `number` - use instead of raw byte values.
- `Rule.*` builders return plain objects or `FieldOperand` (intersection of `OperandNode` + fluent methods like `.eq()`). **Must be used within `rules: (R) => ({...})` callback for auto-completion.**

- `Rule.field()` and `Rule.request()` return chainable `FieldOperand` with `.eq()`, `.neq()`, `.gt()`, `.gte()`, `.lt()`, `.lte()`, `.in()`, `.startsWith()`, `.contains()`.
- `Rule.subquery()` returns `{ where: (expr) => OperandNode }` - call `.where()` to finish.
- `RuleMap` (on `CollectionSchema["x-rules"]`) stores rules per action: `list`, `view`, `create`, `update`, `delete`, plus auth-only `manage`. `BaseRuleMap` types `manage` as `never`, so a base collection cannot declare it. `manage` is evaluated in addition to create/update and never bypasses the base rule.
- The rule compiler/enforcer emits `?` placeholders plus an ordered param array. `renderRuleCheck(where, dialect)` wraps the compiled WHERE as `SELECT 1 AS ok WHERE ...`; `CollectionService` executes that trusted, parameterized statement with `sql.unsafe(check.sql, check.params)`. Repository WHERE clauses are rendered per dialect with `rewritePlaceholders`.
- `SqlClient` is a callable template-literal tag - use `sql\`...\`` for application DML. `sql(name)` produces a quoted identifier for dynamic table/column names. See the `sql.unsafe` rule below.
- No rule → no `x-rules` key → deny all at runtime. `Rule.public()` → `1 = 1` (always allow).

- `MiraPlugin` interface has `_tag: "MiraPlugin"`. All hook properties are optional. `fromLayer(layer)` wraps a plain `Layer<never, never, never>` as a `MiraPlugin`. `MiraApp.extend(plugin)` only accepts `MiraPlugin` - use `fromLayer()` for plain layers.
- `MiraPlugin.adminCollections?: ReadonlyArray<AnyCollectionDef>` is how a plugin declares a rule-bypassing admin collection (the dashboard declares its `SuperAdminCollection` there). Those definitions are automatically merged into the app's collection set by `MiraApp.#getAllCollections()` (deduped by name; app config takes precedence), and their names are passed to `makeCollectionRouter(collections, adminNames)` so a valid JWT whose `payload.col` is in that set yields `RequestCtx.admin = true` (bypassing all rule enforcement and hidden-field stripping, and permitting protected file downloads in `makeFileServeRoute`). An app with no such plugin has an empty admin set - no bypass, rules enforced for everyone. This is a plugin concern only; the app builder has no admin config.
- Pre-hooks (`onRecordCreate`, `onRecordUpdate`, `onRecordDelete`, `onRecordList`, `onRecordView`) are serial and **block** the parent effect. Execute-hooks (`onRecordCreateExecute`, etc.) are also serial and blocking. Success/error observers for records, lists, views, email, and crons are detached with `Effect.forkDetach`, so the parent does not wait; observer failures are contained by the hook runner. Bulk create/update/delete run pre/execute per record before the transaction and success/error per record after it.
- Hook context types (`RecordHookContext`, `ListHookContext`, `ViewHookContext`) use `Type | undefined` (not `prop?: Type`) due to `exactOptionalPropertyTypes: true`.
- `HookCollectionService` wraps `CollectionService` using the decorator pattern (same as `CachedCollectionService`). Layer stack: `hookCollectionServiceLayer → cachedCollectionServiceLayer → collectionServiceLayer`.
- Telemetry is driver-neutral. `makeTelemetryLayer({ storage, ... })` accepts either `{ mode: "dedicated", database: SqliteDatabase(...) }` or `{ mode: "shared" }`, composes `makeSqlTelemetryStoreLayer` with the console core, and persists logs/spans; the caller supplies the database preset (`SqliteDatabase`, `PostgresDatabase`, `MysqlDatabase`, ...). `ConsoleTelemetryLayer` / `makeConsoleTelemetryLayer` print JSON or pretty lines and are the builder default. `logCleanupCronDef` is the daily retention cron.
- The Effect schema compiler is opt-in: `.schemaCompiler({ mode: "jit" })` (default `off`) registers Mira's request-path decode roots with `SchemaJITCompiler.enable(ast)` from `src/schema-compiler/`. It is process-wide and experimental; unsupported nodes and runtimes that block `new Function` fall back to the interpreter. Benchmarks show a large isolated decode win (about 5.6x on Node, 1.6x on Bun) but no reliable end-to-end HTTP separation, so it stays off by default.
- `GET /api/_schema` returns all collection schemas (introspection endpoint).

## Prefer inferred return types

**Do not annotate return types unless necessary to shape the type.** Let TypeScript infer them. Only add an explicit return type when inference produces something too wide or wrong - for example, to narrow a union, to expose a public API surface, or to constrain what callers see.

```typescript
// ✗ Redundant - TypeScript already knows this
function add(a: number, b: number): number { return a + b }

// ✓ Inferred
function add(a: number, b: number) { return a + b }

// ✓ Explicit return type needed - narrows the inferred union to a specific shape
function parse(raw: unknown): ParsedResult { ... }
```

## No inline import() type expressions

**Never use inline `import()` expressions in type positions** (e.g. `import("@effect/platform").HttpClientRequest.HttpClientRequest`).
Always declare a top-level `import type { ... } from "..."` instead.

Inline `import()` is only appropriate in `.d.ts` declaration files or to break a genuine
circular dependency. In regular source files it hides dependencies, makes imports harder to
trace, and is never necessary.

```typescript
// ✗ Never - hides the import, hard to trace
type Foo = import("some-package").Foo

// ✓ Correct - explicit top-level import
import type { Foo } from "some-package"
```

## No reading from node_modules

**Reading directly from `node_modules/` is strictly prohibited.** `.references/` is a local, gitignored vendor checkout; use `.references/effect/` for Effect API reference when it exists. A fresh clone may not have it. Otherwise, use the public Effect v4 docs and the workspace's generated `dist/*.d.ts` declarations. Never open files under `node_modules/`.

## TypeScript-only rule

**No plain JavaScript.** Every file must be `.ts` (or `.tsx`). No `.js` or `.mjs` source files.

## No type assertions

**Never use `as any`, `as unknown`, `as never`, or any other type assertion (`as Whatever`).**
**Never use the non-null assertion operator (`!`).** Both bypass type safety and are forbidden.

If you believe `!` is necessary, the call site is wrong - fix how you are calling the code, not the type. The type is correct; your usage pattern is not.

```typescript
// ✗ Never - non-null assertion papering over a wrong call site
client.authWithPassword!().raw(...)

// ✓ Correct - call it the right way; the type already permits this
client.authWithPassword().raw(...)
```

If you need to satisfy the type system, use proper type narrowing, branded types, or explicit type annotations instead.

## Tagged errors only - never use `new Error()` for typed Effect failures

**Every failure that crosses the typed Effect error channel must be a tagged error.**
Use `Data.TaggedError` or `Schema.TaggedError` - never the plain JavaScript `Error` class
or any untagged subclass.

Plain `Error` is reserved for synchronous configuration/startup validation that throws before a layer is built (for example `MysqlConfigError`, builder misuse, view field guards) and for `Effect.die` defects that are not part of the typed error channel. Never use it for a failure a caller is expected to catch.

```typescript
// ✗ Never - plain Error loses the type in the Effect error channel
Effect.fail(new Error("not found"))
Effect.tryPromise({ try: () => fetch(url), catch: (e) => new Error(String(e)) })

// ✓ Correct - tagged error keeps the type precise and catchable by tag
class NotFoundError extends Data.TaggedError("NotFoundError")<{ id: string }> {}
class FetchError    extends Data.TaggedError("FetchError")<{ cause: unknown }> {}

Effect.fail(new NotFoundError({ id }))
Effect.tryPromise({ try: () => fetch(url), catch: (e) => new FetchError({ cause: e }) })
```

Plain `Error` widens the error channel to `Error` (or `unknown`), destroying the
discriminated union that `Effect.catchTag` / `Effect.catchTags` rely on. Tagged errors
keep each failure arm individually named and catchable without `instanceof` checks.

## Effect error narrowing - never use `instanceof`, use `Effect.catchTag` / `Effect.catchTags`

**Never use `instanceof SomeError` to narrow errors that come from the Effect error channel.** Use the Effect tag-dispatch APIs instead:

| Need | ✗ Never | ✓ Use instead |
|---|---|---|
| Handle one error tag | `if (e instanceof NotFoundError)` | `Effect.catchTag("NotFoundError", ...)` |
| Handle multiple error tags | `if (e instanceof X \|\| e instanceof Y)` | `Effect.catchTags({ NotFoundError: ..., ValidationError: ... })` |
| Map all errors to responses | `Effect.either` + `instanceof` chain | `.pipe(catchCollectionErrors)` (defined in `src/http/errors.ts`) |

Keep errors in the Effect error channel and let `Effect.catchTag`/`Effect.catchTags` dispatch on `_tag` through the Effect API - never extract to `Result` just to do manual `instanceof` checks. Route handlers should be `Effect.gen` generators that `yield*` service calls piped through the appropriate catcher.

## Result and Option - never use `_tag` directly

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
// ✗ Never - await inside Effect.gen
Effect.gen(function* () {
  await new Promise((r) => setTimeout(r, 100))
})

// ✓ Correct - yield* Effect.sleep
Effect.gen(function* () {
  yield* Effect.sleep(100)
})
```

## Testing Effect programs - always use `it.effect` (or `it.live`) from `@effect/vitest`

**Never use the standard `it` from `vitest` to test an Effect or Effectful program.** Effect values have no `.then()` method, so a vitest `it` callback that returns an Effect exits immediately without running any assertions - the test passes vacuously and silently.

Use `it.effect`, or `it.live` when the test needs real time/IO (SQLite, HTTP, driver e2e), and `describe` imported from `@effect/vitest` instead:

```typescript
// ✗ Never - test passes vacuously, assertions never run
import { describe, it, expect } from "vitest"
it("cache hit", () =>
  Effect.gen(function* () {
    const result = yield* cache.get("key")
    expect(result).toBeDefined()  // never executes
  }).pipe(Effect.provide(testLayer)))

// ✓ Correct - Effect is forked into a fiber and properly awaited
import { describe, it } from "@effect/vitest"
import { expect } from "vitest"
it.effect("cache hit", () =>
  Effect.gen(function* () {
    const result = yield* cache.get("key")
    expect(result).toBeDefined()  // executes correctly
  }).pipe(Effect.provide(testLayer)))
```

`it.effect` forks the Effect into a fiber, sets up cleanup via `ctx.onTestFinished`, joins the fiber, and surfaces any failures as test failures. `it.live` uses the live clock and IO, which is the right choice for database and HTTP suites. `expect` still comes from `vitest`.

Tests are part of the lint gate. Decode HTTP response bodies with `HttpIncomingMessage.schemaBodyJson(schema)(res)` rather than `res.json` plus `Schema.decodeUnknownEffect`; the schema-aware helper keeps `DecodingServices` and the client error channel concrete.

## Prefer Schema over JSON.parse/JSON.stringify

**Never use `JSON.parse` or `JSON.stringify` inside Effect code.** This is strictly prohibited.
Use `effect/schema` instead: `Schema.fromJsonString`, `Schema.decodeEffect` / `Schema.decodeUnknownEffect`, and `Schema.encodeEffect` / `Schema.encodeSync`.
These provide type-safe parsing with proper error channels and compose with the Effect runtime. The lint config enforces the ban with `no-restricted-properties`.

## Import paths

**Never use `../` or `../../` relative import paths.** Cross-directory imports must use the `@/` alias (e.g., `import { Foo } from "@/collection/types.js"`); test-only imports use `@tests/`. Same-directory imports may use `./` (e.g., `import { bar } from "./bar.js"`). The aliases map to `src/` and `tests/` in each package's `tsconfig.json` and `vitest.config.ts`, and `import/no-relative-parent-imports` enforces the rule.

## Typed queries with `SqlSchema`

`effect/sql` exports a `SqlSchema` module for type-safe query execution. Prefer it when a concrete result shape is known: it encodes the request through a Schema, executes the query, and decodes all rows, surfacing `ParseError` instead of requiring casts.

```typescript
import { SqlSchema } from "effect/sql"

const rows = yield* SqlSchema.findAll({
  Request: Schema.String,
  Result: ConfigRowSchema,
  execute: (key) => sql`SELECT ${sql("value")} FROM ${sql("_config")} WHERE ${sql("key")} = ${key}`
})(CRON_STATE_CONFIG_KEY)
```

It is used today in `src/config/config.ts` (config bootstrap) and `src/cron/persistence.ts` (persisted cron state); the dashboard config API uses it too. `findAll` is the common constructor; `findOne`, `single`, and `void` are also available for first-row, required-row, and no-result statements.

**When to use it:** for a concrete `Schema.Struct` result. Avoid it at the Repository layer - the repository is intentionally schema-agnostic (`RepoRecord = Record<string, unknown>`) and `SqlSchema` adds `ParseError` without meaningful decode work there.

## Avoid `sql.unsafe`

**Never use `sql.unsafe` for ad-hoc DML built from request values.** It bypasses the
query builder and couples raw strings to runtime values. Use the structured helpers
for application queries:

| Need | Use |
|---|---|
| Dynamic table / column name | `sql(name)` → dialect-quoted `Identifier` |
| INSERT | `` sql`INSERT INTO ${sql(table)} ${sql.insert(record)}` `` |
| UPDATE SET clause | `` sql`UPDATE ${sql(table)} SET ${sql.update(patch, omit)} WHERE …` `` |
| Raw SQL fragment (no params, trusted) | `sql.literal("…")` |
| IN list | `sql.in(values)` or `sql.in(column, values)` |
| AND / OR chains | `sql.and([…])` / `sql.or([…])` |

`sql.unsafe` is allowed only at trusted statement boundaries where the SQL and its
parameter array come from code, never from interpolating user input:

- DDL and migration plan execution in `src/migrator/`.
- Dialect/store statement engines: `src/repository/repository.ts`, `src/dialect/store-sql.ts`, `src/telemetry/sql-store.ts`, `src/rate-limit/sql.ts`.
- Compiled rule checks in `CollectionService` (`sql.unsafe(check.sql, check.params)` after `renderRuleCheck`).

If you reach for `sql.unsafe` anywhere else, stop and use the table above.

```typescript
// Never - ad-hoc DML via sql.unsafe
yield* sql.unsafe(`SELECT * FROM "posts" WHERE id = ?`, [id])

// Correct - template literal + identifier helper
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

The same boundary now covers more than table shape:

- `DialectType.migrationModel` is `{ kind: "transaction" }` or `{ kind: "statement" }`. SQLite/libSQL and PostgreSQL use transactional plans; MySQL/MariaDB use statement-mode plans plus a session-scoped `MigrationLock` (`mira.migrations:<hash>`). `plan`/`status` take a non-blocking preview lock and fail with `MigrationBusyError` when a migration is running.
- `DialectType.transactionProbe` decides whether the mutation batcher may continue after a failed entry. MySQL/MariaDB use the `error-classified` strategy: `1213` (deadlock) is fatal before any probe, while duplicate-key and `1205` lock-wait errors stay statement-level.
- MySQL/MariaDB indexed or unique text uses `Field.text({ maxLength })` -> `VARCHAR(n)`; unindexed text is `LONGTEXT`, and case-insensitive email identity uses `utf8mb4_0900_as_ci`.

## Key principle

> CollectionDef (JSON Schema) is the source of truth. TypeScript is a typed way to produce it.
> `Field.*` builders are the ergonomic TypeScript interface to that format.


## Gaps

Known gaps are tracked in `.plans/current-state.md#gaps` (local, gitignored; the milestone notes and evidence are under `.egm/`).
