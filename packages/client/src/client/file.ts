import type { HttpClient, HttpClientRequest } from "@effect/platform"
import { HttpClientRequest as HCR } from "@effect/platform"
import type { HttpBodyError } from "@effect/platform/HttpBody"
import { Effect, MutableRef } from "effect"
import type { AnyCollectionDef, FieldsMap } from "@gettersethya/mira-collection"
import { MiraError } from "./errors.js"
import type { ClientHandler, ExecuteFn } from "./handler.js"
import type { CollectionFileFields } from "./types.js"

/**
 * Build a file request URL for the Mira file-serving endpoint.
 *
 * Constructs a URL of the form:
 * `{baseUrl}/api/files/{collection}/{id}/{filename}?token={token}&thumb={spec}`
 *
 * Query parameters are only appended when defined.
 *
 * @param baseUrl - The base URL of the Mira server (e.g., "http://localhost:3000" or "/" for same-origin)
 * @param collection - The collection name
 * @param id - The record ID
 * @param filename - The filename as stored in the record's file field
 * @param opts.token - Optional short-lived JWT token for protected files
 * @param opts.thumb - Optional thumbnail spec (e.g., "200x200", "100x100_fit")
 * @returns The fully constructed file URL string
 *
 * @example
 * buildFileUrl("/", "posts", "abc123", "cover.jpg")
 * // "/api/files/posts/abc123/cover.jpg"
 *
 * @example
 * buildFileUrl("http://localhost:8090", "users", "u1", "avatar.png", {
 *   token: "eyJ...",
 *   thumb: "200x200"
 * })
 * // "http://localhost:8090/api/files/users/u1/avatar.png?token=eyJ...&thumb=200x200"
 */
export function buildFileUrl(
  baseUrl: string,
  collection: string,
  id: string,
  filename: string,
  opts?: { token?: string; thumb?: string }
): string {
  const base = `${baseUrl}/api/files/${collection}/${id}/${filename}`
  const params = new URLSearchParams()
  if (opts?.token !== undefined) params.set("token", opts.token)
  if (opts?.thumb !== undefined) params.set("thumb", opts.thumb)
  const qs = params.toString()
  return qs ? `${base}?${qs}` : base
}

function toExecuteEffect<T>(
  reqEffect: Effect.Effect<HttpClientRequest.HttpClientRequest, HttpBodyError, never>,
  execute: ExecuteFn
): Effect.Effect<T, MiraError, HttpClient.HttpClient> {
  return reqEffect.pipe(
    Effect.flatMap((req) => execute<T>(req)),
    Effect.catchTag("HttpBodyError", (e) =>
      Effect.fail(new MiraError({ status: 500, body: String(e) }))
    )
  )
}

/**
 * Create a function that retrieves a short-lived file-access JWT token for a collection.
 * Tokens are cached per collection with a 30-second freshness buffer before expiry.
 *
 * @internal Called internally by `makeFileFields`. Use `ProtectedFileFieldClient.getToken()` instead.
 */
export function makeGetFileToken(
  execute: ExecuteFn,
  cacheRef: MutableRef.MutableRef<Map<string, { token: string; expiresAt: number }>>
): (collection: string) => Effect.Effect<string, MiraError, HttpClient.HttpClient> {
  return (collection: string) =>
    Effect.gen(function* () {
      const cache = MutableRef.get(cacheRef)
      const cached = cache.get(collection)
      if (cached !== undefined && Date.now() < cached.expiresAt - 30_000) {
        return cached.token
      }

      const data = yield* toExecuteEffect<{ token: string; expiresAt: number }>(
        HCR.bodyJson(HCR.post("/api/files/token"), { collection }),
        execute
      )

      const newCache = new Map(cache).set(collection, data)
      MutableRef.set(cacheRef, newCache)
      return data.token
    })
}

