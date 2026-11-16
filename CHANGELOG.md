# Changelog

All notable changes to Mira are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Every package in the workspace is versioned in lockstep: `@gettersethya/mira-collection`,
`@gettersethya/mira-client`, `@gettersethya/mira`, `@gettersethya/mira-tanstack-adapter`
and `@gettersethya/mira-dashboard` always share one version.

Pre-releases are published under the `alpha` npm dist-tag; while the project is pre-1.0
the `latest` tag also tracks the newest alpha. Stable releases publish under `latest`.
Entries before `0.1.0-alpha.33` are not recorded here - that release is the first one
published by CI.

## [Unreleased]

### Added

- **Landing benchmark page and header rebuild.** The shared nav is now four
  primary links plus a Quickstart action, with a current-page marker and a
  simpler mobile drawer. The benchmark report drops the hero summary card: the
  hero states the setup and the scoreboard is the only result surface. Precise
  delta wording (`1.3× throughput`, `4.7× faster startup`), a filterable
  scoreboard, a light/dark method panel and compact mobile latency groups. Copy
  was audited against `benchmarks.json` and the harness for claim, median,
  run-order, batching and overlap accuracy.
- **Tailwind v4 in the landing app.** `@tailwindcss/vite` and `tailwindcss`
  are now wired into `apps/landing`; the benchmark page uses utility classes
  over the existing mono/paper design tokens.
- **Collection-aware auth email templates.** `.emailTemplates({ defaults, collections })`
  lets an app override any of the six built-in auth emails (verification, login
  OTP, passwordless OTP, password reset, email change, login alert) per collection
  or app-wide. Overrides are typed render functions, not string templates;
  resolution is collection → global → built-in. Subjects are CRLF-sanitised and
  `escapeHtml` is exported for custom bodies. The dashboard shows each auth
  collection's effective templates read-only at **Schema → Email**, with source
  labels and sentinel preview data; the preview route is auth-wrapped and never
  returns recipients, live links or SMTP credentials.
- **Dashboard schema inspector for rules and indexes.** The collection schema
  dialog now has Fields / Indexes / Rules / Email / View query tabs. Rules show
  one row per action (including auth `manage`), a readable verdict, referenced
  fields, and collapsible raw JSON; missing rules are explicitly reported as
  deny-all. Indexes show single/composite coverage, unique/system flags, and
  decidable structural findings. `GET /api/_schema` now returns `rules`,
  server-computed `ruleSummary`, and normalized `indexes` including the injected
  auth email index's `system` marker.

### Changed

- **Plugin routes may depend on the collection set.** `MiraPlugin.routes` accepts
  either a static route array or a function receiving the final resolved
  collection list, so plugin routes can validate names (the dashboard email
  template preview uses this to 404 non-auth collections).
- **GitHub release notes.** The Publish workflow now extracts the matching
  `## [<version>]` section from `CHANGELOG.md` with `scripts/release-notes.ts`
  and uses it as the GitHub release body instead of `--generate-notes`.
  `pnpm release:alpha` / `pnpm release:stable` refuse to tag when that section
  is missing or empty.

### Fixed

## [0.1.0-alpha.38] - 2026-11-16

### Added

- **Opt-in transparent mutation batching (create, update, delete).**
  `.batchMutation({ create: {}, update: {}, delete: {} })` merges concurrent
  single-record mutations into one SQLite transaction. Create prepares
  validation, rules and hashing in the request fiber and queues only the insert.
  Update/delete read the stored row, check the update/delete rule, `manage` rule
  and credentials inside the batch transaction, so a later entry in the same
  flush sees an earlier entry's write. One FIFO flusher runs entries in queue
  order, uses a savepoint per entry (single-entry fast path preserved), isolates
  statement-level failures, and settles deferreds only after `COMMIT`. A
  constraint failure at commit (for example a deferred foreign key) maps to
  `409 { error: "batch_conflict", operation }` / `BatchMutationConflictError`
  and does not count as a batcher defect; driver defects close the batcher after
  three consecutive failures. Queue-full, timeout and closed map to `503
  { error: "batch_unavailable", operation, retryable }`; create is never
  retryable, update/delete are retryable for queue-full/timeout (a retried
  delete may return 404). Admin is captured per entry and hidden fields are
  stripped per entry. File and auth-challenge cleanup runs after commit through
  a bounded worker; abandoned jobs are counted and logged. Off by default: the
  disabled path runs inline and the default behaviour is unchanged.
  `BatchMutationStats` exposes overall and per-operation `batches`, `applied`,
  `maxBatchSize`, `lastBatchSizes`, `rejected`, `timedOut`, `admitted` and
  `cleanupAbandoned`, plus `commits`/`inlineCommits` and
  `lastFlushDurationsMs`. `updateMany`/`deleteMany` keep their all-or-nothing
  contract and bypass the queue. Measured on Windows/Node 24, cache off:
  `synchronous=FULL` c50/c100 update **2.23x/2.48x**, delete **2.60x/2.60x**;
  `NORMAL` is flat; c1 regresses (update 0.89x, delete 0.74x), so the feature
  remains opt-in and is not recommended for `NORMAL` or low-concurrency traffic.
  See `.egm/create-batch-polish-2026-11-15/`.
