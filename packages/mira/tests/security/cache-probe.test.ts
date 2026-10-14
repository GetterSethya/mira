import { NodeFileSystem, NodeHttpServer, NodePath } from "@effect/platform-node"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { BaseCollection, Field } from "@gettersethya/mira-client"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Option, Redacted } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/http"
import { SqlClient } from "effect/sql"

import { applyRulesToCollections, defineRule } from "@/app/index.js"
import { buildCtxCacheTag } from "@/cache/ctx-key.js"
import { makeCachedCollectionServiceLayer } from "@/cache/cached-collection.js"
import type { RequestCtx } from "@/collection-service/context.js"
import { AppConfig } from "@/config/index.js"
import { NodeCryptoLayer } from "@/crypto/node.js"
import { Dialect } from "@/dialect/dialect.js"
import { sqliteDialect } from "@/dialect/dialect-sqlite.js"
import { NodeAuthServiceLayer } from "@/http/auth-node.js"
import { makeCollectionRouter } from "@/http/router.js"
import { Repository, RepositoryLive } from "@/repository/repository.js"
import { enforcerForAction } from "@/rule/enforcer.js"
import { FileStorage, FileStorageNotFound } from "@/storage/storage.js"
import { ThumbnailServiceNoopLive } from "@/thumbnail/index.js"

import {
  ADMIN_COLLECTIONS,
  ALL_COLLECTIONS,
  PrivateProfiles,
  get,
  login,
  patchJson,
  postJson,
  seedProfile,
  seedUser,
  setupTables
} from "./_harness.js"

// ---------------------------------------------------------------------------
// Extra collections — base collections whose read rules resolve a request
// *body* field and a request *query* field respectively.
// ---------------------------------------------------------------------------

const bodyRuleDef = BaseCollection.define("body_rules", {
  title: Field.text(),
  token: Field.text()
})
const bodyRuleRules = defineRule(bodyRuleDef, (R) => ({
  list: R.field("token").eq(R.request("body", "token")),
  view: R.field("token").eq(R.request("body", "token")),
  create: R.public(),
  update: R.public(),
  delete: R.public()
}))
const [BodyRule] = applyRulesToCollections([bodyRuleDef], [bodyRuleRules])

const queryRuleDef = BaseCollection.define("query_rules", {
  title: Field.text(),
  token: Field.text()
})
const queryRuleRules = defineRule(queryRuleDef, (R) => ({
  list: R.field("token").eq(R.request("query", "token")),
  view: R.field("token").eq(R.request("query", "token")),
  create: R.public(),
  update: R.public(),
  delete: R.public()
}))
const [QueryRule] = applyRulesToCollections([queryRuleDef], [queryRuleRules])

const CACHED_COLLECTIONS = [...ALL_COLLECTIONS, BodyRule, QueryRule]

// ---------------------------------------------------------------------------
// Helpers (no `as`, no JSON.parse, no `!`)
// ---------------------------------------------------------------------------

/** Read a property off an `unknown` value safely. */
function at(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined
  if (!(key in value)) return undefined
  return Reflect.get(value, key)
}

/** Render a decoded response body as a compact JSON-like string for evidence logs. */
function pretty(value: unknown): string {
  if (value === null) return "null"
  if (value === undefined) return "undefined"
  if (Array.isArray(value)) return `[${value.map((v) => pretty(v)).join(", ")}]`
  if (typeof value === "object") {
    const entries = Object.entries(value)
    return `{${entries.map(([k, v]) => `${k}: ${pretty(v)}`).join(", ")}}`
  }
  if (typeof value === "string") return `"${value}"`
  return String(value)
}

/** Number of items in a decoded list body, or -1 when the shape is wrong. */
function itemCount(body: unknown): number {
  const items = at(body, "items")
  return Array.isArray(items) ? items.length : -1
}

// ---------------------------------------------------------------------------
// Layer — same composition as `_harness.makeSecurityLayer`, with the ONE line
// swapped to wrap the CACHED collection service.
// ---------------------------------------------------------------------------

