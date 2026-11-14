import {
  BaseCollection,
  BunPlatform,
  BunSqliteDatabase,
  defineRule,
  Field,
  LocalFileStorage,
  Mira
} from "@gettersethya/mira"
import { MiraDashboard } from "@gettersethya/mira-dashboard"

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

const port = Number(Bun.env["PORT"] ?? 8080)

Mira.builder()
  .platform(BunPlatform)
  .database(BunSqliteDatabase({ filename: Bun.env["DB_PATH"] ?? "./bun-data.db" }))
  .storage(LocalFileStorage({ directory: Bun.env["UPLOAD_DIR"] ?? "./bun-uploads" }))
  .collections([Posts])
  .rules([postsRules])
  .build()
  .extend(MiraDashboard)
  .serve({ port })
