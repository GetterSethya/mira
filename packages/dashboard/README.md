# @gettersethya/mira-dashboard

[![npm](https://img.shields.io/npm/v/@gettersethya/mira-dashboard)](https://www.npmjs.com/package/@gettersethya/mira-dashboard)

> **Early pre-alpha.** Breaking changes may occur without notice.

Admin dashboard plugin for [Mira](https://github.com/gettersethya/mira). A SvelteKit SPA at `/_dashboard/` providing collection CRUD, log/span viewer, config display, superadmin management, cron job monitoring, and per-collection SDK/HTTP/type generation.

**Documentation:** https://gettersethya.github.io/mira/docs/dashboard/

## Installation

```bash
npm install @gettersethya/mira-dashboard
# or
pnpm add @gettersethya/mira-dashboard
```

`@gettersethya/mira` and `effect@^4` are required peer dependencies. The dashboard is Node-only: it hashes passwords and reads the SPA bundle from `ui/dist`.

## Usage

```typescript
import { LocalFileStorage, Mira, NodePlatform, SqliteDatabase } from "@gettersethya/mira"
import { MiraDashboard } from "@gettersethya/mira-dashboard"
import { Posts, Users } from "./collections.js"

const app = Mira.builder()
  .platform(NodePlatform)
  .database(SqliteDatabase({ filename: "mira.db" }))
  .storage(LocalFileStorage({ directory: "./uploads" }))
  .collections([Users, Posts])
  .build()

app.extend(MiraDashboard).serve()
```

On first boot the dashboard prints a one-time registration URL to stdout:

```
[dashboard] Register at: http://localhost:8080/_dashboard/register?token=<token>
```

Open that URL to create the first superadmin account. Once registered, subsequent boots print the login URL.

## Features

- **Collection browser** — list, create, edit, and delete records with a record editor
- **Connect sheet** — per-collection SDK snippets, raw `fetch`/`curl` calls, and a generated `mira.generated.ts` TypeScript file
- **Logs and span viewer** — works best with `makeSqliteTelemetryLayer` from `@gettersethya/mira`
- **App config** — edit app name/URL/port/log retention; view the live storage and email backends read-only
- **Superadmin management** — create, list, and delete superadmin accounts
- **Cron job monitoring** — list all registered cron jobs with their current status and trigger manual runs

### Cron API

The dashboard exposes two cron endpoints:

| Method | Path | Description |
|---|---|---|
| `GET` | `/_dashboard/api/crons` | List all cron jobs with name, status, last run info |
| `POST` | `/_dashboard/api/crons/:name/run` | Trigger immediate execution of a cron job by name |

`GET /_dashboard/api/config` returns the config snapshot plus live `storage` and
`email` descriptions. `PUT /_dashboard/api/config` updates only the allowlisted
application keys (`app_name`, `application_url`, `port`, `log_retention_days`);
legacy S3/email `_config` rows are hidden and rejected. Running process values stay
unchanged until restart. Use `POST /_dashboard/api/email/test` to send a test email to
the authenticated superadmin's own address.

## Connect sheet

Every collection page has a **Connect** action. It generates copyable output from the
live `GET /api/_schema` payload:

- **SDK** — `createMiraClient(...).withCollections(...)` usage, plus
  `authWithPassword`, `register`, and `me` for auth collections.
- **fetch** — the exact HTTP calls, switchable between `fetch` and `curl`, including
  the JSON `filter` query parameter.
- **Types** — a client-only `mira.generated.ts` module with
  `BaseCollection`/`AuthCollection`/`ViewCollection`, `Record`/`Create`/`Update`
  aliases, and a `collections` map. Server rules and indexes are intentionally omitted.

View collections get read-only snippets; file fields get a multipart example.

## Superadmin collection

The dashboard registers a `SuperAdminCollection` under the name `_superadmin` — an `AuthCollection` with deny-all rules. This collection is separate from your app's own user collection and is only accessible via the dashboard UI. A `_superadmin` token receives `ctx.admin = true` on generic collection and protected-file routes, so treat it as a root credential.

The registration token gates `POST /_dashboard/api/register`, but it does not close the generic `POST /api/collections/_superadmin` route. Because the create rule is public, that route can create a superadmin directly unless you override the rule or keep the route unreachable during first boot. Treat first boot as a trusted window.

## Audit hooks

The dashboard plugin registers audit hooks that log record create/update/delete operations and cron success/error events via `Effect.log`.
