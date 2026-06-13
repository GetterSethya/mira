# @gettersethya/mira

> **Early pre-alpha.** Breaking changes may occur without notice.

Self-hosted backend in TypeScript using [Effect](https://effect.website). Define collections, get a full REST API with auth, file storage, access rules, and schema migrations — all with zero config.

## Installation

```bash
npm install @gettersethya/mira @gettersethya/mira-collection effect
# or
pnpm add @gettersethya/mira @gettersethya/mira-collection effect
```

## Quick start

```typescript
import { LocalFileStorage, Mira, NodePlatform, SqliteDatabase } from "@gettersethya/mira"
import { Posts, Users } from "./collections.js"

const app = Mira.builder()
  .platform(NodePlatform)
  .database(SqliteDatabase({ filename: "mira.db" }))
  .storage(LocalFileStorage({ directory: "./uploads" }))
  .collections([Users, Posts])
  .build()

app.serve({ port: 3000 })
```

The builder uses phantom types to enforce step ordering — TypeScript will not let you call `.build()` until all four steps are complete.

On first boot, Mira auto-generates a `jwt_secret`, runs schema migrations, and creates SQL views for view collections. Everything is persisted in the database.

## Builder steps

| Step | Required | Description |
|---|---|---|
| `.platform(p)` | Yes | Runtime environment (Node.js, etc.) |
| `.database(d)` | Yes | Database backend |
| `.storage(s)` | Yes | File storage backend |
| `.collections(c)` | Yes | Collection definitions |
| `.crons(c)` | No | Array of `CronDef` — scheduled tasks using Effect `Schedule` |
| `.telemetry(layer)` | No | Custom Effect telemetry layer |
| `.extend(plugin)` | No | Register a `MiraPlugin` (lifecycle hooks, routes, crons, layers) |

## Platforms

```typescript
import { NodePlatform } from "@gettersethya/mira"

// Provides: CryptoService, FileSystem, HttpServerFactory, AuthService
```

## Databases

```typescript
import { SqliteDatabase } from "@gettersethya/mira"

SqliteDatabase({ filename: "mira.db" })
SqliteDatabase({ filename: ":memory:" })  // in-memory for tests
```

## Storage

```typescript
import { LocalFileStorage } from "@gettersethya/mira"

LocalFileStorage({ directory: "./uploads" })
```

## Auto-generated endpoints

Each collection gets a full set of REST endpoints:

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/:collection` | List (filter, sort, cursor, expand, select) |
| `GET` | `/api/:collection/:id` | Get one |
| `POST` | `/api/:collection` | Create |
| `PATCH` | `/api/:collection/:id` | Update |
| `DELETE` | `/api/:collection/:id` | Delete |
| `POST` | `/api/:collection/authWithPassword` | Login (auth collections only) |
| `POST` | `/api/auth/logout` | Logout |
| `POST` | `/api/files/token` | Request protected file token |
| `GET` | `/api/files/:collection/:id/:filename` | Serve file |

## Cron jobs

Register scheduled tasks via the `.crons()` builder step. Each cron uses an Effect `Schedule` to define its recurrence.

```typescript
import { Schedule } from "effect"
import { CronService } from "@gettersethya/mira"

const app = Mira.builder()
  .platform(NodePlatform)
  .database(SqliteDatabase({ filename: "mira.db" }))
  .storage(LocalFileStorage({ directory: "./uploads" }))
  .collections([Users, Posts])
  .crons([
    {
      name: "cleanup",
      schedule: Schedule.fixed("1 hour"),
      handler: () => Effect.log("[cron] cleaning up..."),
    },
  ])
  .build()
  .serve()
```

Cron names must be globally unique. Use `CronService.getAll()` to inspect state and `CronService.runNow(name)` to trigger immediate execution. Plugins can declare crons via `crons` and hook into `onCronStart`/`onCronExecute`/`onCronSuccess`/`onCronError`/`onCronFinished`.

See the [Mira root README](https://github.com/gettersethya/mira#cron-jobs) for full cron documentation.

## Testing with the service layer

Use `.buildServiceLayer()` to get an Effect `Layer` for all services without starting an HTTP server:

```typescript
import { Effect, Layer } from "effect"

const serviceLayer = app.buildServiceLayer()

const test = Effect.gen(function* () {
  // inject and use services directly
}).pipe(Effect.provide(serviceLayer))
```

## More

See the [Mira root README](https://github.com/gettersethya/mira) for collection definitions, field types, rules, filter DSL, and client usage.
