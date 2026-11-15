import {
  BaseCollection,
  Field,
  Repository,
  defineRule,
  LocalFileStorage,
  Mira,
  MiraPlugin
} from "@gettersethya/mira"
import { Effect, Layer } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"

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
  create: R.public()
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

const exitRoute = HttpRouter.route(
  "GET",
  "/__bench/exit",
  Effect.sync(() => {
    setTimeout(() => process.exit(0), 100)
    return HttpServerResponse.empty({ status: 204 })
  })
)

const benchPlugin = MiraPlugin.define<Repository>({
  routes: [pingRoute, repoListRoute, memoryRoute, exitRoute]
})

const syncEnv = process.env.BENCH_SYNCHRONOUS
const synchronous =
  syncEnv === "FULL" || syncEnv === "NORMAL" || syncEnv === "OFF" ? syncEnv : undefined
const cacheEnabled = process.env.BENCH_CACHE !== "off"

Mira.builder()
  .platform(platform.preset)
  .database(platform.database({ filename: dbPath, synchronous }))
  .storage(LocalFileStorage({ directory: uploads }))
  .collections([Posts])
  .rules([postsRules])
  .cache({ enabled: cacheEnabled })
  .telemetry(Layer.empty)
  .build()
  .extend(benchPlugin)
  .serve({
    port,
    maxPortAttempts: 1,
    disableLogger: true,
    disableTracing: process.env.BENCH_TRACING !== "on"
  })