- **Transactional bulk update and delete.** `PATCH /api/collections/:name/bulk` accepts
  `{ "records": [{ "id": string, "data": { ... } }, ...] }` and returns `200 { "records": [...] }`;
  `DELETE /api/collections/:name/bulk` accepts a JSON `{ "ids": string[] }` body (intentional —
  up to 1 000 ids do not fit a URL) and returns `200 { "ids": [...] }` in input order. Both run
  every entry through the normal `CollectionService.update`/`delete` path inside one SQLite
  transaction, so a missing id, denied rule or invalid patch rolls the whole batch back; empty
  batches, non-unique or empty ids, malformed bodies and batches over `MAX_BULK_RECORDS`
  (1 000, the shared limit; `MAX_BULK_CREATE_RECORDS` stays as a deprecated alias) return
  `422`. Hooks run per record, the cache invalidates every affected record and the list cache
  once after commit, and the client SDK gains `updateMany().raw([{ id, data }])` /
  `deleteMany().raw(ids)` with TanStack `mutationOptions` enrichment. Bulk routes are
  registered before `/:id`, so a record id literally named `bulk` is shadowed.
- **Transactional bulk create.** `POST /api/collections/:name/bulk` accepts
  `{ "records": [...] }` and creates up to 1 000 records inside a single SQLite transaction,
  returning `201 { "records": [...] }`. Every record still goes through the normal
  `CollectionService.create` path — Effect Schema validation, create-rule enforcement,
  credential checks, password hashing, id/timestamp generation, and hidden-field stripping — so
  a single invalid or denied record rolls the whole batch back. Empty/non-array `records`,
  malformed elements, and batches over the limit return `422`. Record lifecycle hooks run per
  item (pre/execute before the transaction, success observers per created record), the list
  cache is nuked once after commit, and the client SDK gains
  `createMany().raw(records)` plus an enriched `mutationOptions` through the TanStack adapter.
  `pnpm --filter mira-benchmarks bulk-create:audit` compares 500 individual creates with one
  500-record batch under `BENCH_SYNCHRONOUS=FULL`.
- **Self-service email change.** Auth collections can opt in with
  `email: { emailChange: true }`. An authenticated user calls
  `POST /api/collections/:name/request-email-change` with `{ newEmail, oldPassword }`; Mira
  verifies the current password with the login rate limits and sends a 30-minute confirmation
  link to the new address. `POST /api/collections/:name/confirm-email-change` accepts the
  token, sets `email` and `emailVerified: true`, bumps the user's token generation so existing
  sessions are invalid, and consumes the user's other outstanding challenges. The request always
  returns the same generic `202`; if the new address belongs to another account, no mail is sent,
  so the endpoint does not reveal whether an address exists. The current address returns
  `422 email_unchanged`, and confirmation returns `409 email_taken` if the address became taken
  in the meantime. The client SDK exposes `requestEmailChange()` / `confirmEmailChange()`, the
  TanStack adapter enriches both, and `auth-config` reports the new `emailChange` flag.
  `SmtpEmail` accepts `emailChangeUrl` and defaults it to
  `${applicationUrl}/email-change?token={{token}}&collection={{collection}}`.

### Changed

