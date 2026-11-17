import {
  BaseCollection,
  defineRule,
  Field,
  LibsqlDatabase,
  LocalFileStorage,
  makeTelemetryLayer,
  Mira,
  NodePlatform
} from "@gettersethya/mira"
import { Redacted } from "effect"

const Posts = BaseCollection.define("posts", {
  title: Field.text({ required: true }),
  body: Field.text()
})

const postsRules = defineRule(Posts, (R) => ({
  list: R.public(),
  view: R.public(),
  create: R.public()
}))

const url = process.env["LIBSQL_URL"] ?? "file:./mira-libsql.db"
const authToken = process.env["LIBSQL_AUTH_TOKEN"]
const syncUrl = process.env["LIBSQL_SYNC_URL"]
const telemetryUrl = process.env["LIBSQL_TELEMETRY_URL"] ?? url

if (syncUrl !== undefined) {
  console.warn(
    "Embedded replica mode: auto-migration is disabled. Migrate the primary first, then sync before starting this process."
  )
}

Mira.builder()
  .platform(NodePlatform)
  .database(
    LibsqlDatabase({
      url,
      authToken: authToken === undefined ? undefined : Redacted.make(authToken),
      syncUrl
    })
  )
  .storage(LocalFileStorage({ directory: process.env["UPLOAD_DIR"] ?? "./uploads" }))
  .collections([Posts])
  .rules([postsRules])
  .telemetry(
    makeTelemetryLayer({
      storage: {
        mode: "dedicated",
        database: LibsqlDatabase({
          url: telemetryUrl,
          authToken: authToken === undefined ? undefined : Redacted.make(authToken)
        })
      },
      // Remote libSQL charges one round trip per store call. Batch the drain.
      flushBatchSize: 100,
      flushInterval: "1 second"
    })
  )
  .build()
  .serve()
