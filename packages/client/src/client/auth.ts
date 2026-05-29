import type { HttpClient } from "@effect/platform"
import { HttpClientRequest as HCR } from "@effect/platform"
import { Effect, MutableRef } from "effect"
import type { MiraError } from "./errors.js"
import type { ClientHandler, ExecuteFn } from "./handler.js"

/**
 * Browser-side authentication helper. Uses a `loggedInRef` to track whether
 * the client has authenticated.
 *
 * In browser mode, the JWT token is handled via cookies — the client only
 * tracks `isLoggedIn()` state. `clear()` sends a POST to `/api/auth/logout`
 * and resets the ref.
 *
 * @example
 * import { createMiraClient } from "@gettersethya/mira-client"
 *
 * const mira = createMiraClient("/")  // browser mode by default
 * if (mira.auth.isLoggedIn()) {
 *   // user is authenticated
 * }
 * mira.auth.clear()  // sends POST /api/auth/logout
 *
 * @see ServerAuth — server-side alternative for SSR environments
 */
export type BrowserAuth = {
  isLoggedIn(): boolean
  clear(): void
}

/**
 * Server-side authentication helper. Stores the JWT token in a `MutableRef`
 * for manual management (e.g., during SSR hydration).
 *
 * The `token` getter/setter provides direct access to the raw JWT string.
 * `isValid()` checks the JWT `exp` claim against the current time without
 * making an HTTP request — it only validates expiry, not signature.
 *
 * @example
 * import { createMiraClient } from "@gettersethya/mira-client"
 *
 * const mira = createMiraClient("/", { type: "server" })
 * mira.auth.setToken("eyJ...")  // set token from SSR context
 * console.log(mira.auth.isValid())  // true if token is not expired
 * const currentToken = mira.auth.token  // "eyJ..."
 * mira.auth.clear()  // clears token and file token cache
 *
 * @see BrowserAuth — browser-side alternative
 */
export type ServerAuth = {
  token: string | null
  setToken(token: string): void
  clear(): void
  isValid(): boolean
}

/**
 * Factory function for `BrowserAuth`. Called internally by `createMiraClient` in browser mode.
 * @internal Use `createMiraClient()` instead of calling this directly
 */
export function makeBrowserAuth(
  execute: ExecuteFn,
  makeClientHandler: <T>(effect: Effect.Effect<T, MiraError, HttpClient.HttpClient>) => ClientHandler<T>,
  loggedInRef: MutableRef.MutableRef<boolean>
): BrowserAuth {
  return {
    isLoggedIn: () => MutableRef.get(loggedInRef),
    clear: () => {
      const effect = Effect.gen(function* () {
        yield* execute<void>(HCR.post("/api/auth/logout"))
        MutableRef.set(loggedInRef, false)
      })
      void makeClientHandler(effect).raw()
    },
  }
}

function decodeJwtExp(token: string): number | null {
  try {
    const parts = token.split(".")
    if (parts.length !== 3) return null
    const payload = JSON.parse(globalThis.atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")))
    if (typeof payload.exp === "number") return payload.exp
    return null
  } catch {
    return null
  }
}

/**
 * Factory function for `ServerAuth`. Called internally by `createMiraClient` in server mode.
 * @internal Use `createMiraClient("/", { type: "server" })` instead of calling this directly
 */
export function makeServerAuth(
  authTokenRef: MutableRef.MutableRef<string | null>,
  fileTokenCacheRef: MutableRef.MutableRef<Map<string, { token: string; expiresAt: number }>>
): ServerAuth {
  return {
    get token(): string | null {
      return MutableRef.get(authTokenRef)
    },
    setToken(token: string): void {
      MutableRef.set(authTokenRef, token)
    },
    clear: (): void => {
      MutableRef.set(authTokenRef, null)
      MutableRef.set(fileTokenCacheRef, new Map())
    },
    isValid: (): boolean => {
      const token = MutableRef.get(authTokenRef)
      if (token === null) return false
      const exp = decodeJwtExp(token)
      if (exp === null) return false
      return Date.now() < exp * 1000
    },
  }
}
