import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, it } from "@effect/vitest"
import { assert } from "@effect/vitest"
import { Cause, Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"

import { signJwt } from "@/http/auth.js"

import { login, makeSecurityLayer, postJson, seedPost, seedUser, serveRouter, setupTables } from "./_harness.js"

const layer = makeSecurityLayer()

// ---------------------------------------------------------------------------
// Evidence helpers
// ---------------------------------------------------------------------------

type Evidence = { status: number; text: string }

function capture(res: HttpClientResponse.HttpClientResponse) {
  return Effect.map(res.text, (text) => ({ status: res.status, text }))
}

function logCase(label: string, e: Evidence) {
  return Effect.sync(() => {
    console.log(`[FUZZ] ${label} => status=${e.status} body=${e.text.slice(0, 240).replace(/\s+/g, " ")}`)
  })
}

/**
 * Execute a prebuilt request, absorbing transport failures as `status: -1`
 * (a client-side limit such as a too-long URL, not a server response).
 */
function tryExecute(request: HttpClientRequest.HttpClientRequest) {
  return HttpClient.execute(request).pipe(
    Effect.flatMap(capture),
    Effect.catchCause((cause) =>
      Effect.succeed({ status: -1, text: `CLIENT_TRANSPORT: ${Cause.pretty(cause).slice(0, 120)}` })
    )
  )
}

function tryGet(path: string, token?: string) {
  const req = HttpClientRequest.get(path)
  return tryExecute(
    token === undefined
      ? req
      : req.pipe(HttpClientRequest.setHeader("Authorization", `Bearer ${token}`))
  )
}

function rawPost(path: string, body: string, contentType = "application/json") {
  return tryExecute(
    HttpClientRequest.post(path).pipe(
      HttpClientRequest.bodyText(body),
      HttpClientRequest.setHeader("content-type", contentType)
    )
  )
}

const INTERNAL_MARKERS = [
  "SQLITE",
  "SqlError",
  "SELECT ",
  "INSERT ",
  "node_modules",
  "better-sqlite",
  "at Object.",
  "at async ",
  ".ts:",
  "C:\\",
  "/src/",
]

function leakedInternals(text: string): boolean {
  return INTERNAL_MARKERS.some((m) => text.includes(m))
}

// deep nested `not` filter, built iteratively so we never blow our own stack
function nestedNotFilter(depth: number): string {
  return '{"op":"not","node":'.repeat(depth) + '{"op":"eq","field":"title","value":"x"}' + "}".repeat(depth)
}

async function signHs256(secret: string, payload: Record<string, unknown>): Promise<string> {
  const enc = new TextEncoder()
  const b64Text = (data: string) => Buffer.from(data, "utf8").toString("base64url")
  const b64Bytes = (data: Uint8Array) => Buffer.from(data).toString("base64url")
  const header = b64Text(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const body = b64Text(JSON.stringify(payload))
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${header}.${body}`))
  return `${header}.${body}.${b64Bytes(new Uint8Array(sig))}`
}

describe("fuzz-defect: non-scalar filter value must be rejected with 422", () => {
  it.effect("array / object / boolean filter values → 422 (not 500)", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* seedPost({ title: "x" })
      yield* serveRouter()

      const cases: Array<{ label: string; json: string; expected: number }> = [
        { label: "array value", json: '{"op":"eq","field":"title","value":[1,2,3]}', expected: 422 },
        { label: "nested array value", json: '{"op":"eq","field":"title","value":[[["a"]]]}', expected: 422 },
        { label: "object value", json: '{"op":"eq","field":"title","value":{"a":1}}', expected: 422 },
        { label: "boolean value", json: '{"op":"eq","field":"title","value":true}', expected: 422 },
        { label: "in(values:[bool])", json: '{"op":"in","field":"title","values":[true]}', expected: 422 },
        { label: "in(values:[array])", json: '{"op":"in","field":"title","values":[["a"]]}', expected: 422 },
        { label: "null value (scalar control)", json: '{"op":"eq","field":"title","value":null}', expected: 200 },
        { label: "number value (scalar control)", json: '{"op":"eq","field":"title","value":5}', expected: 200 },
      ]

      const observed: Array<{ label: string; e: Evidence; expected: number }> = []
      for (const c of cases) {
        const e = yield* tryGet(`/api/collections/posts?filter=${encodeURIComponent(c.json)}`)
        yield* logCase(`filter-value ${c.label} (expected ${c.expected})`, e)
        observed.push({ label: c.label, e, expected: c.expected })
      }

      for (const o of observed) {
        assert.strictEqual(
          o.e.status,
          o.expected,
          `${o.label}: expected ${o.expected}, got ${o.e.status} body=${o.e.text.slice(0, 140)}`
        )
      }
      for (const o of observed) assert.isFalse(leakedInternals(o.e.text))

      // Control: a benign filter still works and the process is healthy.
      const ok = yield* tryGet(
        `/api/collections/posts?filter=${encodeURIComponent('{"op":"eq","field":"title","value":"x"}')}`
      )
      assert.strictEqual(ok.status, 200)
    }).pipe(Effect.provide(layer))
  )
})

describe("fuzz-defect: duplicate expand must be handled (not 500)", () => {
  it.effect("expand=<relation>,<same relation> → 200", () =>
    Effect.gen(function* () {
      yield* setupTables
      const id = yield* seedPost({ title: "x", profile: null })
      yield* serveRouter()

      const single = yield* tryGet("/api/collections/posts?expand=profile")
      yield* logCase("expand single profile", single)
      assert.strictEqual(single.status, 200)

      const dupList = yield* tryGet("/api/collections/posts?expand=profile,profile")
      yield* logCase("expand duplicate profile (list, must not be 500)", dupList)
      assert.notStrictEqual(dupList.status, 500)
      assert.ok(dupList.status < 500, `duplicate expand (list) => ${dupList.status} body=${dupList.text.slice(0, 140)}`)

      const dupView = yield* tryGet(`/api/collections/posts/${id}?expand=profile,profile`)
      yield* logCase("expand duplicate profile (view, must not be 500)", dupView)
      assert.notStrictEqual(dupView.status, 500)
      assert.ok(dupView.status < 500, `duplicate expand (view) => ${dupView.status} body=${dupView.text.slice(0, 140)}`)

      const ok = yield* tryGet("/api/collections/posts")
      assert.strictEqual(ok.status, 200)
    }).pipe(Effect.provide(layer))
  )
})

describe("fuzz-defect: missing multipart boundary must be 422", () => {
  it.effect("content-type multipart/form-data without boundary → 422 (not 500)", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* serveRouter()

      const noBoundary = yield* rawPost("/api/collections/posts", '{"title":"hi"}', "multipart/form-data")
      yield* logCase("multipart no boundary (expected 422)", noBoundary)

      const emptyBoundary = yield* rawPost(
        "/api/collections/posts",
        '{"title":"hi"}',
        "multipart/form-data; boundary="
      )
      yield* logCase("multipart empty boundary (expected 422)", emptyBoundary)

      // Control: a bounded-but-malformed multipart body is already 422.
      const withBoundary = yield* rawPost(
        "/api/collections/posts",
        '{"title":"hi"}',
        "multipart/form-data; boundary=xyz"
      )
      yield* logCase("multipart with boundary (control, expected 422)", withBoundary)

      assert.strictEqual(
        noBoundary.status,
        422,
        `no boundary => ${noBoundary.status} body=${noBoundary.text.slice(0, 140)}`
      )
      assert.strictEqual(
        emptyBoundary.status,
        422,
        `empty boundary => ${emptyBoundary.status} body=${emptyBoundary.text.slice(0, 140)}`
      )
      assert.strictEqual(withBoundary.status, 422)

      const ok = yield* tryGet("/api/collections/posts")
      assert.strictEqual(ok.status, 200)
    }).pipe(Effect.provide(layer))
  )
})

const fuzzBaseDir = mkdtempSync(join(tmpdir(), "mira-fuzz-"))
const fuzzStorageRoot = join(fuzzBaseDir, "uploads")
mkdirSync(fuzzStorageRoot, { recursive: true })
const TRAVERSAL_CANARY = "TOP-SECRET-TRAVERSAL-CANARY-9f3a"
writeFileSync(join(fuzzBaseDir, "outside-secret.txt"), TRAVERSAL_CANARY, "utf8")
const fileLayer = makeSecurityLayer(fuzzStorageRoot)

describe("fuzz-defect: file path traversal must not disclose files", () => {
  it.effect("attachment='../outside-secret.txt' must not return the target file", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* serveRouter()

      const bodyRes = yield* postJson("/api/collections/posts", {
        title: "t",
        attachment: "../outside-secret.txt",
      })
      const body = yield* capture(bodyRes)
      yield* logCase("create traversal post", body)
      const created = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(Schema.Struct({ id: Schema.String, attachment: Schema.String }))
      )(body.text).pipe(Effect.orDie)

      const res = yield* tryGet(`/api/files/posts/${created.id}/..%2Foutside-secret.txt`)
      yield* logCase("GET traversal file (must not return canary)", res)

      assert.ok(
        res.status !== 200 || !res.text.includes(TRAVERSAL_CANARY),
        `path traversal disclosed file contents: status=${res.status} body=${res.text.slice(0, 120)}`
      )

      // Control: a normal (non-existing) filename is still 404.
      const missing = yield* tryGet(`/api/files/posts/${created.id}/nope.txt`)
      assert.strictEqual(missing.status, 404)
    }).pipe(Effect.provide(fileLayer))
  )
})

describe("fuzz-defect: x-hidden field must not be a filter/sort oracle", () => {
  it.effect("filtering/sorting on hidden internalNote must be rejected (422)", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* serveRouter()

      const secretValue = "TOPSECRET-INTERNAL-NOTE"
      const createRes = yield* postJson("/api/collections/posts", {
        title: "public",
        internalNote: secretValue,
      })
      const created = yield* capture(createRes)
      yield* logCase("create post with hidden internalNote", created)
      assert.strictEqual(created.status, 201)
      assert.isFalse(created.text.includes("internalNote"))

      const list = yield* tryGet("/api/collections/posts")
      yield* logCase("plain list", list)
      assert.isFalse(list.text.includes(secretValue), "hidden value leaked in list")
      assert.isFalse(list.text.includes("internalNote"), "hidden field name leaked in list")

      const byFilter = yield* tryGet(
        `/api/collections/posts?filter=${encodeURIComponent(
          `{"op":"eq","field":"internalNote","value":"${secretValue}"}`
        )}`
      )
      yield* logCase("filter on hidden internalNote (must be 422)", byFilter)

      const bySort = yield* tryGet("/api/collections/posts?sort=internalNote")
      yield* logCase("sort by hidden internalNote (must be 422)", bySort)

      assert.strictEqual(
        byFilter.status,
        422,
        `hidden filter => ${byFilter.status} body=${byFilter.text.slice(0, 140)}`
      )
      assert.strictEqual(
        bySort.status,
        422,
        `hidden sort => ${bySort.status} body=${bySort.text.slice(0, 140)}`
      )
    }).pipe(Effect.provide(layer))
  )
})

describe("fuzz-secure: filter recursion bounded", () => {
  it.effect("deep nested not chain returns 200 at small depth, 431 past Node header limit", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* seedPost({ title: "x" })
      yield* serveRouter()

      for (const depth of [10, 100, 300]) {
        const url = `/api/collections/posts?filter=${encodeURIComponent(nestedNotFilter(depth))}`
        const e = yield* tryGet(url)
        yield* logCase(`nested-not depth=${depth} urlLen=${url.length}`, e)
        assert.strictEqual(e.status, 200)
      }
      for (const depth of [700, 1500]) {
        const url = `/api/collections/posts?filter=${encodeURIComponent(nestedNotFilter(depth))}`
        const e = yield* tryGet(url)
        yield* logCase(`nested-not depth=${depth} urlLen=${url.length}`, e)
        assert.strictEqual(e.status, 431)
      }

      // still healthy
      const ok = yield* tryGet("/api/collections/posts")
      assert.strictEqual(ok.status, 200)
    }).pipe(Effect.provide(layer))
  )
})

describe("fuzz-secure: pagination", () => {
  it.effect("hostile limit/after never 5xx; limit clamped to <=100", () =>
    Effect.gen(function* () {
      yield* setupTables
      for (let i = 0; i < 3; i++) yield* seedPost({ title: `p${i}` })
      yield* serveRouter()

      const cases: Array<[string, string]> = [
        ["limit=1e9", "/api/collections/posts?limit=1e9"],
        ["limit=-1", "/api/collections/posts?limit=-1"],
        ["limit=NaN", "/api/collections/posts?limit=NaN"],
        ["limit=Infinity", "/api/collections/posts?limit=Infinity"],
        ["limit=0", "/api/collections/posts?limit=0"],
        ["limit=1e21", "/api/collections/posts?limit=1e21"],
        ["after=-1", "/api/collections/posts?after=-1"],
        ["after=Infinity", "/api/collections/posts?after=Infinity"],
        ["after=abc", "/api/collections/posts?after=abc"],
        ["after=1e309", "/api/collections/posts?after=1e309"],
        ["after=99999999999999999999", "/api/collections/posts?after=99999999999999999999"],
        ["after=1.9&limit=2", "/api/collections/posts?after=1.9&limit=2"],
      ]
      for (const [label, url] of cases) {
        const e = yield* tryGet(url)
        yield* logCase(`paginate ${label}`, e)
        assert.strictEqual(e.status, 200)
        const parsed = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(Schema.Struct({ items: Schema.Array(Schema.Unknown) }))
        )(e.text).pipe(Effect.orDie)
        assert.ok(parsed.items.length <= 100, `limit not clamped for ${label}`)
      }
    }).pipe(Effect.provide(layer))
  )
})

describe("fuzz-secure: sort / select / expand", () => {
  it.effect("hostile sort/select/expand values are handled without 5xx", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* seedPost({ title: "x" })
      yield* serveRouter()

      const commasOnly = Array.from({ length: 5000 }, () => "").join(",")
      const cases: Array<[string, string]> = [
        ["select=,,,", "/api/collections/posts?select=,,,"],
        ["select=title,title,title", "/api/collections/posts?select=title,title,title"],
        ["select=internalNote(hidden)", "/api/collections/posts?select=internalNote"],
        ["select=commas only (5k)", `/api/collections/posts?select=${encodeURIComponent(commasOnly)}`],
        ["select=%00", "/api/collections/posts?select=%00"],
        ["select=unicode", `/api/collections/posts?select=${encodeURIComponent("标题,💥")}`],
        ["sort=title", "/api/collections/posts?sort=title"],
        ["sort=title&order=desc", "/api/collections/posts?sort=title&order=desc"],
        ["sort=unknown", "/api/collections/posts?sort=unknown"],
        ["sort=title,title", "/api/collections/posts?sort=title,title"],
        ["sort=%00", "/api/collections/posts?sort=%00"],
        ["expand=profile", "/api/collections/posts?expand=profile"],
        ["expand=unknown", "/api/collections/posts?expand=unknown"],
        ["expand=%00", "/api/collections/posts?expand=%00"],
      ]
      for (const [label, url] of cases) {
        const e = yield* tryGet(url)
        yield* logCase(`list ${label}`, e)
        assert.strictEqual(e.status, 200)
      }

      const hidden = yield* tryGet("/api/collections/posts?select=internalNote")
      assert.isFalse(hidden.text.includes("internalNote"))
    }).pipe(Effect.provide(layer))
  )
})

describe("fuzz-secure: path / param injection", () => {
  it.effect("traversal & null-byte segments return 404, never 5xx or foreign bytes", () =>
    Effect.gen(function* () {
      yield* setupTables
      const id = yield* seedPost({ title: "t", attachment: "abc.jpg" })
      yield* serveRouter()

      const cases: Array<[string, string]> = [
        ["file ..%2f traversal", `/api/files/posts/${id}/..%2f..%2fetc%2fpasswd`],
        ["file %00 byte", `/api/files/posts/${id}/abc.jpg%00.png`],
        ["file %00 only", `/api/files/posts/${id}/%00.jpg`],
        ["collection traversal", `/api/files/..%2f..%2fposts/${id}/abc.jpg`],
        ["filename dotdot", `/api/files/posts/${id}/..`],
        ["collection %2e%2e", "/api/collections/%2e%2e"],
        ["collection %2e%2e%2f", "/api/collections/%2e%2e%2f"],
        ["record id traversal", "/api/collections/posts/..%2f..%2fposts"],
        ["record id null byte", "/api/collections/posts/abc%00def"],
        ["record id sql", "/api/collections/posts/1'%20OR%20'1'='1"],
        ["record id unicode", `/api/collections/posts/${encodeURIComponent("💥'--")}`],
      ]
      for (const [label, url] of cases) {
        const e = yield* tryGet(url)
        yield* logCase(`path ${label}`, e)
        assert.ok(e.status === 404 || e.status === 400, `${label} => ${e.status}`)
        assert.ok(e.status < 500, `${label} produced 5xx`)
      }
    }).pipe(Effect.provide(layer))
  )
})

describe("fuzz-secure: malformed bodies", () => {
  it.effect("weird JSON shapes → 4xx with no internals leaked", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* seedUser("u@example.com", "pw123")
      yield* serveRouter()
      const token = yield* login("u@example.com", "pw123")

      const shapes = ["[]", '"x"', "123", "null", "{}", "{bad", ""]
      for (const s of shapes) {
        const unauth = yield* rawPost("/api/files/token", s)
        yield* logCase(`files/token unauth body=${JSON.stringify(s)}`, unauth)
        assert.ok(unauth.status < 500)
        assert.isFalse(leakedInternals(unauth.text))

        const create = yield* rawPost("/api/collections/posts", s)
        yield* logCase(`create posts body=${JSON.stringify(s)}`, create)
        assert.ok(create.status < 500, `create body=${s} => ${create.status}`)
        assert.isFalse(leakedInternals(create.text))
      }

      const authed = yield* tryExecute(
        HttpClientRequest.post("/api/files/token").pipe(
          HttpClientRequest.bodyText("[]"),
          HttpClientRequest.setHeader("Authorization", `Bearer ${token}`)
        )
      )
      yield* logCase("files/token authed body=[]", authed)
      assert.strictEqual(authed.status, 422)
    }).pipe(Effect.provide(layer))
  )
})

describe("fuzz-secure: header abuse", () => {
  it.effect("hostile Authorization headers → 401/403, no 5xx, no bypass", () =>
    Effect.gen(function* () {
      yield* setupTables
      const uid = yield* seedUser("u@example.com", "pw123")
      yield* serveRouter()

      const algNone = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url")}.${Buffer.from('{"sub":"x","col":"users"}').toString("base64url")}.`
      const wrongSecret = yield* Effect.promise(() => signHs256("not-the-secret", { sub: uid, col: "users" }))
      const numericCol = yield* Effect.promise(() => signHs256("security-audit-secret", { sub: uid, col: 123 }))
      const numericSub = yield* Effect.promise(() => signHs256("security-audit-secret", { sub: 123, col: "users" }))
      const nonAuthCol = yield* signJwt({ sub: uid, col: "posts" }, "security-audit-secret").pipe(Effect.orDie)

      const headers: Array<[string, string]> = [
        ["empty bearer", "Bearer"],
        ["bearer trailing space", "Bearer "],
        ["bearer many spaces", "Bearer      a.b.c"],
        ["alg none", `Bearer ${algNone}`],
        ["wrong secret", `Bearer ${wrongSecret}`],
        ["numeric col", `Bearer ${numericCol}`],
        ["numeric sub", `Bearer ${numericSub}`],
        ["non-auth col (posts)", `Bearer ${nonAuthCol}`],
        ["basic scheme", "Basic dXNlcjpwYXNz"],
        ["jwt-ish garbage", "Bearer a.b.c"],
      ]
      for (const [label, value] of headers) {
        const e = yield* tryExecute(
          HttpClientRequest.get("/api/auth/me").pipe(HttpClientRequest.setHeader("Authorization", value))
        )
        yield* logCase(`auth ${label}`, e)
        assert.ok(e.status === 401 || e.status === 403, `${label} => ${e.status}`)
        assert.isFalse(leakedInternals(e.text))
      }

      // sanity: a real token still works
      const ok = yield* tryGet("/api/auth/me", yield* login("u@example.com", "pw123"))
      assert.strictEqual(ok.status, 200)
    }).pipe(Effect.provide(layer))
  )
})

