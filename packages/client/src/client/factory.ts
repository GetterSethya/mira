import type { AnyCollectionDef, FieldsMap } from "@gettersethya/mira-collection"
import { Effect, MutableRef } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest as HCR } from "effect/http"
import type { HttpBodyError } from "effect/http/HttpBody"
import type { HttpClientError } from "effect/http/HttpClientError"

import type { BrowserAuth, ServerAuth } from "./auth.js"
import { makeBrowserAuth, makeServerAuth } from "./auth.js"
import type { AdaptedCollectionClient, AuthByKind, CollectionClient, RawCollectionClient, RetryOptions } from "./collection.js"
import { makeCollectionClient } from "./collection.js"
import { MiraError } from "./errors.js"
import type { ClientHandler, ExecuteFn } from "./handler.js"
import { makeClientHandler as makeHandler } from "./handler.js"
import type { TelemetryClient } from "./telemetry.js"
import { makeTelemetryClient } from "./telemetry.js"
import type { AnyAuthCollectionDef, CollectionKind, InferRecord } from "./types.js"

/**
 * Wraps a {@link CollectionClient} to add framework query/mutation metadata.
 * The adapter package (`@gettersethya/mira-tanstack-adapter`) provides the
 * concrete implementation; the client only needs the shape to type the return.
 */
type CollectionAdapter = <F extends FieldsMap, K extends CollectionKind>(
  client: CollectionClient<F, K>,
  name: string,
  kind: K
) => AdaptedCollectionClient<F, K>

type AdaptedAccessors<M extends Record<string, AnyCollectionDef>> = {
  [K in keyof M]: AdaptedCollectionClient<M[K]["fields"], M[K]["schema"]["x-collection-kind"]>
}

/**
 * The accessor type for a single collection definition — the raw client plus the
 * auth methods required for the collection's kind (`AuthByKind`).
 */
type AccessorFor<C extends AnyCollectionDef> = RawCollectionClient<
  C["fields"],
  C["schema"]["x-collection-kind"]
> &
  AuthByKind<C["fields"]>[C["schema"]["x-collection-kind"]]

type BaseClient<A extends BrowserAuth | ServerAuth = BrowserAuth | ServerAuth> = {
  collection<C extends AnyCollectionDef>(def: C): AccessorFor<C>
  auth: A
  telemetry: TelemetryClient
  /**
   * Create typed accessors for each collection.
   *
   * Pass `{ adapter }` to wrap every accessor with framework query/mutation
   * metadata (`.queryOptions` / `.mutationOptions` / `.invalidateAll`):
   *
   * @example
   * const mira = createMiraClient("/").withCollections(
   *   { posts, users },
   *   { adapter: collectionAdapter },
   * )
   * const { data } = useQuery(mira.posts.getList().queryOptions)
   */
  withCollections<M extends Record<string, AnyCollectionDef>>(
    map: M,
    opts: { adapter: CollectionAdapter }
  ): BaseClient<A> & AdaptedAccessors<M>
  withCollections<M extends Record<string, AnyCollectionDef>>(
    map: M,
    opts?: { adapter?: undefined }
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
  [K in keyof M]: AccessorFor<M[K]>
}

type BrowserMiraClient = BaseClient<BrowserAuth>

type ServerMiraClient = BaseClient<ServerAuth>

function catchAllErrors<T>(
  effect: Effect.Effect<T, MiraError | HttpClientError | HttpBodyError, HttpClient.HttpClient>
): Effect.Effect<T, MiraError, HttpClient.HttpClient> {
  return effect.pipe(
    Effect.catchTags({
      HttpClientError: (e) =>
        Effect.fail(new MiraError({ status: e.response?.status ?? 0, body: e.message })),
      HttpBodyError: (e) => Effect.fail(new MiraError({ status: 500, body: String(e) }))
    })
  )
}

function createExecute(
  baseUrl: string,
  authTokenRef: MutableRef.MutableRef<string | null> | null,
  sendCredentials: boolean
): ExecuteFn {
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
    const effect = catchAllErrors(raw)
    return sendCredentials
      ? Effect.provideService(effect, FetchHttpClient.RequestInit, { credentials: "include" })
      : effect
  }
}

