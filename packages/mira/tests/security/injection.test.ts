import { describe, it, assert } from "@effect/vitest"
import { Effect, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import type { HttpClientResponse } from "effect/http"

import { Repository } from "@/repository/repository.js"

import {
  get,
  login,
  makeSecurityLayer,
  patchJson,
  postJson,
  seedPost,
  seedUser,
  serveRouter,
  setupTables,
} from "./_harness.js"

const layer = makeSecurityLayer()

// ---------------------------------------------------------------------------
// Helpers (no type assertions — Schema decoding + raw text capture only)
// ---------------------------------------------------------------------------

const ListSchema = Schema.Struct({
  items: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  nextCursor: Schema.NullOr(Schema.Number),
})

const RecordSchema = Schema.Record(Schema.String, Schema.Unknown)

function readList(res: HttpClientResponse.HttpClientResponse) {
  return Effect.gen(function* () {
    const json = yield* res.json
    return yield* Schema.decodeUnknownEffect(ListSchema)(json).pipe(Effect.orDie)
  })
}

function readRecord(res: HttpClientResponse.HttpClientResponse) {
  return Effect.gen(function* () {
    const json = yield* res.json
    return yield* Schema.decodeUnknownEffect(RecordSchema)(json).pipe(Effect.orDie)
  })
}

function log(label: string, res: HttpClientResponse.HttpClientResponse, text: string) {
  return Effect.sync(() =>
    console.log(`[INJ] ${label} => status=${res.status} body=${text.slice(0, 320).replace(/\s+/g, " ")}`)
  )
}

/** Send a raw JSON string body. */
function rawRequest(method: "POST" | "PATCH", path: string, body: string, token?: string) {
  const base = method === "POST" ? HttpClientRequest.post(path) : HttpClientRequest.patch(path)
  const withBody = base.pipe(HttpClientRequest.bodyText(body, "application/json"))
  const withAuth =
    token === undefined ? withBody : withBody.pipe(HttpClientRequest.setHeader("Authorization", `Bearer ${token}`))
  return HttpClient.execute(withAuth)
}

const SELECT_INJECTION = `id" FROM posts t WHERE 1=0 UNION SELECT 'MIRAINJECTED' WHERE ? IS NOT NULL--`

const SELECT_EXFIL = `id" FROM posts t WHERE 1=0 UNION SELECT password FROM _superadmin WHERE ? IS NOT NULL--`

describe("H1 — SQL injection via query parameters", () => {
  it.effect("H1a REGRESSION (fails until fixed) — admin `select` must NOT execute injected SQL", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* seedPost({ title: "normal-post" })
      const rootId = yield* seedUser("root@example.com", "pw", "_superadmin")
      yield* serveRouter({ admin: true })
      const token = yield* login("root@example.com", "pw", "_superadmin")

      const base = yield* get("/api/collections/posts", token)
      const baseText = yield* base.text
      yield* log("baseline list (admin)", base, baseText)
      assert.strictEqual(base.status, 200, "baseline list must succeed")
      assert.ok(!baseText.includes("MIRAINJECTED"), "baseline must not contain the injected marker")

      const url = `/api/collections/posts?select=${encodeURIComponent(SELECT_INJECTION)}`
      const res = yield* get(url, token)
      const text = yield* res.text
      yield* log(`admin select marker injection (select=${SELECT_INJECTION})`, res, text)

      const exfilUrl = `/api/collections/posts?select=${encodeURIComponent(SELECT_EXFIL)}`
      const exfilRes = yield* get(exfilUrl, token)
      const exfilText = yield* exfilRes.text
      yield* log(`admin select exfil (select=${SELECT_EXFIL})`, exfilRes, exfilText)

      const repo = yield* Repository
      const storedRow = yield* repo.view("_superadmin", rootId).pipe(Effect.orDie)
      const stored = yield* Schema.decodeUnknownEffect(Schema.Struct({ password: Schema.String }))(
        Option.getOrElse(storedRow, () => ({}))
      ).pipe(Effect.orDie)

      assert.ok(res.status < 500, `admin select injection must not 5xx, got ${res.status}`)
      assert.ok(
        !text.includes("MIRAINJECTED"),
        "admin select must not execute injected SQL — response contained the injected marker MIRAINJECTED"
      )
      assert.ok(exfilRes.status < 500, `admin select exfil must not 5xx, got ${exfilRes.status}`)
      assert.ok(
        !exfilText.includes(stored.password),
        "admin select must not read arbitrary tables — response leaked the superadmin password hash"
      )
    }).pipe(Effect.provide(layer))
  )

  it.effect("H1b SECURE — non-admin `select` payload is dropped by the hidden-field allowlist", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* seedPost({ title: "normal-post" })
      yield* seedUser("user@example.com", "pw")
      yield* serveRouter()
      const token = yield* login("user@example.com", "pw")

      const url = `/api/collections/posts?select=${encodeURIComponent(SELECT_INJECTION)}`
      const res = yield* get(url, token)
      const text = yield* res.text
      yield* log("non-admin select injection", res, text)

      assert.strictEqual(res.status, 200)
      const body = yield* readList(res)
      assert.ok(!text.includes("MIRAINJECTED"), "non-admin select must be filtered to schema fields")
      assert.strictEqual(body.items.length, 1)
      assert.strictEqual(body.items[0]?.["title"], undefined)
    }).pipe(Effect.provide(layer))
  )

  it.effect("H1c SECURE — admin `select` with a quoted/comma payload is dropped by the schema allowlist", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* seedPost({ title: "normal-post" })
      yield* seedUser("root@example.com", "pw", "_superadmin")
      yield* serveRouter({ admin: true })
      const token = yield* login("root@example.com", "pw", "_superadmin")

      const payload = `title", (SELECT 1) AS x, t."id`
      const res = yield* get(`/api/collections/posts?select=${encodeURIComponent(payload)}`, token)
      const text = yield* res.text
      yield* log(`admin select quoted payload (${payload})`, res, text)

      assert.strictEqual(res.status, 200)
      assert.ok(!text.includes("MIRAINJECTED"))
      const body = yield* readList(res)
      assert.strictEqual(body.items.length, 1)
      assert.strictEqual(body.items[0]?.["title"], undefined)
    }).pipe(Effect.provide(layer))
  )

  it.effect("H1d SECURE — sort / order / limit / after payloads are validated or coerced, table survives", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* seedPost({ title: "normal-post" })
      yield* serveRouter()

      const payloads = [
        `sort=${encodeURIComponent(`id" DESC; DROP TABLE posts;--`)}`,
        `sort=${encodeURIComponent("title;SELECT 1")}`,
        `sort=${encodeURIComponent(`title"`)}`,
        `order=${encodeURIComponent("desc;DROP TABLE posts;--")}`,
        `limit=${encodeURIComponent("1;DROP TABLE posts")}`,
        `after=${encodeURIComponent("1;DROP TABLE posts")}`,
        `expand=${encodeURIComponent(`profile";DROP TABLE posts;--`)}`,
      ]

      for (const qs of payloads) {
        const res = yield* get(`/api/collections/posts?${qs}`)
        const text = yield* res.text
        yield* log(`payload ?${qs}`, res, text)
        assert.strictEqual(res.status, 200, `expected 200 for ?${qs}`)
      }

      // Table must still exist and normal listing still work.
      const after = yield* get("/api/collections/posts")
      const afterText = yield* after.text
      yield* log("post-payload sanity list", after, afterText)
      assert.strictEqual(after.status, 200)
      assert.ok(afterText.includes("normal-post"))
    }).pipe(Effect.provide(layer))
  )
})

