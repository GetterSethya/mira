/**
 * Scaffold app — server and client as separate processes
 *
 * Run:
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/scaffold-app-separated-script.ts
 *
 * The orchestrator spawns the HTTP server as a child process, waits for it to
 * be ready, then exercises every client-SDK operation using createMiraClient.
 * Exits with a non-zero code if any test fails.
 *
 * Internal flag --server: start the HTTP server child process directly.
 */

import { HttpServer } from "@effect/platform"
import { NodeFileSystem, NodeHttpServer, NodePath, NodeRuntime } from "@effect/platform-node"
import { SqlClient } from "@effect/sql"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Data, Effect, Layer, Schedule, Schema } from "effect"
import { execSync, spawn } from "node:child_process"
import { existsSync, unlinkSync } from "node:fs"
import { createServer } from "node:http"
import { AuthCollection, BaseCollection, ViewCollection, Field } from "@gettersethya/mira-client"
import { Dialect } from "@/migrator/dialect.js"
import { sqliteDialect } from "@/migrator/dialect-sqlite.js"
import { Migrator, MigratorLive } from "@/migrator/migrator.js"
import { Repository, RepositoryLive } from "@/repository/repository.js"
import { makeCachedCollectionServiceLayer } from "@/cache/index.js"
import { makeCollectionRouter } from "@/http/router.js"
import { makeFileStorageLayer } from "@/storage/storage.js"
import { hashPassword } from "@/http/auth.js"
import { ThumbnailServicePhotonLive } from "@/thumbnail/index.js"
import { createMiraClient, MiraError } from "@gettersethya/mira-client"
import { AppConfig, AppConfigLive } from "@/config/index.js"
import { NodeCryptoLayer } from "@/crypto/node.js"
import { NodeAuthServiceLayer } from "@/http/auth-node.js"
import * as Match from "effect/Match"

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = 8182
const DB_FILE = "scaffold-separated.db"
const UPLOAD_DIR = "./uploads-separated"
const BASE = `http://localhost:${PORT}`

// ---------------------------------------------------------------------------
// Collection definitions — shared between server and client modes
// ---------------------------------------------------------------------------

const Users = AuthCollection.define("users", {
  displayName: Field.text({
    maxLength: 100,
    required: false,
    error: (kind) =>
      Match.value(kind).pipe(
        Match.when("maxLength", () => "Name cannot be more than 100 characters"),
        Match.when("minLength", () => "Name cannot be empty"),
        Match.when("required", () => "Name cannot be empty"),
        Match.when("type", () => "Invalid name"),
        Match.exhaustive
      )
  })
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

// View collection: joins posts with users to expose the author's display name
const PostsWithAuthors = ViewCollection.define(
  "posts_with_authors",
  `SELECT
     CAST(ROW_NUMBER() OVER (ORDER BY p.seqId) AS INTEGER) AS seqId,
     p.id,
     p.title,
     p.authorId,
     u.displayName AS authorName
   FROM posts p
   JOIN users u ON p.authorId = u.id`,
  {
    seqId: Field.integer().view(),
    id: Field.text().view(),
    title: Field.text().view(),
    authorId: Field.text().view(),
    authorName: Field.text().view()
  }
).rules((R) => ({ list: R.public(), view: R.public() }))

const allCollections = [Users, Posts, Comments, PostsWithAuthors] as const

// ---------------------------------------------------------------------------
// Test harness helpers
// ---------------------------------------------------------------------------

let _passed = 0
let _failed = 0

function check(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}

function formatError(e: unknown): string {
  if (e instanceof MiraError) return `MiraError(${e.status}): ${JSON.stringify(e.body)}`
  if (e instanceof Error) return e.message
  return String(e)
}

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    _passed++
    console.log(`  ✓  ${name}`)
  } catch (e) {
    _failed++
    console.log(`  ✗  ${name}`)
    console.log(`       → ${formatError(e)}`)
  }
}

async function expectMiraError(status: number, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn()
  } catch (e) {
    if (e instanceof MiraError && e.status === status) return
    throw new Error(`expected MiraError(${status}), got: ${formatError(e)}`)
  }
  throw new Error(`expected MiraError(${status}) but the call succeeded`)
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