/**
 * Maps the values of `obj`, preserving every key, into a target mapped type `R`
 * whose keys mirror `T`'s. The callback is generic over the key, so each value
 * is checked against `R[K]`.
 *
 * The public call signature is fully checked at every call site. The
 * implementation's mapping of runtime keys onto the mapped type cannot be
 * expressed in the type system, so it is stated in the overload signature
 * rather than with a type assertion in the body.
 */
type MapValuesFn<T, R extends { [K in keyof T]: unknown }> =
  <K extends keyof T & string>(value: T[K], key: K) => R[K]

function mapValues<T extends object, R extends { [K in keyof T]: unknown }>(
  obj: T,
  fn: MapValuesFn<T, R>
): R
function mapValues(obj: Record<string, unknown>, fn: (value: unknown, key: string) => unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(obj)) {
    out[key] = fn(obj[key], key)
  }
  return out
}

function createMiraClientInternal(
  baseUrl = "/",
  type: "browser" | "server" = "browser",
  defaultRetryOptions?: RetryOptions
) {
  const fileTokenCacheRef = MutableRef.make(new Map<string, { token: string; expiresAt: number }>())

  const authTokenRef = type === "server" ? MutableRef.make<string | null>(null) : null

  const loggedInRef = type === "browser" ? MutableRef.make(false) : null

  // Browser mode relies on the HttpOnly `mira_token` cookie, which the browser
  // only stores/sends on cross-origin requests when `credentials: "include"`.
  // Server/SSR mode authenticates via a Bearer token and never needs cookies.
  const execute = createExecute(baseUrl, authTokenRef, type === "browser")

  const makeClientHandler = <T>(effect: Effect.Effect<T, MiraError, HttpClient.HttpClient>): ClientHandler<T> =>
    makeHandler(effect)

  function makeRawCollectionClient<C extends AnyCollectionDef>(
    def: C
  ): RawCollectionClient<C["fields"], C["schema"]["x-collection-kind"]> {
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
      kind: def.schema["x-collection-kind"],
      ...(defaultRetryOptions !== undefined ? { defaultRetryOptions } : {})
    })
  }

  // `makeCollectionClient` returns the raw shape (auth methods optional for any
  // kind), but they are present for auth collections. `buildAccessor` narrows the
  // result per kind via `AccessorFor`, using the correlated per-kind builder map
  // so a generic `K` stays linked to its own auth tail — no assertions needed.
  function buildAccessor<C extends AnyCollectionDef>(def: C): AccessorFor<C>
  function buildAccessor(def: AnyCollectionDef) {
    return makeRawCollectionClient(def)
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

  function withCollections<M extends Record<string, AnyCollectionDef>>(
    map: M,
    opts: { adapter: CollectionAdapter }
  ): BaseClient & AdaptedAccessors<M>
  function withCollections<M extends Record<string, AnyCollectionDef>>(
    map: M,
    opts?: { adapter?: undefined }
  ): BaseClient & CollectionAccessors<M>
  function withCollections<M extends Record<string, AnyCollectionDef>>(
    map: M,
    opts?: { adapter?: CollectionAdapter | undefined }
  ) {
    const baseClient = buildBaseClient()
    const adapter = opts?.adapter
    // Query keys use the collection's `name` (e.g. "todos") so they match the
    // server route and `invalidateAll` stays consistent.
    if (adapter) {
      const adapted = mapValues<M, AdaptedAccessors<M>>(
        map,
        <P extends keyof M & string>(def: M[P]) =>
          adapter<M[P]["fields"], M[P]["schema"]["x-collection-kind"]>(
            buildAccessor(def),
            def.name,
            def.schema["x-collection-kind"]
          )
      )
      return Object.assign(baseClient, adapted)
    }
    const plain = mapValues<M, CollectionAccessors<M>>(map, (def) => buildAccessor(def))
    return Object.assign(baseClient, plain)
  }

  function buildBaseClient(): BaseClient {
    return {
      collection: <C extends AnyCollectionDef>(def: C) => buildAccessor(def),
      auth: makeAuth(),
      telemetry: makeTelemetryClient(execute),
      withCollections,
      me: (<C extends AnyAuthCollectionDef>(_def?: C) => {
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
  const { defaultRetryOptions, type = "browser" } = opts
  return createMiraClientInternal(baseUrl, type, defaultRetryOptions) as BrowserMiraClient | ServerMiraClient
}
