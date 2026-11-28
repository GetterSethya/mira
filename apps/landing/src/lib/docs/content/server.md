Turn a set of collection definitions into a configured, migrating, observable server process. Four builder steps are required. The optional steps tune storage, email, rate limits, telemetry, and CORS.

Bun has its own [runtime page](../bun/). [Email](../email/), [plugins](../plugins/), the [HTTP API](../http-api/), and the [dashboard](../dashboard/) have their own pages too.

## What lives where

| Step | Required | Supplies |
|---|---|---|
| `platform` | yes | Runtime services, password auth, and `runMain` |
| `database` | yes | `SqlClient` and active `Dialect` |
| `storage` | yes | `FileStorage` for uploads, downloads, thumbnails |
| `collections` | yes | Base, auth, and view definitions |
| `email` | no | SMTP `EmailService`. Defaults to a no-op |
| `rateLimits` | no | Custom `RateLimitStore` and email policy overrides |
| `rules` | no | Server-only bindings merged onto schemas |
| `crons` | no | Scoped scheduled jobs |
| `telemetry` | no | Tracer and logger layer. Defaults to console |
| `cors` | no | Origin, method, header, and credential policy |
| `migrations` | no | `allowDestructive` and boot-time log verbosity |

The builder exposes `build()` only once all four required steps exist and re-checks at runtime. A collection with no rule denies ordinary callers. See [access rules](../rules/).

The snippet assumes `Posts`, `Users`, `postsRules`, and `nightlyCleanup` are defined in your app. The collection and rule pages show those definitions.

```ts
import { Config } from "effect"
import { ConsoleTelemetryLayer, LocalFileStorage, Mira, NodePlatform, SmtpEmail, SqliteDatabase } from "@gettersethya/mira"

const app = Mira.builder()
  .platform(NodePlatform)
  .database(SqliteDatabase({ filename: "data.db" }))
  .storage(LocalFileStorage({ directory: "./uploads" }))
  .email(SmtpEmail({
    host: Config.String("SMTP_HOST"),
    port: Config.Number("SMTP_PORT"),
    from: "Mira <no-reply@example.com>"
  }))
  .collections([Posts, Users])
  .rules([postsRules])
  .crons([nightlyCleanup])
  .telemetry(ConsoleTelemetryLayer)
  .cors({ allowedOrigins: ["https://app.example.com"], credentials: true })
  .migrations({ allowDestructive: false, logLevel: 2 })
  .build()

app.serve()
```

For Bun, import `BunPlatform` and `BunSqliteDatabase` from `@gettersethya/mira/bun` and pass them to the same `.platform(...)` and `.database(...)` steps. The Bun entry also exports `PostgresDatabase` and `MysqlDatabase`, so a Bun PostgreSQL or MySQL app keeps the same builder. The rest of the builder is unchanged.

`serve()` accepts optional `port` and `maxPortAttempts` (default 10). On a busy port it retries upward and reports the bound port to `AppConfig`, keeping `applicationUrl` accurate.

## Boot sequence

Building the app assembles the layer graph in a fixed order. The foundation binds the platform, database, storage, thumbnails, and telemetry. The mid layer adds `Repository`, the migrator, `AppConfig`, the token store, and the rate-limit stores. The email transport, plugin layers, the cached collection service, and the hook decorator sit on top.

Auto-migration is a side effect of that graph, so the plan completes before the server binds. The server layer then adds the router (generated collection routes plus plugin routes) and the port-retry binding.

Plugin `onBootstrap` hooks run during that startup, after the socket binds and before requests are handled. [Plugins](../plugins/) covers the hook order and the stages that never run.

## Configuration in `_config`

There is no config-file layer. `AppConfig` seeds a `_config` table on first boot and reads it on every start. Some values, such as S3 credentials, can also be supplied as Effect `Config` values.

```sql
SELECT `key`, `value` FROM `_config`;
```

The backticks are required on MySQL and MariaDB because `key` is a reserved word.

The seeded defaults are `app_name = "mira"`, `port = "8080"`, `application_url = "http://localhost:8080"`, `use_s3 = "false"`, and `log_retention_days = "30"`. Existing rows win. Seeding only fills missing keys. `jwt_secret` is 48 random bytes as hex, generated on first boot and persisted, so tokens survive restarts. It is a `Redacted<string>`.

