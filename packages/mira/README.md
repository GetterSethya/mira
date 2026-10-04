# @gettersethya/mira

[![npm](https://img.shields.io/npm/v/@gettersethya/mira)](https://www.npmjs.com/package/@gettersethya/mira)

> **Early pre-alpha.** Breaking changes may occur without notice.

Self-hosted backend in TypeScript using [Effect v4](https://effect.website). Define collections, get a full REST API with auth, file storage, access rules, and schema migrations — all with zero config.

## Installation

```bash
npm install @gettersethya/mira @gettersethya/mira-collection effect
# or
pnpm add @gettersethya/mira @gettersethya/mira-collection effect
```

## Quick start

```typescript
import { defineRule, LocalFileStorage, Mira, NodePlatform, Rule, SqliteDatabase } from "@gettersethya/mira"
import { Posts, Users } from "./collections.js"

const userRules = defineRule(Users, (R) => ({
  list:   Rule.public(),
  view:   Rule.public(),
  create: Rule.public(),
  update: R.selfId().eq(R.authId(Users)),
}))

const postRules = defineRule(Posts, (R) => ({
  list:   R.field("published").eq(R.literal(true)),
  view:   R.or(
    R.field("published").eq(R.literal(true)),
    R.field("authorId").eq(R.authId(Users))
  ),
  create: R.authId(Users).neq(R.literal(null)),
  update: R.field("authorId").eq(R.authId(Users)),
  delete: R.field("authorId").eq(R.authId(Users)),
}))

const app = Mira.builder()
  .platform(NodePlatform)
  .database(SqliteDatabase({ filename: "mira.db" }))
  .storage(LocalFileStorage({ directory: "./uploads" }))
  .collections([Users, Posts])
  .rules([userRules, postRules])
  .build()

app.serve({ port: 3000 })
```

The builder uses phantom types to enforce step ordering — TypeScript will not let you call `.build()` until all four required steps are complete.

On first boot, Mira auto-generates a `jwt_secret`, runs schema migrations, and creates SQL views for view collections. Everything is persisted in the database.

## Builder steps

| Step | Required | Description |
|---|---|---|
| `.platform(p)` | Yes | Runtime environment (Node.js, etc.) |
| `.database(d)` | Yes | Database backend |
| `.storage(s)` | Yes | File storage backend |
| `.collections(c)` | Yes | Collection definitions |
| `.rules(r)` | No | Array of `RuleBinding` from `defineRule(collection, cb)` |
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
| `GET` | `/api/collections/:collection` | List (filter, sort, cursor, expand, select) |
| `GET` | `/api/collections/:collection/:id` | Get one |
| `POST` | `/api/collections/:collection` | Create |
| `PATCH` | `/api/collections/:collection/:id` | Update |
| `DELETE` | `/api/collections/:collection/:id` | Delete |
| `POST` | `/api/collections/:collection/auth-with-password` | Login (auth collections only) |
| `GET` | `/api/auth/me` | Current authenticated record |
| `POST` | `/api/auth/logout` | Logout |
| `POST` | `/api/files/token` | Request protected file token |
| `GET` | `/api/files/:collection/:id/:filename` | Serve file |
| `GET` | `/api/_schema` | Schema introspection |

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
