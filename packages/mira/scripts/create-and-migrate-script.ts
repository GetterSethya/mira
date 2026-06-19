/**
 * Demonstration script: define collections with rules and run migrations.
 *
 * Run:
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/create-and-migrate-script.ts
 *
 * Creates mira-dev.db in the project root. Delete it to start fresh.
 */

import { SqlClient } from "@effect/sql"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Effect, Layer, Schema } from "effect"
import { existsSync, unlinkSync } from "node:fs"
import { resolve } from "node:path"
import { AuthCollection, BaseCollection, Field, ViewCollection } from "@gettersethya/mira-client"
import { Dialect } from "@/dialect/dialect.js"
import { sqliteDialect } from "@/dialect/dialect-sqlite.js"
import { Migrator, MigratorLive } from "@/migrator/migrator.js"

// ---------------------------------------------------------------------------
// 1. Collection definitions
// ---------------------------------------------------------------------------

const Users = AuthCollection.define("users", {
  displayName: Field.text({ maxLength: 100 }),
  role: Field.text({ default: "member" })
}).rules((R) => ({
  list: R.field("id").eq(R.selfId()),
  view: R.field("id").eq(R.selfId()),
  create: R.public(),
  update: R.field("id").eq(R.selfId()),
  delete: R.field("id").eq(R.selfId())
}))

const Posts = BaseCollection.define("posts", {
  title: Field.text({ maxLength: 200 }),
  body: Field.text({ required: false }),
  published: Field.boolean({ default: false }),
  publishedAt: Field.date({ required: false }),
  authorId: Field.text({ indexed: true }),
  viewCount: Field.integer({ default: 0, min: 0 })
})
  .indexes((I) => [I.on("publishedAt"), I.unique("authorId", "title")])
  .rules((R) => ({
    list: R.or(
      R.field("published").eq(R.literal(true)),
      R.field("authorId").eq(R.authId(Users))
    ),
    view: R.or(
      R.field("published").eq(R.literal(true)),
      R.field("authorId").eq(R.authId(Users))
    ),
    create: R.field("authorId").eq(R.authId(Users)),
    update: R.field("authorId").eq(R.authId(Users)),
    delete: R.field("authorId").eq(R.authId(Users))
  }))

const Comments = BaseCollection.define("comments", {
  postId: Field.text({ indexed: true }),
  authorId: Field.text({ indexed: true }),
  body: Field.text({ maxLength: 2000 }),
  createdAt: Field.date()
})
  .indexes((I) => [I.on("postId", "createdAt")])
  .rules((R) => ({
    list: R.public(),
    view: R.public(),
    create: R.field("authorId").eq(R.authId(Users)),
    update: R.field("authorId").eq(R.authId(Users)),
    delete: R.field("authorId").eq(R.authId(Users))
  }))

const PublishedPosts = ViewCollection.define(
  "published_posts",
  `SELECT
     CAST(ROW_NUMBER() OVER (ORDER BY p.seqId) AS INTEGER) AS seqId,
     p.id, p.title, p.publishedAt, p.viewCount,
     u.id as authorId, u.displayName as authorName
   FROM posts p JOIN users u ON p.authorId = u.id
   WHERE p.published = 1`,
  {
    seqId:       Field.integer().view(),
    id:          Field.text().view(),
    title:       Field.text().view(),
    publishedAt: Field.date().view(),
    viewCount:   Field.integer().view(),
    authorId:    Field.text().view(),
    authorName:  Field.text().view()
  }
).rules((R) => ({ list: R.public(), view: R.public() }))

const allSchemas = [
  { name: Users.name, schema: Users.schema },
  { name: Posts.name, schema: Posts.schema },
  { name: Comments.name, schema: Comments.schema },
  { name: PublishedPosts.name, schema: PublishedPosts.schema }
]

// ---------------------------------------------------------------------------
// 2. Effect layer (SQLite file so you can inspect the result)
// ---------------------------------------------------------------------------

const DB_PATH = resolve("mira-dev.db")

// provideMerge keeps SqlClient.SqlClient in the output so the program can query directly.
const appLayer = MigratorLive.pipe(
  Layer.provideMerge(Layer.mergeAll(Layer.succeed(Dialect, sqliteDialect), SqliteClient.layer({ filename: DB_PATH })))
)

// ---------------------------------------------------------------------------
// 3. Main program
// ---------------------------------------------------------------------------

const program = Effect.gen(function* () {
  const migrator = yield* Migrator
  const sql = yield* SqlClient.SqlClient

  // -- Plan (dry run) -------------------------------------------------------
  console.log("\n=== Migration Plan ===")
  const plan = yield* migrator.plan(allSchemas)
  if (plan.steps.length === 0) {
    console.log("  (no changes — DB is already up to date)")
  } else {
    for (const step of plan.steps) {
      const marker = plan.destructive ? "  [DESTRUCTIVE]" : "  "
      console.log(`${marker} ${step.kind}: ${"table" in step ? step.table : "name" in step ? step.name : ""}`)
    }
    if (plan.destructive) {
      console.log("\n  Warning: plan contains destructive steps.")
    }
  }

  // -- Migrate --------------------------------------------------------------
  console.log("\n=== Running Migration ===")
  yield* migrator.migrate(allSchemas, { logLevel: 2 })
  console.log("  Done.")

  // -- Verify: tables -------------------------------------------------------
  console.log("\n=== Tables in DB ===")
  const tables = yield* sql<{ name: string; type: string }>`
    SELECT name, type FROM sqlite_master
    WHERE type IN ('table', 'index')
    ORDER BY type, name
  `
  for (const row of tables) {
    console.log(`  [${row.type}] ${row.name}`)
  }

  // -- Verify: _collections -------------------------------------------------
  console.log("\n=== Stored Collection Schemas ===")
  const collections = yield* sql<{ name: string; schema: string }>`
    SELECT name, schema FROM _collections ORDER BY name
  `
  for (const row of collections) {
    const parsed = yield* Schema.decodeUnknown(
      Schema.parseJson(Schema.Record({ key: Schema.String, value: Schema.Unknown }))
    )(row.schema).pipe(Effect.orDie)
    const props = parsed["properties"]
    const fieldNames = Object.keys(typeof props === "object" && props !== null ? props : {})
    console.log(`${row.name}: [${fieldNames.join(", ")}]`)
  }

  // -- Content: all tables and views ----------------------------------------
  console.log("\n=== Table & View Contents ===")
  const queryables = yield* sql<{ name: string; type: string }>`
    SELECT name, type FROM sqlite_master
    WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `
  for (const { name, type } of queryables) {
    const rows = yield* sql`SELECT * FROM ${sql(name)}`
    console.log(`\n  [${type}] ${name} — ${rows.length} row(s)`)
    if (rows.length === 0) {
      console.log("    (empty)")
    } else {
      for (const row of rows) {
        console.log("   ", JSON.stringify(row))
      }
    }
  }

  console.log(`\nDB file: ${DB_PATH}\n`)
})

// ---------------------------------------------------------------------------
// 4. Bootstrap
// ---------------------------------------------------------------------------

if (existsSync(DB_PATH)) {
  console.log(`Removing existing DB: ${DB_PATH}`)
  unlinkSync(DB_PATH)
}

Effect.runPromise(Effect.provide(program, appLayer)).catch((err: unknown) => {
  console.error("Script failed:", err)
  process.exit(1)
})