/**
 * Client interface for a public (non-protected) file field.
 * File URLs are constructed synchronously because no auth token is needed.
 *
 * @example
 * // Given a post with a public "cover" file field
 * const url = post.fields.cover.url(post.id, "cover.jpg")
 * // "/api/files/posts/abc/cover.jpg"
 *
 * @example
 * // With thumbnail variant
 * const thumbUrl = post.fields.cover.url(post.id, "cover.jpg", { thumb: "200x200" })
 *
 * @see ProtectedFileFieldClient — file client that requires auth tokens
 * @see buildFileUrl — underlying URL builder
 */
export type PublicFileFieldClient = {
  isProtected: false
  url(id: string, filename: string, opts?: { thumb?: string }): string
}

/**
 * Client interface for a protected file field.
 * Protected files require a short-lived JWT token to access.
 *
 * Three modes:
 * - `url(id, filename, { token })` — synchronous URL construction when you already
 *   have a token (e.g., from `getToken()`)
 * - `asyncUrl(id, filename)` — returns a `ClientHandler<string>` that fetches a token
 *   and constructs the URL in one async call
 * - `getToken()` — fetches a fresh file-access token (cached for 30s by collection)
 *
 * @example
 * // Async URL construction (fetches token automatically)
 * const url = await post.fields.avatar.asyncUrl(post.id, "avatar.png").raw()
 *
 * @example
 * // Manual token management for batch operations
 * const token = await post.fields.avatar.getToken().raw()
 * const u1 = post.fields.avatar.url("id1", "img1.png", { token })
 * const u2 = post.fields.avatar.url("id2", "img2.png", { token })
 *
 * @see PublicFileFieldClient — file client for unprotected files
 * @see buildFileUrl — underlying URL builder
 */
export type ProtectedFileFieldClient = {
  isProtected: true
  asyncUrl(id: string, filename: string, opts?: { thumb?: string }): ClientHandler<string>
  url(id: string, filename: string, opts: { token: string; thumb?: string }): string
  getToken(): ClientHandler<string>
}

/**
 * Build the file field client interfaces for a collection.
 * Iterates over the schema's properties, creating `PublicFileFieldClient` or
 * `ProtectedFileFieldClient` instances for each `file`-kind field.
 *
 * @internal Called by `makeCollectionClient` — use `collection.fields` instead.
 */
export function makeFileFields<F extends FieldsMap>(
  collection: AnyCollectionDef,
  schema: AnyCollectionDef["schema"],
  baseUrl: string,
  execute: ExecuteFn,
  cacheRef: MutableRef.MutableRef<Map<string, { token: string; expiresAt: number }>>,
  makeClientHandler: <T>(effect: Effect.Effect<T, MiraError, HttpClient.HttpClient>) => ClientHandler<T>
): CollectionFileFields<F> {
  const result: Record<string, unknown> = {}
  const getFileToken = makeGetFileToken(execute, cacheRef)

  for (const [key, prop] of Object.entries(schema.properties)) {
    if (prop["x-kind"] !== "file") continue

    const isProtected = prop["x-protected"] === true

    if (isProtected) {
      const protectedField: ProtectedFileFieldClient = {
        isProtected: true,
        asyncUrl: (id: string, filename: string, opts?: { thumb?: string }) =>
          makeClientHandler(
            Effect.gen(function* () {
              const token = yield* getFileToken(collection.name)
              return buildFileUrl(baseUrl, collection.name, id, filename, { token, ...(opts?.thumb !== undefined ? { thumb: opts.thumb } : {}) })
            })
          ),
        url: (id: string, filename: string, opts: { token: string; thumb?: string }) =>
          buildFileUrl(baseUrl, collection.name, id, filename, { token: opts.token, ...(opts.thumb !== undefined ? { thumb: opts.thumb } : {}) }),
        getToken: () =>
          makeClientHandler(getFileToken(collection.name)),
      }
      result[key] = protectedField
    } else {
      const publicField: PublicFileFieldClient = {
        isProtected: false,
        url: (id: string, filename: string, opts?: { thumb?: string }) =>
          buildFileUrl(baseUrl, collection.name, id, filename, opts),
      }
      result[key] = publicField
    }
  }

  return result as CollectionFileFields<F>
}
