# Database Presets

## Overview

Preset `MiraDatabase` implementations that the App Builder's `.database()` step consumes.
Each preset bundles both the SQL client layer and the matching `Dialect` into one
`{ layer }` object, so selecting a database also selects how its schema is generated.
SQLite ships for both Node (`@effect/sql-sqlite-node`) and Bun
(`@effect/sql-sqlite-bun`); a Postgres preset would live here alongside them.

## Interface

- `SqliteDatabase(config)` — Node SQLite preset; returns a `MiraDatabase` whose `layer` provides `SqlClient` and `Dialect` [sqlite.ts:SqliteDatabase]
- `BunSqliteDatabase(config)` — Bun SQLite preset using `bun:sqlite`; same shape [sqlite-bun.ts:BunSqliteDatabase]
- The Node barrel re-exports `SqliteDatabase` [index.ts:SqliteDatabase]; the Bun entry exports `BunSqliteDatabase` and aliases it as `SqliteDatabase` [index.bun.ts:SqliteDatabase]

## Invariants

- Both presets accept `{ filename: string, synchronous?: "FULL" | "NORMAL" | "OFF" }`; `":memory:"` selects an ephemeral test database [sqlite.ts:SqliteDatabase] [sqlite-bun.ts:BunSqliteDatabase]
- Every preset explicitly enables `PRAGMA journal_mode = WAL` through the layer's own `SqlClient` (via `Layer.tap`) right after the connection opens, before the app serves requests. This does not rely on the driver default staying WAL; `":memory:"` reports `memory` and cannot use WAL [pragmas.ts:withSqlitePragmas]
- `synchronous` is applied as `PRAGMA synchronous = …` through the layer's own `SqlClient` (via `Layer.tap`) right after the connection opens and before the app serves requests; the pragma is connection-level, so it must use that client. It runs after WAL; omitted means no statement is issued and the driver default (`FULL`) stays in effect [pragmas.ts:withSqlitePragmas]
- `NORMAL` is durable across process crashes but can lose recent transactions on power loss; `OFF` is unsafe for production [pragmas.ts:SqliteSynchronousMode]
- The returned object's only property is `layer`, matching the `MiraDatabase` interface (`{ layer }`) declared in `packages/mira/src/app/types.ts` [sqlite.ts:SqliteDatabase]
- Each layer is `Layer.mergeAll` of its `SqliteClient.layer({ filename })` and `Layer.succeed(Dialect, sqliteDialect)` — the SQL client and its dialect are always paired [sqlite.ts:SqliteDatabase] [sqlite-bun.ts:BunSqliteDatabase]
- `Layer.orDie` turns a config error into a defect, so bad database config panics at startup instead of surfacing as a typed error callers must handle [sqlite.ts:SqliteDatabase]
- The boolean storage convention comes from the bundled dialect (`sqliteDialect`), not from the preset [sqlite.ts:SqliteDatabase]
- The Bun preset's `index.bun.ts` aliases `BunSqliteDatabase` as `SqliteDatabase` so the builder code is portable [index.bun.ts:SqliteDatabase]

## Side Effects

- Opens (and creates on demand) the SQLite database file named by `filename` when the layer is built [sqlite.ts:SqliteDatabase] [sqlite-bun.ts:BunSqliteDatabase]
- Registers the `Dialect` service in the Effect context as `sqliteDialect` [sqlite.ts:SqliteDatabase]
- Both presets enable WAL explicitly; the Bun driver also keeps its 5-second busy timeout default [sqlite-bun.ts:BunSqliteDatabase] [pragmas.ts:withSqlitePragmas]

## Verification

- Run: `pnpm --filter @gettersethya/mira test`
- Bun smoke: `bun run apps/example-bun/src/smoke.ts`
- Typecheck: `pnpm --filter @gettersethya/mira typecheck`
