import type { AnyCollectionDef } from "@gettersethya/mira-client"
import { Context, Data, Effect, Redacted } from "effect"
import * as jose from "jose"

import { idClause } from "@/collection-service/where.js"
import { AppConfig } from "@/config/index.js"
import { Repository } from "@/repository/repository.js"
import type { RepoRecord } from "@/repository/types.js"

import { TokenStore } from "./token-store.js"

export type JwtPayload = { sub: string; col: string }
export type FileTokenPayload = { sub: string; col: string; filecol: string }
export type VerifiedJwt = {
  sub: string
  col: string
  jti: string | null
  exp: number | null
  /** Credential binding: base64 HMAC-SHA-256 of the stored password hash. */
  pwf: string | null
  /** Per-user generation at mint time (invalidation epoch). */
  gen: number | null
}

/** Options for minting a session token bound to the user's current credential. */
export interface SessionTokenOptions {
  /** `pwf` — base64 HMAC-SHA-256 of the user's stored password hash. */
  pwf?: string
  /** Generation the token belongs to (see `TokenStore.currentGeneration`). */
  gen?: number
}

export class AuthError extends Data.TaggedError("AuthError")<{ reason: string }> {}

export class AuthService extends Context.Service<
  AuthService,
  {
    hashPassword(plain: string): Effect.Effect<string>
    verifyPassword(plain: string, stored: string): Effect.Effect<boolean>
  }
>()("AuthService") {}

export const hashPassword = (plain: string) => Effect.flatMap(AuthService, (auth) => auth.hashPassword(plain))

export const verifyPassword = (plain: string, stored: string) =>
  Effect.flatMap(AuthService, (auth) => auth.verifyPassword(plain, stored))

export function signJwt(payload: JwtPayload, secret: string, options?: SessionTokenOptions) {
  return Effect.tryPromise({
    try: async () => {
      const encoder = new TextEncoder()
      const claims: Record<string, unknown> = {
        sub: payload.sub,
        col: payload.col,
        typ: "session"
      }
      if (options?.pwf !== undefined) claims["pwf"] = options.pwf
      if (options?.gen !== undefined) claims["gen"] = options.gen
      return await new jose.SignJWT(claims)
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt()
        .setExpirationTime("72h")
        .setJti(crypto.randomUUID())
        .sign(encoder.encode(secret))
    },
    catch: (e) => new AuthError({ reason: String(e) })
  })
}

export function signFileToken(payload: FileTokenPayload, secret: string) {
  return Effect.tryPromise({
    try: async () => {
      const encoder = new TextEncoder()
      return await new jose.SignJWT({ sub: payload.sub, col: payload.col, filecol: payload.filecol, typ: "file" })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(encoder.encode(secret))
    },
    catch: (e) => new AuthError({ reason: String(e) })
  })
}

export function verifyFileToken(token: string, secret: string) {
  return Effect.tryPromise({
    try: async () => {
      const encoder = new TextEncoder()
      const { payload } = await jose.jwtVerify(token, encoder.encode(secret))
      if (payload["typ"] !== "file") {
        throw new Error("Not a file token")
      }
      const sub = payload.sub
      const col = payload["col"]
      const filecol = payload["filecol"]
      if (typeof sub !== "string" || typeof col !== "string" || typeof filecol !== "string") {
        throw new Error("Missing sub, col, or filecol in file token")
      }
      return { sub, col, filecol }
    },
    catch: (e) => new AuthError({ reason: String(e) })
  })
}

export function verifyJwt(token: string, secret: string) {
  return Effect.tryPromise({
    try: async () => {
      const encoder = new TextEncoder()
      const { payload } = await jose.jwtVerify(token, encoder.encode(secret))
      if (payload["typ"] !== "session") {
        throw new Error("Not a session token")
      }
      const sub = payload.sub
      const col = payload["col"]
      if (typeof sub !== "string" || typeof col !== "string") {
        throw new Error("Missing sub or col in JWT")
      }
      const jti = typeof payload["jti"] === "string" ? payload["jti"] : null
      const exp = typeof payload.exp === "number" ? payload.exp : null
      const pwf = typeof payload["pwf"] === "string" ? payload["pwf"] : null
      const gen = typeof payload["gen"] === "number" ? payload["gen"] : null
      return { sub, col, jti, exp, pwf, gen }
    },
    catch: (e) => new AuthError({ reason: String(e) })
  })
}

