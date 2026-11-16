# Dashboard API (`src/api`)

## Overview

`packages/dashboard/src/api` contains the request handlers mounted under `/_dashboard/api` by
`makeDashboardRouter`. Every handler is a plain `Effect` producing an `HttpServerResponse`; none of
them register routes themselves — the route table lives in the parent module
([../EGM.md](../EGM.md)). All handlers resolve their dependencies (`CollectionService`,
`CronService`, `AppConfig`, `SqlClient`) from the Effect context.

The directory covers six concerns: the `_superadmin` JWT guard, first-boot status and registration,
authenticated superadmin CRUD, `_config` read/write with key allow-lists, cron status / run-now, and
email diagnostics plus the read-only template preview.

## Interface

### Auth guard

- `DashboardUnauthorizedError` — `Data.TaggedError("DashboardUnauthorizedError")` with no payload; the routers translate it to 401. [auth.ts:DashboardUnauthorizedError]
- `requireDashboardAuth` — Effect that extracts a token from the request, verifies it with `verifyJwt` against `AppConfig.jwtSecret`, requires `payload.col === "_superadmin"`, and returns the JWT payload. [auth.ts:requireDashboardAuth]

### Bootstrap

- `bootstrapStatusRoute` — `GET /_dashboard/api/bootstrap-status`; returns `{ bootstrapped, message? }` based on whether `_superadmin` has any row. [bootstrap-status.ts:bootstrapStatusRoute]

### First-boot registration

- `registerRoute` — `POST /_dashboard/api/register`; validates `{ email, password, name, token }`, checks the in-memory register token, refuses when already bootstrapped, creates the first superadmin. [register.ts:registerRoute]

### Superadmin management

- `createSuperadminRoute` — `POST /_dashboard/api/superadmin/create`; validates `{ email, password }`, rejects duplicate email, creates a superadmin. [superadmin.ts:createSuperadminRoute]
- `listSuperadminsRoute` — `GET /_dashboard/api/superadmin`; returns up to 500 superadmins projected to `{ id, email, created }`. [superadmin.ts:listSuperadminsRoute]
- `deleteSuperadminRoute` — `DELETE /_dashboard/api/superadmin/:id`; refuses to delete the last remaining superadmin. [superadmin.ts:deleteSuperadminRoute]

### Config

- `configRoute` — `GET /_dashboard/api/config`; returns `{ appName, applicationUrl, port, values, editable, readOnly, secret }`. [config.ts:configRoute]
- `configUpdateRoute` — `PUT /_dashboard/api/config`; validates `{ values: Record<string,string> }`, rejects keys outside the editable allow-list, upserts the rest, and returns a fresh snapshot. [config.ts:configUpdateRoute]

### Crons

- `cronsRoute` — `GET /_dashboard/api/crons`; returns every cron's state with ISO dates and stringified errors. [crons.ts:cronsRoute]
- `cronRunNowRoute` — `POST /_dashboard/api/crons/:name/run`; triggers `runNow(name)`, 204 on success, 404 on `CronNotFoundError`. [crons.ts:cronRunNowRoute]

### Email

- `emailTestRoute` — `POST /_dashboard/api/email/test`; sends a test message only to the authenticated superadmin's own address, under the `email:dashboard:test` budget. [email.ts:emailTestRoute]
- `makeEmailTemplatesRoute(collections)` — `GET /_dashboard/api/email/templates?collection=<name>`; 400 without `collection`, 404 when the name is unknown or non-auth, otherwise `{ collection, transportEnabled, templates }` from `EmailTemplates.preview`. [email-templates.ts:makeEmailTemplatesRoute]
- `authCollectionNames(collections)` — the auth-name set used for that 404 decision. [email-templates.ts:authCollectionNames]

### Route table

Routes are registered in the parent router; paths and methods below are the contract.

