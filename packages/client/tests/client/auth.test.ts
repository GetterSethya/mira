import { describe, expect, it } from "vitest"

import { Effect, MutableRef } from "effect"
import { HttpClientRequest } from "@effect/platform"
import { makeBrowserAuth, makeServerAuth } from "@/client/auth.js"
import { makeClientHandler } from "@/client/handler.js"
import type { ExecuteFn } from "@/client/handler.js"

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