const stubFileStorage = Layer.succeed(
  FileStorage,
  FileStorage.of({
    upload: (key) => Effect.succeed(key),
    delete: () => Effect.void,
    url: (key) => `/files/${key}`,
    read: (key) => Effect.fail(new FileStorageNotFound({ key })),
    exists: () => Effect.succeed(false),
    list: () => Effect.succeed([])
  })
)

const AppConfigTest = Layer.succeed(
  AppConfig,
  AppConfig.of({
    appName: "test-cache-probe",
    port: 8080,
    applicationUrl: "http://localhost:8080",
    jwtSecret: Redacted.make("cache-probe-secret"),
    useS3: false,
    s3Config: Option.none(),
    logRetentionDays: 30
  })
)

/** Fresh layer per test: the cached service + all of its dependencies. */
function makeCachedSecurityLayer(collections: ReadonlyArray<typeof CACHED_COLLECTIONS[number]>) {
  const sqliteLayer = SqliteClient.layer({ filename: ":memory:" })
  const repoWithSql = RepositoryLive.pipe(Layer.provide(sqliteLayer), Layer.provide(NodeCryptoLayer))
  const DialectTest = Layer.succeed(Dialect, sqliteDialect)

  // >>> the swap <<< — uses the cached collection service
  const collectionServiceWithDeps = makeCachedCollectionServiceLayer(collections).pipe(
    Layer.provide(repoWithSql),
    Layer.provide(stubFileStorage),
    Layer.provide(sqliteLayer),
    Layer.provide(DialectTest),
    Layer.provide(NodeAuthServiceLayer)
  )

  return Layer.mergeAll(
    collectionServiceWithDeps,
    repoWithSql,
    stubFileStorage,
    sqliteLayer,
    ThumbnailServiceNoopLive,
    NodeHttpServer.layerTest,
    AppConfigTest,
    NodeCryptoLayer,
    NodeAuthServiceLayer,
    DialectTest,
    NodeFileSystem.layer,
    NodePath.layer
  )
}

/** Install the production collection router (cached service) on the test server. */
function serveCachedRouter() {
  return Effect.flatMap(
    HttpRouter.toHttpEffect(HttpRouter.addAll(makeCollectionRouter(CACHED_COLLECTIONS, ADMIN_COLLECTIONS))),
    HttpServer.serveEffect()
  )
}

// ---------------------------------------------------------------------------
// Extra tables + seeding for the body_rules / query_rules collections
// ---------------------------------------------------------------------------

const extraTable = (name: string) => `
  CREATE TABLE IF NOT EXISTS "${name}" (
    "seqId"   INTEGER PRIMARY KEY AUTOINCREMENT,
    "id"      TEXT NOT NULL UNIQUE,
    "title"   TEXT NOT NULL DEFAULT '',
    "token"   TEXT NOT NULL DEFAULT '',
    "created" TEXT NOT NULL,
    "updated" TEXT NOT NULL
  )
`

const setupExtraTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql.unsafe(extraTable("body_rules"))
  yield* sql.unsafe(extraTable("query_rules"))
  yield* sql`DELETE FROM ${sql("body_rules")}`
  yield* sql`DELETE FROM ${sql("query_rules")}`
})

function seedRow(
  table: string,
  data: Record<string, unknown>
): Effect.Effect<void, never, Repository> {
  return Effect.gen(function* () {
    const repo = yield* Repository
    yield* repo.create(table, data).pipe(Effect.orDie)
  })
}