// ---------------------------------------------------------------------------
// Client mode: full test suite using createMiraClient
// ---------------------------------------------------------------------------

async function runTests(): Promise<void> {
  const collectionMap = { users: Users, posts: Posts, comments: Comments, postsWithAuthors: PostsWithAuthors }

  // Three client instances: alice (auth), bob (auth), anon (no auth)
  const aliceMira = createMiraClient(BASE, { type: "server" }).withCollections(collectionMap)
  const bobMira = createMiraClient(BASE, { type: "server" }).withCollections(collectionMap)
  const anonMira = createMiraClient(BASE, { type: "server" }).withCollections(collectionMap)

  // Essential pre-test setup (fail-fast: these are prerequisites, not counted tests)
  const aliceAuth = await aliceMira.users.authWithPassword().raw({ email: "alice@example.com", password: "alice123" })
  const bobAuth = await bobMira.users.authWithPassword().raw({ email: "bob@example.com", password: "bob123" })
  const aliceId = aliceAuth.record.id
  const bobId = bobAuth.record.id

  const { items: seedPosts } = await anonMira.posts.getList({ limit: 100 }).raw()
  const { items: seedComments } = await anonMira.comments.getList({ limit: 100 }).raw()
  const alicePost = seedPosts.find((p) => p.authorId === aliceId)
  const bobPost = seedPosts.find((p) => p.authorId === bobId)
  const bobComment = seedComments.find((c) => c.authorId === bobId)

  if (!alicePost || !bobPost || !bobComment) {
    throw new Error("Seed data missing — ensure the server seeded correctly on startup")
  }

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
  console.log("  Client SDK test suite")
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")

  // ── Auth SDK ──────────────────────────────────────────────────────────────
  console.log("\n  Auth SDK")

  await test("auth.token is set after authWithPassword", async () => {
    const tok = aliceMira.auth.token
    check(typeof tok === "string" && tok.length > 0, "expected non-empty token string")
    check(tok === aliceAuth.token, "stored token should match authWithPassword result")
  })

  await test("auth.isValid() → true immediately after login", async () => {
    check(aliceMira.auth.isValid(), "expected isValid() to return true")
  })

  await test("authWithPassword wrong password → MiraError(403)", async () => {
    const c = createMiraClient(BASE, { type: "server" }).withCollections(collectionMap)
    await expectMiraError(403, () =>
      c.users.authWithPassword!().raw({ email: "alice@example.com", password: "wrongpassword" })
    )
  })

  await test("authWithPassword unknown user → MiraError(403)", async () => {
    const c = createMiraClient(BASE, { type: "server" }).withCollections(collectionMap)
    await expectMiraError(403, () =>
      c.users.authWithPassword!().raw({ email: "nobody@example.com", password: "anything" })
    )
  })

  await test("auth.setToken() stores an arbitrary token value", async () => {
    const c = createMiraClient(BASE, { type: "server" })
    c.auth.setToken("my-custom-token")
    check(c.auth.token === "my-custom-token", "expected the set token to be retrievable")
  })

  await test("auth.clear() resets token to null and invalidates isValid()", async () => {
    const c = createMiraClient(BASE, { type: "server" }).withCollections(collectionMap)
    await c.users.authWithPassword!().raw({ email: "alice@example.com", password: "alice123" })
    check(c.auth.isValid(), "should be valid before clear")
    c.auth.clear()
    check(!c.auth.isValid(), "should be invalid after clear")
    check(c.auth.token === null, "token should be null after clear")
  })

  // ── Users ─────────────────────────────────────────────────────────────────
  console.log("\n  Users")

  await test("getOne own user → record with correct id", async () => {
    const user = await aliceMira.users.getOne(aliceId).raw()
    check(user.id === aliceId, `expected id ${aliceId}, got ${user.id}`)
  })

  await test("getOne another user (view: public) → record", async () => {
    const user = await anonMira.users.getOne(bobId).raw()
    check(user.id === bobId, "expected bob's id")
  })

  await test("getOne non-existent id → MiraError(404)", async () => {
    await expectMiraError(404, () => anonMira.users.getOne("no-such-id").raw())
  })

  await test("update own user → updated displayName", async () => {
    const updated = await aliceMira.users.update().raw({ id: aliceId, data: { displayName: "Alice Updated" } })
    check(updated.id === aliceId, "expected same id")
    // restore
    await aliceMira.users.update().raw({ id: aliceId, data: { displayName: "Alice" } })
  })

  await test("update another user (self-only rule) → MiraError(403)", async () => {
    await expectMiraError(403, () => aliceMira.users.update().raw({ id: bobId, data: { displayName: "Hacked" } }))
  })

  // ── Posts — getList ───────────────────────────────────────────────────────
  console.log("\n  Posts — getList")

  await test("getList with no options → { items, nextCursor }", async () => {
    const result = await anonMira.posts.getList().raw()
    check(Array.isArray(result.items), "expected items array")
    check("nextCursor" in result, "expected nextCursor field")
    check(result.items.length >= 3, "expected at least 3 seeded posts")
  })

  await test("getList with typed filter (authorId eq) → only alice's posts", async () => {
    const result = await anonMira.posts
      .getList({
        filter: (f) => f.field("authorId").eq(aliceId)
      })
      .raw()
    check(result.items.length > 0, "expected at least one matching post")
    check(
      result.items.every((p) => p.authorId === aliceId),
      "all items should have alice's authorId"
    )
  })

  await test("getList with sort + order → deterministic ordering", async () => {
    const asc = await anonMira.posts.getList({ sort: "title", order: "asc", limit: 10 }).raw()
    const desc = await anonMira.posts.getList({ sort: "title", order: "desc", limit: 10 }).raw()
    if (asc.items.length >= 2) {
      check(asc.items[0].title <= asc.items[1].title, "expected ascending order")
    }
    if (desc.items.length >= 2) {
      check(desc.items[0].title >= desc.items[1].title, "expected descending order")
    }
  })

  await test("getList with limit=1 → nextCursor advances between pages", async () => {
    const page1 = await anonMira.posts.getList({ limit: 1 }).raw()
    check(page1.items.length === 1, "expected exactly 1 item on page 1")
    check(page1.nextCursor !== null, "expected non-null nextCursor after page 1")
    const page2 = await anonMira.posts.getList({ limit: 1, cursor: page1.nextCursor }).raw()
    check(page2.items.length >= 1, "expected at least 1 item on page 2")
    check(page2.items[0].id !== page1.items[0].id, "page 2 should return a different item")
  })

  await test("getList with select → requested field is present in results", async () => {
    const result = await anonMira.posts.getList({ select: ["title"] }).raw()
    check(
      result.items.every((p) => typeof p.title === "string"),
      "all items should have title"
    )
  })

  // ── Posts — getOne + CRUD ─────────────────────────────────────────────────
  console.log("\n  Posts — getOne + CRUD")

  await test("getOne → record with expected id and fields", async () => {
    const post = await anonMira.posts.getOne(alicePost.id).raw()
    check(post.id === alicePost.id, "expected matching id")
    check(typeof post.title === "string", "expected title string")
    check(post.authorId === aliceId, "expected alice's authorId")
  })

  await test("getOne non-existent id → MiraError(404)", async () => {
    await expectMiraError(404, () => anonMira.posts.getOne("no-such-post-id").raw())
  })

  let newPostId: string | undefined

  await test("create post as alice (authorId = aliceId) → record", async () => {
    const post = await aliceMira.posts.create().raw({ title: "SDK Integration Test", authorId: aliceId })
    check(typeof post.id === "string" && post.id.length > 0, "expected non-empty id")
    check(post.authorId === aliceId, "expected alice's authorId on new post")
    newPostId = post.id
  })

  await test("create post with wrong authorId (bob sends aliceId) → MiraError(403)", async () => {
    await expectMiraError(403, () => bobMira.posts.create().raw({ title: "Hijack Attempt", authorId: aliceId }))
  })

  await test("create post unauthenticated → MiraError(403)", async () => {
    await expectMiraError(403, () => anonMira.posts.create().raw({ title: "No Auth Post", authorId: aliceId }))
  })

  await test("update own post → updated title in response", async () => {
    if (newPostId === undefined) throw new Error("skipped: create test did not run")
    const updated = await aliceMira.posts
      .update()
      .raw({ id: newPostId!, data: { title: "SDK Integration Test (edited)" } })
    check(updated.title === "SDK Integration Test (edited)", "expected updated title in response")
  })

  await test("update another user's post → MiraError(403)", async () => {
    if (newPostId === undefined) throw new Error("skipped: create test did not run")
    await expectMiraError(403, () => bobMira.posts.update().raw({ id: newPostId!, data: { title: "Bob Hacks" } }))
  })

  await test("delete another user's post → MiraError(403)", async () => {
    if (newPostId === undefined) throw new Error("skipped: create test did not run")
    await expectMiraError(403, () => bobMira.posts.delete().raw(newPostId!))
  })

  await test("delete own post → resolves with no error", async () => {
    if (newPostId === undefined) throw new Error("skipped: create test did not run")
    await aliceMira.posts.delete().raw(newPostId!)
  })

  await test("seeded posts are unchanged (delete was own post only)", async () => {
    const result = await anonMira.posts.getList({ limit: 100 }).raw()
    const aliceStillHasPost = result.items.some((p) => p.id === alicePost.id)
    const bobStillHasPost = result.items.some((p) => p.id === bobPost.id)
    check(aliceStillHasPost, "alice's seeded post should still exist")
    check(bobStillHasPost, "bob's seeded post should still exist")
  })

  // ── Comments ──────────────────────────────────────────────────────────────
  console.log("\n  Comments")

  let newCommentId: string | undefined

  await test("getList → items array with seeded comments", async () => {
    const result = await anonMira.comments.getList().raw()
    check(Array.isArray(result.items), "expected items array")
    check(result.items.length > 0, "expected at least one seeded comment")
  })

  await test("getList with typed filter (postId eq) → all match postId", async () => {
    const result = await anonMira.comments
      .getList({
        filter: (f) => f.field("postId").eq(alicePost.id)
      })
      .raw()
    check(result.items.length > 0, "expected at least one comment on alice's post")
    check(
      result.items.every((c) => c.postId === alicePost.id),
      "all comments should match postId filter"
    )
  })

  await test("create comment as alice → record with correct fields", async () => {
    const comment = await aliceMira.comments.create().raw({
      postId: alicePost.id,
      authorId: aliceId,
      body: "Client SDK integration test comment"
    })
    check(typeof comment.id === "string", "expected id")
    check(comment.authorId === aliceId, "expected alice's authorId")
    check(comment.postId === alicePost.id, "expected correct postId")
    newCommentId = comment.id
  })

  await test("update own comment → updated body in response", async () => {
    if (newCommentId === undefined) throw new Error("skipped: create test did not run")
    const updated = await aliceMira.comments.update().raw({ id: newCommentId!, data: { body: "Updated body via SDK" } })
    check(updated.body === "Updated body via SDK", "expected updated body")
  })

  await test("update another user's comment → MiraError(403)", async () => {
    await expectMiraError(403, () =>
      aliceMira.comments.update().raw({ id: bobComment.id, data: { body: "Hacked by alice" } })
    )
  })

  await test("delete another user's comment → MiraError(403)", async () => {
    await expectMiraError(403, () => aliceMira.comments.delete().raw(bobComment.id))
  })

  await test("delete own comment → resolves with no error", async () => {
    if (newCommentId === undefined) throw new Error("skipped: create test did not run")
    await aliceMira.comments.delete().raw(newCommentId!)
  })

  // ── View collection ───────────────────────────────────────────────────────
  console.log("\n  View collection (posts_with_authors)")

  await test("getList → items include authorName from JOIN", async () => {
    const result = await anonMira.postsWithAuthors.getList().raw()
    check(Array.isArray(result.items), "expected items array")
    check(result.items.length >= 3, "expected all seeded posts to appear in view")
    check(
      result.items.every((r) => typeof r.authorName === "string" && r.authorName.length > 0),
      "every item should have authorName from the JOIN"
    )
  })

  await test("getList with typed filter (authorId eq) → only alice's rows", async () => {
    const result = await anonMira.postsWithAuthors
      .getList({
        filter: (f) => f.field("authorId").eq(aliceId)
      })
      .raw()
    check(result.items.length > 0, "expected alice's posts in view")
    check(
      result.items.every((r) => r.authorId === aliceId),
      "all rows should be alice's"
    )
    check(
      result.items.every((r) => r.authorName === "Alice"),
      "authorName should be 'Alice'"
    )
  })

  await test("getOne by id → record with authorName", async () => {
    const list = await anonMira.postsWithAuthors.getList({ limit: 1 }).raw()
    check(list.items.length === 1, "expected at least one item")
    const item = list.items[0]
    const record = await anonMira.postsWithAuthors.getOne(item.id).raw()
    check(record.id === item.id, "expected matching id")
    check(typeof record.authorName === "string", "expected authorName string")
  })

  await test("getList with limit=1 → cursor-based pagination works on view", async () => {
    const page1 = await anonMira.postsWithAuthors.getList({ limit: 1 }).raw()
    check(page1.items.length === 1, "expected 1 item on page 1")
    check(page1.nextCursor !== null, "expected non-null nextCursor")
    const page2 = await anonMira.postsWithAuthors.getList({ limit: 1, cursor: page1.nextCursor }).raw()
    check(page2.items.length >= 1, "expected items on page 2")
    check(page2.items[0].id !== page1.items[0].id, "page 2 should be a different row")
  })

  await test("create on view collection → MiraError(405) read-only", async () => {
    await expectMiraError(405, () => aliceMira.postsWithAuthors.create().raw({}))
  })

  await test("update on view collection → MiraError(405) read-only", async () => {
    const list = await anonMira.postsWithAuthors.getList({ limit: 1 }).raw()
    check(list.items.length >= 1, "expected at least one row to attempt update on")
    await expectMiraError(405, () =>
      aliceMira.postsWithAuthors.update().raw({ id: list.items[0].id, data: { title: "Illegal" } })
    )
  })

  await test("delete on view collection → MiraError(405) read-only", async () => {
    const list = await anonMira.postsWithAuthors.getList({ limit: 1 }).raw()
    check(list.items.length >= 1, "expected at least one row to attempt delete on")
    await expectMiraError(405, () => aliceMira.postsWithAuthors.delete().raw(list.items[0].id))
  })

  // ── Summary ───────────────────────────────────────────────────────────────
  const total = _passed + _failed
  console.log()
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
  console.log(`  ${_passed}/${total} passed${_failed > 0 ? `  (${_failed} failed)` : "  ✓"}`)
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
  console.log()
}

