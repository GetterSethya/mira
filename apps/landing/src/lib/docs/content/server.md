Mira assembles a server from four required builder steps and a few optional ones. Durable state lives in SQLite: collection definitions, configuration, and optionally logs and spans. This page covers the builder, config, storage, migrations, telemetry, and thumbnails; [email](../email/), [plugins](../plugins/), [HTTP API](../http-api/), and the [dashboard](../dashboard/) have their own pages.

## What lives where

| Step | Required | Supplies |
|---|---|---|
| `platform` | yes | Runtime services, password auth, and `runMain` |
| `database` | yes | `SqlClient` and active `Dialect` |
| `storage` | yes | `FileStorage` for uploads, downloads, thumbnails |
| `collections` | yes | Base, auth, and view definitions |
| `email` | no | SMTP `EmailService`; defaults to a no-op |
| `rateLimits` | no | Custom `RateLimitStore` and email policy overrides |
| `rules` | no | Server-only bindings merged onto schemas |
| `crons` | no | Scoped scheduled jobs |
| `telemetry` | no | Tracer and logger layer; defaults to console |
| `cors` | no | Origin, method, header, and credential policy |
| `migrations` | no | `allowDestructive` and boot-time log verbosity |

The builder exposes `build()` only once all four required steps exist and re-checks at runtime. A collection with no rule denies ordinary callers; see [access rules](../rules/).

The snippet assumes `Posts`, `Users`, `PostsRules`, and `nightlyCleanup` are defined in your app; the collection and rule pages show those definitions.

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
  .rules([PostsRules])
  .crons([nightlyCleanup])
  .telemetry(ConsoleTelemetryLayer)
  .cors({ allowedOrigins: ["https://app.example.com"], credentials: true })
  .migrations({ allowDestructive: false, logLevel: 2 })
  .build()