| Method | Path | Handler | Registration |
|---|---|---|---|
| GET | `/_dashboard/api/bootstrap-status` | `bootstrapStatusRoute` | [../router.ts:makeDashboardRouter] ([../EGM.md](../EGM.md)) |
| POST | `/_dashboard/api/register` | `registerRoute` | [../router.ts:makeDashboardRouter] ([../EGM.md](../EGM.md)) |
| POST | `/_dashboard/api/superadmin/create` | `createSuperadminRoute` (auth) | [../router.ts:makeDashboardRouter] ([../EGM.md](../EGM.md)) |
| GET | `/_dashboard/api/superadmin` | `listSuperadminsRoute` (auth) | [../router.ts:makeDashboardRouter] ([../EGM.md](../EGM.md)) |
| DELETE | `/_dashboard/api/superadmin/:id` | `deleteSuperadminRoute` (auth) | [../router.ts:makeDashboardRouter] ([../EGM.md](../EGM.md)) |
| GET | `/_dashboard/api/config` | `configRoute` (auth) | [../router.ts:makeDashboardRouter] ([../EGM.md](../EGM.md)) |
| PUT | `/_dashboard/api/config` | `configUpdateRoute` (auth) | [../router.ts:makeDashboardRouter] ([../EGM.md](../EGM.md)) |
| GET | `/_dashboard/api/crons` | `cronsRoute` (auth) | [../router.ts:makeDashboardRouter] ([../EGM.md](../EGM.md)) |
| POST | `/_dashboard/api/crons/:name/run` | `cronRunNowRoute` (auth) | [../router.ts:makeDashboardRouter] ([../EGM.md](../EGM.md)) |
| POST | `/_dashboard/api/email/test` | `emailTestRoute` (auth) | [../router.ts:makeDashboardRouter] ([../EGM.md](../EGM.md)) |
| GET | `/_dashboard/api/email/templates` | `makeEmailTemplatesRoute(collections)` (auth) | [../router.ts:makeDashboardRouter] ([../EGM.md](../EGM.md)) |

## Invariants