Port and URL are mutable in-process: after a fallback, `updateBoundPort` rewrites the URL port so plugin logs and links point at the real address.

Email settings are not stored in `_config`. They come from `.email(...)`, and the dashboard shows the live transport read-only.

## Storage and database backends

Local disk storage is the default choice for development:

```ts
.storage(LocalFileStorage({ directory: "./uploads" }))
```

Keys are opaque strings. Local storage confines every key to the root, rejecting absolute or escaping paths. Uploads create parent directories, deletes are forced, and `url()` returns `/files/<key>` synchronously.

S3-compatible storage works with AWS S3, MinIO, RustFS, R2, and other compatible services:

```ts
import { Config } from "effect"
import { S3CompatibleStorage } from "@gettersethya/mira"

.storage(
  S3CompatibleStorage({
    endpoint: Config.String("S3_ENDPOINT"),
    bucketName: Config.String("S3_BUCKET_NAME"),
    regionName: Config.String("S3_REGION_NAME").pipe(Config.withDefault("us-east-1")),
    accessKey: Config.Redacted("S3_ACCESS_KEY"),
    secret: Config.Redacted("S3_SECRET")
  })
)
```

Every field accepts a plain value or an Effect `Config`, resolved once at build, so a missing variable fails at startup rather than on first upload. Path-style is the default. Set `forcePathStyle: false` for virtual-host style and `publicBaseUrl` for a CDN. The bucket must already exist. No `@aws-sdk/*` package is involved.

The `_config` table also carries `use_s3` and `s3_*` legacy keys, but the current storage layer is activated by `.storage(S3CompatibleStorage(...))`, not by those rows. Use the builder call as the source of truth. Do not assume setting `use_s3` swaps the backend. An incomplete `use_s3=true` row logs a warning and yields no S3 config instead of crashing boot.

SQLite, libSQL, PostgreSQL, MySQL, and MariaDB are the database backends. `SqliteDatabase({ filename })` wires the Node SQLite client and `sqliteDialect`; `BunSqliteDatabase({ filename })` does the same on Bun. `PostgresDatabase({ url })` wires the PostgreSQL client and `postgresDialect`. `MysqlDatabase({ url })` wires `@effect/sql-mysql2` and `mysqlDialect` on Node and Bun. Use `":memory:"` in SQLite tests. SQLite and MySQL store booleans as `0`/`1`; PostgreSQL stores native `BOOLEAN` because the dialect declares it, not because the collection service hardcodes it.

`LibsqlDatabase` runs libSQL on Node. `TursoDatabase` is an alias:

```ts
import { LibsqlDatabase, TursoDatabase } from "@gettersethya/mira"
import { Redacted } from "effect"

// local file
LibsqlDatabase({ url: "file:./mira.db" })

// remote Turso or sqld
LibsqlDatabase({
  url: "libsql://your-db.turso.io",
  authToken: Redacted.make(process.env.TURSO_AUTH_TOKEN!)
})

// embedded replica
LibsqlDatabase({
  url: "file:./replica.db",
  syncUrl: "libsql://your-db.turso.io",
  authToken: Redacted.make(process.env.TURSO_AUTH_TOKEN!),
  syncInterval: 60
})
```

Local libSQL applies WAL, an optional `synchronous` mode, `busy_timeout=5000`, and `foreign_keys=OFF`. Remote libSQL applies no writable pragmas; sqld rejects them. A remote URL with `synchronous`, a remote URL with `syncUrl`, or a plain local URL with `authToken` fails at construction. `syncUrl` sets `migrateAtStartup: false`, so migrate the primary, sync the replica, then start the app. Mira does not call `sync()` and does not claim read-your-writes across a replica.

The libSQL driver is loaded only when the preset is built, so importing `@gettersethya/mira` does not load the native addon. `@libsql/client` ships platform-native binaries. The preset is available on Node and Bun; the Bun entry exports the same names. The tested set is Node 24, Bun 1.4.2, `@effect/sql-libsql` 4.0.0, `@libsql/client` 0.18.0, local SQLite 3.45.1, and sqld `v0.24.33` (SQLite 3.47.0).

