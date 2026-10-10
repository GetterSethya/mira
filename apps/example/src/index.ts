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

const UserCollection = AuthCollection.define("users", {
  name: Field.text({ required: true, minLength: 1 }),
})

type UserCollection = InferRecord<typeof UserCollection.fields>

const PostCollection = BaseCollection.define("posts", {
  title: Field.text({ required: true }),
  body: Field.text(),
  published: Field.boolean({ default: false }),
  user: Field.relation(UserCollection, { required: true })
})

type PostCollection = InferRecord<typeof PostCollection.fields>

const LikeCollection = BaseCollection.define("likes", {
  post: Field.relation(PostCollection, { required: true }),
  user: Field.relation(UserCollection, { required: true })
})

type LikeCollection = InferRecord<typeof LikeCollection.fields>

const userCollectionRules = defineRule(UserCollection, (R) => ({
  list: R.public(),
  view: R.public(),
  create: R.public(),
  update: R.field("id").eq(R.selfId()), // bisa diupdate oleh yang punya
  delete: R.field("id").eq(R.selfId()) // bisa didelete oleh yang punya
}))

const likeCollectionRules = defineRule(LikeCollection, (R) => ({
  create: R.field("user").eq(R.authId(UserCollection)), // field user = user.id
  update: R.field("user").eq(R.authId(UserCollection)),
  list: R.field("user").eq(R.authId(UserCollection)),
  view: R.field("user").eq(R.authId(UserCollection)),
  delete: R.field("user").eq(R.authId(UserCollection))
}))

const postCollectionRules = defineRule(PostCollection, (R) => ({
  list: R.public(),
  view: R.public(),
  create: R.field("user").eq(R.authId(UserCollection)),
  update: R.field("user").eq(R.authId(UserCollection)),
  delete: R.field("user").eq(R.authId(UserCollection))
}))

Mira.builder()
  .platform(NodePlatform) // NodePlatform, BunPlatform, DenoPlatform, CloudflarePlatform,....
  .database(SqliteDatabase({ filename: process.env["DB_PATH"] ?? "mira.db" })) // PostgresDatabase, SqliteDatabase, MySqlDatabase, D1Database, TursoDatabase....
  .storage(LocalFileStorage({ directory: process.env["UPLOAD_DIR"] ?? "./uploads" })) // LocalfileStorage, S3Storage,
  .collections([
    //
    UserCollection,
    PostCollection,
    LikeCollection
  ])
  .rules([
    //
    postCollectionRules,
    userCollectionRules,
    likeCollectionRules
  ])
  .telemetry(makeSqliteTelemetryLayer({ dbPath: "log.db", logConsole: true, pretty: true }))
  .crons([logCleanupCronDef])
  .build()
  .extend(MiraDashboard)
  .serve()