describe("H1: cached cross-requester isolation (owner-only view rule)", () => {
  it.effect(
    "owner read is cached; non-owner and anonymous never receive the owner's cached row",
    () =>
      Effect.gen(function* () {
        yield* setupTables
        yield* setupExtraTables

        const userAId = yield* seedUser("cache-a@example.com", "pw")
        const userBId = yield* seedUser("cache-b@example.com", "pw")
        const profileId = yield* seedProfile({
          email: "a-private@example.com",
          ssn: "111-22-3333",
          ownerId: userAId
        })
        yield* serveCachedRouter()

        const tokenA = yield* login("cache-a@example.com", "pw")
        const tokenB = yield* login("cache-b@example.com", "pw")

        const repo = yield* Repository

        // ---- 1. owner A reads (populates the cache under A's ctxTag) --------
        const a1 = yield* get(`/api/collections/private_profiles/${profileId}`, tokenA)
        const a1Body = yield* a1.json
        // eslint-disable-next-line no-console
        console.log(`[H1] A read #1          status=${a1.status} body=${pretty(a1Body)}`)
        assert.strictEqual(a1.status, 200)
        assert.strictEqual(at(a1Body, "ssn"), "111-22-3333")

        // ---- 2. mutate the row OUT OF BAND (bypasses cache invalidation) ----
        yield* repo.update("private_profiles", profileId, { ssn: "999-88-7777" }).pipe(Effect.orDie)

        // ---- 3. owner A reads again: STALE value proves a cache hit ---------
        const a2 = yield* get(`/api/collections/private_profiles/${profileId}`, tokenA)
        const a2Body = yield* a2.json
        // eslint-disable-next-line no-console
        console.log(
          `[H1] A read #2 (stale?) status=${a2.status} body=${pretty(a2Body)} (DB now has 999-88-7777)`
        )
        assert.strictEqual(a2.status, 200)
        assert.strictEqual(
          at(a2Body, "ssn"),
          "111-22-3333",
          "cache must be engaged: out-of-band update not seen within TTL"
        )

        // ---- 4. non-owner B must NOT be served A's cached row ---------------
        const b1 = yield* get(`/api/collections/private_profiles/${profileId}`, tokenB)
        const b1Body = yield* b1.json
        // eslint-disable-next-line no-console
        console.log(`[H1] B read             status=${b1.status} body=${pretty(b1Body)}`)
        assert.notStrictEqual(b1.status, 200, "non-owner must be denied")
        assert.strictEqual(at(b1Body, "ssn"), undefined, "non-owner must not receive the ssn")

        // ---- 5. anonymous must NOT be served A's cached row -----------------
        const anon = yield* get(`/api/collections/private_profiles/${profileId}`)
        const anonBody = yield* anon.json
        // eslint-disable-next-line no-console
        console.log(`[H1] anon read          status=${anon.status} body=${pretty(anonBody)}`)
        assert.notStrictEqual(anon.status, 200, "anonymous must be denied")
        assert.strictEqual(at(anonBody, "ssn"), undefined)

        // ---- 6. raw cache-key evidence --------------------------------------
        const ctxA: RequestCtx = { auth: { collection: "users", record: { id: userAId } }, headers: {}, query: {} }
        const ctxB: RequestCtx = { auth: { collection: "users", record: { id: userBId } }, headers: {}, query: {} }
        const ctxAnon: RequestCtx = { headers: {}, query: {} }
        const tagA = buildCtxCacheTag(PrivateProfiles, "view", ctxA)
        const tagB = buildCtxCacheTag(PrivateProfiles, "view", ctxB)
        const tagAnon = buildCtxCacheTag(PrivateProfiles, "view", ctxAnon)
        // eslint-disable-next-line no-console
        console.log(`[H1] cache tags: A=${tagA} | B=${tagB} | anon=${tagAnon}`)
        assert.notStrictEqual(tagA, tagB)
        assert.notStrictEqual(tagA, tagAnon)
        assert.notStrictEqual(tagB, tagAnon)
      }).pipe(Effect.provide(makeCachedSecurityLayer(CACHED_COLLECTIONS)))
  )

  it.effect("admin-populated record cache is not served to a non-admin requester", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* setupExtraTables

      const userAId = yield* seedUser("cache-a2@example.com", "pw")
      const userBId = yield* seedUser("cache-b2@example.com", "pw")
      yield* seedUser("root@example.com", "pw", "_superadmin")
      const profileId = yield* seedProfile({
        email: "a2-private@example.com",
        ssn: "222-33-4444",
        ownerId: userAId
      })
      yield* serveCachedRouter()

      const adminToken = yield* login("root@example.com", "pw", "_superadmin")
      const tokenB = yield* login("cache-b2@example.com", "pw")

      // ---- 1. admin reads first (populates the `::admin` cache entry) -----
      const adm = yield* get(`/api/collections/private_profiles/${profileId}`, adminToken)
      const admBody = yield* adm.json
      // eslint-disable-next-line no-console
      console.log(`[H1c] admin read        status=${adm.status} body=${pretty(admBody)}`)
      assert.strictEqual(adm.status, 200)
      assert.strictEqual(at(admBody, "ssn"), "222-33-4444")

      // ---- 2. non-owner B (authenticated users token) must be denied ------
      const b = yield* get(`/api/collections/private_profiles/${profileId}`, tokenB)
      const bBody = yield* b.json
      // eslint-disable-next-line no-console
      console.log(`[H1c] B read            status=${b.status} body=${pretty(bBody)}`)
      assert.notStrictEqual(b.status, 200, "non-admin must not be served the admin cache entry")
      assert.strictEqual(at(bBody, "ssn"), undefined)

      // ---- 3. anonymous must be denied ------------------------------------
      const anon = yield* get(`/api/collections/private_profiles/${profileId}`)
      const anonBody = yield* anon.json
      // eslint-disable-next-line no-console
      console.log(`[H1c] anon read         status=${anon.status} body=${pretty(anonBody)}`)
      assert.notStrictEqual(anon.status, 200)

      // ---- 4. key evidence: admin tag is literally `admin` ----------------
      const adminCtx: RequestCtx = {
        auth: { collection: "_superadmin", record: { id: "root" } },
        headers: {},
        query: {},
        admin: true
      }
      const nonAdminCtx: RequestCtx = {
        auth: { collection: "users", record: { id: userBId } },
        headers: {},
        query: {}
      }
      const adminTag = buildCtxCacheTag(PrivateProfiles, "view", adminCtx)
      const nonAdminTag = buildCtxCacheTag(PrivateProfiles, "view", nonAdminCtx)
      // eslint-disable-next-line no-console
      console.log(`[H1c] cache tags: admin=${adminTag} | non-admin=${nonAdminTag}`)
      assert.strictEqual(adminTag, "admin")
      assert.notStrictEqual(nonAdminTag, adminTag)
    }).pipe(Effect.provide(makeCachedSecurityLayer(CACHED_COLLECTIONS)))
  )
})