### PostgreSQL

`PostgresDatabase` runs PostgreSQL 15+ on Node and Bun through `@effect/sql-pg`. 17.12 is the validated version and CI target; 15+ is the support policy.

```ts
import { Redacted } from "effect"
import { PostgresDatabase } from "@gettersethya/mira"

.database(PostgresDatabase({
  url: Redacted.make(process.env.DATABASE_URL!),
  maxConnections: 20,
  idleTimeout: "30 seconds",
  prepare: true,
  ssl: false
}))
```

The URL is `Redacted` and is not logged. The driver parses `connect_timeout`, `application_name`, `sslmode`, and `options`; `ssl: true` is a convenience for a URL that omits `sslmode`. `maxConnections` defaults to 10, `idleTimeout` controls pool idle retirement, and `prepare` defaults to true. Use `prepare: false` for a transaction-mode or statement-mode pooler such as PgBouncer that cannot keep named prepared statements. The preset runs `SELECT 1` at boot, so a malformed URL, bad password, refused TLS handshake, or unreachable host fails before the app serves.

The schema uses `BIGINT GENERATED BY DEFAULT AS IDENTITY` for `seqId`, native `BOOLEAN`, `DOUBLE PRECISION` for `Field.number()`, and `TEXT` timestamps. A `BIGINT` `seqId` is a decimal string in `nextCursor` and in admin view/update/expand responses. Public list items still omit `seqId`. A JavaScript number is exact only below 2^53, so a PostgreSQL cursor above that limit is a canonical decimal string; pass it back unchanged.

Collection migrations run in one transaction with `READ COMMITTED`, a transaction-scoped `pg_advisory_xact_lock`, and a five-second `lock_timeout` for the DDL. Replicas booting together serialize on the advisory lock. `Migrator.plan` and `Migrator.status` use a non-blocking preview lock and fail with `MigrationBusyError` while a migration runs. A role or URL `lock_timeout` set before the transaction can cancel the lock wait with SQLSTATE `55P03`; a `statement_timeout` can cancel it with `57014`. The migration role needs a wait budget long enough for the lock.

For a deploy job, set `migrateAtStartup: false` and run the exported `Migrator` before starting replicas:

```ts
import { Effect, Redacted } from "effect"
import { LocalFileStorage, Mira, Migrator, NodePlatform, PostgresDatabase } from "@gettersethya/mira"

const app = Mira.builder()
  .platform(NodePlatform)
  .database(PostgresDatabase({
    url: Redacted.make(process.env.DATABASE_URL!),
    migrateAtStartup: false
  }))
  .storage(LocalFileStorage({ directory: "./uploads" }))
  .collections([Users, Posts])
  .build()

const migrate = Effect.gen(function* () {
  const migrator = yield* Migrator
  yield* migrator.migrate(app.collections.map(({ name, schema }) => ({ name, schema })))
}).pipe(Effect.provide(app.buildServiceLayer()))

await Effect.runPromise(migrate)
```

`buildServiceLayer()` already includes the exported `MigratorLive`, so the job resolves only the `Migrator` tag. `app.collections` is the final served set: app, plugin, and admin collections with rules applied. The flag disables collection migrations only. The internal stores and shared telemetry still run their idempotent bootstrap DDL on every boot, and the stores serialize their own boot through the dialect's advisory lock.

PostgreSQL does not scan `pg_catalog` for untracked objects. An untracked view that depends on a dropped column makes `DROP COLUMN` or `ALTER COLUMN TYPE` fail at the statement, and the transaction rolls back with the existing table and view intact. A desired view whose name already exists outside Mira fails `CREATE VIEW`, because PostgreSQL has no `CREATE VIEW IF NOT EXISTS`. Track the view in Mira, or remove or rename it before migrating. Table, column, view, and index-field names over 63 bytes fail preflight with `UnsupportedMigrationStepError`; generated index names over 63 bytes are truncated with an FNV-1a suffix.

### MySQL and MariaDB

