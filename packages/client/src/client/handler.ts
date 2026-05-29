import type { HttpClient, HttpClientRequest } from "@effect/platform"
import { FetchHttpClient } from "@effect/platform"
import { Cause, Effect, Exit, Option } from "effect"
import type { MiraError } from "./errors.js"

/**
 * A dual-interface handler for dealing with Mira server responses.
 *
 * When `TInput extends void` (query operations: getList, getOne, getFirstOrNone, getFullList):
 * - `.raw()` — returns `Promise<TData>`, throws `MiraError` on failure
 * - `.toEffect()` — returns `Effect.Effect<TData, MiraError, HttpClient.HttpClient>`
 *
 * When `TInput` is provided (mutation operations: create, update, delete):
 * - `.raw(input: TInput)` — returns `Promise<TData>`, throws `MiraError` on failure
 * - `.toEffect(input: TInput)` — returns `Effect.Effect<TData, MiraError, HttpClient.HttpClient>`
 *
 * @example
 * import type { ClientHandler } from "@gettersethya/mira-client"
 *
 * // Query handler: TInput = void
 * const listHandler: ClientHandler<{ items: Post[]; nextCursor: number | null }>
 * const items = await listHandler.raw()  // Promise-based
 * const effect = listHandler.toEffect()  // Effect-based
 *
 * // Mutation handler: TInput = { title: string }
 * const createHandler: ClientHandler<Post, { title: string }>
 * const post = await createHandler.raw({ title: "hello" })
 * const createEffect = createHandler.toEffect({ title: "hello" })
 *
 * @see makeClientHandler — constructs a ClientHandler from an Effect
 * @see makeMutationHandler — constructs a ClientHandler for mutations
 * @see MiraError — the error thrown by .raw()
 */
export type ClientHandler<TData, TInput = void> = TInput extends void
  ? {
      raw(): Promise<TData>
      toEffect(): Effect.Effect<TData, MiraError, HttpClient.HttpClient>
    }
  : {
      raw(input: TInput): Promise<TData>
      toEffect(input: TInput): Effect.Effect<TData, MiraError, HttpClient.HttpClient>
    }

/**
 * Construct a `ClientHandler<T>` (query variant, TInput = void) from an Effect.
 *
 * The Effect is provided `FetchHttpClient.layer` at runtime when `.raw()` is called.
 * The `.toEffect()` method returns the Effect without providing the layer, allowing
 * the caller to supply their own `HttpClient` implementation (e.g., for testing).
 *
 * @param effect - The Effect to wrap. Must produce `T` on success or `MiraError` on failure
 * @returns A ClientHandler with zero-arg .raw() and .toEffect()
 *
 * @example
 * import { Effect } from "effect"
 * import { makeClientHandler } from "@gettersethya/mira-client"
 *
 * const handler = makeClientHandler<{ name: string }>(
 *   Effect.succeed({ name: "test" })
 * )
 * const result = await handler.raw()  // { name: "test" }
 */
export function makeClientHandler<T>(
  effect: Effect.Effect<T, MiraError, HttpClient.HttpClient>
): ClientHandler<T> {
  return {
    raw: () =>
      Effect.runPromiseExit(effect.pipe(Effect.provide(FetchHttpClient.layer))).then((exit) => {
        if (Exit.isSuccess(exit)) return exit.value
        return Promise.reject(
          Option.getOrElse(Cause.failureOption(exit.cause), () => Cause.squash(exit.cause))
        )
      }),
    toEffect: () => effect,
  }
}

/**
 * Construct a `ClientHandler<TData, TInput>` (mutation variant) from a function
 * that accepts input and returns an Effect.
 *
 * The input is provided at call time (`.raw(input)` or `.toEffect(input)`).
 * The Effect is provided `FetchHttpClient.layer` at runtime when `.raw()` is called.
 *
 * @param fn - A function that takes `TInput` and returns an Effect producing `TData`
 * @returns A ClientHandler with input-arg .raw() and .toEffect()
 *
 * @example
 * import { Effect } from "effect"
 * import { makeMutationHandler } from "@gettersethya/mira-client"
 *
 * const handler = makeMutationHandler<{ id: string }, { name: string }>(
 *   (input) => Effect.succeed({ id: "1", ...input })
 * )
 * const result = await handler.raw({ name: "test" })  // { id: "1", name: "test" }
 */
export function makeMutationHandler<TData, TInput>(
  fn: (input: TInput) => Effect.Effect<TData, MiraError, HttpClient.HttpClient>
): ClientHandler<TData, TInput> {
  const handler = {
    raw: (input: TInput) =>
      Effect.runPromiseExit(fn(input).pipe(Effect.provide(FetchHttpClient.layer))).then((exit) => {
        if (Exit.isSuccess(exit)) return exit.value
        return Promise.reject(
          Option.getOrElse(Cause.failureOption(exit.cause), () => Cause.squash(exit.cause))
        )
      }),
    toEffect: (input: TInput) => fn(input),
  }
  return handler as ClientHandler<TData, TInput>
}

/**
 * The core HTTP execution function used internally by all client handlers.
 * Takes an `HttpClientRequest`, sends it to the server, and returns the
 * deserialized response body.
 *
 * Handles authentication token injection, base URL prefixing, and error mapping
 * (HTTP 4xx/5xx responses become `MiraError` in the Effect error channel).
 *
 * @typeParam T - The expected response body type
 * @param req - The HTTP request to execute (constructed via `HttpClientRequest.*`)
 * @returns Effect that resolves to the parsed response body, or fails with MiraError
 */
export type ExecuteFn = <T>(
  req: HttpClientRequest.HttpClientRequest
) => Effect.Effect<T, MiraError, HttpClient.HttpClient>