- **Tracing-off request-path fast paths.** HTTP, collection-service, cache, hook
  and mutation-batch spans now use `withSpanWhenEnabled`, and `auth.*` /
  `cache.hit` / `http.forwarded_for` annotations use
  `annotateCurrentSpanWhenEnabled` (`fiber.cache.tracerEnabled` + native span).
  Tracing-off requests no longer build no-op spans or perform
  `Effect.currentSpan` lookups; tracing-on names, kinds, attributes and
  parent/child topology are unchanged. The benchmark harness now writes a
  windowed inspector heap profile (`PROFILE_HEAP=1`). Fedora 44, 5,000 list
  requests: **960 -> 1048 rps** (+9.2%), p50 **47.4 -> 42.8 ms**, p99
  **103.0 -> 94.2 ms**, profile CPU **5449 -> 4954 ms**; update **801 -> 847
  rps** (+5.7%); sampled heap **593.7 -> 471.4 MiB** (-20.6%, **121.6 -> 96.5
  KiB/request**). Helper isolation: `Effect.withSpan` 1295 ns/op / 276.63 MiB
  sampled -> `withSpanWhenEnabled` 499 ns/op / 111.16 MiB. Internal performance
  only; no API shape change.
- **Read-path fast path for default list responses.** Default visible fields
  are cached per schema, `fields + seqId` is cached for the default projection,
  and the no-select/no-expand list path uses a projection-based row mapper that
  preserves SELECT key order and skips `seqId` without a per-row `Object.keys`.
  `select`/`expand` keep the existing mapper. Measured list medians: **2569 →
  2673 rps**, p99 **33.5 → 30.3 ms**, profile CPU **2084 → 2024 ms**; the mapper
  microbenchmark is **3.81M → 4.20M ops/s** on the full projection (narrow
  `select` still uses the old mapper). Internal performance only; no API shape
  change.
- **Effect-runtime fast paths for the mutation request path.** Placeholder-free
  rules (`1 = 1`) return their compiled clause without a regex scan; batched
  entries use a plain one-way cancellation flag and a mutable observed-cause
  slot instead of per-entry `Ref` allocations; repository CRUD spans are skipped
  when tracing is disabled, while `CurrentStackFrame` is preserved so failure
  causes still name `repository.*`; and `batch.wait_ms` clock reads/annotations
  are skipped when tracing is off. Measured at `synchronous=FULL` c50 with
  batching on: update **1847 → 2003 rps** (median, +8.4%), p99 **50.9 → 44.9 ms**,
  profile CPU **2805 → 2606 ms**; create is non-inferior (2299 vs 2269 rps);
  tracing-on is neutral. The benchmark profiler now prints p50/p99 and accepts
  `PROFILE_TRACING=on`.
- **Delete fast path with dialect-aware affected-row reporting.** Delete now reads
  the stored row and the delete-rule result in one `SELECT` via
  `Repository.viewWithAccess`, then removes the row with
  `Repository.deleteExisting` instead of a separate existence query (service-layer
  statements 4 → 2; full HTTP 5 → 3). `DialectType.deleteResult` selects the
  strategy: `returning` for SQLite/Postgres/MariaDB, `affectedRows` for MySQL
  when its driver exposes an affected count, and `precheck` as the portable
  fallback. SQLite `DELETE ... RETURNING` is verified on Node 24 and Bun 1.4.
  Body-placeholder and anonymous `@auth_*` delete rules keep the existing
  fallback, preserving 404-before-403 and body semantics. **Breaking for custom
  dialects:** `DialectType` now requires `deleteResult`; use
  `{ _tag: "precheck" }` when the driver has no affected-row signal.
- **Update fast path with body-aware rule predicates.** Update now reads the
  stored row, the update rule, and the `manage` rule result in one `SELECT` via
  `Repository.viewWithAccess`, then writes with `Repository.update` (service-layer
  statements 4 → 3; auth + `manage` 5 → 3). A `@request_body_*` key present in
  the patch binds the patch value; an absent key that is a real non-generated
  field binds `t."<key>"` so the rule still evaluates against the stored row.
  Body-only keys, generated/system fields, subquery body rules, unknown request
  sources, and anonymous auth-requiring rules keep the row-first fallback, so
  404-before-403 and merged-body semantics are unchanged. Measured at
  `synchronous=FULL` c50 with batching on: 1.08×–1.21× in two off/on runs;
  statement count is the deterministic evidence.
