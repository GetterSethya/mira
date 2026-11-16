import { writeFileSync } from "node:fs"
import { Session } from "node:inspector"

import {
  BaseCollection,
  Field,
  Repository,
  BatchMutationStats,
  defineRule,
  LocalFileStorage,
  Mira,
  MiraPlugin
} from "@gettersethya/mira"
import { Effect, Layer } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"

if (process.env.BENCH_STACK_TRACES === "off") {
  Error.stackTraceLimit = 0
}

const platformName = process.env.BENCH_PLATFORM
if (platformName !== "node" && platformName !== "bun") {
  throw new Error("BENCH_PLATFORM must be node or bun")
}

const port = Number(process.env.BENCH_PORT ?? "39001")
const dbPath = process.env.BENCH_DB ?? "./bench.sqlite"
const uploads = process.env.BENCH_UPLOADS ?? "./bench-uploads"

const Posts = BaseCollection.define("posts", {
  title: Field.text({ required: true }),
  body: Field.text(),
  published: Field.boolean({ default: false })
})

const postsRules = defineRule(Posts, (R) => ({
  list: R.public(),
  view: R.public(),
  create: R.public(),
  update: R.public(),
  delete: R.public()
}))

const platform =
  platformName === "bun"
    ? await import("@gettersethya/mira/bun").then((m) => ({
        preset: m.BunPlatform,
        database: m.BunSqliteDatabase
      }))
    : await import("@gettersethya/mira").then((m) => ({
        preset: m.NodePlatform,
        database: m.SqliteDatabase
      }))

const pingRoute = HttpRouter.route(
  "GET",
  "/__bench/ping",
  Effect.succeed(HttpServerResponse.jsonUnsafe({ ok: true }))
)

const repoListRoute = HttpRouter.route(
  "GET",
  "/__bench/repo-list",
  Effect.gen(function* () {
    const repo = yield* Repository
    const req = yield* HttpServerRequest.HttpServerRequest
    const params = new URLSearchParams(req.url.includes("?") ? req.url.split("?")[1] : "")
    const value = params.get("value") ?? "missing"
    const op = params.get("op") === "eq" ? "=" : "!="
    const page = yield* repo.list("posts", 30, {
      fields: ["id", "seqId", "title", "body", "published", "created", "updated"],
      where: { sql: `t."title" ${op} ?`, params: [value] }
    })
    return HttpServerResponse.jsonUnsafe(page)
  }).pipe(
    Effect.catchCause(() =>
      Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "repo-list failed" }, { status: 500 }))
    )
  )
)

const memoryRoute = HttpRouter.route(
  "GET",
  "/__bench/memory",
  Effect.sync(() => HttpServerResponse.jsonUnsafe(process.memoryUsage()))
)

// Create-batch observability: counters are recorded at the transaction
// chokepoint, so `commits` is the real number of outer commits, never derived
// from the flush count.
const batchStatsRoute = HttpRouter.route(
  "GET",
  "/__bench/batch-stats",
  Effect.gen(function* () {
    const stats = yield* BatchMutationStats
    return HttpServerResponse.jsonUnsafe(yield* stats.snapshot)
  }).pipe(
    Effect.catchCause(() =>
      Effect.succeed(
        HttpServerResponse.jsonUnsafe(
          { error: "batch_stats_unavailable" },
          { status: 503 }
        )
      )
    )
  )
)

// Reset the counters after warm-up so `records === measuredRequests` and the
// commit ratio cover the measured phase only.
const resetBatchStatsRoute = HttpRouter.route(
  "POST",
  "/__bench/batch-stats/reset",
  Effect.gen(function* () {
    const stats = yield* BatchMutationStats
    yield* stats.reset
    return HttpServerResponse.jsonUnsafe({ ok: true })
  }).pipe(
    Effect.catchCause(() =>
      Effect.succeed(
        HttpServerResponse.jsonUnsafe(
          { error: "batch_stats_unavailable" },
          { status: 503 }
        )
      )
    )
  )
)

