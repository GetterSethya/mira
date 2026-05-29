/**
 * Scaffold app: Users + Posts + Comments with migration, seeding, and HTTP server.
 *
 * Run:
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/scaffold-app-script.ts
 *
 * Delete scaffold.db to wipe and re-seed.
 *
 * API after startup (default port 8080):
 *
 *   # Login
 *   POST /api/collections/users/auth-with-password
 *     body: { "email": "alice@example.com", "password": "alice123" }
 *     → { token, record }
 *
 *   # Current user (requires Bearer token)
 *   GET /api/collections/users/:id
 *
 *   # All posts (public)
 *   GET /api/collections/posts
 *
 *   # Posts by a specific user (URL-encode the filter JSON)
 *   GET /api/collections/posts?filter={"op":"eq","field":"authorId","value":"USER_ID"}
 *
 *   # Comments on a post
 *   GET /api/collections/comments?filter={"op":"eq","field":"postId","value":"POST_ID"}
 *
 *   # Comments by a user
 *   GET /api/collections/comments?filter={"op":"eq","field":"authorId","value":"USER_ID"}
 *
 *   # Create a post (requires Bearer token)
 *   POST /api/collections/posts
 *     body: { "title": "...", "body": "...", "authorId": "YOUR_ID" }
 *
 *   # Create a comment (requires Bearer token)
 *   POST /api/collections/comments
 *     body: { "postId": "...", "authorId": "YOUR_ID", "body": "..." }
 */

import { HttpServer } from "@effect/platform"
import { NodeFileSystem, NodeHttpServer, NodePath, NodeRuntime } from "@effect/platform-node"
import { SqlClient } from "@effect/sql"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Data, Effect, Layer, Schedule, Schema } from "effect"
import { createServer } from "node:http"
import { AuthCollection, BaseCollection, Field } from "@gettersethya/mira-client"
import { Dialect } from "@/migrator/dialect.js"
import { sqliteDialect } from "@/migrator/dialect-sqlite.js"
import { Migrator, MigratorLive } from "@/migrator/migrator.js"
import { Repository, RepositoryLive } from "@/repository/repository.js"
import { makeCachedCollectionServiceLayer } from "@/cache/index.js"
import { makeCollectionRouter } from "@/http/router.js"
import { makeFileStorageLayer } from "@/storage/storage.js"
import { hashPassword } from "@/http/auth.js"
import { ThumbnailServicePhotonLive } from "@/thumbnail/index.js"
import { AppConfig, AppConfigLive } from "@/config/index.js"
import { NodeCryptoLayer } from "@/crypto/node.js"
import { NodeAuthServiceLayer } from "@/http/auth-node.js"

// ---------------------------------------------------------------------------
// 1. Collection definitions
// ---------------------------------------------------------------------------

const Users = AuthCollection.define("users", {
  displayName: Field.text({ maxLength: 100, required: false })
}).rules((R) => ({
  list: R.field("id").eq(R.selfId()),
  view: R.public(),
  create: R.public(),
  update: R.field("id").eq(R.selfId()),
  delete: R.field("id").eq(R.selfId())
}))

const Posts = BaseCollection.define("posts", {
  title: Field.text({ maxLength: 200 }),
  body: Field.text({ required: false }),
  authorId: Field.relation(Users)
}).rules((R) => ({
  list: R.public(),
  view: R.public(),
  create: R.field("authorId").eq(R.authId(Users)),
  update: R.field("authorId").eq(R.authId(Users)),
  delete: R.field("authorId").eq(R.authId(Users))
}))

const Comments = BaseCollection.define("comments", {
  postId: Field.relation(Posts),
  authorId: Field.relation(Users),
  body: Field.text({ maxLength: 2000 })
}).rules((R) => ({
  list: R.public(),
  view: R.public(),
  create: R.field("authorId").eq(R.authId(Users)),
  update: R.field("authorId").eq(R.authId(Users)),
  delete: R.field("authorId").eq(R.authId(Users))
}))

const allCollections = [Users, Posts, Comments] as const
const allSchemas = allCollections.map((c) => ({ name: c.name, schema: c.schema }))

// ---------------------------------------------------------------------------
// 2. Config
// ---------------------------------------------------------------------------

const DB_FILE = process.env["DB_PATH"] ?? "scaffold.db"
const PORT = Number(process.env["PORT"] ?? 8080)
const UPLOAD_DIR = process.env["UPLOAD_DIR"] ?? "./uploads"

// ---------------------------------------------------------------------------
// 3. Startup: migration + conditional seed
// ---------------------------------------------------------------------------