`MysqlDatabase` runs MySQL 8.4+ and MariaDB 11.4.6+ on Node and Bun through `@effect/sql-mysql2`. 8.4.13 and 11.4.13 are the validated versions and CI targets. MariaDB 11.4.6 is the floor because earlier 11.4 patches lack the `utf8mb4_0900_*` collations or alias them to a PAD-space collation.

```ts
import { Redacted } from "effect"
import { MysqlDatabase } from "@gettersethya/mira"

.database(MysqlDatabase({
  url: Redacted.make(process.env.MYSQL_URL!),
  maxConnections: 20,
  connectionTTL: "30 seconds",
  ssl: true,
  connectTimeout: "5 seconds",
  disablePreparedStatements: false
}))
```

The URL is `Redacted` and is not logged. The preset parses the standard `mysql://user:password@host:3306/database` shape into the driver's non-URL options, so `ssl`, `connectTimeout`, and `disablePreparedStatements` reach the pool. Query parameters are not forwarded. `connectionTTL` is the pool idle setting, not a maximum connection age. `maxConnections` defaults to 10. The preset validates the URL and `maxConnections` synchronously and runs a readiness probe that logs the engine version and database at boot, never credentials.

MySQL stores `seqId` as `BIGINT AUTO_INCREMENT`, booleans as `tinyint(1)`, `Field.number()` as `DOUBLE`, timestamps as text, and keyed text as `VARCHAR(n)` with the binary `utf8mb4_0900_bin` collation. A `seqId` above 2^53 comes back as a decimal string; pass it back unchanged as a cursor. Deletes report the driver's `affectedRows`, not a `RETURNING` row, on both engines.

Migrations use the statement model from `#68` because MySQL commits DDL implicitly. `Migrator.migrate` reserves one connection, takes a session-scoped `GET_LOCK`, applies catalog-guarded statements outside a transaction, verifies the catalog, and writes metadata last. A failed plan can leave partial DDL; the next boot resumes from the catalog and the stored schema. `plan` and `status` check `information_schema` instead of bootstrapping tables, so a dry run does not mutate the database. `plan` and `status` fail with `MigrationBusyError` while another migration holds the lock. Table, column, view, and index-field names over 64 code points fail preflight; generated index names are truncated with an FNV-1a suffix.

`migrateAtStartup: false` skips collection migrations only. The internal config, token, rate-limit, auth-challenge, and cron stores still run idempotent DDL at boot, so the runtime role needs `CREATE`, `ALTER`, and `INDEX` on the app database. The bootstrap sets a five-second metadata-lock timeout on its connection.

The runtime and migration roles have different grants. A minimal deployment separates them:

```sql
-- Runtime role: app DML plus the idempotent internal-store bootstrap DDL.
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX ON mira.* TO 'mira_app'@'%';

-- Migration role: everything above plus destructive and view DDL.
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, DROP, CREATE VIEW, SHOW VIEW
  ON mira.* TO 'mira_migrator'@'%';

-- Dedicated telemetry database, if used.
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX ON mira_logs.* TO 'mira_app'@'%';
```

The runtime role must keep `CREATE`/`ALTER`/`INDEX` because the internal stores re-run their guarded bootstrap on every boot. The default `migrateAtStartup: true` also runs collection migrations, so a single-role deployment needs the migration grants too; use `mira_migrator` for `Migrator` and `mira_app` for the server only when `migrateAtStartup: false`.

### Single-role deployment

If one role runs both the server and `migrateAtStartup: true`, grant the union. This is the simplest deployment and the one the tests exercise:

```sql
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, DROP, CREATE VIEW, SHOW VIEW
  ON mira.* TO 'mira'@'%';
```

The dialect does not enable `NO_BACKSLASH_ESCAPES`; user data is always bound. Do not enable that mode on an app connection. Request-path locking reads use `FOR UPDATE` inside a short transaction; the store retries once on `1205`/`1213`. The bootstrap sets a five-second lock-wait timeout (`innodb_lock_wait_timeout` and `lock_wait_timeout`) for its own connection and restores both session values before the connection returns to the pool, logging a warning if a restore statement fails, so request connections keep the server default. Lower `innodb_lock_wait_timeout` at the server for latency-sensitive deployments.

