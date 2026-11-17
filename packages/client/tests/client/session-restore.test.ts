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

// Mocks answer every request with one fixture, so narrow that fixture to the
// response type the production code requests instead of asserting it.
function respondWith<T>(value: unknown): T {
  if (isResponseOfType<T>(value)) return value
  throw new Error("mock response fixture cannot be narrowed to the requested type")
}

function isResponseOfType<T>(_value: unknown): _value is T {
  return true
}

const UserCollection: AnyCollectionDef = {
  name: "users",
  fields: { name: Field.text() },
  schema: {
    "x-collection-kind": "auth",
    type: "object",
    properties: { name: { type: "string" } },
  },
}

// Regression coverage for the login/logout redirect loops:
// - after login, a session check memoized *while logged out* must not be reused;
// - after logout, a session check must not re-authenticate from a cookie that is
//   still valid because the logout request is fire-and-forget.
describe("BrowserAuth session lifecycle", () => {
  function makeHarness() {
    const loggedInRef = MutableRef.make(false)
    const sessionMemoRef = MutableRef.make<Promise<boolean> | null>(null)
    // Models the server-side cookie: stays valid until the logout POST lands.
    const cookieValid = MutableRef.make(false)

    const execute: ExecuteFn = <T>(req: HttpClientRequest.HttpClientRequest) =>
      Effect.gen(function* () {
        if (req.url.includes("auth-with-password")) {
          MutableRef.set(cookieValid, true)
          return respondWith<T>({
            token: "tok",
            record: { id: "u1", created: "", updated: "", name: "Budi" },
          })
        }
        if (req.url.includes("/api/auth/logout")) {
          yield* Effect.sleep("20 millis")
          MutableRef.set(cookieValid, false)
          return respondWith<T>(undefined)
        }
        if (req.url.includes("/api/auth/me")) {
          if (!MutableRef.get(cookieValid)) {
            return yield* Effect.fail(new MiraError({ status: 401, body: "unauthorized" }))
          }
          return respondWith<T>({ collection: "users", record: { id: "u1" } })
        }
        return respondWith<T>({ items: [], nextCursor: null })
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

    return { auth, users, cookieValid }
  }

  it("clears the memoized session after login so ensureSession() returns true", async () => {
    const { auth, users } = makeHarness()

    // Logged out: a guard caches a failed check.
    expect(await auth.ensureSession()).toBe(false)

    const authWithPassword = users.authWithPassword
    if (!authWithPassword) throw new Error("expected authWithPassword on an auth collection")
    await authWithPassword().raw({ email: "budi@email.com", password: "1234567890" })
    expect(auth.isLoggedIn()).toBe(true)

    // Must be true — the stale `false` must be gone.
    expect(await auth.ensureSession()).toBe(true)
  })

  it("clear() flips isLoggedIn() to false synchronously", async () => {
    const { auth, users } = makeHarness()

    const authWithPassword = users.authWithPassword
    if (!authWithPassword) throw new Error("expected authWithPassword on an auth collection")
    await authWithPassword().raw({ email: "budi@email.com", password: "1234567890" })
    expect(auth.isLoggedIn()).toBe(true)

    auth.clear()
    expect(auth.isLoggedIn()).toBe(false)
  })

  it("ensureSession() is false right after logout even though the cookie is still valid", async () => {
    const { auth, users, cookieValid } = makeHarness()

    const authWithPassword = users.authWithPassword
    if (!authWithPassword) throw new Error("expected authWithPassword on an auth collection")
    await authWithPassword().raw({ email: "budi@email.com", password: "1234567890" })
    expect(await auth.ensureSession()).toBe(true)

    auth.clear()
    // The logout POST has not landed yet — the cookie is still valid server-side.
    expect(MutableRef.get(cookieValid)).toBe(true)
    // A guard running during the transition must NOT re-authenticate.
    expect(await auth.ensureSession()).toBe(false)
  })
})
