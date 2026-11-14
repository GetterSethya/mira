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

- Both presets accept exactly `{ filename: string }`; `":memory:"` selects an ephemeral test database [sqlite.ts:SqliteDatabase] [sqlite-bun.ts:BunSqliteDatabase]
- The returned object's only property is `layer`, matching the `MiraDatabase` interface (`{ layer }`) declared in `packages/mira/src/app/types.ts` [sqlite.ts:SqliteDatabase]
- Each layer is `Layer.mergeAll` of its `SqliteClient.layer({ filename })` and `Layer.succeed(Dialect, sqliteDialect)` — the SQL client and its dialect are always paired [sqlite.ts:SqliteDatabase] [sqlite-bun.ts:BunSqliteDatabase]
- `Layer.orDie` turns a config error into a defect, so bad database config panics at startup instead of surfacing as a typed error callers must handle [sqlite.ts:SqliteDatabase]
- The boolean storage convention comes from the bundled dialect (`sqliteDialect`), not from the preset [sqlite.ts:SqliteDatabase]
- The Bun preset's `index.bun.ts` aliases `BunSqliteDatabase` as `SqliteDatabase` so the builder code is portable [index.bun.ts:SqliteDatabase]

## Side Effects

- Opens (and creates on demand) the SQLite database file named by `filename` when the layer is built [sqlite.ts:SqliteDatabase] [sqlite-bun.ts:BunSqliteDatabase]
- Registers the `Dialect` service in the Effect context as `sqliteDialect` [sqlite.ts:SqliteDatabase]
- The Bun driver enables WAL and a 5-second busy timeout by default [sqlite-bun.ts:BunSqliteDatabase]

## Verification

- Run: `pnpm --filter @gettersethya/mira test`
- Bun smoke: `bun run apps/example-bun/src/smoke.ts`
- Typecheck: `pnpm --filter @gettersethya/mira typecheck`