## Email transport

`.email(SmtpEmail(...))` selects an SMTP transport. Without it Mira uses a no-op `EmailService`. Host, port, TLS, auth, From, and the reset URL are resolved once at layer build, and every field also accepts an Effect `Config` value. The transport is optional because local development and clients that do not use email should not need an SMTP server. The [email page](../email/) covers auth-collection options, routes, rate limits, plugin hooks, and Mailpit.

## Rate limits

Rate limits use a `RateLimitStore` service. The app's default store is the SQL-backed store (`_rate_limits`). It runs on SQLite, libSQL, PostgreSQL, MySQL, and MariaDB. PostgreSQL uses a conditional upsert with `RETURNING`; MySQL and MariaDB use a locked transaction with `FOR UPDATE`, an explicit guard, and all-or-nothing rollback. Tests use an explicit in-memory store. To use another backend, pass `.rateLimits({ store: MyStoreLayer, emailPolicies: {...} })`. The custom store layer must be self-contained. The SQL store is single-node on SQLite and libSQL; row-locked on PostgreSQL, MySQL, and MariaDB. A multi-instance deployment needs a shared database or a shared store. Request policies fail open on store errors. Send policies fail closed with `503 rate_limit_unavailable`. Buckets longer than 512 code points are rejected on MySQL and MariaDB; SQLite and PostgreSQL impose no new cap.

## Migrations at boot

Auto-migration runs during layer initialization, before any request, and a failed migration stops the boot. It bootstraps two system tables:

- `_collections` stores each collection's name, JSON schema, and update timestamp.
- `_migrations` stores one row per applied plan with an id, name, steps JSON, and timestamp.

The desired schema is diffed against `_collections`. On PostgreSQL the system-table bootstrap, stored-schema read, diff, render, and validation all run inside the migration transaction, after the dialect's migration setup statements and before any plan DDL. On SQLite and libSQL the same work runs inside the transaction, and an impossible plan fails before any DDL reaches the driver. Applied plans commit with their `_migrations` row, and only then is `_collections` upserted.

On SQLite and libSQL the dialect reads `sqlite_master` inside the migration transaction, so a plan that would silently damage a catalog object fails before any plan DDL runs. A rebuilt or dropped object with an untracked dependent view fails preflight naming the views, and a tracked dependent of a dropped object that is neither recreated nor dropped also fails naming the view. A recreated view that carries a trigger or an explicit column list fails naming the view, a rebuilt table with a trigger fails naming the table, and a `createView` whose name already exists fails naming the object, because `CREATE VIEW IF NOT EXISTS` would skip the desired query. A native column drop that an untracked view may block logs a note instead; SQLite still fails the statement at execution if the view reads the dropped column, and the transaction rolls back. Triggers on dropped tables and removed views are noted, since the removal is explicit. Every connected surviving view, tracked or untracked, is probed with a `LIMIT 0` read inside the transaction, so a view broken by the plan or changed between the plan and `BEGIN` rolls the migration back. To resolve a refusal, track the object in Mira, or remove or rename it before migrating.

`allowDestructive` gates data-losing work: dropped tables and columns always qualify, and an `alterColumn` qualifies only on a type change or `nullable → NOT NULL`. Nullability relaxation and default changes are safe. With the flag off the whole plan is skipped and each destructive step is logged. Removed collections drop only with the flag on.

SQLite cannot `ALTER COLUMN`, so the dialect rebuilds any table targeted by a column change: create a scratch table, copy rows, move the `sqlite_sequence` high-water mark, drop the original, create the desired original, copy back, restore the sequence, drop the scratch, then recreate indexes. When a column becomes `NOT NULL` and has a default, existing rows are copied through `COALESCE(column, default)`. A new `NOT NULL` column without a default gets the same synthetic `DEFAULT ''`/`0` as `ADD COLUMN`. No `PRAGMA legacy_alter_table` is emitted, so the same rebuild works on local SQLite and remote libSQL. A new column, a nullable-to-`NOT NULL` default, or a type change on a single-field unique index is rejected before any table copy.