describe("H2 — prototype pollution via JSON body", () => {
  it.effect("H2a SECURE — __proto__ in the body does not pollute Object.prototype", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* serveRouter()

      const res = yield* rawRequest(
        "POST",
        "/api/collections/posts",
        `{"title":"x","__proto__":{"polluted":"yes"}}`
      )
      const text = yield* res.text
      yield* log("POST posts body with __proto__", res, text)

      assert.ok(res.status === 201 || res.status === 422, `unexpected status ${res.status}`)
      assert.strictEqual(Reflect.get(Object.prototype, "polluted"), undefined, "Object.prototype.polluted must stay undefined")
      assert.strictEqual(Reflect.get({}, "polluted"), undefined)
    }).pipe(Effect.provide(layer))
  )

  it.effect("H2b SECURE — constructor.prototype in the body does not pollute Object.prototype", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* serveRouter()

      const res = yield* rawRequest(
        "POST",
        "/api/collections/posts",
        `{"title":"x","constructor":{"prototype":{"polluted2":"yes"}}}`
      )
      const text = yield* res.text
      yield* log("POST posts body with constructor.prototype", res, text)

      assert.ok(res.status === 201 || res.status === 422, `unexpected status ${res.status}`)
      assert.strictEqual(Reflect.get(Object.prototype, "polluted2"), undefined, "Object.prototype.polluted2 must stay undefined")
      assert.strictEqual(Reflect.get({}, "polluted2"), undefined)
    }).pipe(Effect.provide(layer))
  )
})