// ---------------------------------------------------------------------------
// Server mode: migrate, seed, serve
// ---------------------------------------------------------------------------

function runServerMode(): void {
  if (existsSync(DB_FILE)) unlinkSync(DB_FILE)

  const allSchemas = allCollections.map((c) => ({ name: c.name, schema: c.schema }))

  const startupEffect = Effect.gen(function* () {
    const migrator = yield* Migrator
    const repo = yield* Repository
    const sql = yield* SqlClient.SqlClient

    yield* migrator.migrate(allSchemas, { logLevel: 4 })

    const rows = yield* sql<{ n: number }>`SELECT COUNT(*) as n FROM ${sql("users")}`
    const userCount = rows[0]?.n ?? 0
    if (userCount > 0) return

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

    const post1 = yield* repo
      .create("posts", { title: "Hello from Alice", body: "Alice's first post.", authorId: aliceId })
      .pipe(Effect.orDie)
    const post2 = yield* repo
      .create("posts", { title: "Bob's Perspective", body: "Bob's thoughts on Mira.", authorId: bobId })
      .pipe(Effect.orDie)
    const post3 = yield* repo
      .create("posts", { title: "Effect-TS Tips", body: "Layer composition tips.", authorId: aliceId })
      .pipe(Effect.orDie)

    const { id: p1Id } = yield* Schema.decodeUnknown(IdSchema)(post1).pipe(Effect.orDie)
    const { id: p2Id } = yield* Schema.decodeUnknown(IdSchema)(post2).pipe(Effect.orDie)
    const { id: p3Id } = yield* Schema.decodeUnknown(IdSchema)(post3).pipe(Effect.orDie)

    yield* repo.create("comments", { postId: p1Id, authorId: bobId, body: "Great post, Alice!" }).pipe(Effect.orDie)
    yield* repo.create("comments", { postId: p1Id, authorId: aliceId, body: "Thanks Bob!" }).pipe(Effect.orDie)
    yield* repo.create("comments", { postId: p2Id, authorId: aliceId, body: "Agreed!" }).pipe(Effect.orDie)
    yield* repo.create("comments", { postId: p3Id, authorId: bobId, body: "Very helpful." }).pipe(Effect.orDie)

    console.log("[server] Seeded 2 users, 3 posts, 4 comments.")
  })

  const router = makeCollectionRouter([...allCollections])

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
  const infra = Layer.mergeAll(RepositoryLive, MigratorLive).pipe(Layer.provideMerge(foundation))
  const infraMigrated = Layer.effectDiscard(startupEffect).pipe(Layer.provideMerge(infra))
  const collectionLayer = makeCachedCollectionServiceLayer([...allCollections]).pipe(Layer.provideMerge(infraMigrated))

  // Pre-seed port into _config so AppConfigLive uses 8182, then run AppConfigLive
  const configLayer = Layer.unwrapEffect(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS _config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
      yield* sql`INSERT INTO ${sql("_config")} ${sql.insert({ key: "port", value: String(PORT) })} ON CONFLICT(key) DO NOTHING`
      return AppConfigLive
    })
  ).pipe(Layer.provideMerge(foundation))

  // Derive Node HTTP server port from AppConfig (reads the value we just seeded)
  const serverLayer = Layer.unwrapEffect(
    Effect.map(AppConfig, (cfg) => NodeHttpServer.layer(() => createServer(), { port: cfg.port }))
  )

  const appLayer = HttpServer.serve(router).pipe(
    Layer.provideMerge(serverLayer),
    Layer.provideMerge(Layer.merge(collectionLayer, configLayer))
  )

  console.log(`[server] Starting on port ${PORT} with DB ${DB_FILE}`)
  NodeRuntime.runMain(Layer.launch(appLayer))
}

