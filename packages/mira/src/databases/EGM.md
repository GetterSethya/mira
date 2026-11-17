# Database Presets

## Overview

Preset `MiraDatabase` implementations that the App Builder's `.database()` step consumes.
Each preset bundles both the SQL client layer and the matching `Dialect` into one
`{ layer }` object, so selecting a database also selects how its schema is generated.
SQLite ships for Node (`@effect/sql-sqlite-node`), Bun
(`@effect/sql-sqlite-bun`), and Node libSQL (`@effect/sql-libsql`). A Postgres
preset would live here alongside them.

## Interface

- `SqliteDatabase(config)` - Node SQLite preset; returns a `MiraDatabase` whose `layer` provides `SqlClient` and `Dialect` [sqlite.ts:SqliteDatabase]
- `BunSqliteDatabase(config)` - Bun SQLite preset using `bun:sqlite`; same shape [sqlite-bun.ts:BunSqliteDatabase]
- `LibsqlDatabase(config)` - Node libSQL preset backed by `@effect/sql-libsql`; local `file:`/`:memory:` or remote `libsql:`, `http(s):`, `ws(s):` URLs [libsql.ts:LibsqlDatabase]
- `TursoDatabase` - alias for `LibsqlDatabase` [libsql.ts:TursoDatabase]
- `LibsqlConfigError` - thrown for an unknown URL scheme or invalid option combination [libsql.ts:LibsqlConfigError]
- The Node barrel re-exports `SqliteDatabase`, `LibsqlDatabase`, and `TursoDatabase` [index.ts:SqliteDatabase]; the Bun entry exports `BunSqliteDatabase` and aliases it as `SqliteDatabase` [index.bun.ts:SqliteDatabase]. libSQL is Node-only in this issue.

## Invariants

- SQLite presets accept `{ filename: string, synchronous?: "FULL" | "NORMAL" | "OFF" }`; `":memory:"` selects an ephemeral test database [sqlite.ts:SqliteDatabase] [sqlite-bun.ts:BunSqliteDatabase]
- `LibsqlDatabase` accepts `{ url, authToken?, syncUrl?, syncInterval?, synchronous? }`. `authToken` is a `Redacted<string>`. `syncInterval` is in seconds [libsql.ts:LibsqlDatabaseConfig]
- URL classification is pure and single-source: `:memory:` and `file:` are local; `libsql:`, `http:`, `https:`, `ws:`, and `wss:` are remote; anything else throws [dialect-libsql.ts:libsqlConnectionMode]
- Remote URLs reject `synchronous`, `syncUrl`, and a plain local URL rejects `authToken` unless it is a `file:` replica with `syncUrl`. `:memory:` cannot be a replica. `syncInterval` requires `syncUrl` [libsql.ts:LibsqlDatabase]
- A `syncUrl` preset sets `migrateAtStartup: false`. The app skips auto-migration on a replica; the operator migrates the primary and syncs first [libsql.ts:LibsqlDatabase] [app.ts:buildServiceLayer]
- Every local SQLite preset explicitly enables `PRAGMA journal_mode = WAL` through the layer's own `SqlClient` (via `Layer.tap`) right after the connection opens, before the app serves requests. This does not rely on the driver default staying WAL; `":memory:"` reports `memory` and cannot use WAL. Remote libSQL skips this because sqld rejects writable pragmas [pragmas.ts:withSqlitePragmas] [libsql.ts:LibsqlDatabase]
- Local libSQL also sets `busy_timeout=5000` and `foreign_keys=OFF`. libSQL defaults foreign keys to on; Mira's other SQLite presets leave them off, and the drop/create rebuild must not cascade into user-defined child tables [pragmas.ts:withSqlitePragmas] [libsql.ts:LibsqlDatabase]
- `synchronous` is applied as `PRAGMA synchronous = ...` through the layer's own `SqlClient` (via `Layer.tap`) right after the connection opens and before the app serves requests; the pragma is connection-level, so it must use that client. It runs after WAL; omitted means no statement is issued and the driver default (`FULL`) stays in effect [pragmas.ts:withSqlitePragmas]
- Local libSQL is created with `concurrency: 1` so the client's connection pool cannot hand a later statement a connection that missed the per-connection pragmas. The Effect driver already serializes statements [libsql.ts:LibsqlDatabase]
- `NORMAL` is durable across process crashes but can lose recent transactions on power loss; `OFF` is unsafe for production [pragmas.ts:SqliteSynchronousMode]
- `MiraDatabase` has `{ layer, migrateAtStartup? }`. `migrateAtStartup` defaults to true when omitted [types.ts:MiraDatabase]
- Each layer is `Layer.mergeAll` of its SQL client layer and `Layer.succeed(Dialect, ...)` - the SQL client and its dialect are always paired [sqlite.ts:SqliteDatabase] [sqlite-bun.ts:BunSqliteDatabase] [libsql.ts:LibsqlDatabase]
- The libSQL driver is loaded with a dynamic import inside `Layer.unwrap`, so importing `@gettersethya/mira` does not load the native libSQL addon [libsql.ts:LibsqlDatabase]
- `Layer.orDie` turns a config error into a defect, so bad database config panics at startup instead of surfacing as a typed error callers must handle [sqlite.ts:SqliteDatabase]
- The boolean storage convention comes from the bundled dialect (`sqliteDialect`), not from the preset [sqlite.ts:SqliteDatabase]
- The Bun preset's `index.bun.ts` aliases `BunSqliteDatabase` as `SqliteDatabase` so the builder code is portable [index.bun.ts:SqliteDatabase]

## Side Effects

- Opens (and creates on demand) the SQLite database file named by `filename` when the layer is built [sqlite.ts:SqliteDatabase] [sqlite-bun.ts:BunSqliteDatabase]
- Opens a local libSQL file or a remote connection when the libSQL layer is built [libsql.ts:LibsqlDatabase]
- Registers the `Dialect` service in the Effect context as `sqliteDialect` for local libSQL or the remote telemetry-hook variant [libsql.ts:LibsqlDatabase] [dialect-libsql.ts:libsqlDialect]
- Enables WAL explicitly; the Bun driver also keeps its 5-second busy timeout default. Local libSQL gets an explicit busy timeout and foreign-key enforcement off [sqlite-bun.ts:BunSqliteDatabase] [pragmas.ts:withSqlitePragmas]
- libSQL remote setup is a network operation when the first migration or query runs; the preset itself does not probe the endpoint [libsql.ts:LibsqlDatabase]

## Version and packaging

- Tested with Node 24, `@effect/sql-libsql` 4.0.0, `@libsql/client` 0.18.0, local SQLite 3.45.1, and sqld `v0.24.33` (SQLite 3.47.0).
- SQLite 3.35+ is required for `DROP COLUMN` and `RENAME COLUMN`. Both tested engines are above it.
- `@libsql/client` ships platform-native binaries. It is a direct dependency so the packed package pins the version; the dynamic import keeps it out of the root import graph.

## Verification

- Run: `pnpm --filter @gettersethya/mira test`
- Bun smoke: `bun run apps/example-bun/src/smoke.ts`
- libSQL remote e2e: `docker compose -f docker-compose.libsql.yml up -d`, then `MIRA_LIBSQL_E2E=1 pnpm --filter @gettersethya/mira exec vitest run tests/databases/libsql-sqld.e2e.test.ts`
- Typecheck: `pnpm --filter @gettersethya/mira typecheck`
