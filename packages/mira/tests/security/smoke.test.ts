import { describe, it } from "@effect/vitest"
import { assert } from "@effect/vitest"
import { Effect } from "effect"

import { get, login, makeSecurityLayer, seedUser, serveRouter, setupTables } from "./_harness.js"

const layer = makeSecurityLayer()

/**
 * Harness health-check. If this passes, the shared harness used by the rest of
 * `tests/security/*.test.ts` is wired correctly.
 */
describe("security harness smoke", () => {
  it.effect("list posts + login + authenticated me", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* seedUser("smoke@example.com", "pw123")
      yield* serveRouter()
      const listRes = yield* get("/api/collections/posts")
      assert.strictEqual(listRes.status, 200)
      const token = yield* login("smoke@example.com", "pw123")
      const meRes = yield* get("/api/auth/me", token)
      assert.strictEqual(meRes.status, 200)
      const me = (yield* meRes.json) as Record<string, unknown>
      assert.strictEqual(me["collection"], "users")
    }).pipe(Effect.provide(layer))
  )
})
