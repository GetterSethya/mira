import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import { buildCtxCacheTag } from "@/cache/ctx-key.js"
import { Repository } from "@/repository/repository.js"

import {
  PrivateProfiles,
  get,
  login,
  makeSecurityLayer,
  seedPost,
  seedProfile,
  seedUser,
  serveRouter,
  setupTables
} from "./_harness.js"

// ---------------------------------------------------------------------------
// Tiny reflection/printing helpers (no `as` assertions, no JSON.parse)
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

/** Build a `filter=` query-string fragment from a plain object. */
function filterQuery(url: string, node: unknown): string {
  const sep = url.includes("?") ? "&" : "?"
  return `${url}${sep}filter=${encodeURIComponent(JSON.stringify(node))}`
}

/** Find the item in a decoded list body whose `id` equals `id`. */
function itemById(body: unknown, id: string): unknown {
  const items = at(body, "items")
  if (!Array.isArray(items)) return undefined
  return items.find((it) => at(it, "id") === id)
}

/** Number of items in a decoded list body, or -1 when the shape is wrong. */
function itemCount(body: unknown): number {
  const items = at(body, "items")
  return Array.isArray(items) ? items.length : -1
}

/** First item of a decoded list body, or undefined. */
function firstItem(body: unknown): unknown {
  const items = at(body, "items")
  return Array.isArray(items) ? items[0] : undefined
}

/** True when a request was rejected by the API (any 4xx). */
function isRejected(status: number): boolean {
  return status >= 400 && status < 500
}

const layer = makeSecurityLayer()

describe("H1: relation expand must not bypass target collection view rule", () => {
  it.effect(
    "posts?expand=profile does not leak private_profiles to a non-owner or anonymous",
    () =>
      Effect.gen(function* () {
        yield* setupTables
        const userAId = yield* seedUser("a@example.com", "pw")
        const userBId = yield* seedUser("b@example.com", "pw")
        const profileId = yield* seedProfile({
          email: "a-private@example.com",
          ssn: "111-22-3333",
          ownerId: userAId
        })
        const postId = yield* seedPost({ title: "post-with-profile", profile: profileId })
        yield* serveRouter()

        const tokenA = yield* login("a@example.com", "pw")
        const tokenB = yield* login("b@example.com", "pw")

        // --- direct reads: control rules, expected to stay enforced ----------
        const bDirect = yield* get(`/api/collections/private_profiles/${profileId}`, tokenB)
        const bDirectBody = yield* bDirect.json
        // eslint-disable-next-line no-console
        console.log(`[H1] B direct read   status=${bDirect.status} body=${pretty(bDirectBody)}`)

        const anonDirect = yield* get(`/api/collections/private_profiles/${profileId}`)
        const anonDirectBody = yield* anonDirect.json
        // eslint-disable-next-line no-console
        console.log(`[H1] anon direct read status=${anonDirect.status} body=${pretty(anonDirectBody)}`)

        const aDirect = yield* get(`/api/collections/private_profiles/${profileId}`, tokenA)
        const aDirectBody = yield* aDirect.json
        // eslint-disable-next-line no-console
        console.log(`[H1] A (owner) read   status=${aDirect.status} body=${pretty(aDirectBody)}`)

        const anonList = yield* get("/api/collections/posts?expand=profile")
        const anonListBody = yield* anonList.json
        // eslint-disable-next-line no-console
        console.log(`[H1] anon list+expand  status=${anonList.status} body=${pretty(anonListBody)}`)
        const anonItem = itemById(anonListBody, postId)
        const anonExpandedProfile = at(at(anonItem, "expand"), "profile")

        const bList = yield* get("/api/collections/posts?expand=profile", tokenB)
        const bListBody = yield* bList.json
        // eslint-disable-next-line no-console
        console.log(`[H1] B list+expand     status=${bList.status} body=${pretty(bListBody)}`)
        const bItem = itemById(bListBody, postId)
        const bExpandedProfile = at(at(bItem, "expand"), "profile")

        const bView = yield* get(`/api/collections/posts/${postId}?expand=profile`, tokenB)
        const bViewBody = yield* bView.json
        // eslint-disable-next-line no-console
        console.log(`[H1] B view+expand     status=${bView.status} body=${pretty(bViewBody)}`)
        const bViewExpandedProfile = at(at(bViewBody, "expand"), "profile")

        assert.notStrictEqual(bDirect.status, 200, "non-owner must be denied direct access")
        assert.notStrictEqual(anonDirect.status, 200, "anonymous must be denied direct access")
        assert.strictEqual(aDirect.status, 200, "owner must be able to read their profile")
        assert.strictEqual(at(aDirectBody, "ssn"), "111-22-3333")

        assert.strictEqual(
          at(anonExpandedProfile, "ssn"),
          undefined,
          "anonymous expand must not expose the denied private_profiles.ssn"
        )
        assert.strictEqual(
          at(bExpandedProfile, "ssn"),
          undefined,
          "non-owner expand must not expose the denied private_profiles.ssn"
        )
        assert.strictEqual(
          at(bViewExpandedProfile, "ssn"),
          undefined,
          "non-owner view+expand must not expose the denied private_profiles.ssn"
        )

        // reference unused binding
        void userBId
      }).pipe(Effect.provide(layer))
  )
})