describe("fuzz-secure: error shape consistency", () => {
  it.effect("4xx bodies are documented shapes and leak no internals", () =>
    Effect.gen(function* () {
      yield* setupTables
      const id = yield* seedPost({ title: "t" })
      yield* serveRouter()

      const requests: Array<[string, HttpClientRequest.HttpClientRequest]> = [
        ["unknown collection", HttpClientRequest.get("/api/collections/nope")],
        ["missing record", HttpClientRequest.get("/api/collections/posts/does-not-exist")],
        ["unknown file", HttpClientRequest.get(`/api/files/posts/${id}/missing.jpg`)],
        ["schema no auth", HttpClientRequest.get("/api/_schema")],
        ["telemetry no auth", HttpClientRequest.get("/api/_telemetry/logs")],
        ["bad filter json", HttpClientRequest.get("/api/collections/posts?filter=%7Bbad")],
        ["unknown filter field", HttpClientRequest.get(`/api/collections/posts?filter=${encodeURIComponent('{"op":"eq","field":"nope","value":1}')}`)],
        ["filter wrong op", HttpClientRequest.get(`/api/collections/posts?filter=${encodeURIComponent('{"op":"nope"}')}`)],
      ]
      for (const [label, req] of requests) {
        const e = yield* tryExecute(req)
        yield* logCase(`error-shape ${label}`, e)
        assert.ok(e.status < 500, `${label} => ${e.status}`)
        assert.isFalse(leakedInternals(e.text), `${label} leaked internals: ${e.text.slice(0, 200)}`)
        const parsed = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(Schema.Struct({ error: Schema.String }))
        )(e.text)
        assert.ok(parsed.error.length > 0)
      }
    }).pipe(Effect.provide(layer))
  )
})

// ---------------------------------------------------------------------------

process.on("exit", () => {
  try {
    rmSync(fuzzBaseDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})
