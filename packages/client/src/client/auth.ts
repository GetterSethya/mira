import type { HttpClient } from "@effect/platform"
import { HttpClientRequest as HCR } from "@effect/platform"
import { Effect, MutableRef } from "effect"
import type { MiraError } from "./errors.js"
import type { ClientHandler, ExecuteFn } from "./handler.js"

/**
 * Browser-side authentication helper.
 *
 * The server sets an HttpOnly cookie (`mira_token`) on successful login. The
 * browser sends it automatically on every same-origin request — the client
 * never reads or writes it directly.
 *
 * Because the cookie is HttpOnly, the client cannot tell on page load whether
 * a session exists. Call `refresh()` once on app startup to re-validate the
 * cookie against the server and restore `isLoggedIn()` state.
 *
 * `clear()` calls `POST /api/auth/logout` to clear the cookie server-side,
 * then resets the in-memory login flag.
 *
 * @see ServerAuth — server-side alternative for SSR environments
 */
export type BrowserAuth = {
  /** True if the user logged in during this page session or `refresh()` confirmed a valid cookie. */
  isLoggedIn(): boolean
  /**
   * Calls `GET /api/auth/me` to check whether a valid `mira_token` cookie exists.
   * Sets the in-memory login flag to match the server's answer.
   * Call this once on app startup to restore login state after a page reload.
   *
   * @returns true if a valid session exists, false otherwise
   */
  refresh(): Promise<boolean>
  /** Calls `POST /api/auth/logout` to clear the server cookie, then resets the login flag. */
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

    refresh: async () => {
      try {
        const effect = execute<{ collection: string; record: Record<string, unknown> }>(
          HCR.get("/api/auth/me")
        )
        await makeClientHandler(effect).raw()
        MutableRef.set(loggedInRef, true)
        return true
      } catch {
        MutableRef.set(loggedInRef, false)
        return false
      }
    },

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