describe("H3 — mass assignment / system fields", () => {
  for (const field of ["id", "seqId", "created", "updated"]) {
    it.effect(`H3a SECURE — create rejects read-only system field \`${field}\``, () =>
      Effect.gen(function* () {
        yield* setupTables
        yield* serveRouter()

        const res = yield* postJson("/api/collections/posts", { title: "x", [field]: "ATTACKER" })
        const text = yield* res.text
        yield* log(`create with ${field}=ATTACKER`, res, text)

        assert.strictEqual(res.status, 422)
        assert.ok(text.includes("read-only"), "expected a read-only validation error")
      }).pipe(Effect.provide(layer))
    )
  }

  for (const field of ["id", "seqId", "created", "updated"]) {
    it.effect(`H3b SECURE — update rejects read-only system field \`${field}\``, () =>
      Effect.gen(function* () {
        yield* setupTables
        const id = yield* seedPost({ title: "original" })
        yield* serveRouter()

        const res = yield* patchJson(`/api/collections/posts/${id}`, { [field]: "ATTACKER" })
        const text = yield* res.text
        yield* log(`patch ${id} with ${field}=ATTACKER`, res, text)

        assert.strictEqual(res.status, 422)
        assert.ok(text.includes("read-only"), "expected a read-only validation error")
      }).pipe(Effect.provide(layer))
    )
  }

  it.effect("H3c — normal (non-system) fields remain writable on create", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* serveRouter()

      const res = yield* postJson("/api/collections/posts", {
        title: "writable",
        content: "body",
        profile: "some-profile-id",
      })
      const text = yield* res.text
      yield* log("create with normal fields", res, text)

      assert.strictEqual(res.status, 201)
      const record = yield* readRecord(res)
      assert.strictEqual(record["title"], "writable")
      assert.strictEqual(record["profile"], "some-profile-id")
    }).pipe(Effect.provide(layer))
  )
})