// ---------------------------------------------------------------------------
// Credential binding (`pwf`) — binds a session token to the stored password hash
// ---------------------------------------------------------------------------

/**
 * Compute the `pwf` claim: a base64 HMAC-SHA-256 of the user's **stored**
 * password hash, keyed by the JWT secret.
 *
 * A token carrying `pwf` is only accepted while the record's stored hash hashes
 * to the same value, so a password change invalidates previously minted tokens
 * (including the current session).
 *
 * Uses WebCrypto (`globalThis.crypto.subtle`) so there is no `node:crypto`
 * dependency — the auth module stays platform-agnostic.
 */
export function computePwf(storedHash: string, secret: string) {
  return Effect.tryPromise({
    try: () => hmacSha256Base64(secret, storedHash),
    catch: (e) => new AuthError({ reason: `pwf computation failed: ${String(e)}` })
  })
}

async function hmacSha256Base64(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const signature = await globalThis.crypto.subtle.sign("HMAC", key, encoder.encode(message))
  return bytesToBase64(new Uint8Array(signature))
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

/** Constant-time string compare (both inputs are fixed-length HMAC outputs). */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

// ---------------------------------------------------------------------------
// One shared, fail-closed session-authentication helper
// ---------------------------------------------------------------------------

/** A successfully authenticated session: the auth collection and its stored row. */
export interface SessionAuth {
  collection: string
  record: RepoRecord
}

/**
 * The single auth decision used by `resolveAuth`, `requireApiAuth` **and** the
 * file-token mint route. Fail-closed throughout:
 *
 * 1. extract token (already done by the caller)
 * 2. `verifyJwt` — must be a `typ: "session"` token
 * 3. deny if the `jti` is revoked
 * 4. load the auth record — it must still exist
 * 5. verify `pwf` matches the record's stored password hash (constant time)
 * 6. verify `gen` matches the user's current generation
 *
 * A `SqlError` from `TokenStore` **denies** — it never falls through as
 * authenticated. The same is true of any other unexpected failure in this path.
 */
export function authenticateSession(
  rawToken: string | null,
  isAuthCollection: (name: string) => boolean
): Effect.Effect<SessionAuth | undefined, never, AppConfig | Repository> {
  return Effect.gen(function* () {
    if (rawToken === null) return undefined

    const config = yield* AppConfig
    const jwtSecret = Redacted.value(config.jwtSecret)

    const payload = yield* verifyJwt(rawToken, jwtSecret).pipe(Effect.orElseSucceed(() => undefined))
    if (payload === undefined) return undefined

    const store = yield* TokenStore
    if (payload.jti !== null) {
      // `orElseSucceed(true)` = fail closed: a store error denies.
      const revoked = yield* store.isRevoked(payload.jti).pipe(Effect.orElseSucceed(() => true))
      if (revoked) return undefined
    }

    if (!isAuthCollection(payload.col)) return undefined

    const repo = yield* Repository
    const rows = yield* repo
      .viewFilter(payload.col, { where: idClause(payload.sub) })
      .pipe(Effect.orElseSucceed(() => []))
    if (rows.length === 0) return undefined
    const record = rows[0]

    // Credential binding: reject a token that lacks `pwf`, or whose `pwf` no
    // longer matches the record's stored hash (password changed since mint).
    const storedHash = record["password"]
    if (typeof storedHash !== "string") return undefined
    const expectedPwf = yield* computePwf(storedHash, jwtSecret).pipe(Effect.orElseSucceed(() => null))
    if (expectedPwf === null || payload.pwf === null) return undefined
    if (!constantTimeEqual(payload.pwf, expectedPwf)) return undefined

    // Generation check: rejects tokens minted before a "log out everywhere".
    const currentGen = yield* store
      .currentGeneration(payload.col, payload.sub)
      .pipe(Effect.orElseSucceed(() => null))
    if (currentGen === null) return undefined
    if ((payload.gen ?? 0) !== currentGen) return undefined

    return { collection: payload.col, record }
  })
}

/** Convenience predicate factory for a fixed collection set. */
export function isAuthCollectionName(
  collections: ReadonlyArray<AnyCollectionDef>
): (name: string) => boolean {
  const authNames = new Set(
    collections.filter((c) => c.schema["x-collection-kind"] === "auth").map((c) => c.name)
  )
  return (name) => authNames.has(name)
}