- **SQLite WAL is explicit for Node and Bun.** `SqliteDatabase` and `BunSqliteDatabase`
  now issue `PRAGMA journal_mode = WAL` themselves when the connection opens, immediately
  before the optional `PRAGMA synchronous` mode. The Effect SQLite drivers already default
  writable connections to WAL; issuing it in Mira keeps that guarantee independent of a
  driver default change. `":memory:"` reports `memory` (WAL is not available there). The
  telemetry database already applies WAL explicitly and is unchanged. Node tests assert
  `journal_mode = wal`; the Bun smoke test asserts it for both the main and telemetry
  databases.
- **Breaking: driver-neutral SQLite telemetry.** `makeSqliteTelemetryLayer` no longer
  accepts `dbPath` and no longer opens the database itself. Pass a `SqlClient` layer for a
  dedicated telemetry database:
  `makeSqliteTelemetryLayer({ sqlLayer: SqliteClient.layer({ filename: "mira-logs.db" }) })`,
  importing `SqliteClient` from `@effect/sql-sqlite-node` on Node or
  `@effect/sql-sqlite-bun` on Bun. Both the Node entry and `@gettersethya/mira/bun` export
  `makeSqliteTelemetryLayer`, `SqliteLoggerConfig`, `TelemetrySqlClient`, and
  `logCleanupCronDef`; the telemetry layer no longer pulls a SQLite driver into either
  entry. At construction the layer applies WAL, `synchronous=NORMAL`, and
  `busy_timeout=5000`, then adds a `created` index to `logs` and `spans`. Log rows now go
  through a bounded 10,000-entry queue drained by a scoped writer, spans keep their
  unbounded queue, and both queues are flushed on shutdown with dropped log rows reported.
  `MiraBuilder`/`MiraApp` now carry the telemetry output type, so
  `buildLayer()`/`buildServiceLayer()` expose `TelemetrySqlClient` to `Context.get` without
  `getUnsafe`. The retention cron deletes in batches of 1,000 using the new index,
  checkpoints the WAL with `PRAGMA wal_checkpoint(TRUNCATE)`, and warns instead of failing
  when the checkpoint is busy. Upgrading an existing telemetry database builds the `created`
  indexes once on the first boot after upgrade, which can pause startup on a large `logs` or
  `spans` table.
- **Lazy Photon thumbnails.** Importing `@gettersethya/mira` no longer loads
  `@cf-wasm/photon`; the WASM backend is imported through `thumbnail/lazy.ts` only when the
  thumbnail layer is built, and the app builder builds `ThumbnailServiceNoopLive` when no
  collection declares a file field. `BunPlatform` no longer statically imports Photon either:
  the Bun layer's `cover`/fallback path loads it on the first fallback resize. The Photon
  layers and factories exported from the package keep their names and behavior, and
  `computeDimensions` moved to `thumbnail/dimensions.ts` (still re-exported from
  `thumbnail/photon.ts`).

### Fixed

- **Sorted list cursor pagination.** `?sort=<field>&after=<seqId>` now resolves
  the cursor row's sort value and continues with a `(sortField, seqId)` keyset,
  with `seqId` as the tie-breaker. Previously the server filtered on `seqId`
  and then sorted by the requested field, so later pages could skip or repeat
  rows. Nullable sort fields and deleted cursor rows now fail closed with `422`
  instead of returning a silently incomplete page. The numeric `nextCursor` /
  `after` contract is unchanged; only non-`seqId` cursor pages pay one
  primary-key lookup.

## [0.1.0-alpha.37] - 2026-11-14

### Added

- **Landing API reference and changelog.** The landing now builds a TypeDoc reference for
  every public package and the Bun entry, linked from `/docs/api/`, and a `/changelog`
  page that renders `CHANGELOG.md` from GitHub at build time. The landing `build` script
  regenerates the reference, and CI checks it.
- **SMTP email service.** Optional `.email(SmtpEmail(...))` builder step backed by
  `nodemailer` and a platform `MailTransport` capability. Settings accept plain values or
  Effect `Config` values; missing required values fail at layer build. Without the step a
  no-op `EmailService` is used.
- **Auth email flows.** Per-auth-collection options for login alerts, email verification,
  login OTP, and passwordless login. New routes for verification, reset, login OTP, and
  passwordless login; reset links use a configurable `passwordResetUrl`.
- **Email plugin surface.** Plugins can use `EmailService` and observe sends through
  `onEmailSend`, `onEmailSent`, and `onEmailError`.
- **Local email testing.** `docker-compose.mailpit.yml`, plus an in-process `smtp-server`
  test suite.