describe("H4 — auth credential enforcement", () => {
  it.effect("H4a SECURE — non-admin create with emailVerified:true is rejected", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* serveRouter()

      const res = yield* postJson("/api/collections/users", {
        email: "new@example.com",
        password: "pw123",
        passwordConfirm: "pw123",
        emailVerified: true,
      })
      const text = yield* res.text
      yield* log("create users emailVerified:true", res, text)
      assert.strictEqual(res.status, 422)
    }).pipe(Effect.provide(layer))
  )

  it.effect("H4b SECURE — non-admin create without passwordConfirm is rejected", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* serveRouter()

      const res = yield* postJson("/api/collections/users", {
        email: "new@example.com",
        password: "pw123",
      })
      const text = yield* res.text
      yield* log("create users without passwordConfirm", res, text)
      assert.strictEqual(res.status, 422)
    }).pipe(Effect.provide(layer))
  )

  it.effect("H4c SECURE — update own password without passwordConfirm is rejected", () =>
    Effect.gen(function* () {
      yield* setupTables
      const id = yield* seedUser("me@example.com", "pw123")
      yield* serveRouter()
      const token = yield* login("me@example.com", "pw123")

      const res = yield* patchJson(`/api/collections/users/${id}`, { password: "newpw" }, token)
      const text = yield* res.text
      yield* log("update own password, no passwordConfirm", res, text)
      assert.strictEqual(res.status, 422)
    }).pipe(Effect.provide(layer))
  )

  it.effect("H4d SECURE — update own password without oldPassword is rejected", () =>
    Effect.gen(function* () {
      yield* setupTables
      const id = yield* seedUser("me@example.com", "pw123")
      yield* serveRouter()
      const token = yield* login("me@example.com", "pw123")

      const res = yield* patchJson(
        `/api/collections/users/${id}`,
        { password: "newpw", passwordConfirm: "newpw" },
        token
      )
      const text = yield* res.text
      yield* log("update own password, passwordConfirm only (no oldPassword)", res, text)
      assert.strictEqual(res.status, 422)
    }).pipe(Effect.provide(layer))
  )

  it.effect("H4e SECURE — change own email without oldPassword is rejected", () =>
    Effect.gen(function* () {
      yield* setupTables
      const id = yield* seedUser("me@example.com", "pw123")
      yield* serveRouter()
      const token = yield* login("me@example.com", "pw123")

      const res = yield* patchJson(`/api/collections/users/${id}`, { email: "changed@example.com" }, token)
      const text = yield* res.text
      yield* log("update own email, no oldPassword", res, text)
      assert.strictEqual(res.status, 422)
    }).pipe(Effect.provide(layer))
  )

  it.effect("H4f SECURE — non-admin cannot flip own emailVerified", () =>
    Effect.gen(function* () {
      yield* setupTables
      const id = yield* seedUser("me@example.com", "pw123")
      yield* serveRouter()
      const token = yield* login("me@example.com", "pw123")

      const res = yield* patchJson(`/api/collections/users/${id}`, { emailVerified: true }, token)
      const text = yield* res.text
      yield* log("update own emailVerified:true", res, text)
      assert.strictEqual(res.status, 422)
    }).pipe(Effect.provide(layer))
  )

  it.effect("H4g SECURE — non-admin cannot patch another user's record (self-only rule)", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* seedUser("me@example.com", "pw123")
      const otherId = yield* seedUser("other@example.com", "pw123")
      yield* serveRouter()
      const token = yield* login("me@example.com", "pw123")

      const res = yield* patchJson(`/api/collections/users/${otherId}`, { email: "hijack@example.com" }, token)
      const text = yield* res.text
      yield* log("patch another user's record", res, text)
      assert.strictEqual(res.status, 403)
    }).pipe(Effect.provide(layer))
  )

  it.effect("H4h SECURE — password + matching passwordConfirm but no oldPassword is rejected", () =>
    Effect.gen(function* () {
      yield* setupTables
      const id = yield* seedUser("me@example.com", "pw123")
      yield* serveRouter()
      const token = yield* login("me@example.com", "pw123")

      const res = yield* patchJson(
        `/api/collections/users/${id}`,
        { password: "hunter2", passwordConfirm: "hunter2" },
        token
      )
      const text = yield* res.text
      yield* log("password+confirm, no oldPassword (bypass attempt)", res, text)
      assert.strictEqual(res.status, 422)
    }).pipe(Effect.provide(layer))
  )
})