describe("H2: @request_body_* rule on list/view (fail-closed?)", () => {
  it.effect("a body-referencing list rule cannot be satisfied by a request header, even with the cache", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* setupExtraTables
      yield* seedRow("body_rules", { title: "body-secret-row", token: "body-secret" })
      yield* serveCachedRouter()

      const compiled = enforcerForAction(BodyRule.schema, "list")
      // eslint-disable-next-line no-console
      console.log(`[H2] compiled list rule: sql=${pretty(compiled?.sql)} params=${pretty(compiled?.params)}`)

      // ---- 1. request WITH the header ----
      const withHeader = yield* HttpClient.execute(
        HttpClientRequest.get("/api/collections/body_rules").pipe(
          HttpClientRequest.setHeader("token", "body-secret")
        )
      )
      const withHeaderBody = yield* withHeader.json
      // eslint-disable-next-line no-console
      console.log(
        `[H2] list + header token=body-secret status=${withHeader.status} items=${itemCount(
          withHeaderBody
        )} body=${pretty(withHeaderBody)}`
      )

      // ---- 2. request WITHOUT the header ----
      const withoutHeader = yield* get("/api/collections/body_rules")
      const withoutHeaderBody = yield* withoutHeader.json
      // eslint-disable-next-line no-console
      console.log(
        `[H2] list header-less     status=${withoutHeader.status} items=${itemCount(
          withoutHeaderBody
        )} body=${pretty(withoutHeaderBody)}`
      )

      assert.strictEqual(withHeader.status, 200)
      assert.strictEqual(
        itemCount(withHeaderBody),
        0,
        "a header must not satisfy a @request_body_* list rule"
      )
      assert.strictEqual(withoutHeader.status, 200)
      assert.strictEqual(
        itemCount(withoutHeaderBody),
        0,
        "header-less request must not see a header-triggered cached page"
      )

      const headerCtx: RequestCtx = { headers: { token: "body-secret" }, query: {} }
      const headerlessCtx: RequestCtx = { headers: {}, query: {} }
      const tagH = buildCtxCacheTag(BodyRule, "list", headerCtx)
      const tagN = buildCtxCacheTag(BodyRule, "list", headerlessCtx)
      // eslint-disable-next-line no-console
      console.log(`[H2] cache tags: with-header=${tagH} | header-less=${tagN}`)
      assert.strictEqual(tagH, tagN, "body-source cache tag must not vary with headers")
    }).pipe(Effect.provide(makeCachedSecurityLayer(CACHED_COLLECTIONS)))
  )
})

