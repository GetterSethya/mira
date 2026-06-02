import {
  BaseCollection,
  Field,
  LocalFileStorage,
  makeSqliteTelemetryLayer,
  Mira,
  NodePlatform,
  SqliteDatabase
} from "@gettersethya/mira"
import { MiraDashboard } from "@gettersethya/mira-dashboard"

const Posts = BaseCollection.define("posts", {
  title: Field.text({ required: true }),
  body: Field.text(),
  published: Field.boolean({ default: false })
}).rules((R) => ({
  list: R.public(),
  view: R.public(),
  create: R.public(),
  update: R.public(),
  delete: R.public()
}))

const app = Mira.builder()
  .platform(NodePlatform)
  .database(SqliteDatabase({ filename: process.env["DB_PATH"] ?? "mira.db" }))
  .storage(LocalFileStorage({ directory: process.env["UPLOAD_DIR"] ?? "./uploads" }))
  .collections([Posts])
  .telemetry(makeSqliteTelemetryLayer({ dbPath: "log.db", logConsole: true }))
  .build()

app.extend(MiraDashboard).serve()
