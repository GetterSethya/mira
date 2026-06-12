import { HttpClient, HttpClientRequest as HCR } from "@effect/platform"
import type { HttpClientError } from "@effect/platform/HttpClientError"
import type { HttpBodyError } from "@effect/platform/HttpBody"
import { Effect, MutableRef } from "effect"
import type { AnyCollectionDef, FieldsMap } from "@gettersethya/mira-collection"
import type { BrowserAuth, ServerAuth } from "./auth.js"
import { makeBrowserAuth, makeServerAuth } from "./auth.js"
import type { CollectionClient, RetryOptions } from "./collection.js"
import { makeCollectionClient } from "./collection.js"
import { MiraError } from "./errors.js"
import type { ClientHandler, ExecuteFn } from "./handler.js"
import { makeClientHandler as makeHandler } from "./handler.js"
import type { AnyAuthCollectionDef, InferRecord } from "./types.js"
import type { TelemetryClient } from "./telemetry.js"
import { makeTelemetryClient } from "./telemetry.js"

type CollectionAdapter = <F extends FieldsMap>(client: CollectionClient<F>, name: string) => CollectionClient<F>

type BaseClient<A extends BrowserAuth | ServerAuth = BrowserAuth | ServerAuth> = {
  collection<C extends AnyCollectionDef>(def: C): CollectionClient<C["fields"]>
  auth: A
  telemetry: TelemetryClient
  withCollections<M extends Record<string, AnyCollectionDef>>(
    map: M,
    opts?: { adapter?: CollectionAdapter }
  ): BaseClient<A> & CollectionAccessors<M>
  /**
   * Fetches the currently authenticated user from `GET /api/auth/me`.
   *
   * Pass an auth collection definition to get a typed response:
   * @example
   * const result = await mira.me(MyAuthCollection).raw()
   * // result.record is typed as InferRecord<MyAuthCollection["fields"]>
   *
   * Or call with no args for an untyped response (backward compat):
   * @example
   * const result = await mira.me().raw()
   * // result.record is Record<string, unknown>
   */
  me<C extends AnyAuthCollectionDef>(def: C): ClientHandler<{ collection: string; record: InferRecord<C["fields"]> }>
  me(): ClientHandler<{ collection: string; record: Record<string, unknown> }>
}

type CollectionAccessors<M extends Record<string, AnyCollectionDef>> = {
  [K in keyof M]: CollectionClient<M[K]["fields"]> &
    (M[K]["schema"]["x-collection-kind"] extends "auth"
      ? {
          authWithPassword(): ClientHandler<
            { token: string; record: InferRecord<M[K]["fields"]> },
            { email: string; password: string }
          >
        }
      : {})
}

type BrowserMiraClient = BaseClient<BrowserAuth>

type ServerMiraClient = BaseClient<ServerAuth>

function catchAllErrors<T>(
  effect: Effect.Effect<T, MiraError | HttpClientError | HttpBodyError, HttpClient.HttpClient>
): Effect.Effect<T, MiraError, HttpClient.HttpClient> {
  return effect.pipe(
    Effect.catchTags({
      RequestError: (e) => Effect.fail(new MiraError({ status: 0, body: e.message })),
      ResponseError: (e) => Effect.fail(new MiraError({ status: e.response.status, body: e.message })),
      HttpBodyError: (e) => Effect.fail(new MiraError({ status: 500, body: String(e) }))
    })
  )
}

function createExecute(baseUrl: string, authTokenRef: MutableRef.MutableRef<string | null> | null): ExecuteFn {
  return <T>(req: HCR.HttpClientRequest) => {
    const raw = Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient
      const token = authTokenRef ? MutableRef.get(authTokenRef) : null

      const finalReq = HCR.prependUrl(baseUrl)(token ? HCR.setHeader(req, "Authorization", `Bearer ${token}`) : req)

      const res = yield* http.execute(finalReq)

      if (res.status >= 400) {
        const body = yield* res.json
        return yield* new MiraError({ status: res.status, body })
      }

      if (res.status === 204) {
        return undefined as T
      }

      return (yield* res.json) as T
    })
    return catchAllErrors(raw)
  }
}

