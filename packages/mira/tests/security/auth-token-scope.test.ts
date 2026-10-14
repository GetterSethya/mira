/**
 * Security audit — FAILING REGRESSION TESTS for confirmed auth / token-scoping
 * findings in the Mira HTTP API.
 *
 * Each test below asserts the SECURE expectation, so the suite is RED while the
 * vulnerability is present and turns GREEN once it is fixed. Baseline / control
 * assertions (anonymous 401s and legitimate success paths) are kept and must
 * always pass.
 *
 * Confirmed findings covered (see the raw `[VULN EVIDENCE]` logs):
 *   H1. `GET /api/_schema` + `GET /api/_telemetry/*` are gated only by ANY valid
 *       JWT (no admin check) -> a normal `users` token reads them.
 *   H2. A 5-minute single-collection FILE token is accepted as a full session
 *       token by `verifyJwt`.
 *   H3. A file token can mint further file tokens.
 *   H4. Logout does not revoke the JWT.
 *   H5. A token for a deleted user record is still accepted by `requireApiAuth`.
 *
 * Expected secure outcomes (what these tests demand):
 *   H1. `GET /api/_schema` with a normal non-admin token -> 403 (not 200).
 *       `GET /api/_telemetry/logs|spans` with a normal non-admin token -> 403.
 *   H2. A file token -> 401/403 on `/api/auth/me` and `/api/_schema` (not 200).
 *   H3. `POST /api/files/token` with a file token as Bearer -> 401/403.
 *   H4. The token -> 401 on `/api/auth/me` AFTER `POST /api/auth/logout`.
 *   H5. A deleted user's token -> 401/403 on `/api/_schema`.
 */
import { describe, it, assert } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { decodeJwt } from "jose"

import {
  del,
  get,
  login,
  makeSecurityLayer,
  postJson,
  seedUser,
  serveRouter,
  setupTables,
} from "./_harness.js"

const layer = makeSecurityLayer()

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/** Decode (NOT verify) a JWT payload so we can show exactly what was signed. */
const payloadOf = (token: string) => decodeJwt(token)

const decodeTokenResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ token: Schema.String }))
)
const decodeMeResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ collection: Schema.String }))
)
const decodeCollectionList = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ name: Schema.String })))
)

/**
 * Assert the endpoint DENIED the request. The secure expectation is 401
 * (unauthenticated) or 403 (authenticated but not authorized); a 200 is the
 * vulnerability. This stays RED today and turns GREEN for any correct fix.
 */
function assertDenied(status: number, context: string) {
  assert.notStrictEqual(
    status,
    200,
    `${context}: expected the request to be DENIED (401/403) but got 200 — vulnerable`
  )
  assert.ok(
    status === 401 || status === 403,
    `${context}: expected 401 or 403 but got ${status}`
  )
}

// ===========================================================================
// H1 — privileged read endpoints must not be reachable with a normal JWT
// ===========================================================================

