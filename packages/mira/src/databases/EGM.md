# Database Presets

## Overview

Preset `MiraDatabase` implementations that the App Builder's `.database()` step consumes.
Each preset bundles both the SQL client layer and the matching `Dialect` into one
`{ layer }` object, so selecting a database also selects how its schema is generated.
Only SQLite is shipped today; a Postgres preset would live here alongside it.

## Interface

- `SqliteDatabase(config)` — returns a `MiraDatabase` whose `layer` provides `SqlClient` and `Dialect` [sqlite.ts:SqliteDatabase]
- Barrel re-exports `SqliteDatabase` [index.ts:SqliteDatabase]

## Invariants

- `SqliteDatabase` accepts exactly `{ filename: string }`; `":memory:"` selects an ephemeral test database [sqlite.ts:SqliteDatabase]
- The returned object's only property is `layer`, matching the `MiraDatabase` interface (`{ layer }`) declared in `packages/mira/src/app/types.ts` [sqlite.ts:SqliteDatabase]
- The layer is `Layer.mergeAll` of `SqliteClient.layer({ filename })` and `Layer.succeed(Dialect, sqliteDialect)` — the SQL client and its dialect are always paired [sqlite.ts:SqliteDatabase]
- `Layer.orDie` turns a `ConfigError` into a defect, so bad database config panics at startup instead of surfacing as a typed error callers must handle [sqlite.ts:SqliteDatabase]
- The boolean storage convention comes from the bundled dialect (`sqliteDialect`), not from this preset [sqlite.ts:SqliteDatabase]

## Side Effects

- Opens (and creates on demand) the SQLite database file named by `filename` when the layer is built [sqlite.ts:SqliteDatabase]
- Registers the `Dialect` service in the Effect context as `sqliteDialect` [sqlite.ts:SqliteDatabase]

## Verification

- Run: `pnpm --filter @gettersethya/mira test`
- Typecheck: `pnpm --filter @gettersethya/mira typecheck`