function createMiraClientInternal(
  baseUrl = "/",
  type: "browser" | "server" = "browser",
  defaultRetryOptions?: RetryOptions
) {
  const fileTokenCacheRef = MutableRef.make(new Map<string, { token: string; expiresAt: number }>())

  const authTokenRef = type === "server" ? MutableRef.make<string | null>(null) : null

  const loggedInRef = type === "browser" ? MutableRef.make(false) : null

  const execute = createExecute(baseUrl, authTokenRef)

  const makeClientHandler = <T>(effect: Effect.Effect<T, MiraError, HttpClient.HttpClient>): ClientHandler<T> =>
    makeHandler(effect)

  function buildCollectionClient<C extends AnyCollectionDef>(def: C): CollectionClient<C["fields"]> {
    const isAuth = def.schema["x-collection-kind"] === "auth"
    return makeCollectionClient({
      collectionName: def.name,
      schema: def.schema,
      fields: def.fields,
      execute,
      baseUrl,
      authTokenRef,
      loggedInRef,
      fileTokenCacheRef,
      isAuth,
      ...(defaultRetryOptions !== undefined ? { defaultRetryOptions } : {})
    })
  }

  function makeAuth(): BrowserAuth | ServerAuth {
    if (type === "server" && authTokenRef !== null) {
      return makeServerAuth(authTokenRef, fileTokenCacheRef)
    }
    if (loggedInRef !== null) {
      return makeBrowserAuth(execute, makeClientHandler, loggedInRef)
    }
    return makeBrowserAuth(execute, makeClientHandler, MutableRef.make(false))
  }

  function withCollections<M extends Record<string, AnyCollectionDef>>(map: M, opts?: { adapter?: CollectionAdapter }) {
    const baseClient = buildBaseClient()
    const collections = {} as CollectionAccessors<M>
    for (const key of Object.keys(map) as Array<keyof M>) {
      const raw = buildCollectionClient(map[key])
      collections[key] = (opts?.adapter ? opts.adapter(raw, String(key)) : raw) as CollectionAccessors<M>[keyof M]
    }
    return Object.assign(baseClient, collections)
  }

  function buildBaseClient(): BaseClient {
    return {
      collection: <C extends AnyCollectionDef>(def: C) => buildCollectionClient(def),
      auth: makeAuth(),
      telemetry: makeTelemetryClient(execute),
      withCollections,
      me: (<C extends AnyAuthCollectionDef>(def?: C) => {
        return makeClientHandler(
          execute<{
            collection: string
            record: C extends AnyAuthCollectionDef ? InferRecord<C["fields"]> : Record<string, unknown>
          }>(HCR.get("/api/auth/me"))
        )
      }) as BaseClient["me"]
    }
  }

  return buildBaseClient()
}

/**
 * Create a Mira client instance for the browser (default mode).
 * Uses cookies for auth — the client tracks login state via `auth.isLoggedIn()`.
 *
 * @param baseUrl - Base URL of the Mira server (default: "/" for same-origin)
 * @param opts.defaultRetryOptions - Optional default retry schedule for all operations
 * @returns A BrowserMiraClient with `auth: BrowserAuth`
 *
 * @example
 * import { createMiraClient } from "@gettersethya/mira-client"
 *
 * const mira = createMiraClient("http://localhost:3000")
 * const posts = await mira.posts.getList().raw()
 *
 * @example
 * // With retry options
 * import { Schedule } from "effect"
 * const mira = createMiraClient("/", {
 *   defaultRetryOptions: { schedule: Schedule.exponential(100) }
 * })
 */
export function createMiraClient(
  baseUrl?: string,
  opts?: { type?: "browser"; defaultRetryOptions?: RetryOptions }
): BrowserMiraClient

/**
 * Create a Mira client instance for server-side rendering (SSR).
 * Uses `type: "server"` to enable manual JWT token management via `auth: ServerAuth`.
 *
 * In server mode, the client does NOT track login state — you must call
 * `mira.auth.setToken(token)` explicitly with the JWT from your SSR context.
 *
 * @param baseUrl - Base URL of the Mira server
 * @param opts.type - Must be "server"
 * @param opts.defaultRetryOptions - Optional default retry schedule
 * @returns A ServerMiraClient with `auth: ServerAuth`
 *
 * @example
 * import { createMiraClient } from "@gettersethya/mira-client"
 *
 * const mira = createMiraClient("http://localhost:3000", { type: "server" })
 * mira.auth.setToken("eyJ...")  // set token from SSR context
 * const posts = await mira.posts.getList().raw()
 */
export function createMiraClient(
  baseUrl: string | undefined,
  opts: { type: "server"; defaultRetryOptions?: RetryOptions }
): ServerMiraClient

/**
 * Create a Mira client instance.
 *
 * In browser mode (default), auth is cookie-based and `isLoggedIn()` reflects
 * client-side login state. In server mode, you manage the JWT token explicitly
 * via `auth.setToken()`.
 *
 * Use `withCollections()` to create typed accessors for each collection:
 *
 * @example
 * const mira = createMiraClient("/").withCollections({ posts, users })
 * const posts = await mira.posts.getList().raw()
 * const loginResult = await mira.users.authWithPassword().raw({
 *   email: "admin@test.com",
 *   password: "admin1234"
 * })
 *
 * @see BrowserAuth — client-side auth
 * @see ServerAuth — server-side auth
 * @see CollectionClient — the per-collection client interface
 */
export function createMiraClient(
  baseUrl = "/",
  opts: { type?: "browser" | "server"; defaultRetryOptions?: RetryOptions } = {}
) {
  const { type = "browser", defaultRetryOptions } = opts
  return createMiraClientInternal(baseUrl, type, defaultRetryOptions) as BrowserMiraClient | ServerMiraClient
}