- **Rate-limit engine and email budgets.** A reusable `RateLimiter` with an in-memory
  store for tests and a swappable `RateLimitStore` (SQLite by default). Auth email requests
  are limited per IP and recipient; sends are limited per recovery, login, or notification
  class, collection, and recipient. Daily caps bound cost. `429` responses
  carry `retryAfterSeconds` and `Retry-After`. The builder accepts `.rateLimits({ store,
  emailPolicies })`.
- **Bun runtime.** `BunPlatform` and `BunSqliteDatabase` backed by
  `@effect/platform-bun` and `@effect/sql-sqlite-bun`, plus the
  `@gettersethya/mira/bun` package entry and a root `bun` export condition. Bun uses native
  filesystem, path, HTTP server, runtime, SQLite, hashing (`Bun.CryptoHasher`), password
  hashing (`Bun.password` Argon2id), UUIDs (`Bun.randomUUIDv7`), and contain/fill
  thumbnails (`Bun.Image`). SMTP reuses `nodemailer` on Bun's native sockets; `cover`
  thumbnails reuse Photon because `Bun.Image` has no crop. Requires Bun `1.3.14+`
  (`Bun.Image`); `BunPlatform` fails fast below that floor and `engines.bun` declares
  it. `BunPortablePlatform` keeps scrypt hashing for databases that must move between
  Node and Bun. A Bun smoke app exercises migrations, HTTP CRUD, Argon2id, legacy
  scrypt, UUIDv7, native thumbnails, and the rate-limit store.
- **Password-login rate limits and hash upgrades.** `auth-with-password` charges per-IP
  and per-submitted-recipient budgets before the user lookup; store errors fail closed
  with `503`. A successful login upgrades a legacy `scrypt$...` row to the platform's
  current hash (Argon2id on Bun). `BunPortablePlatform` keeps scrypt for bidirectional
  databases.
- **Image decode budget.** PNG/JPEG/WebP headers are checked against a 64 MP budget
  before Photon or `Bun.Image` allocates pixels, including the Node/Photon path and
  the Bun `cover`/fallback. `makeThumbnailServicePhotonLive({ maxPixels })` and
  `makeThumbnailServiceBunLive({ maxPixels })` override the budget.

### Changed

- **Dashboard config is read-only and live.** Settings -> App now shows the live
  `FileStorage` and `EmailService` descriptions instead of editable legacy `_config`
  rows. S3/email `_config` keys are hidden and rejected by the update route.
- **Auth client result.** `authWithPassword()` now returns a union: a session result or
  `{ otpRequired: true, challengeId, expiresAt }`. This is a pre-1.0 type change.
- **Bun floor is 1.3.14.** `engines.bun` declares `>=1.3.14`, and `BunPlatform` checks
  `Bun.version` at layer build, failing with a clear error instead of silently losing the
  native `Bun.Image` path. The tested baseline remains 1.4.2.
- **Legacy `use_s3` is non-fatal.** An incomplete `use_s3=true` row logs a warning and
  yields no S3 config instead of crashing boot.
- **Auth email request outcomes.** Request endpoints now return `503 email_not_configured`
  when no transport is configured and can return `429 rate_limited`. Signup returns
  `verificationDeferred: true` when verification mail is blocked. `EmailService.send` gains
  `RateLimitedError` and `RateLimitUnavailableError` in its error union. These are pre-1.0
  client-visible changes.
- **Spans use `http.forwarded_for`.** The header-derived IP attribute is no longer named
  `http.client_ip`; enforcement uses `remoteAddress`.

### Fixed

- **Boolean rule parameters.** Auth rules such as
  `R.auth(Users, "emailVerified").eq(R.literal(true))` now encode booleans for the active
  dialect, including create and `manage` pre-checks.
- **Session invalidation.** Password reset bumps the token generation and consumes all
  outstanding auth challenges; dashboard auth now uses `authenticateSession`.

## [0.1.0-alpha.36] - 2026-11-09

### Added

- **Dashboard: inline collection filter builder.** The collection records page now filters
  in a bar directly above the table instead of a modal. Condition chips show field, operator
  and value; `and` / `or` pills toggle connectors backed by Mira's `Filter.and` /
  `Filter.or` DSL. Operators and value editors adapt to the collection schema (text,
  number, date, boolean, relation, and `x-literal` values), new conditions inherit the last
  connector, and the active search is shown as a `search` chip grouped with the condition
  expression.