describe("H3: cached view/list invalidation after a write by a different requester", () => {
  it.effect("an update by admin invalidates the owner's cached view (fresh data on re-read)", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* setupExtraTables

      const userAId = yield* seedUser("cache-h3@example.com", "pw")
      yield* seedUser("root3@example.com", "pw", "_superadmin")
      const profileId = yield* seedProfile({
        email: "h3-private@example.com",
        ssn: "111-00-0000",
        ownerId: userAId
      })
      yield* serveCachedRouter()

      const tokenA = yield* login("cache-h3@example.com", "pw")
      const adminToken = yield* login("root3@example.com", "pw", "_superadmin")

      // owner reads (cache populated)
      const before = yield* get(`/api/collections/private_profiles/${profileId}`, tokenA)
      const beforeBody = yield* before.json
      // eslint-disable-next-line no-console
      console.log(`[H3] A read before update status=${before.status} ssn=${pretty(at(beforeBody, "ssn"))}`)
      assert.strictEqual(at(beforeBody, "ssn"), "111-00-0000")

      // a DIFFERENT requester (admin) updates through the service (invalidates)
      const upd = yield* patchJson(
        `/api/collections/private_profiles/${profileId}`,
        { ssn: "555-66-7777" },
        adminToken
      )
      const updBody = yield* upd.json
      // eslint-disable-next-line no-console
      console.log(`[H3] admin update          status=${upd.status} body=${pretty(updBody)}`)
      assert.strictEqual(upd.status, 200)

      // owner re-reads within TTL — must be fresh
      const after = yield* get(`/api/collections/private_profiles/${profileId}`, tokenA)
      const afterBody = yield* after.json
      // eslint-disable-next-line no-console
      console.log(`[H3] A read after update   status=${after.status} ssn=${pretty(at(afterBody, "ssn"))}`)
      assert.strictEqual(after.status, 200)
      assert.strictEqual(
        at(afterBody, "ssn"),
        "555-66-7777",
        "update must invalidate the record cache -> fresh value within TTL"
      )
    }).pipe(Effect.provide(makeCachedSecurityLayer(CACHED_COLLECTIONS)))
  )

  it.effect("a create nukes the cached list so the new row is visible within TTL", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* setupExtraTables
      yield* serveCachedRouter()

      // anonymous list (public rule) — cached at 0 items
      const list1 = yield* get("/api/collections/posts")
      const list1Body = yield* list1.json
      // eslint-disable-next-line no-console
      console.log(`[H3b] list before create   status=${list1.status} items=${itemCount(list1Body)}`)
      assert.strictEqual(itemCount(list1Body), 0)

      const created = yield* postJson("/api/collections/posts", { title: "brand-new-post" })
      const createdBody = yield* created.json
      // eslint-disable-next-line no-console
      console.log(`[H3b] create               status=${created.status} body=${pretty(createdBody)}`)
      assert.strictEqual(created.status, 201)

      const list2 = yield* get("/api/collections/posts")
      const list2Body = yield* list2.json
      // eslint-disable-next-line no-console
      console.log(`[H3b] list after create    status=${list2.status} items=${itemCount(list2Body)}`)
      assert.strictEqual(
        itemCount(list2Body),
        1,
        "create must nuke the list cache -> new row visible within TTL"
      )
    }).pipe(Effect.provide(makeCachedSecurityLayer(CACHED_COLLECTIONS)))
  )
})

