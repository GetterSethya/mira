import type { AnyCollectionDef } from "@gettersethya/mira-collection"
import { Field } from "@gettersethya/mira-collection"
import { Effect, MutableRef } from "effect"
import type { HttpClientRequest } from "effect/http"
import { describe, expect, it } from "vitest"

import { makeBrowserAuth } from "@/client/auth.js"
import { makeCollectionClient } from "@/client/collection.js"
import { MiraError } from "@/client/errors.js"
import type { ExecuteFn } from "@/client/handler.js"
import { makeClientHandler } from "@/client/handler.js"

const UserCollection: AnyCollectionDef = {
  name: "users",
  fields: { name: Field.text() },
  schema: {
    "x-collection-kind": "auth",
    type: "object",
    properties: { name: { type: "string" } },
  },
}

// Regression: after a successful login the client must not reuse a session
// check that was memoized while logged out, otherwise a route guard bounces
// between `/login` and the protected route ("too many redirects") until a hard
// refresh resets module state.
describe("BrowserAuth session restore across login", () => {
  function makeHarness() {
    const loggedInRef = MutableRef.make(false)
    const sessionMemoRef = MutableRef.make<Promise<boolean> | null>(null)

    const execute: ExecuteFn = <T>(req: HttpClientRequest.HttpClientRequest) =>
      Effect.gen(function* () {
        if (req.url.includes("auth-with-password")) {
          return { token: "tok", record: { id: "u1", created: "", updated: "", name: "Budi" } } as T
        }
        if (req.url.includes("/api/auth/me")) {
          if (!MutableRef.get(loggedInRef)) {
            return yield* Effect.fail(new MiraError({ status: 401, body: "unauthorized" }))
          }
          return { collection: "users", record: { id: "u1" } } as T
        }
        return { items: [], nextCursor: null } as T
      })

    const auth = makeBrowserAuth(execute, makeClientHandler, loggedInRef, sessionMemoRef)

    const users = makeCollectionClient({
      collectionName: "users",
      schema: UserCollection.schema,
      fields: UserCollection.fields,
      execute,
      baseUrl: "http://localhost",
      authTokenRef: null,
      loggedInRef,
      sessionMemoRef,
      fileTokenCacheRef: MutableRef.make(new Map()),
      isAuth: true,
    })

    return { auth, users, sessionMemoRef, loggedInRef }
  }

  it("clears the memoized session after login so ensureSession() returns true", async () => {
    const { auth, users } = makeHarness()

    // Logged out: a guard caches a failed check.
    expect(await auth.ensureSession()).toBe(false)
    expect(auth.isLoggedIn()).toBe(false)

    const authWithPassword = users.authWithPassword
    if (!authWithPassword) throw new Error("expected authWithPassword on an auth collection")
    const result = await authWithPassword().raw({ email: "budi@email.com", password: "1234567890" })
    expect(result.token).toBe("tok")
    expect(auth.isLoggedIn()).toBe(true)

    // The stale `false` must be gone — otherwise this returns false and the
    // guarded route redirects back to /login.
    expect(await auth.ensureSession()).toBe(true)
  })

  it("logout clears the memo so ensureSession() reports logged out again", async () => {
    const { auth, users, loggedInRef } = makeHarness()

    const authWithPassword = users.authWithPassword
    if (!authWithPassword) throw new Error("expected authWithPassword on an auth collection")
    await authWithPassword().raw({ email: "budi@email.com", password: "1234567890" })
    expect(await auth.ensureSession()).toBe(true)

    auth.clear()
    // The logout POST is fire-and-forget; reflect the server-side cookie being
    // gone so the next check fails deterministically.
    await Promise.resolve()
    MutableRef.set(loggedInRef, false)
    expect(await auth.ensureSession()).toBe(false)
    expect(auth.isLoggedIn()).toBe(false)
  })
})