describe("H1 - privileged read endpoints reject a normal (non-admin) user token", () => {
  it.effect(
    "GET /api/_schema with a normal non-admin users token must be 403 (not 200); anonymous must be 401",
    () =>
      Effect.gen(function* () {
        yield* setupTables
        yield* seedUser("normal@example.com", "pw123")
        // App served with NO admin collection -> no token is "admin".
        yield* serveRouter()
        const token = yield* login("normal@example.com", "pw123")
        const decoded = payloadOf(token)
        console.log("[H1] normal user token payload =", JSON.stringify(decoded))

        // Control: anonymous is correctly rejected.
        const anon = yield* get("/api/_schema")
        const anonBody = yield* anon.text
        console.log("[H1] CONTROL  GET /api/_schema (anonymous) ->", anon.status, anonBody)
        assert.strictEqual(anon.status, 401)

        // Vulnerability: a non-admin token is accepted.
        const res = yield* get("/api/_schema", token)
        const body = yield* res.text
        const names = yield* decodeCollectionList(body).pipe(Effect.orElseSucceed(() => []))
        console.log(
          "[H1] VULN EVIDENCE  GET /api/_schema (normal user token) ->",
          res.status,
          JSON.stringify(names.map((c) => c.name))
        )
        assertDenied(res.status, "GET /api/_schema with a normal non-admin users token")
      }).pipe(Effect.provide(layer))
  )

  it.effect(
    "GET /api/_telemetry/logs and /spans with a normal users token must be 403 (not 200); anonymous must be 401",
    () =>
      Effect.gen(function* () {
        yield* setupTables
        yield* seedUser("normal2@example.com", "pw123")
        yield* serveRouter()
        const token = yield* login("normal2@example.com", "pw123")

        // Control: anonymous is rejected by the auth gate.
        const anonLogs = yield* get("/api/_telemetry/logs")
        const anonLogsText = yield* anonLogs.text
        console.log("[H1] CONTROL  GET /api/_telemetry/logs (anonymous) ->", anonLogs.status, anonLogsText)
        assert.strictEqual(anonLogs.status, 401)

        // Vulnerability: the auth gate passes the non-admin token, so the route
        // itself runs and returns its 200 body (telemetry SQLite is not
        // configured in this harness -> "not configured" payload).
        const logs = yield* get("/api/_telemetry/logs", token)
        const logsBody = yield* logs.text
        console.log("[H1] VULN EVIDENCE  GET /api/_telemetry/logs (normal user token) ->", logs.status, logsBody)

        const spans = yield* get("/api/_telemetry/spans", token)
        const spansBody = yield* spans.text
        console.log("[H1] VULN EVIDENCE  GET /api/_telemetry/spans (normal user token) ->", spans.status, spansBody)

        assertDenied(logs.status, "GET /api/_telemetry/logs with a normal non-admin users token")
        assertDenied(spans.status, "GET /api/_telemetry/spans with a normal non-admin users token")
      }).pipe(Effect.provide(layer))
  )
})

// ===========================================================================
// H2 — a file-scoped token must not authenticate the session
// ===========================================================================

describe("H2 - a file token must not be accepted as a session token", () => {
  it.effect(
    "a file token issued for 'posts' must be rejected by /api/auth/me and /api/_schema (401/403, not 200)",
    () =>
      Effect.gen(function* () {
        yield* setupTables
        yield* seedUser("filetoken@example.com", "pw123")
        yield* serveRouter()
        const session = yield* login("filetoken@example.com", "pw123")

        // Control: minting a file token with a real session token is legitimate
        // and must keep working.
        const tokenRes = yield* postJson("/api/files/token", { collection: "posts" }, session)
        const tokenText = yield* tokenRes.text
        console.log("[H2] CONTROL  POST /api/files/token (session) ->", tokenRes.status, tokenText)
        assert.strictEqual(tokenRes.status, 200, "control: file-token minting with a session token must succeed")
        const tokenBody = yield* decodeTokenResponse(tokenText).pipe(Effect.orDie)
        const fileToken = tokenBody.token
        console.log("[H2] decoded FILE token payload =", JSON.stringify(payloadOf(fileToken)))

        // Control: the real session token authenticates /api/auth/me.
        const meSession = yield* get("/api/auth/me", session)
        const meSessionBody = yield* meSession.text
        const sessionCollection = yield* decodeMeResponse(meSessionBody).pipe(Effect.orElseSucceed(() => ({ collection: "" })))
        console.log("[H2] CONTROL  GET /api/auth/me (session token) ->", meSession.status, meSessionBody)
        assert.strictEqual(meSession.status, 200)
        assert.strictEqual(sessionCollection.collection, "users")

        // Vulnerability: the file token is accepted as a full session token.
        const me = yield* get("/api/auth/me", fileToken)
        const meBody = yield* me.text
        const schema = yield* get("/api/_schema", fileToken)
        const schemaBody = yield* schema.text
        console.log("[H2] VULN EVIDENCE  GET /api/auth/me (FILE token) ->", me.status, meBody)
        console.log("[H2] VULN EVIDENCE  GET /api/_schema (FILE token) ->", schema.status, schemaBody)

        assertDenied(me.status, "GET /api/auth/me with a file-scoped token")
        assertDenied(schema.status, "GET /api/_schema with a file-scoped token")
      }).pipe(Effect.provide(layer))
  )
})

// ===========================================================================
// H3 — a file token must not be able to mint further tokens
// ===========================================================================

