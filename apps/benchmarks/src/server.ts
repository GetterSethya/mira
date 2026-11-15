import { BaseCollection, Field, defineRule, LocalFileStorage, Mira } from "@gettersethya/mira"
import { Layer } from "effect"

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

Mira.builder()
  .platform(platform.preset)
  .database(platform.database({ filename: dbPath }))
  .storage(LocalFileStorage({ directory: uploads }))
  .collections([Posts])
  .rules([postsRules])
  .telemetry(Layer.empty)
  .build()
  .serve({ port, maxPortAttempts: 1 })