A `dropColumn` plan with tracked views drops the views that depend on the changed table in reverse dependency order, applies the column change, recreates the desired views in dependency order, and validates their declared properties plus `seqId` with a `LIMIT 0` probe. If a view query or declared property still names the dropped column, the probe fails and the whole plan rolls back. This covers local SQLite and libSQL. Views created outside Mira are not tracked in `_collections`, but the preflight scan and the in-transaction probes cover them too: a rebuild or drop that would break one fails before any DDL, a native drop that one may block logs a note and still fails at execution if the view reads the dropped column, and every connected surviving view is probed inside the transaction.

PostgreSQL changes types with `ALTER COLUMN TYPE ... USING` and recreates tracked views around a destructive table change. It does not scan `pg_catalog`, so an untracked dependent view that reads a dropped column fails at the statement and the transaction rolls back. The same is true for a desired view whose name already exists outside Mira: `CREATE VIEW` fails instead of silently skipping the desired query.

On SQLite, libSQL, and PostgreSQL, migrations run through `sql.withTransaction`, so the plan statements, validation probes, the `_migrations` row, and the `_collections` upserts commit or roll back together. MySQL and MariaDB use the statement model instead: DDL commits implicitly, the catalog is verified before metadata is written, and a failed plan can leave partial DDL for the next boot to resume. `plan` and `status` still bootstrap the system tables on transaction-model dialects and therefore need write permission on first use; the MySQL statement model checks `information_schema` instead. The abstract step order is global: drop views, drop indexes, table changes, create indexes, create views. Synthesized view drops and creates follow the plan's dependency order, and synthesized validations run after the DDL.

On PostgreSQL, `migrate` takes a transaction-scoped advisory lock, so concurrent replicas serialize instead of racing `CREATE TABLE`. `plan` and `status` take a non-blocking preview lock and fail with `MigrationBusyError` rather than waiting behind a migration. On SQLite and libSQL the write transaction serializes its own DDL; for a remote deployment, run migrations on one instance or as a deploy step.

## Telemetry

`ConsoleTelemetryLayer` prints one JSON line per completed span prefixed `[trace]`, plus structured logs carrying `traceId`/`spanId` when a span is active. `makeConsoleTelemetryLayer({ pretty: true })` switches to Chalk output.

To keep logs and spans in SQL, use a **dedicated telemetry database** preset. Shared storage is also available when a second connection is impossible:

```ts
import { makeTelemetryLayer, SqliteDatabase } from "@gettersethya/mira"

.telemetry(makeTelemetryLayer({
  storage: {
    mode: "dedicated",
    database: SqliteDatabase({ filename: "mira-logs.db" }),
  },
  logConsole: true,
  pretty: false,
}))
```

On Bun, use `BunSqliteDatabase` from `@gettersethya/mira/bun` and keep the same shape. Both entries export `makeTelemetryLayer`, `TelemetryLoggerConfig`, `TelemetryStore`, and `logCleanupCronDef`.

Dedicated mode applies `journal_mode=WAL`, `synchronous=NORMAL`, and `busy_timeout=5000` at construction, then migrates `logs` and `spans`. Both tables index `created`, so retention scans do not read the whole table. The admin telemetry routes read through `TelemetryStore`. Set `flushBatchSize` to batch rows per store call; the default of one preserves current behavior.

For libSQL, pass `LibsqlDatabase` as the dedicated preset. Local `file:` telemetry reuses the SQLite WAL and checkpoint hooks. Remote libSQL skips setup and cleanup because sqld rejects writable pragmas. Each unbatched row is a network round trip, so remote deployments should set `flushBatchSize: 100` and `flushInterval: "1 second"`. A `syncUrl` replica sets `migrateAtStartup` to false; migrate the telemetry tables on the primary and sync first. Shared telemetry on a replica needs `{ mode: "shared", migrate: false }`.

For PostgreSQL, shared storage is the recommended mode: it reuses the app pool and writes `logs` and `spans` in the app database. Dedicated mode needs a second `PostgresDatabase` and a separate database or schema; pointing it at the app database can make the app migrator treat `logs` and `spans` as app collections. PostgreSQL telemetry has no setup or cleanup statements and treats `40001`, `40P01`, and `55P03` as retryable. The telemetry read cursor is numeric and exact only below 2^53; retention deletes by a `seqId` subquery, so retention is not affected by that ceiling.