describe("H2: x-hidden field must not be a filter/sort oracle", () => {
  it.effect("filtering a hidden field is rejected or non-discriminating", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* seedPost({ title: "post-aaa", internalNote: "aaa-secret" })
      const betaId = yield* seedPost({ title: "post-beta", internalNote: "beta-secret" })
      yield* seedPost({ title: "post-zzz", internalNote: "zzz-secret" })
      yield* serveRouter()

      // --- baseline control: a plain list strips internalNote --------------
      const plain = yield* get("/api/collections/posts")
      const plainBody = yield* plain.json
      // eslint-disable-next-line no-console
      console.log(`[H2] plain list         status=${plain.status} body=${pretty(plainBody)}`)
      const plainItems = at(plainBody, "items")
      assert.ok(Array.isArray(plainItems))
      for (const item of plainItems) {
        assert.strictEqual(at(item, "internalNote"), undefined, "hidden field must be stripped")
      }

      const eqUrl = filterQuery("/api/collections/posts", {
        op: "eq",
        field: "internalNote",
        value: "beta-secret"
      })
      const eqRes = yield* get(eqUrl)
      const eqBody = yield* eqRes.json
      // eslint-disable-next-line no-console
      console.log(`[H2] filter eq hidden   status=${eqRes.status} body=${pretty(eqBody)}`)

      // control: select projection still strips the hidden field
      const sel = yield* get("/api/collections/posts?select=internalNote")
      const selBody = yield* sel.json
      // eslint-disable-next-line no-console
      console.log(`[H2] select hidden      status=${sel.status} body=${pretty(selBody)}`)
      const selItems = at(selBody, "items")
      assert.ok(Array.isArray(selItems))
      assert.strictEqual(at(selItems[0], "internalNote"), undefined)

      assert.ok(
        isRejected(eqRes.status) || itemCount(eqBody) === 0,
        `hidden field filter must be rejected or non-discriminating (got status=${eqRes.status}, items=${itemCount(eqBody)})`
      )
      // extra guard: if it was not rejected, it must not have isolated the row
      assert.notStrictEqual(
        at(itemById(eqBody, betaId), "id"),
        betaId,
        "hidden field filter isolated a row by its secret value"
      )
    }).pipe(Effect.provide(layer))
  )

  it.effect("sorting by a hidden field is rejected or ignored", () =>
    Effect.gen(function* () {
      yield* setupTables
      const zebraId = yield* seedPost({ title: "p-z", internalNote: "zebra-secret" })
      yield* seedPost({ title: "p-a", internalNote: "alpha-secret" })
      yield* seedPost({ title: "p-m", internalNote: "mango-secret" })
      yield* serveRouter()

      const plain = yield* get("/api/collections/posts")
      const plainBody = yield* plain.json
      // eslint-disable-next-line no-console
      console.log(`[H2] plain list (default seqId order) status=${plain.status} body=${pretty(plainBody)}`)
      assert.strictEqual(at(firstItem(plainBody), "id"), zebraId, "baseline order is seqId asc")

      const sortAsc = yield* get("/api/collections/posts?sort=internalNote&order=asc")
      const sortAscBody = yield* sortAsc.json
      // eslint-disable-next-line no-console
      console.log(`[H2] sort hidden asc    status=${sortAsc.status} body=${pretty(sortAscBody)}`)

      assert.ok(
        isRejected(sortAsc.status) || at(firstItem(sortAscBody), "id") === zebraId,
        `hidden sort must be rejected or ignored (got status=${sortAsc.status}, first=${String(
          at(firstItem(sortAscBody), "id")
        )})`
      )
    }).pipe(Effect.provide(layer))
  )
})