describe("H5 — JSON body shape fuzzing", () => {
  const shapes: ReadonlyArray<{ label: string; body: unknown }> = [
    { label: "array [1,2,3]", body: [1, 2, 3] },
    { label: 'string "x"', body: "x" },
    { label: "number 42", body: 42 },
    { label: "null", body: null },
  ]

  for (const shape of shapes) {
    it.effect(`H5 SECURE — POST with JSON ${shape.label} yields 4xx, not 5xx`, () =>
      Effect.gen(function* () {
        yield* setupTables
        yield* serveRouter()

        const res = yield* postJson("/api/collections/posts", shape.body)
        const text = yield* res.text
        yield* log(`POST posts body=${shape.label}`, res, text)

        assert.ok(res.status >= 400 && res.status < 500, `expected 4xx, got ${res.status}`)
      }).pipe(Effect.provide(layer))
    )
  }

  for (const shape of shapes) {
    it.effect(`H5 — PATCH with JSON ${shape.label} does not 5xx (observed 200 no-op)`, () =>
      Effect.gen(function* () {
        yield* setupTables
        const id = yield* seedPost({ title: "original" })
        yield* serveRouter()

        const res = yield* patchJson(`/api/collections/posts/${id}`, shape.body)
        const text = yield* res.text
        yield* log(`PATCH posts/${id} body=${shape.label}`, res, text)

        // The update schema is entirely optional, so a non-object / empty root
        // decodes to `{}` and performs a no-op update -> 200. The security
        // requirement is only "no unhandled 5xx".
        assert.ok(res.status < 500, `expected no 5xx, got ${res.status}`)
      }).pipe(Effect.provide(layer))
    )
  }
})

describe("H6 — filter field validation", () => {
  const unknownFields = ["does_not_exist", "t.id", `id";--`]

  for (const field of unknownFields) {
    it.effect(`H6 SECURE — filter with unknown field ${JSON.stringify(field)} is 422`, () =>
      Effect.gen(function* () {
        yield* setupTables
        yield* serveRouter()

        const filter = `{"op":"eq","field":${JSON.stringify(field)},"value":1}`
        const res = yield* get(`/api/collections/posts?filter=${encodeURIComponent(filter)}`)
        const text = yield* res.text
        yield* log(`filter field=${field}`, res, text)

        assert.strictEqual(res.status, 422)
      }).pipe(Effect.provide(layer))
    )
  }

  it.effect("H6 SECURE — a valid filter still works and is parameterised", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* seedPost({ title: "match-me" })
      yield* seedPost({ title: "other" })
      yield* serveRouter()

      const filter = `{"op":"eq","field":"title","value":"match-me"}`
      const res = yield* get(`/api/collections/posts?filter=${encodeURIComponent(filter)}`)
      const text = yield* res.text
      yield* log("valid filter title=match-me", res, text)

      assert.strictEqual(res.status, 200)
      const body = yield* readList(res)
      assert.strictEqual(body.items.length, 1)
      assert.strictEqual(body.items[0]?.["title"], "match-me")
    }).pipe(Effect.provide(layer))
  )

  it.effect("H6 REGRESSION (fails until fixed) — prototype-inherited filter keys must be rejected with 422", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* serveRouter()

      for (const field of ["constructor", "__proto__", "toString"]) {
        const filter = `{"op":"eq","field":${JSON.stringify(field)},"value":1}`
        const res = yield* get(`/api/collections/posts?filter=${encodeURIComponent(filter)}`)
        const text = yield* res.text
        yield* log(`filter inherited field=${field}`, res, text)
        assert.strictEqual(
          res.status,
          422,
          `filter field ${JSON.stringify(field)} must be rejected as an unknown field (422), got ${res.status}`
        )
      }
    }).pipe(Effect.provide(layer))
  )
})


