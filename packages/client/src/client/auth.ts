import { Effect, MutableRef } from "effect"
import type { HttpClient } from "effect/http"
import { HttpClientRequest as HCR } from "effect/http"

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
 * a session exists. Use `ensureSession()` (or `refresh()`) to re-validate the
 * cookie against the server and restore `isLoggedIn()` state.
 *
 * `clear()` calls `POST /api/auth/logout` to clear the cookie server-side,
 * then resets the in-memory login flag.
 *
 * @see ServerAuth — server-side alternative for SSR environments
 */
export type BrowserAuth = {
  /** True if the user logged in during this page session or a session check confirmed a valid cookie. */
  isLoggedIn(): boolean
  /**
   * Calls `GET /api/auth/me` to check whether a valid `mira_token` cookie exists.
   * Sets the in-memory login flag to match the server's answer.
   * Call this once on app startup to restore login state after a page reload.
   *
   * Always performs a fresh request (does not dedupe). Prefer `ensureSession()`
   * in route guards so multiple guards share a single request per page load.
   *
   * @returns true if a valid session exists, false otherwise
   */
  refresh(): Promise<boolean>
  /**
   * Like `refresh()`, but memoized per page load: the first call issues a
   * single `GET /api/auth/me` and every subsequent call returns the same
   * in-flight/recently-resolved promise. Safe to call from many async route
   * guards without triggering duplicate requests.
   *
   * @example
   * // TanStack Router guard
   * beforeLoad: async () => {
   *   if (!(await client.auth.ensureSession())) throw redirect({ to: "/login" })
   * }
   *
   * @returns true if a valid session exists, false otherwise
   */
  ensureSession(): Promise<boolean>
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
  loggedInRef: MutableRef.MutableRef<boolean>,
  /**
   * Shared per-page-load memo for the session check. Shared with the collection
   * clients so a successful login / logout can invalidate a stale result (e.g. a
   * `false` memoized before login) — otherwise a post-login navigation would
   * re-read the stale `false` and bounce between `/login` and the protected route.
   */
  sessionMemoRef: MutableRef.MutableRef<Promise<boolean> | null> = MutableRef.make(null)
): BrowserAuth {
  const checkSession = async (): Promise<boolean> => {
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
  }

  return {
    isLoggedIn: () => MutableRef.get(loggedInRef),

    refresh: () => {
      const promise = checkSession()
      MutableRef.set(sessionMemoRef, promise)
      return promise
    },

    ensureSession: () => {
      const memo = MutableRef.get(sessionMemoRef)
      if (memo !== null) return memo
      const promise = checkSession()
      MutableRef.set(sessionMemoRef, promise)
      return promise
    },

    clear: () => {
      // Flip the flag synchronously so a route guard that runs immediately after
      // `clear()` (e.g. `navigate({ to: "/login" })`) does not still see the user
      // as logged in and bounce back to the protected route.
      MutableRef.set(loggedInRef, false)
      // Pin the session memo to a resolved `false` rather than `null`. The logout
      // POST is fire-and-forget, so the cookie may still be valid for a moment;
      // if a guard re-ran `ensureSession()` in that window it would get a `200`
      // and re-authenticate, bouncing the user back to the protected route.
      // A pinned `false` short-circuits every check until the next login, which
      // resets the memo (see `authWithPassword`).
      MutableRef.set(sessionMemoRef, Promise.resolve(false))
      const effect = execute<void>(HCR.post("/api/auth/logout"))
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