describe("H3: auth password column must not be a filter oracle", () => {
  it.effect("hidden users.password column is rejected or non-discriminating", () =>
    Effect.gen(function* () {
      yield* setupTables
      const email = "oracle@example.com"
      yield* seedUser(email, "correct-horse")
      yield* serveRouter()

      const repo = yield* Repository
      const rows = yield* repo
        .viewFilter("users", { where: { sql: "t.email = ?", params: [email] } })
        .pipe(Effect.orDie)
      const storedHash = at(rows[0], "password")
      assert.ok(typeof storedHash === "string", "stored password hash must be a string")
      const hash = storedHash.slice(0, 12)

      // baseline control: the hidden column is never returned.
      const plain = yield* get("/api/collections/users")
      const plainBody = yield* plain.json
      // eslint-disable-next-line no-console
      console.log(`[H3] users plain list   status=${plain.status} body=${pretty(plainBody)}`)
      const plainItems = at(plainBody, "items")
      assert.ok(Array.isArray(plainItems))
      for (const item of plainItems) {
        assert.strictEqual(at(item, "password"), undefined, "password must be stripped from output")
      }

      const broadUrl = filterQuery("/api/collections/users", {
        op: "like",
        field: "password",
        value: "%"
      })
      const broad = yield* get(broadUrl)
      const broadBody = yield* broad.json
      // eslint-disable-next-line no-console
      console.log(`[H3] like password %     status=${broad.status} body=${pretty(broadBody)}`)

      const realPrefixUrl = filterQuery("/api/collections/users", {
        op: "like",
        field: "password",
        value: `${hash}%`
      })
      const realPrefix = yield* get(realPrefixUrl)
      const realPrefixBody = yield* realPrefix.json
      // eslint-disable-next-line no-console
      console.log(`[H3] password like real-prefix status=${realPrefix.status} body=${pretty(realPrefixBody)}`)

      assert.ok(
        isRejected(broad.status) || itemCount(broadBody) === 0,
        `hidden password filter must be rejected or non-discriminating (got status=${broad.status}, items=${itemCount(broadBody)})`
      )
      assert.ok(
        isRejected(realPrefix.status) || itemCount(realPrefixBody) === 0,
        `hidden password prefix oracle must be rejected or non-discriminating (got status=${realPrefix.status}, items=${itemCount(realPrefixBody)})`
      )
    }).pipe(Effect.provide(layer))
  )
})

describe("H4: cache authorization scoping", () => {
  it.effect("ctx-key scopes cached reads by auth identity (HTTP reproduction not possible here)", () =>
    Effect.sync(() => {
      const ctxA = { auth: { collection: "users", record: { id: "user-A" } }, headers: {}, query: {} }
      const ctxB = { auth: { collection: "users", record: { id: "user-B" } }, headers: {}, query: {} }
      const tagA = buildCtxCacheTag(PrivateProfiles, "view", ctxA)
      const tagB = buildCtxCacheTag(PrivateProfiles, "view", ctxB)
      // eslint-disable-next-line no-console
      console.log(`[H4] tagA=${tagA} tagB=${tagB}`)
      assert.notStrictEqual(tagA, tagB, "owner-scoped rule must yield identity-distinct cache tags")
      assert.ok(tagA.includes("user-A"))
      assert.ok(tagB.includes("user-B"))
    })
  )
})