const startupEffect = Effect.gen(function* () {
  const migrator = yield* Migrator
  const repo = yield* Repository
  const sql = yield* SqlClient.SqlClient

  // -- Migration ------------------------------------------------------------
  console.log("[startup] Running migrations…")
  yield* migrator.migrate(allSchemas, { logLevel: 1 })
  console.log("[startup] Migrations complete.")

  // -- Seed (only when the users table is empty) ----------------------------
  const rows = yield* sql<{ n: number }>`SELECT COUNT(*) as n FROM ${sql("users")}`
  const userCount = rows[0]?.n ?? 0
  if (userCount > 0) {
    console.log(`[startup] ${userCount} user(s) already in DB — skipping seed.`)
    return
  }

  console.log("[startup] Seeding sample data…")

  // Seed users (bypass CollectionService — system fields are write-only via repo)
  const aliceHash = yield* hashPassword("alice123")
  const alice = yield* repo
    .create("users", { email: "alice@example.com", password: aliceHash, displayName: "Alice" })
    .pipe(Effect.orDie)

  const bobHash = yield* hashPassword("bob123")
  const bob = yield* repo
    .create("users", { email: "bob@example.com", password: bobHash, displayName: "Bob" })
    .pipe(Effect.orDie)

  const IdSchema = Schema.Struct({ id: Schema.String })
  const { id: aliceId } = yield* Schema.decodeUnknown(IdSchema)(alice).pipe(Effect.orDie)
  const { id: bobId } = yield* Schema.decodeUnknown(IdSchema)(bob).pipe(Effect.orDie)

  // Seed posts
  const post1 = yield* repo
    .create("posts", { title: "Hello from Alice", body: "My first post on Mira.", authorId: aliceId })
    .pipe(Effect.orDie)
  const post2 = yield* repo
    .create("posts", { title: "Bob's Thoughts", body: "Mira is a great self-hosted backend.", authorId: bobId })
    .pipe(Effect.orDie)
  const post3 = yield* repo
    .create("posts", {
      title: "Effect-TS tips",
      body: "Use Layer.provideMerge for clean composition.",
      authorId: aliceId
    })
    .pipe(Effect.orDie)

  const { id: post1Id } = yield* Schema.decodeUnknown(IdSchema)(post1).pipe(Effect.orDie)
  const { id: post2Id } = yield* Schema.decodeUnknown(IdSchema)(post2).pipe(Effect.orDie)
  const { id: post3Id } = yield* Schema.decodeUnknown(IdSchema)(post3).pipe(Effect.orDie)

  // Seed comments
  yield* repo.create("comments", { postId: post1Id, authorId: bobId, body: "Great post, Alice!" }).pipe(Effect.orDie)
  yield* repo.create("comments", { postId: post1Id, authorId: aliceId, body: "Thanks Bob!" }).pipe(Effect.orDie)
  yield* repo
    .create("comments", { postId: post2Id, authorId: aliceId, body: "Agreed, very useful." })
    .pipe(Effect.orDie)
  yield* repo
    .create("comments", { postId: post3Id, authorId: bobId, body: "This is exactly what I needed." })
    .pipe(Effect.orDie)

  console.log("[startup] Seeded 2 users, 3 posts, 4 comments.")
  console.log("[startup]   alice@example.com  / alice123")
  console.log("[startup]   bob@example.com    / bob123")
})

// ---------------------------------------------------------------------------
// 4. Layer stack
//
//   foundation   — SQLite file, dialect, file storage (no external deps)
//   infra        — Repository + Migrator on top of foundation
//   infraMigrated — infra + startup effect (migration + seed run here)
//   collection   — CollectionService on top of infraMigrated
//   app          — HTTP router served once collection layer is ready
// ---------------------------------------------------------------------------

const router = makeCollectionRouter([...allCollections])

// foundation: no external dependencies
const foundation = Layer.mergeAll(
  SqliteClient.layer({ filename: DB_FILE }),
  Layer.succeed(Dialect, sqliteDialect),
  makeFileStorageLayer("local", { directory: UPLOAD_DIR }).pipe(
    Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))
  ),
  ThumbnailServicePhotonLive,
  NodeCryptoLayer,
  NodeAuthServiceLayer,
)

// infra: Repository + Migrator, wired to foundation
const infra = Layer.mergeAll(RepositoryLive, MigratorLive).pipe(Layer.provideMerge(foundation))