// ---------------------------------------------------------------------------
// Orchestrator mode: spawn server child, run tests, report
// ---------------------------------------------------------------------------

async function runOrchestratorMode(): Promise<void> {
  const scriptPath = process.argv[1]

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
  console.log("  Mira scaffold — separated server + client")
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
  console.log(`  Port     : ${PORT}`)
  console.log(`  DB       : ${DB_FILE}`)
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
  console.log()

  const child = spawn("npx", ["tsx", "--no-cache", "--tsconfig", "scripts/tsconfig.json", scriptPath, "--server"], {
    shell: true,
    stdio: ["ignore", "pipe", "pipe"]
  })

  child.stdout?.on("data", (chunk: Buffer) => {
    for (const line of String(chunk).split("\n").filter(Boolean)) {
      process.stdout.write(`[server] ${line}\n`)
    }
  })
  child.stderr?.on("data", (chunk: Buffer) => {
    for (const line of String(chunk).split("\n").filter(Boolean)) {
      process.stderr.write(`[server] ${line}\n`)
    }
  })

  let childExited = false
  child.on("exit", () => {
    childExited = true
  })

  try {
    console.log("Waiting for server to be ready…")
    await waitForServer()
    console.log("Server ready. Running tests.\n")
    await runTests()
  } finally {
    if (!childExited) {
      // On Windows, shell:true wraps the command in cmd.exe.
      // child.kill() only kills cmd.exe, leaving the tsx/node child alive and
      // holding file locks. taskkill /F /T kills the entire process tree.
      if (process.platform === "win32" && child.pid !== undefined) {
        try {
          execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: "ignore" })
        } catch {
          /* already dead */
        }
      } else {
        child.kill()
      }
    }
    await Effect.runPromise(Effect.sleep("500 millis"))
  }

  process.exit(_failed > 0 ? 1 : 0)
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (process.argv.includes("--server")) {
  runServerMode()
} else {
  runOrchestratorMode().catch((e: unknown) => {
    console.error("[fatal]", e instanceof Error ? e.message : String(e))
    process.exit(1)
  })
}
