# @gettersethya/mira-dashboard

> **Early pre-alpha.** Breaking changes may occur without notice.

Admin dashboard plugin for [Mira](https://github.com/gettersethya/mira). A SvelteKit SPA at `/_dashboard/` providing collection CRUD, log/span viewer, config display, superadmin management, and cron job monitoring.

## Installation

```bash
npm install @gettersethya/mira-dashboard
# or
pnpm add @gettersethya/mira-dashboard
```

`@gettersethya/mira` is a required peer dependency.

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
- **Logs and span viewer** — works best with `makeSqliteTelemetryLayer` from `@gettersethya/mira`
- **App config display** — view the current `AppConfig` from the `_config` table
- **Superadmin management** — create, list, and delete superadmin accounts
- **Cron job monitoring** — list all registered cron jobs with their current status and trigger manual runs

### Cron API

The dashboard exposes two cron endpoints:

| Method | Path | Description |
|---|---|---|
| `GET` | `/_dashboard/api/crons` | List all cron jobs with name, status, last run info |
| `POST` | `/_dashboard/api/crons/:name/run` | Trigger immediate execution of a cron job by name |

## Superadmin collection

The dashboard registers a `SuperAdminCollection` under the name `_superadmins` — an `AuthCollection` with deny-all rules. This collection is separate from your app's own user collection and is only accessible via the dashboard UI.

## Audit hooks

The dashboard plugin registers audit hooks that log record create/update/delete operations and cron success/error events via `Effect.log`.