describe("H3 - a file token must not be accepted at POST /api/files/token", () => {
  it.effect("POST /api/files/token with a file token as Bearer must be 401/403 (not 200)", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* seedUser("chain@example.com", "pw123")
      yield* serveRouter()
      const session = yield* login("chain@example.com", "pw123")

      // Control: a session token mints the first (legitimate) file token.
      const first = yield* postJson("/api/files/token", { collection: "posts" }, session)
      const firstText = yield* first.text
      console.log("[H3] CONTROL  first POST /api/files/token (session) ->", first.status, firstText)
      assert.strictEqual(first.status, 200)
      const firstBody = yield* decodeTokenResponse(firstText).pipe(Effect.orDie)
      const fileToken = firstBody.token

      // Vulnerability: the file token mints another file token.
      const second = yield* postJson("/api/files/token", { collection: "users" }, fileToken)
      const secondText = yield* second.text
      console.log("[H3] VULN EVIDENCE  second POST /api/files/token (FILE token) ->", second.status, secondText)

      assertDenied(second.status, "POST /api/files/token with a file-scoped token as Bearer")
    }).pipe(Effect.provide(layer))
  )
})

// ===========================================================================
// H4 — logout must invalidate the token
// ===========================================================================

describe("H4 - logout must invalidate the JWT", () => {
  it.effect("the same token must be rejected (401) by /api/auth/me after POST /api/auth/logout", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* seedUser("logout@example.com", "pw123")
      yield* serveRouter()
      const token = yield* login("logout@example.com", "pw123")

      // Control: the token works before logout.
      const before = yield* get("/api/auth/me", token)
      const beforeBody = yield* before.text
      console.log("[H4] CONTROL  GET /api/auth/me before logout ->", before.status, beforeBody)
      assert.strictEqual(before.status, 200)

      // Control: logout returns 204 and clears the cookie.
      const logout = yield* postJson("/api/auth/logout", {}, token)
      const setCookie = logout.headers["set-cookie"]
      console.log("[H4] CONTROL  POST /api/auth/logout ->", logout.status, "set-cookie:", JSON.stringify(setCookie))
      assert.strictEqual(logout.status, 204)

      // Secure expectation: the token is revoked server-side.
      const after = yield* get("/api/auth/me", token)
      const afterBody = yield* after.text
      console.log(
        "[H4] VULN EVIDENCE  GET /api/auth/me after logout (same token) ->",
        after.status,
        afterBody
      )
      assert.strictEqual(
        after.status,
        401,
        "GET /api/auth/me after logout: expected 401 (token revoked) but got " + after.status + " — logout does not invalidate the JWT"
      )
    }).pipe(Effect.provide(layer))
  )
})

// ===========================================================================
// H5 — a token for a deleted user record must not be accepted
// ===========================================================================

describe("H5 - requireApiAuth must re-check the user record exists", () => {
  it.effect("a deleted user's token must be rejected (401/403) by /api/_schema (and /api/auth/me is 401)", () =>
    Effect.gen(function* () {
      yield* setupTables
      const userId = yield* seedUser("ghost@example.com", "pw123")
      yield* serveRouter()
      const token = yield* login("ghost@example.com", "pw123")

      // Control: delete the user via the self-only delete rule.
      const deleted = yield* del(`/api/collections/users/${userId}`, token)
      console.log("[H5] CONTROL  DELETE /api/collections/users/" + userId + " ->", deleted.status)
      assert.strictEqual(deleted.status, 204)

      // Secure expectation (already holds): resolveAuth re-checks the record.
      const me = yield* get("/api/auth/me", token)
      const meBody = yield* me.text
      console.log("[H5] CONTROL  GET /api/auth/me (deleted user token) ->", me.status, meBody)
      assert.strictEqual(me.status, 401)

      // Secure expectation (violated today): requireApiAuth must also reject it.
      const schema = yield* get("/api/_schema", token)
      const schemaBody = yield* schema.text
      console.log("[H5] VULN EVIDENCE  GET /api/_schema (deleted user token) ->", schema.status, schemaBody)
      console.log("[H5] asymmetry: /api/auth/me =", me.status, "vs /api/_schema =", schema.status)
      assertDenied(schema.status, "GET /api/_schema with a token whose user record was deleted")
    }).pipe(Effect.provide(layer))
  )
})