- Token extraction prefers `Authorization: Bearer <token>` (case-insensitive) and falls back to the `mira_token` cookie. [auth.ts:extractToken]
- A token is only accepted when its JWT payload has `col === "_superadmin"`; any other collection yields `DashboardUnauthorizedError`. [auth.ts:requireDashboardAuth]
- `requireDashboardAuth` annotates `auth.result` = `anonymous` when no token is present, `invalid_token` when a valid JWT is scoped to a collection other than `_superadmin`, and `authenticated` on success; a `verifyJwt` failure returns `DashboardUnauthorizedError` without setting `auth.result`. On success it also annotates `auth.collection`. [auth.ts:requireDashboardAuth]
- Wire-level failures from `verifyJwt` are converted to `DashboardUnauthorizedError`, never surfaced as a defect. [auth.ts:requireDashboardAuth]
- `bootstrapStatusRoute` treats "zero superadmin rows" as not bootstrapped and includes the registration hint only in that case. [bootstrap-status.ts:bootstrapStatusRoute]
- Registration succeeds only when the supplied token equals the in-memory token from `getRegisterToken`, and only while the `_superadmin` list is empty. [register.ts:registerRoute]
- Registration and superadmin mutations call `CollectionService` with a hardcoded `admin: true` context. [register.ts:adminCtx], [superadmin.ts:adminCtx]
- Registration returns `201` with `{ id, email }`, `403 invalid_token`, and `403 already_bootstrapped`. [register.ts:registerRoute]
- `createSuperadminRoute` performs an email lookup through `Filter.field("email").eq(...)` before creating, returning `409 email_taken` on a match. [superadmin.ts:createSuperadminRoute]
- `deleteSuperadminRoute` returns `404` when `:id` is missing and `409 last_superadmin` when the collection holds one or zero rows (deletion would leave no administrator). [superadmin.ts:deleteSuperadminRoute]
- `deleteSuperadminRoute` swallows delete failures (`Effect.catch(() => Effect.void)`) and still returns `204`. [superadmin.ts:deleteSuperadminRoute]
- `cronsRoute` never emits an `undefined` field: description, dates, last status, duration and error are normalised to `null`. [crons.ts:cronsRoute]
- `cronRunNowRoute` reads the cron name from `RouteContext.params["name"]` and maps only `CronNotFoundError` to 404. [crons.ts:cronRunNowRoute]
- `HIDDEN_KEYS` is exactly `["cron_state"]`; those rows are dropped from the config snapshot. [config.ts:HIDDEN_KEYS]
- `READ_ONLY_KEYS` is exactly `["jwt_secret"]`; it is returned but cannot be written. [config.ts:READ_ONLY_KEYS]
- `EDITABLE_KEYS` is the complete write allow-list (`app_name`, `application_url`, `port`, `use_s3`, `log_retention_days`, and the five S3 keys); everything else is rejected. [config.ts:EDITABLE_KEYS]
- `SECRET_KEYS` (`jwt_secret`, `s3_access_key`, `s3_secret`) tells the UI which values to mask. [config.ts:SECRET_KEYS]
- `configUpdateRoute` rejects the whole request with `400 not_editable` (listing offending keys) if any key is outside `EDITABLE_KEYS`. [config.ts:configUpdateRoute]
- Config writes are upserts into `_config` (`ON CONFLICT(key) DO UPDATE`), so a new value takes effect only after restart. [config.ts:configUpdateRoute]
- The template preview resolves `EmailTemplates` and `AppConfig` directly; it never calls `EmailService.describe()` or `send()`, so it works with the transport disabled and leaks no SMTP settings. [email-templates.ts:makeEmailTemplatesRoute]
- Preview rows use sentinel inputs only (`user@example.invalid`, `203.0.113.10`, sample tokens, a fixed timestamp) and contain no `to`, live reset token, or live link. [email-templates.ts:makeEmailTemplatesRoute]
- `transportEnabled` is `EmailService.enabled`; the UI uses it to explain that previews exist but mail cannot be sent. [email-templates.ts:makeEmailTemplatesRoute]

## Side Effects

- Verifies JWTs (`verifyJwt`) and reads `AppConfig.jwtSecret` on every authenticated request. [auth.ts:requireDashboardAuth]
- Annotates the active effect span with auth attributes. [auth.ts:requireDashboardAuth]
- Reads `_superadmin` rows through `CollectionService.list` with an admin context. [bootstrap-status.ts:bootstrapStatusRoute], [register.ts:registerRoute], [superadmin.ts:listSuperadminsRoute], [superadmin.ts:deleteSuperadminRoute]
- Creates superadmin records (which hashes the password downstream in `CollectionService`). [register.ts:registerRoute], [superadmin.ts:createSuperadminRoute]
- Deletes superadmin records. [superadmin.ts:deleteSuperadminRoute]
- Reads the `_config` table with `SqlSchema.findAll` and writes it with `INSERT … ON CONFLICT` upserts. [config.ts:readRows], [config.ts:configUpdateRoute]
- Queries and triggers cron runs via `CronService.getAll` / `CronService.runNow`. [crons.ts:cronsRoute], [crons.ts:cronRunNowRoute]
- Sends a test email through `EmailService.send` only to the authenticated superadmin. [email.ts:emailTestRoute]
- Reads `EmailTemplates`, `AppConfig`, and `EmailService.enabled` for the template preview; no SMTP call. [email-templates.ts:makeEmailTemplatesRoute]
- Returns HTTP responses (JSON or empty) from the handlers. [bootstrap-status.ts:bootstrapStatusRoute], [config.ts:configRoute], [crons.ts:cronRunNowRoute], [register.ts:registerRoute], [superadmin.ts:deleteSuperadminRoute]
- No logging calls are made in this directory.

## Verification

- Run: `pnpm --filter @gettersethya/mira-dashboard test`