// infraMigrated: same services as infra, but migration + seed run during construction
const infraMigrated = Layer.effectDiscard(startupEffect).pipe(Layer.provideMerge(infra))

// collection: CollectionService wired to the migrated infrastructure
const collectionLayer = makeCachedCollectionServiceLayer([...allCollections]).pipe(Layer.provideMerge(infraMigrated))

// config: pre-seed port into _config so AppConfigLive picks it up, then run AppConfigLive
const configLayer = Layer.unwrapEffect(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS _config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
    yield* sql`INSERT INTO ${sql("_config")} ${sql.insert({ key: "port", value: String(PORT) })} ON CONFLICT(key) DO NOTHING`
    return AppConfigLive
  })
).pipe(Layer.provideMerge(foundation))

// http: derive port from AppConfig (reads the value we just seeded)
const serverLayer = Layer.unwrapEffect(
  Effect.map(AppConfig, (cfg) => NodeHttpServer.layer(() => createServer(), { port: cfg.port }))
)

// app: serve the router with all service dependencies provided
const appLayer = HttpServer.serve(router).pipe(
  Layer.provideMerge(serverLayer),
  Layer.provideMerge(Layer.merge(collectionLayer, configLayer)),
)

// ---------------------------------------------------------------------------
// 5. Main
// ---------------------------------------------------------------------------

console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
console.log("  Mira scaffold app")
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
console.log(`  DB       : ${DB_FILE}`)
console.log(`  Port     : ${PORT}`)
console.log(`  Uploads  : ${UPLOAD_DIR}`)
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
console.log()

// ---------------------------------------------------------------------------
// 6. Test suite  (runs concurrently once the server is ready)
// ---------------------------------------------------------------------------

const BASE = `http://localhost:${PORT}`
let _passed = 0
let _failed = 0

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    _passed++
    console.log(`  ✓  ${name}`)
  } catch (e) {
    _failed++
    console.log(`  ✗  ${name}`)
    console.log(`       → ${e instanceof Error ? e.message : String(e)}`)
  }
}

function check(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}

async function req(
  method: string,
  path: string,
  opts?: { body?: unknown; token?: string }
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (opts?.token) headers["Authorization"] = `Bearer ${opts.token}`
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    ...(opts?.body !== undefined ? { body: JSON.stringify(opts.body) } : {})
  })
  let body: unknown = null
  try { body = await res.json() } catch { /* 204 or non-JSON */ }
  return { status: res.status, body }
}

class ServerNotReadyError extends Data.TaggedError("ServerNotReadyError")<{ cause: unknown }> {}

async function waitForServer(): Promise<void> {
  await Effect.runPromise(
    Effect.retry(
      Effect.tryPromise({
        try: () => fetch(`${BASE}/api/collections/posts`).then(() => undefined),
        catch: (e) => new ServerNotReadyError({ cause: e })
      }),
      Schedule.intersect(Schedule.recurs(49), Schedule.spaced("200 millis"))
    ).pipe(Effect.mapError((e) => new ServerNotReadyError({ cause: e })))
  )
}

async function doLogin(email: string, password: string) {
  const r = await req("POST", "/api/collections/users/auth-with-password", { body: { email, password } })
  if (r.status !== 200) throw new Error(`Login failed: status ${r.status}`)
  return Schema.decodeUnknownSync(
    Schema.Struct({ token: Schema.String, record: Schema.Struct({ id: Schema.String }) })
  )(r.body)
}