For MySQL and MariaDB, shared storage is also the recommended mode; dedicated mode needs a second `MysqlDatabase` and its own database. MySQL has no separate schema namespace, so use a separate database, not a schema. Telemetry has no setup or cleanup statements. Setup and migration retries treat `1205` and `1213` as retryable; append and retention retries treat `1205` only, because a `1213` deadlock already ended the caller's transaction. Duplicate telemetry ids are ignored with `ON DUPLICATE KEY UPDATE id = id`. Retention uses a derived-table `seqId` subquery and does not run `OPTIMIZE TABLE`; InnoDB reuses pages and an online optimize is an operator choice. The telemetry read cursor is numeric and exact only below 2^53.

Completed spans go onto an unbounded queue and log rows onto a bounded 10,000-entry queue, each drained by a scoped fiber, so span and record completion never blocks on I/O. On shutdown Mira interrupts the writers, drains both queues with a 2-second budget, and reports log rows dropped because the bounded queue was full. `logConsole` echoes to stdout. `pretty` affects only that echo, never the stored rows.

`logCleanupCronDef` is a daily `0 0 * * *` job deleting `logs` and `spans` older than `AppConfig.logRetentionDays` through `TelemetryStore.deleteOlderThan`. Add it to `.crons([...])`. Deletes run in batches of 1,000 using the `created` index, then the dialect cleanup hook runs and the actual deleted counts are logged. The default console telemetry has no store, so use it with `makeTelemetryLayer` or a custom store. Reading persisted telemetry needs a superadmin session. See the [HTTP API](../http-api/).

## Moving from SQLite to PostgreSQL

There is no built-in SQLite-to-PostgreSQL data migration. Move the rows with a dump and `COPY` (or an export/import tool), then start the app against the new database and let collection migrations create the schema.

- Booleans move from SQLite `0`/`1` to native `BOOLEAN`.
- Timestamps stay `TEXT`; Mira does not convert them to `timestamptz`.
- `seqId` identity values restart at the new database's sequence, so do not assume the old SQLite row numbers carry over. Use `id` for application references.
- Password hashes copy unchanged. A Node-written `scrypt$...` row verifies on PostgreSQL because password hashing is in the app layer, not the database.
- Reverting the builder configuration does not copy PostgreSQL data back. Rows written after cutover stay in PostgreSQL, so plan an export/import if you need to return to SQLite.

## Thumbnails and the platform boundary

`ThumbnailServicePhotonLive` is wired into the foundation layer and supports JPEG, PNG, and WebP through `@cf-wasm/photon`. The file-serving route accepts a `thumb` spec in `WxH[tbf]` form: `t` is cover, `b` is contain, `f` is fill, and no suffix defaults to cover. A `0` axis scales proportionally. `0x0` returns the source size. Results are cached best-effort at `_thumbs/<filename>/<spec>`, and a resize failure falls back to the original. The app hardcodes the Photon layer. `ThumbnailServiceNoopLive` exists internally for tests and is not a public builder option.

`NodePlatform` provides the node-backed file system, path, crypto, HTTP server factory, and password service, and delegates `runMain` to the Node runtime. `BunPlatform` does the same with native Bun filesystem, path, HTTP server, and runtime. It reuses the Node-compatible crypto, password, and SMTP layers. `BunSqliteDatabase` pairs Bun SQLite with the same dialect, and `PostgresDatabase` works on Bun through `@effect/sql-pg`.

Most of the service graph (repository, migrator, config, collection service, router) is platform-agnostic. Photon works under both runtimes, and SQLite telemetry works on both through the matching database preset.

For hook ordering and cron state see [plugins](../plugins/). For routes and status codes see the [HTTP API](../http-api/). For the admin UI see the [dashboard](../dashboard/).

## Next

- [Bun runtime](../bun/) for the native platform preset, Bun SQLite, and password hashing.
- [Email and auth flows](../email/) for SMTP setup, verification, reset, and the email-change flow.

