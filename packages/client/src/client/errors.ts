import { Data } from "effect"

/**
 * Error thrown by `ClientHandler.raw()` when an HTTP request to the Mira server fails.
 *
 * Wraps the HTTP status code and response body. The `status` field corresponds to
 * the HTTP status code (e.g., 404, 403, 422, 0 for network errors). The `body`
 * field contains the server's JSON error response (typically `{ error, message, issues }`).
 *
 * `MiraError` is thrown **directly** from `.raw()` — it is NOT wrapped in `FiberFailure`.
 * In the Effect channel (`toEffect()`), it is available in the error channel and can
 * be caught via `Effect.catchTag("MiraError", ...)`.
 *
 * @example
 * import { createMiraClient, MiraError } from "@gettersethya/mira-client"
 *
 * const mira = createMiraClient("/")
 *
 * try {
 *   await mira.posts.getOne("nonexistent").raw()
 * } catch (e) {
 *   if (e instanceof MiraError) {
 *     console.error(`HTTP ${e.status}:`, e.body)
 *   }
 * }
 *
 * @example
 * // In Effect context via toEffect()
 * import { Effect } from "effect"
 *
 * mira.posts.getOne("nonexistent").toEffect().pipe(
 *   Effect.catchTag("MiraError", (e) =>
 *     Effect.logError(`HTTP ${e.status}: ${JSON.stringify(e.body)}`)
 *   )
 * )
 *
 * @see ClientHandler — the interface that throws MiraError from .raw()
 */
export class MiraError extends Data.TaggedError("MiraError")<{
  readonly status: number
  readonly body: unknown
}> {}