async function runTests(): Promise<void> {
  await waitForServer()

  const alice = await doLogin("alice@example.com", "alice123")
  const bob   = await doLogin("bob@example.com",   "bob123")
  const aliceId = alice.record.id
  const bobId   = bob.record.id

  // Prefetch seed data for IDs used across sections
  const PostItemSchema = Schema.Struct({ id: Schema.String, authorId: Schema.String })
  const CommentItemSchema = Schema.Struct({ id: Schema.String, authorId: Schema.String, postId: Schema.String })
  const allPosts = Schema.decodeUnknownSync(Schema.Struct({ items: Schema.Array(PostItemSchema) }))(
    (await req("GET", "/api/collections/posts")).body
  ).items
  const allComments = Schema.decodeUnknownSync(Schema.Struct({ items: Schema.Array(CommentItemSchema) }))(
    (await req("GET", "/api/collections/comments")).body
  ).items
  const alicePost   = allPosts.find((p) => p.authorId === aliceId)
  const bobPost     = allPosts.find((p) => p.authorId === bobId)
  const bobComment  = allComments.find((c) => c.authorId === bobId)

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
  console.log("  Test suite")
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")

  // ── Auth ────────────────────────────────────────────────────────────────
  console.log("\n  Auth")

  await test("login correct password → 200 + emailVerified is boolean", async () => {
    const r = await req("POST", "/api/collections/users/auth-with-password", {
      body: { email: "alice@example.com", password: "alice123" }
    })
    check(r.status === 200, `expected 200, got ${r.status}`)
    const { record } = Schema.decodeUnknownSync(
      Schema.Struct({ record: Schema.Struct({ emailVerified: Schema.Boolean }) })
    )(r.body)
    check(typeof record.emailVerified === "boolean", `emailVerified should be boolean, got ${typeof record.emailVerified} (${String(record.emailVerified)})`)
  })

  await test("login wrong password → 403", async () => {
    const r = await req("POST", "/api/collections/users/auth-with-password", {
      body: { email: "alice@example.com", password: "wrongpassword" }
    })
    check(r.status === 403, `expected 403, got ${r.status}`)
  })

  await test("login missing email field → 422", async () => {
    const r = await req("POST", "/api/collections/users/auth-with-password", {
      body: { password: "alice123" }
    })
    check(r.status === 422, `expected 422, got ${r.status}`)
  })

  await test("login missing password field → 422", async () => {
    const r = await req("POST", "/api/collections/users/auth-with-password", {
      body: { email: "alice@example.com" }
    })
    check(r.status === 422, `expected 422, got ${r.status}`)
  })

  // ── Users ────────────────────────────────────────────────────────────────
  console.log("\n  Users")

  await test("get own user → 200", async () => {
    const r = await req("GET", `/api/collections/users/${aliceId}`, { token: alice.token })
    check(r.status === 200, `expected 200, got ${r.status}`)
  })

  await test("get another user by id (view: public) → 200", async () => {
    const r = await req("GET", `/api/collections/users/${bobId}`, { token: alice.token })
    check(r.status === 200, `expected 200, got ${r.status}`)
  })

  await test("create user via API (email is system field) → 422", async () => {
    const r = await req("POST", "/api/collections/users", {
      body: { email: "charlie@example.com", displayName: "Charlie" }
    })
    check(r.status === 422, `expected 422, got ${r.status}`)
  })

  await test("update own user → 200", async () => {
    const r = await req("PATCH", `/api/collections/users/${aliceId}`, {
      token: alice.token,
      body: { displayName: "Alice Updated" }
    })
    check(r.status === 200, `expected 200, got ${r.status}`)
    await req("PATCH", `/api/collections/users/${aliceId}`, { token: alice.token, body: { displayName: "Alice" } })
  })

  await test("try update another user (update: self-only) → 403", async () => {
    const r = await req("PATCH", `/api/collections/users/${bobId}`, {
      token: alice.token,
      body: { displayName: "Hacked" }
    })
    check(r.status === 403, `expected 403, got ${r.status}`)
  })

  // ── Posts ────────────────────────────────────────────────────────────────
  console.log("\n  Posts")

  await test("list posts (public) → 200 with items", async () => {
    const r = await req("GET", "/api/collections/posts")
    check(r.status === 200, `expected 200, got ${r.status}`)
    const body = Schema.decodeUnknownSync(Schema.Struct({ items: Schema.Array(Schema.Unknown) }))(r.body)
    check(Array.isArray(body.items), "expected items array")
  })

  await test("get post by id (public) → 200", async () => {
    check(alicePost !== undefined, "no alice post in seed data")
    const r = await req("GET", `/api/collections/posts/${alicePost!.id}`)
    check(r.status === 200, `expected 200, got ${r.status}`)
  })

  let newPostId: string | undefined

  await test("create post (as alice) → 201", async () => {
    const r = await req("POST", "/api/collections/posts", {
      token: alice.token,
      body: { title: "Test Post", body: "Created during tests.", authorId: aliceId }
    })
    check(r.status === 201, `expected 201, got ${r.status}`)
    newPostId = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(r.body).id
  })

  await test("update own post → 200", async () => {
    check(newPostId !== undefined, "no post was created")
    const r = await req("PATCH", `/api/collections/posts/${newPostId}`, {
      token: alice.token,
      body: { title: "Updated Test Post" }
    })
    check(r.status === 200, `expected 200, got ${r.status}`)
  })

  await test("try update other user's post (authorId rule) → 403", async () => {
    check(bobPost !== undefined, "no bob post in seed data")
    const r = await req("PATCH", `/api/collections/posts/${bobPost!.id}`, {
      token: alice.token,
      body: { title: "Hacked" }
    })
    check(r.status === 403, `expected 403, got ${r.status}`)
  })

  await test("try delete other user's post (authorId rule) → 403", async () => {
    check(bobPost !== undefined, "no bob post in seed data")
    const r = await req("DELETE", `/api/collections/posts/${bobPost!.id}`, { token: alice.token })
    check(r.status === 403, `expected 403, got ${r.status}`)
  })

  if (newPostId !== undefined) {
    await req("DELETE", `/api/collections/posts/${newPostId}`, { token: alice.token })
  }

  // ── Comments ─────────────────────────────────────────────────────────────
  console.log("\n  Comments")

  await test("list comments (public) → 200 with items", async () => {
    const r = await req("GET", "/api/collections/comments")
    check(r.status === 200, `expected 200, got ${r.status}`)
    check(Array.isArray((r.body as any).items), "expected items array")
  })

  await test("get comment by id (public) → 200", async () => {
    check(bobComment !== undefined, "no bob comment in seed data")
    const r = await req("GET", `/api/collections/comments/${bobComment!.id}`)
    check(r.status === 200, `expected 200, got ${r.status}`)
  })

  await test("list comments by post (filter by postId) → 200, all match", async () => {
    check(alicePost !== undefined, "no alice post in seed data")
    const filter = encodeURIComponent(JSON.stringify({ op: "eq", field: "postId", value: alicePost!.id }))
    const r = await req("GET", `/api/collections/comments?filter=${filter}`)
    check(r.status === 200, `expected 200, got ${r.status}`)
    const { items } = Schema.decodeUnknownSync(
      Schema.Struct({ items: Schema.Array(Schema.Struct({ postId: Schema.String })) })
    )(r.body)
    check(items.length > 0, "expected at least one comment for alice's post")
    check(items.every((c) => c.postId === alicePost!.id), "all returned comments should match the filtered postId")
  })

  let newCommentId: string | undefined

  await test("create comment (as alice) → 201", async () => {
    check(alicePost !== undefined, "no alice post in seed data")
    const r = await req("POST", "/api/collections/comments", {
      token: alice.token,
      body: { postId: alicePost!.id, authorId: aliceId, body: "Test comment." }
    })
    check(r.status === 201, `expected 201, got ${r.status}`)
    newCommentId = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(r.body).id
  })

  await test("update own comment → 200", async () => {
    check(newCommentId !== undefined, "no comment was created")
    const r = await req("PATCH", `/api/collections/comments/${newCommentId}`, {
      token: alice.token,
      body: { body: "Updated test comment." }
    })
    check(r.status === 200, `expected 200, got ${r.status}`)
  })

  await test("try update other user's comment (authorId rule) → 403", async () => {
    check(bobComment !== undefined, "no bob comment in seed data")
    const r = await req("PATCH", `/api/collections/comments/${bobComment!.id}`, {
      token: alice.token,
      body: { body: "Hacked" }
    })
    check(r.status === 403, `expected 403, got ${r.status}`)
  })

  await test("delete own comment → 204", async () => {
    check(newCommentId !== undefined, "no comment was created")
    const r = await req("DELETE", `/api/collections/comments/${newCommentId}`, { token: alice.token })
    check(r.status === 204, `expected 204, got ${r.status}`)
  })

  await test("try delete other user's comment (authorId rule) → 403", async () => {
    check(bobComment !== undefined, "no bob comment in seed data")
    const r = await req("DELETE", `/api/collections/comments/${bobComment!.id}`, { token: alice.token })
    check(r.status === 403, `expected 403, got ${r.status}`)
  })

  // ── Users: delete (last — invalidates alice's token) ─────────────────────
  console.log("\n  Users (delete)")

  await test("delete own user (alice) → 204", async () => {
    const r = await req("DELETE", `/api/collections/users/${aliceId}`, { token: alice.token })
    check(r.status === 204, `expected 204, got ${r.status}`)
  })

  const total = _passed + _failed
  console.log()
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
  console.log(`  ${_passed}/${total} passed${_failed > 0 ? `  (${_failed} failed)` : "  ✓"}`)
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
  console.log()
}

const program = Effect.gen(function* () {
  yield* Effect.forkDaemon(Layer.launch(appLayer))
  yield* Effect.promise(() =>
    runTests().catch((e: unknown) => { console.error("[tests] Fatal:", e) })
  )
}).pipe(Effect.ensuring(Effect.sync(() => { process.exit(_failed > 0 ? 1 : 0) })))

NodeRuntime.runMain(program)