- **Dashboard: anchored condition editor.** Editing a chip or adding a condition opens a
  viewport-clamped popover with Field / Operator / Value labels, focus/select of the value,
  Enter-to-apply, Escape close, and focus return. It is fully keyboard and phone operable.
- **Dashboard: schema inspector dialog.** The collection schema now opens from a `Schema`
  button beside `Connect`, with fixed header/footer, an independently scrollable field list,
  per-field icons, type labels and required/hidden annotations.
- **Dashboard: responsive record list.** Identity-first rows, copyable short IDs, ISO
  timestamps, text status labels, mobile card rows and a sticky, capped table header.
- **Dashboard: accessible form feedback.** Field labels are associated with controls,
  required fields expose `aria-required`, errors use alert semantics, and composite inputs
  focus as one group.

### Changed

- **Dashboard: landing-aligned palette.** Dashboard colours now mirror the landing project's
  black-and-white tokens (`#fafafa` / `#08080a` grounds, ink/primary, neutral borders and
  muted text) instead of the previous teal-tinted palette.
- **Dashboard: shell and navigation.** Breadcrumb alignment, active navigation state,
  compact mobile drawer and full-width phone navigation.
- **Dashboard: Connect and collections index.** Fitted Connect tabs and control sizes,
  fixed index action widths and a schema/operations footer.

### Fixed

- **Dashboard:** removed page-level horizontal overflow at tablet widths, fixed modal
  scrolling and clipped dialog actions, and removed the duplicate Clear Filters trigger.
- **Dashboard:** focus now outlines the whole input group rather than the inner input, so
  password fields no longer draw an overlapping inner rectangle.

## [0.1.0-alpha.35] - 2026-10-28

### Added

- **Storage: S3-compatible backend.** `S3CompatibleStorage(...)` and
  `makeS3FileStorageLayer(...)` back `FileStorage` with any S3-compatible bucket (AWS S3,
  MinIO, RustFS, LocalStack, Cloudflare R2, Backblaze B2). Requests are signed by
  `files-sdk`'s zero-peer `s3Fetch` adapter, so no `@aws-sdk/*` package is installed.
  Path-style addressing is the default; `url()` supports path-style, virtual-host and
  `publicBaseUrl` links. The adapter-agnostic `makeFileStorageFromFiles` core keeps
  `upload` stream errors (such as the upload-size limit) in their original error channel.
- **Storage: `Config`-based options.** Every `S3CompatibleStorage` field accepts a plain
  value or an Effect `Config` (`Config.String`, `Config.Redacted`, `Config.withDefault`, …).
  Values are resolved once when the layer is built with the active `ConfigProvider`, so a
  missing variable fails at startup instead of on the first upload. `accessKey` / `secret`
  also accept `Redacted` values.
- **Testing: RustFS end-to-end suite.** `docker-compose.rustfs.yml` starts RustFS on
  `:9000` (console `:9001`). The opt-in `MIRA_S3_E2E=1` test
  (`packages/mira/tests/storage/s3-rustfs.e2e.test.ts`) covers the full path: multipart
  upload → object stored in RustFS → `GET /api/files/...` streaming → prefix listing →
  record delete removing the object, plus a direct `FileStorage` roundtrip and `url()`.
- **Dashboard: package-manager selector.** The Connect sheet's install blocks have a
  `pnpm` / `npm` / `yarn` / `bun` dropdown that rewrites both install snippets. The choice
  is persisted in `localStorage` (`mira.dashboard.package-manager`).
- **Example app:** `apps/example` documents switching from `LocalFileStorage` to
  `S3CompatibleStorage`.

### Changed

- **Dependencies:** `@gettersethya/mira` now depends on `files-sdk@^3.1.2` for the S3
  adapter; local-disk deployments are unaffected but install the package.

## [0.1.0-alpha.34] - 2026-10-27

### Changed

- **npm:** alpha releases now also move the `latest` dist-tag onto the new version. While the
  project is pre-1.0 the npm package page (which renders `latest`) shows the newest build, and
  `npm i @gettersethya/mira` resolves to it. Stable releases take `latest` back by publishing
  with `--tag latest`.
- **CI:** `actions/checkout@v7`, `actions/setup-node@v7`, `actions/upload-artifact@v7` and
  `actions/download-artifact@v8`. `pnpm/action-setup` stays on v4 because v6 requires pnpm 11+.

## [0.1.0-alpha.33] - 2026-10-27