// Exact row count for the cell self-checks. `Repository.list` is paginated, so
// this uses COUNT(*) directly.
const countRoute = HttpRouter.route(
  "GET",
  "/__bench/count",
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM ${sql("posts")}`
    return HttpServerResponse.jsonUnsafe({ count: Number(rows[0]?.count ?? 0) })
  }).pipe(
    Effect.catchCause(() =>
      Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "count failed" }, { status: 500 }))
    )
  )
)

let profileSession: Session | null = null

const profileStartRoute = HttpRouter.route(
  "GET",
  "/__bench/profile/start",
  Effect.sync(() => {
    if (profileSession !== null) {
      return HttpServerResponse.jsonUnsafe({ error: "already profiling" }, { status: 409 })
    }
    const session = new Session()
    session.connect()
    session.post("Profiler.enable", () => {
      session.post("Profiler.start", () => {})
    })
    profileSession = session
    return HttpServerResponse.jsonUnsafe({ ok: true })
  })
)

const profileStopRoute = HttpRouter.route(
  "GET",
  "/__bench/profile/stop",
  Effect.gen(function* () {
    const req = yield* HttpServerRequest.HttpServerRequest
    const params = new URLSearchParams(req.url.includes("?") ? req.url.split("?")[1] : "")
    const file = params.get("file")
    if (file === null) {
      return HttpServerResponse.jsonUnsafe({ error: "file required" }, { status: 400 })
    }
    const session = profileSession
    if (session === null) {
      return HttpServerResponse.jsonUnsafe({ error: "not profiling" }, { status: 409 })
    }
    profileSession = null
    const profile = yield* Effect.promise(
      () =>
        new Promise<unknown>((resolve, reject) => {
          session.post("Profiler.stop", (error, result) => {
            session.disconnect()
            if (error) reject(error)
            else resolve(result.profile)
          })
        })
    )
    yield* Effect.sync(() => writeFileSync(file, JSON.stringify(profile)))
    return HttpServerResponse.jsonUnsafe({ ok: true, file })
  }).pipe(
    Effect.catchCause(() =>
      Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "profile_stop_failed" }, { status: 500 }))
    )
  )
)

const exitRoute = HttpRouter.route(
  "GET",
  "/__bench/exit",
  Effect.sync(() => {
    setTimeout(() => process.exit(0), 100)
    return HttpServerResponse.empty({ status: 204 })
  })
)

const benchPlugin = MiraPlugin.define<Repository | BatchMutationStats | SqlClient.SqlClient>({
  routes: [
    pingRoute,
    repoListRoute,
    memoryRoute,
    batchStatsRoute,
    resetBatchStatsRoute,
    countRoute,
    profileStartRoute,
    profileStopRoute,
    exitRoute
  ]
})

const syncEnv = process.env.BENCH_SYNCHRONOUS
const synchronous =
  syncEnv === "FULL" || syncEnv === "NORMAL" || syncEnv === "OFF" ? syncEnv : undefined
const cacheEnabled = process.env.BENCH_CACHE !== "off"

const createBatchEnabled = process.env.BENCH_CREATE_BATCH !== "off"
const createBatchWindowMs = Number(process.env.BENCH_CREATE_BATCH_WINDOW_MS ?? "0")
const createBatchMax = Number(process.env.BENCH_CREATE_BATCH_MAX ?? "100")
const updateBatchEnabled = process.env.BENCH_UPDATE_BATCH === "on"
const deleteBatchEnabled = process.env.BENCH_DELETE_BATCH === "on"

Mira.builder()
  .platform(platform.preset)
  .database(platform.database({ filename: dbPath, synchronous }))
  .storage(LocalFileStorage({ directory: uploads }))
  .collections([Posts])
  .rules([postsRules])
  .cache({ enabled: cacheEnabled })
  .batchMutation({
    create: {
      enabled: createBatchEnabled,
      windowMs: createBatchWindowMs,
      maxBatchSize: createBatchMax
    },
    ...(updateBatchEnabled ? { update: { enabled: true } } : {}),
    ...(deleteBatchEnabled ? { delete: { enabled: true } } : {})
  })
  .telemetry(Layer.empty)
  .build()
  .extend(benchPlugin)
  .serve({
    port,
    maxPortAttempts: 1,
    disableLogger: true,
    disableTracing: process.env.BENCH_TRACING !== "on"
  })
