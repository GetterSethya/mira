import { Effect, MutableRef } from "effect"
import type { HttpClientRequest } from "effect/http"
import { describe, expect, it } from "vitest"

import { makeBrowserAuth, makeServerAuth } from "@/client/auth.js"
import { MiraError } from "@/client/errors.js"
import type { ExecuteFn } from "@/client/handler.js"
import { makeClientHandler } from "@/client/handler.js"

describe("BrowserAuth", () => {
  it("isLoggedIn() false initially", () => {
    const loggedInRef = MutableRef.make(false)
    const execute: ExecuteFn = <T>() => Effect.succeed(undefined as T)
    const auth = makeBrowserAuth(execute, makeClientHandler, loggedInRef)
    expect(auth.isLoggedIn()).toBe(false)
  })

  it("isLoggedIn() true after setting ref", () => {
    const loggedInRef = MutableRef.make(true)
    const execute: ExecuteFn = <T>() => Effect.succeed(undefined as T)
    const auth = makeBrowserAuth(execute, makeClientHandler, loggedInRef)
    expect(auth.isLoggedIn()).toBe(true)
  })

  it("refresh() checks /api/auth/me, sets the flag, and returns true", async () => {
    const loggedInRef = MutableRef.make(false)
    let calls = 0
    const execute: ExecuteFn = <T>() =>
      Effect.sync(() => {
        calls++
        return { collection: "users", record: {} } as T
      })
    const auth = makeBrowserAuth(execute, makeClientHandler, loggedInRef)

    expect(await auth.refresh()).toBe(true)
    expect(calls).toBe(1)
    expect(auth.isLoggedIn()).toBe(true)
  })

  it("refresh() returns false and clears the flag when the check fails", async () => {
    const loggedInRef = MutableRef.make(true)
    const execute: ExecuteFn = <T>() =>
      Effect.fail(new MiraError({ status: 401, body: "unauthorized" }))
    const auth = makeBrowserAuth(execute, makeClientHandler, loggedInRef)

    expect(await auth.refresh()).toBe(false)
    expect(auth.isLoggedIn()).toBe(false)
  })

  it("ensureSession() memoizes — concurrent calls share a single check", async () => {
    const loggedInRef = MutableRef.make(false)
    let calls = 0
    const execute: ExecuteFn = <T>() =>
      Effect.sync(() => {
        calls++
        return { collection: "users", record: {} } as T
      })
    const auth = makeBrowserAuth(execute, makeClientHandler, loggedInRef)

    const [first, second] = await Promise.all([auth.ensureSession(), auth.ensureSession()])
    expect(first).toBe(true)
    expect(second).toBe(true)
    expect(calls).toBe(1)
    expect(auth.isLoggedIn()).toBe(true)
  })

  it("ensureSession() reuses the resolved check on later calls", async () => {
    const loggedInRef = MutableRef.make(false)
    let calls = 0
    const execute: ExecuteFn = <T>() =>
      Effect.sync(() => {
        calls++
        return { collection: "users", record: {} } as T
      })
    const auth = makeBrowserAuth(execute, makeClientHandler, loggedInRef)

    await auth.ensureSession()
    await auth.ensureSession()
    expect(calls).toBe(1)
  })

  it("clear() pins the memo to false so ensureSession() short-circuits without a re-check", async () => {
    const loggedInRef = MutableRef.make(false)
    let meCalls = 0
    const execute: ExecuteFn = <T>(req: HttpClientRequest.HttpClientRequest) =>
      Effect.sync(() => {
        if (req.url.includes("/api/auth/me")) meCalls++
        return { collection: "users", record: {} } as T
      })
    const auth = makeBrowserAuth(execute, makeClientHandler, loggedInRef)

    await auth.ensureSession()
    expect(meCalls).toBe(1)
    auth.clear()
    // Post-logout the memo is pinned to `false` (the logout POST is async and
    // the cookie may still be valid), so no new `/api/auth/me` request is made.
    expect(await auth.ensureSession()).toBe(false)
    expect(meCalls).toBe(1)
  })
})

describe("ServerAuth", () => {
  it("token is null initially", () => {
    const authTokenRef = MutableRef.make<string | null>(null)
    const fileTokenCacheRef = MutableRef.make(new Map())
    const auth = makeServerAuth(authTokenRef, fileTokenCacheRef)
    expect(auth.token).toBeNull()
  })

  it("setToken stores the token, token reads it back", () => {
    const authTokenRef = MutableRef.make<string | null>(null)
    const fileTokenCacheRef = MutableRef.make(new Map())
    const auth = makeServerAuth(authTokenRef, fileTokenCacheRef)
    auth.setToken("my-jwt-token")
    expect(auth.token).toBe("my-jwt-token")
  })

  it("clear() sets token to null, clears file token cache", () => {
    const authTokenRef = MutableRef.make<string | null>(null)
    const fileTokenCacheRef = MutableRef.make(new Map([["users", { token: "t", expiresAt: 123 }]]))
    const auth = makeServerAuth(authTokenRef, fileTokenCacheRef)
    auth.setToken("my-jwt-token")
    auth.clear()
    expect(auth.token).toBeNull()
    expect(MutableRef.get(fileTokenCacheRef).size).toBe(0)
  })

  it("isValid() returns false for null token", () => {
    const authTokenRef = MutableRef.make<string | null>(null)
    const fileTokenCacheRef = MutableRef.make(new Map())
    const auth = makeServerAuth(authTokenRef, fileTokenCacheRef)
    expect(auth.isValid()).toBe(false)
  })

  it("isValid() returns true for valid JWT", () => {
    const futureExp = Math.floor(Date.now() / 1000) + 3600
    const payload = JSON.stringify({ exp: futureExp })
    const fakeJwt = `header.${Buffer.from(payload).toString("base64")}.sig`
    const authTokenRef = MutableRef.make<string | null>(fakeJwt)
    const fileTokenCacheRef = MutableRef.make(new Map())
    const auth = makeServerAuth(authTokenRef, fileTokenCacheRef)
    expect(auth.isValid()).toBe(true)
  })

  it("isValid() returns false for expired JWT", () => {
    const pastExp = Math.floor(Date.now() / 1000) - 3600
    const payload = JSON.stringify({ exp: pastExp })
    const fakeJwt = `header.${Buffer.from(payload).toString("base64")}.sig`
    const authTokenRef = MutableRef.make<string | null>(fakeJwt)
    const fileTokenCacheRef = MutableRef.make(new Map())
    const auth = makeServerAuth(authTokenRef, fileTokenCacheRef)
    expect(auth.isValid()).toBe(false)
  })
})
