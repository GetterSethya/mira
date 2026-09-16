import {
  AuthCollection,
  BaseCollection,
  defineRule,
  Field,
  InferRecord,
  LocalFileStorage,
  logCleanupCronDef,
  makeSqliteTelemetryLayer,
  Mira,
  NodePlatform,
  SqliteDatabase
} from "@gettersethya/mira"
import { MiraDashboard } from "@gettersethya/mira-dashboard"

const Users = AuthCollection.define("users", {
  name: Field.text({ required: true, minLength: 1 })
})

type Users = InferRecord<typeof Users.fields>

const Posts = BaseCollection.define("posts", {
  title: Field.text({ required: true }),
  body: Field.text(),
  published: Field.boolean({ default: false })
})

type Posts = InferRecord<typeof Posts.fields>

const Likes = BaseCollection.define("likes", {
  post: Field.relation(Posts, { required: true }),
  user: Field.relation(Users, { required: true })
})

type Likes = InferRecord<typeof Likes.fields>

const userRules = defineRule(Users, (R) => ({
  list: R.public(),
  view: R.public(),
  create: R.public(),
  update: R.field("id").eq(R.selfId()),
  delete: R.field("id").eq(R.selfId())
}))

const likeRules = defineRule(Likes, (R) => ({
  create: R.field("user").eq(R.authId(Users)),
  update: R.field("user").eq(R.authId(Users)),
  list: R.field("user").eq(R.authId(Users)),
  view: R.field("user").eq(R.authId(Users)),
  delete: R.field("user").eq(R.authId(Users))
}))

const postsRules = defineRule(Posts, (R) => ({
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
  .collections([Users, Posts, Likes])
  .rules([postsRules, userRules, likeRules])
  .telemetry(makeSqliteTelemetryLayer({ dbPath: "log.db", logConsole: true }))
  .crons([logCleanupCronDef])
  .build()

app.extend(MiraDashboard).serve()