describe("H4 (REGRESSION): a request whose rule value differs from the one that warmed the cache tag must not receive the cached row", () => {
  it.effect("unauthorised `?token=a&token=b` (resolves \"a\") must NOT replay the row authorised by `?token=a,b`", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* setupExtraTables
      yield* seedRow("query_rules", { title: "comma-secret-row", token: "a,b" })
      // A second row used only for the cold control (its tag is never warmed).
      yield* seedRow("query_rules", { title: "control-row", token: "c,d" })
      yield* serveCachedRouter()

      const compiled = enforcerForAction(QueryRule.schema, "list")
      // eslint-disable-next-line no-console
      console.log(`[H4] compiled list rule: sql=${pretty(compiled?.sql)}`)

      // ---- control: the repeated shape is genuinely denied with a cold cache ----
      const cold = yield* get("/api/collections/query_rules?token=c&token=d")
      const coldBody = yield* cold.json
      // eslint-disable-next-line no-console
      console.log(
        `[H4] control: cold ?token=c&token=d status=${cold.status} items=${itemCount(
          coldBody
        )} (resolves "c"; tag q:token=c,d never warmed)`
      )
      assert.strictEqual(
        itemCount(coldBody),
        0,
        "control: a repeated query value resolves to element [0] and must not match a comma-valued secret"
      )

      // ---- control: authorised scalar value exactly matches the seeded token ----
      const scalar = yield* get("/api/collections/query_rules?token=a,b")
      const scalarBody = yield* scalar.json
      // eslint-disable-next-line no-console
      console.log(
        `[H4] control: authorised ?token=a,b   status=${scalar.status} items=${itemCount(
          scalarBody
        )} body=${pretty(scalarBody)}`
      )
      assert.strictEqual(itemCount(scalarBody), 1, "control: authorised scalar request must match the row")

      // ---- the unauthorised repeated value resolves to "a" (never matches "a,b") ----
      const repeated = yield* get("/api/collections/query_rules?token=a&token=b")
      const repeatedBody = yield* repeated.json
      // eslint-disable-next-line no-console
      console.log(
        `[H4] VULNERABLE EVIDENCE: unauthorised ?token=a&token=b status=${repeated.status} items=${itemCount(
          repeatedBody
        )} body=${pretty(repeatedBody)}`
      )

      const scalarCtx: RequestCtx = { headers: {}, query: { token: "a,b" } }
      const repeatedCtx: RequestCtx = { headers: {}, query: { token: ["a", "b"] } }
      const scalarTag = buildCtxCacheTag(QueryRule, "list", scalarCtx)
      const repeatedTag = buildCtxCacheTag(QueryRule, "list", repeatedCtx)
      // eslint-disable-next-line no-console
      console.log(
        `[H4] VULNERABLE EVIDENCE: cache tags scalar=${scalarTag} repeated=${repeatedTag} (must differ)`
      )

      assert.strictEqual(
        itemCount(repeatedBody),
        0,
        "SECURE EXPECTED: unauthorised repeated-value request must not replay the cached comma-secret row"
      )
      assert.notStrictEqual(
        scalarTag,
        repeatedTag,
        "SECURE EXPECTED: scalar and repeated query shapes must not collapse to one cache tag"
      )
    }).pipe(Effect.provide(makeCachedSecurityLayer(CACHED_COLLECTIONS)))
  )

  it.effect("a missing gate param must NOT replay the cache entry of an empty-string param", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* setupExtraTables
      // a row whose gate value is the empty string
      yield* seedRow("query_rules", { title: "empty-token-row", token: "" })
      yield* serveCachedRouter()

      // control: `?token=` resolves to "" and matches the empty-token row, warming
      // the `q:token=` cache entry.
      const emptyParam = yield* get("/api/collections/query_rules?token=")
      const emptyParamBody = yield* emptyParam.json
      // eslint-disable-next-line no-console
      console.log(
        `[H4b] control: authorised ?token= status=${emptyParam.status} items=${itemCount(
          emptyParamBody
        )} body=${pretty(emptyParamBody)}`
      )
      assert.strictEqual(itemCount(emptyParamBody), 1, "control: authorised empty-param request matches the row")

      // the unauthorised request omits the param entirely (resolves to NULL)
      const missingParam = yield* get("/api/collections/query_rules")
      const missingParamBody = yield* missingParam.json
      // eslint-disable-next-line no-console
      console.log(
        `[H4b] VULNERABLE EVIDENCE: omitted (no token) status=${missingParam.status} items=${itemCount(
          missingParamBody
        )} body=${pretty(missingParamBody)}`
      )

      const emptyTag = buildCtxCacheTag(QueryRule, "list", { headers: {}, query: { token: "" } })
      const missingTag = buildCtxCacheTag(QueryRule, "list", { headers: {}, query: {} })
      // eslint-disable-next-line no-console
      console.log(
        `[H4b] VULNERABLE EVIDENCE: cache tags empty=${emptyTag} missing=${missingTag} (must differ)`
      )
      assert.strictEqual(
        itemCount(missingParamBody),
        0,
        "SECURE EXPECTED: request omitting the gate param must not replay the empty-string request's cached row"
      )
      assert.notStrictEqual(
        emptyTag,
        missingTag,
        "SECURE EXPECTED: empty and missing query values must not collapse to one cache tag"
      )
    }).pipe(Effect.provide(makeCachedSecurityLayer(CACHED_COLLECTIONS)))
  )

  it.effect("an authorised request must not be poisoned by a prior unauthorised cold request sharing its tag", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* setupExtraTables
      yield* seedRow("query_rules", { title: "empty-token-row", token: "" })
      yield* serveCachedRouter()

      // cold control FIRST: omitting the gate param resolves to NULL and matches
      // nothing — proving the missing shape is genuinely unauthorised.
      const coldMissing = yield* get("/api/collections/query_rules")
      const coldMissingBody = yield* coldMissing.json
      // eslint-disable-next-line no-console
      console.log(
        `[H4c] control: cold (no token) status=${coldMissing.status} items=${itemCount(coldMissingBody)}`
      )
      assert.strictEqual(itemCount(coldMissingBody), 0, "control: missing param resolves to NULL")

      // the AUTHORISED request must see its own row — not the cold entry.
      const emptyParam = yield* get("/api/collections/query_rules?token=")
      const emptyParamBody = yield* emptyParam.json
      // eslint-disable-next-line no-console
      console.log(
        `[H4c] VULNERABLE EVIDENCE: authorised ?token= status=${emptyParam.status} items=${itemCount(
          emptyParamBody
        )} body=${pretty(emptyParamBody)} (currently served the cold unauthorised entry)`
      )
      assert.strictEqual(
        itemCount(emptyParamBody),
        1,
        "SECURE EXPECTED: authorised `?token=` request must see its own row, not be poisoned by the cold missing-param entry"
      )
    }).pipe(Effect.provide(makeCachedSecurityLayer(CACHED_COLLECTIONS)))
  )
})