First release published by CI from a `v*` tag, with npm trusted publishing (OIDC) and
build provenance for all five packages.

### Added

- **Dashboard: Connect sheet.** Every collection page now has a `Connect` button that
  opens a tabbed sheet with ready-to-copy integration code for that collection.
  - `SDK` tab: install line, `createMiraClient(...).withCollections(collections)`, typed
    CRUD calls, the `@gettersethya/mira-tanstack-adapter` form, and a server-token variant.
    Auth collections lead with `register()` → `authWithPassword()` → `me()`.
  - `fetch` tab: wire-accurate HTTP calls, switchable between `fetch` and `curl`, including
    the JSON `FilterNode` used by the `filter` query parameter and multipart uploads when
    the collection has a file field.
  - `Types` tab: a generated `mira.generated.ts` with `BaseCollection` / `AuthCollection` /
    `ViewCollection` definitions, `PostsRecord` / `PostsCreate` / `PostsUpdate` aliases and a
    `collections` map, scoped to the current collection (plus its relation targets) or the
    whole schema, with copy and download.
  - The sheet state lives in the URL (`?connect=sdk|fetch|types`), and the base URL is
    editable and seeded from the configured `application_url`.
- **Dashboard: app settings.** `/settings` is split into `/settings/app` (editable
  configuration with editable/read-only/secret fields driven by the server) and
  `/settings/account`. The config API now returns `AppConfigResponse` and supports updates.
- **Dashboard: `InputGroup` primitive**, adopted across the record form fields.
- **Client:** `ApiFieldSchema` exposes the constraint annotations that `GET /api/_schema`
  already returned (`x-literal`, `x-maxSize`, `x-mimeTypes`, `minLength`, `maxLength`,
  `minimum`, `maximum`, `default`), so consumers can read field metadata without casts.
- **Release tooling:** tag-driven publishing. `pnpm release:alpha` / `pnpm release:stable`
  bump every manifest, commit and tag; `pnpm release:info <tag>` validates a tag against the
  manifests. `.github/workflows/publish.yml` verifies the tag, builds, typechecks, tests,
  packs with `pnpm pack` (which rewrites `workspace:*` to exact versions), publishes with
  `npm publish` in dependency order and creates a GitHub Release.

### Changed

- **Client:** `select` and `expand` keys are surfaced in the query option types.
- **Dashboard:** record forms, tables, sidebar, theme toggle and account menu were reworked
  on top of the new `InputGroup` primitive, and hidden values are stripped from exported and
  copied records.
- **Dashboard package:** `@gettersethya/mira-dashboard` now ships `ui/dist`, so the SPA is
  served from the published package instead of only from a local build.
- **Build:** each package has `clean-dist` and `check-exports` steps plus a dedicated
  `tsconfig.build.json`; pnpm is pinned through `packageManager`; the workspace root is
  `"type": "module"`.
- **CI:** least-privilege workflow permissions, no npm token (OIDC only), and a weekly
  Dependabot update for GitHub Actions.

### Fixed

- **Dashboard:** the Connect sheet was clamped to 75% width by the sheet primitive; it is now
  full-width on small screens and 896/1024 px on larger ones.
- **Dashboard:** snippets use unambiguous `<placeholder>` values instead of repeating the
  field name as the example value.
- **Example app:** `apps/example` declares `@types/node`, fixing `pnpm -r typecheck` on a
  clean install.

### Removed

- `scripts/bump-alpha.mjs` and `scripts/retag-latest.mjs`. Alpha releases no longer move the
  `latest` dist-tag; `latest` is reserved for stable releases.

### Security

- npm publishing uses short-lived OIDC credentials bound to the `npm_alpha` / `npm_stable`
  GitHub environments, with provenance attestations and no long-lived token in the repository.

[Unreleased]: https://github.com/GetterSethya/mira/compare/v0.1.0-alpha.36...HEAD
[0.1.0-alpha.36]: https://github.com/GetterSethya/mira/releases/tag/v0.1.0-alpha.36
[0.1.0-alpha.35]: https://github.com/GetterSethya/mira/releases/tag/v0.1.0-alpha.35
[0.1.0-alpha.34]: https://github.com/GetterSethya/mira/releases/tag/v0.1.0-alpha.34
[0.1.0-alpha.33]: https://github.com/GetterSethya/mira/releases/tag/v0.1.0-alpha.33