app.serve()
```

`serve()` accepts optional `port` and `maxPortAttempts` (default 10). On a busy port it retries upward and reports the bound port to `AppConfig`, keeping `applicationUrl` accurate.

## Configuration in `_config`

There is no config-file layer. `AppConfig` seeds a `_config` table on first boot and reads it on every start; some values, such as S3 credentials, can also be supplied as Effect `Config` values.

```sql
SELECT key, value FROM _config;
```

The seeded defaults are `app_name = "mira"`, `port = "8080"`, `application_url = "http://localhost:8080"`, `use_s3 = "false"`, and `log_retention_days = "30"`. Existing rows win; seeding only fills missing keys. `jwt_secret` is 48 random bytes as hex, generated on first boot and persisted, so tokens survive restarts; it is a `Redacted<string>`.

Port and URL are mutable in-process: after a fallback, `updateBoundPort` rewrites the URL port so plugin logs and links point at the real address.

The `_config` table also carries `use_s3` and `s3_*` legacy keys, but the current storage layer is activated by `.storage(S3CompatibleStorage(...))`, not by those rows. Use the builder call as the source of truth; do not assume setting `use_s3` swaps the backend. An incomplete `use_s3=true` row logs a warning and yields no S3 config instead of crashing boot. Email settings are not stored in `_config`; they come from `.email(...)`, and the dashboard shows the live transport read-only.

## Storage backends

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

Every field accepts a plain value or an Effect `Config`, resolved once at build, so a missing variable fails at startup rather than on first upload. Path-style is the default; set `forcePathStyle: false` for virtual-host style and `publicBaseUrl` for a CDN. The bucket must already exist; no `@aws-sdk/*` package is involved.

SQLite is the only database backend today. `SqliteDatabase({ filename })` wires the `SqlClient` and `sqliteDialect`; use `":memory:"` in tests. Booleans are stored as `0`/`1` because the dialect declares it, not because the collection service hardcodes it.

## Email transport

`.email(SmtpEmail(...))` selects an SMTP transport; without it Mira uses a no-op `EmailService`. Host, port, TLS, auth, From, and the reset URL are resolved once at layer build; every field also accepts an Effect `Config` value. The transport is optional because local development and clients that do not use email should not need an SMTP server.

`SmtpEmail` delegates socket work to the platform `MailTransport`, so the core service does not import `nodemailer`; only the Node platform does. The [email page](../email/) covers auth-collection options, routes, rate limits, plugin hooks, and Mailpit.

Rate limits use a `RateLimitStore` service. The app's default store is SQLite (`_rate_limits`); tests use an explicit in-memory store. To use another backend, pass `.rateLimits({ store: MyStoreLayer, emailPolicies: {...} })`. The custom store layer must be self-contained. The SQLite store is single-node; a multi-instance deployment needs a shared store. Request policies fail open on store errors; send policies fail closed with `503 rate_limit_unavailable`.

## Migrations at boot

Auto-migration runs during layer initialization, before any request, and a failed migration stops the boot. It bootstraps two system tables:

- `_collections` stores each collection's name, JSON schema, and update timestamp.
- `_migrations` stores one row per applied plan with an id, name, steps JSON, and timestamp.

The desired schema is diffed against `_collections`. The whole plan is rendered through the active dialect and validated to contain real SQL before a transaction opens, so an impossible plan fails before `BEGIN`. Applied plans commit with their `_migrations` row, and only then is `_collections` upserted.

`allowDestructive` gates data-losing work: dropped tables and columns always qualify, and an `alterColumn` qualifies only on a type change or `nullable → NOT NULL`. Nullability relaxation and default changes are safe. With the flag off the whole plan is skipped and each destructive step is logged; removed collections drop only with the flag on.

SQLite cannot `ALTER COLUMN`, so the dialect rebuilds any table targeted by a column change: scratch table, `INSERT … SELECT`, `sqlite_sequence` transfer, `DROP`, `RENAME`, then index recreation. When a column becomes `NOT NULL` and has a default, existing rows are copied through `COALESCE(column, default)`. `PRAGMA legacy_alter_table = ON` is emitted before the rebuild and `OFF` runs as cleanup on both commit and rollback paths. Step order is global: drop views, drop indexes, table changes, create indexes, create views.

## Telemetry

`ConsoleTelemetryLayer` prints one JSON line per completed span prefixed `[trace]`, plus structured logs carrying `traceId`/`spanId` when a span is active. `makeConsoleTelemetryLayer({ pretty: true })` switches to Chalk output.

To keep logs and spans in SQLite:

```ts
import { makeSqliteTelemetryLayer } from "@gettersethya/mira"

.telemetry(makeSqliteTelemetryLayer({ dbPath: "mira-logs.db", logConsole: true }))
```

It opens a separate SQLite database, migrates `logs` and `spans` at layer construction, and re-provides the connection as `TelemetrySqlClient` for the admin telemetry routes. Spans go onto an unbounded queue drained by a scoped fiber, so completion never blocks on I/O. Log writes are fire-and-forget. `dbPath` defaults to `"mira-logs.db"`; `logConsole` echoes to stdout and `pretty` affects only that echo.

`logCleanupCronDef` is a daily `0 0 * * *` job deleting `logs` and `spans` older than `AppConfig.logRetentionDays`; add it to `.crons([...])`. It requires `TelemetrySqlClient`, so use it only with `makeSqliteTelemetryLayer`; the default console telemetry does not provide the table client. Reading persisted telemetry needs a superadmin session; see the [HTTP API](../http-api/).

## Thumbnails and the platform boundary

`ThumbnailServicePhotonLive` is wired into the foundation layer and supports JPEG, PNG, and WebP through `@cf-wasm/photon`. The file-serving route accepts a `thumb` spec in `WxH[tbf]` form: `t` is cover, `b` is contain, `f` is fill, and no suffix defaults to cover. A `0` axis scales proportionally; `0x0` returns the source size. Results are cached best-effort at `_thumbs/<filename>/<spec>`, and a resize failure falls back to the original. The app hardcodes the Photon layer; `ThumbnailServiceNoopLive` exists internally for tests and is not a public builder option.

`NodePlatform` provides the node-backed file system, path, crypto, HTTP server factory, and password service, and delegates `runMain` to the Node runtime. A different runtime needs one preset satisfying `MiraPlatform`: a layer for those services plus a `runMain`. Most of the service graph (repository, migrator, config, collection service, router) is platform-agnostic; the Photon thumbnail backend and SQLite telemetry remain environment-specific. For hook ordering and cron state see [plugins](../plugins/); for routes and status codes see the [HTTP API](../http-api/); for the admin UI see the [dashboard](../dashboard/).
