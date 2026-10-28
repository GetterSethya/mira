import { Config, Effect, Layer, Redacted, Stream } from "effect"
import { Files as FilesClient } from "files-sdk"
import type { FilesService } from "files-sdk/effect"
import { make as makeFilesService } from "files-sdk/effect"
import { s3Fetch } from "files-sdk/s3-fetch"

import { FileStorage, FileStorageError, FileStorageNotFound } from "./storage.js"

/**
 * A value that can be provided directly or read from Effect's `Config` system
 * when the storage layer is built.
 *
 * @example
 * endpoint: "http://localhost:9000"      // plain value
 * endpoint: Config.String("S3_ENDPOINT") // resolved at layer build
 */
export type S3ConfigValue<T> = T | Config.Config<T>

/**
 * Configuration for the S3-compatible {@link FileStorage} backend. Works with
 * AWS S3 as well as self-hosted implementations (MinIO, LocalStack, RustFS,
 * Cloudflare R2, Backblaze B2, …).
 *
 * Every field accepts a plain value or an Effect `Config`. Config values are
 * resolved once when the layer is built, so a missing environment variable
 * fails fast at startup instead of on the first upload.
 *
 * @example
 * // Plain values
 * {
 *   endpoint: "http://localhost:9000",
 *   bucketName: "mira-uploads",
 *   regionName: "us-east-1",
 *   accessKey: "minioadmin",
 *   secret: "minioadmin",
 * }
 *
 * @example
 * // Effect Config values
 * {
 *   endpoint: Config.String("S3_ENDPOINT"),
 *   bucketName: Config.String("S3_BUCKET_NAME"),
 *   regionName: Config.String("S3_REGION_NAME").pipe(Config.withDefault("us-east-1")),
 *   accessKey: Config.Redacted("S3_ACCESS_KEY"),
 *   secret: Config.Redacted("S3_SECRET"),
 * }
 */
export interface S3CompatibleStorageConfig {
  /** S3 endpoint, including scheme, e.g. `https://s3.eu-central-1.amazonaws.com`. */
  readonly endpoint: S3ConfigValue<string>
  /** Bucket that receives every uploaded object. Must already exist. */
  readonly bucketName: S3ConfigValue<string>
  /** Region used for request signing (`us-east-1` works for most S3-compatible servers). */
  readonly regionName: S3ConfigValue<string>
  /** Access key id used to sign requests. Accepts plain or `Redacted` values. */
  readonly accessKey: S3ConfigValue<string | Redacted.Redacted<string>>
  /** Secret access key used to sign requests. Accepts plain or `Redacted` values. */
  readonly secret: S3ConfigValue<string | Redacted.Redacted<string>>
  /**
   * Address the bucket as `{endpoint}/{bucket}/{key}` (`true`) instead of
   * `{scheme}://{bucket}.{host}/{key}` (`false`).
   *
   * Defaults to `true`, which is what self-hosted S3-compatible servers
   * (MinIO, LocalStack, RustFS, …) need.
   */
  readonly forcePathStyle?: S3ConfigValue<boolean>
  /**
   * Optional public base URL (CDN, custom domain, signed proxy) used by the
   * synchronous `url()` method. When omitted, `url()` returns a direct
   * bucket URL derived from `endpoint` / `bucketName` — useful only for
   * buckets that allow public reads.
   */
  readonly publicBaseUrl?: S3ConfigValue<string>
}

/** Fully resolved form of {@link S3CompatibleStorageConfig}. */
interface ResolvedS3CompatibleStorageConfig {
  readonly endpoint: string
  readonly bucketName: string
  readonly regionName: string
  readonly accessKey: string
  readonly secret: string
  readonly forcePathStyle: boolean
  readonly publicBaseUrl?: string
}

/** Narrow a plain value or a `Config` to a `Config`. */
const isConfigValue = <A>(value: A | Config.Config<A>): value is Config.Config<A> =>
  Config.isConfig(value)

/** Lift a plain value into a `Config`; leaves an existing `Config` untouched. */
const resolveConfigValue = <A>(value: A | Config.Config<A>): Config.Config<A> =>
  isConfigValue(value) ? value : Config.succeed(value)

/** Unwrap a string or `Redacted<string>` secret. */
const unwrapSecret = (value: string | Redacted.Redacted<string>): string =>
  typeof value === "string" ? value : Redacted.value(value)

/**
 * Encode a storage key for use in a URL path.
 *
 * Each `/`-separated segment is `encodeURIComponent`-ed, and empty, `.` and
 * `..` segments are dropped, so a key can never escape the bucket root.
 *
 * @param key - Raw storage key, e.g. `"uploads/user 1/photo.jpg"`
 * @returns The encoded key, e.g. `"uploads/user%201/photo.jpg"`
 */
const encodeKeyPath = (key: string) =>
  key
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== "." && segment !== "..")
    .map((segment) => encodeURIComponent(segment))
    .join("/")

/**
 * Strip every trailing `/` from a base URL so segments can be appended with a
 * single separator.
 *
 * @param value - Base URL, e.g. `"https://cdn.example.com/"`
 * @returns The URL without trailing slashes
 */
const trimTrailingSlashes = (value: string) => value.replace(/\/+$/, "")

/**
 * Build the synchronous `url()` implementation for a config.
 *
 * - `publicBaseUrl` wins when set — the object is served from a CDN/custom
 *   domain, which is the only option for private buckets.
 * - Otherwise a path-style URL (`{endpoint}/{bucket}/{key}`) is produced, or a
 *   virtual-host URL (`{scheme}://{bucket}.{host}/{key}`) when
 *   `forcePathStyle: false`. An unparseable endpoint falls back to path style.
 *
 * Note that Mira normally serves files through its own
 * `/api/files/:collection/:id/:filename` route (which enforces the collection
 * view rule and protected-file tokens); this URL is a direct bucket/CDN link
 * for callers that need one.
 *
 * @param config - Resolved S3-compatible storage config
 * @returns A function mapping a storage key to a public URL
 */
const makeUrlBuilder = (config: ResolvedS3CompatibleStorageConfig) => {
  if (config.publicBaseUrl !== undefined) {
    const base = trimTrailingSlashes(config.publicBaseUrl)
    return (key: string) => `${base}/${encodeKeyPath(key)}`
  }

  const endpoint = trimTrailingSlashes(config.endpoint)
  const pathStyleUrl = (key: string) => `${endpoint}/${config.bucketName}/${encodeKeyPath(key)}`

  if (config.forcePathStyle) {
    return pathStyleUrl
  }

  return (key: string) => {
    if (!URL.canParse(endpoint)) {
      return pathStyleUrl(key)
    }
    const parsed = new URL(endpoint)
    return `${parsed.protocol}//${config.bucketName}.${parsed.host}/${encodeKeyPath(key)}`
  }
}

/**
 * Adapt any `files-sdk` {@link FilesService} to Mira's {@link FileStorage}
 * contract.
 *
 * This is the adapter-agnostic core of the S3 backend: the S3 layer feeds it a
 * `s3Fetch`-backed service, while tests can feed it the in-memory adapter — no
 * network required. Every `FilesError` is mapped to `FileStorageError`, except
 * `NotFound` on read, which becomes `FileStorageNotFound`.
 *
 * @param files - A `files-sdk` Effect service
 * @param urlForKey - Synchronous URL builder; defaults to a Mira-relative `/files/{key}`
 * @returns A `FileStorage` service implementation
 *
 * @see makeS3FileStorageLayer — S3-backed layer built on this
 */
export const makeFileStorageFromFiles = (
  files: FilesService,
  urlForKey: (key: string) => string = (key: string) => `/files/${encodeKeyPath(key)}`
) =>
  FileStorage.of({
    // The upstream stream is drained *inside* the Effect and only then handed
    // to the adapter, so streaming errors (e.g. the upload size limit's
    // `PayloadTooLargeError`) stay in the error channel with their original
    // type instead of being rewritten by the adapter's error mapping.
    upload: <E>(key: string, stream: Stream.Stream<Uint8Array, E>, mimeType: string) =>
      Effect.gen(function* () {
        const chunks = yield* Stream.runCollect(stream)
        let total = 0
        for (const chunk of chunks) {
          total += chunk.length
        }
        const bytes = new Uint8Array(total)
        let offset = 0
        for (const chunk of chunks) {
          bytes.set(chunk, offset)
          offset += chunk.length
        }
        yield* files.upload(key, bytes, { contentType: mimeType }).pipe(
          Effect.catchTag("FilesError", (error) =>
            Effect.fail(new FileStorageError({ reason: error.message }))
          )
        )
        return key
      }),

    delete: (key: string) =>
      files.delete(key).pipe(
        Effect.catchTag("FilesError", (error) =>
          error.reason._tag === "NotFound"
            ? Effect.void
            : Effect.fail(new FileStorageError({ reason: error.message }))
        )
      ),

    url: urlForKey,

    read: (key: string) =>
      Effect.gen(function* () {
        // The handler's return type is annotated because the two failure arms
        // are different tags: without it catchTag widens the callback's error
        // to a single branch instead of the union.
        const downloaded = yield* files.download(key).pipe(
          Effect.catchTag(
            "FilesError",
            (error): Effect.Effect<never, FileStorageError | FileStorageNotFound> =>
              error.reason._tag === "NotFound"
                ? Effect.fail(new FileStorageNotFound({ key }))
                : Effect.fail(new FileStorageError({ reason: error.message }))
          )
        )
        const buffer = yield* downloaded.arrayBuffer.pipe(
          Effect.catchTag("FilesError", (error) =>
            Effect.fail(new FileStorageError({ reason: error.message }))
          )
        )
        return new Uint8Array(buffer)
      }),

    exists: (key: string) =>
      files.exists(key).pipe(
        Effect.catchTag("FilesError", (error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed(false)
            : Effect.fail(new FileStorageError({ reason: error.message }))
        )
      ),

    list: (prefix: string) =>
      Effect.gen(function* () {
        const infos = yield* Stream.runCollect(files.listAll({ prefix })).pipe(
          Effect.catchTag("FilesError", (error) =>
            Effect.fail(new FileStorageError({ reason: error.message }))
          )
        )
        return Array.from(infos, (info) => info.key)
      })
  })

/**
 * Create a {@link FileStorage} layer backed by an S3-compatible bucket.
 *
 * Requests are signed by `files-sdk`'s zero-peer `s3Fetch` adapter (aws4fetch),
 * so no `@aws-sdk/*` package is needed. The client is constructed lazily inside
 * the layer — importing this module performs no network or credential work.
 *
 * Any field may be a plain value or an Effect `Config`; `Config` values are
 * resolved once when the layer is built (using the ambient `ConfigProvider`),
 * so a missing env var fails at startup rather than on the first upload.
 *
 * @param config - S3-compatible endpoint, bucket, region and credentials
 * @returns A Layer providing `FileStorage`
 *
 * @example
 * makeS3FileStorageLayer({
 *   endpoint: "http://localhost:9000",
 *   bucketName: "mira-uploads",
 *   regionName: "us-east-1",
 *   accessKey: "minioadmin",
 *   secret: "minioadmin",
 * })
 *
 * @example
 * makeS3FileStorageLayer({
 *   endpoint: Config.String("S3_ENDPOINT"),
 *   bucketName: Config.String("S3_BUCKET_NAME"),
 *   regionName: Config.String("S3_REGION_NAME").pipe(Config.withDefault("us-east-1")),
 *   accessKey: Config.Redacted("S3_ACCESS_KEY"),
 *   secret: Config.Redacted("S3_SECRET"),
 * })
 *
 * @see S3CompatibleStorage — preset wrapping this function
 */
export const makeS3FileStorageLayer = (config: S3CompatibleStorageConfig): Layer.Layer<FileStorage> =>
  Layer.effect(
    FileStorage,
    Effect.gen(function* () {
      const endpoint = yield* resolveConfigValue(config.endpoint)
      const bucketName = yield* resolveConfigValue(config.bucketName)
      const regionName = yield* resolveConfigValue(config.regionName)
      const accessKey = unwrapSecret(yield* resolveConfigValue(config.accessKey))
      const secret = unwrapSecret(yield* resolveConfigValue(config.secret))
      const forcePathStyle =
        config.forcePathStyle === undefined
          ? true
          : yield* resolveConfigValue(config.forcePathStyle)
      const publicBaseUrl =
        config.publicBaseUrl === undefined
          ? undefined
          : yield* resolveConfigValue(config.publicBaseUrl)

      const resolved: ResolvedS3CompatibleStorageConfig = {
        endpoint,
        bucketName,
        regionName,
        accessKey,
        secret,
        forcePathStyle,
        ...(publicBaseUrl === undefined ? {} : { publicBaseUrl })
      }

      const client = new FilesClient({
        adapter: s3Fetch({
          bucket: resolved.bucketName,
          endpoint: resolved.endpoint,
          region: resolved.regionName,
          accessKeyId: resolved.accessKey,
          secretAccessKey: resolved.secret,
          forcePathStyle: resolved.forcePathStyle,
          ...(resolved.publicBaseUrl === undefined ? {} : { publicBaseUrl: resolved.publicBaseUrl })
        })
      })
      return makeFileStorageFromFiles(makeFilesService(client), makeUrlBuilder(resolved))
    }).pipe(Effect.orDie)
  )
