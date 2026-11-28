import { scryptSync } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { SMTPServer } from "smtp-server"
import { Context, Effect, Layer, Result, Schema, Stream } from "effect"
import { SqlClient } from "effect/sql"
import {
  AppConfig,
  AuthService,
  BaseCollection,
  BunPlatform,
  BunSqliteDatabase,
  CryptoService,
  defineRule,
  EmailService,
  Field,
  FileStorage,
  hmacSha256Base64Url,
  LocalFileStorage,
  makeTelemetryLayer,
  makeThumbnailServiceBunLive,
  Mira,
  parseThumbSpec,
  RateLimiter,
  sha256Base64Url,
  SmtpEmail,
  TelemetryStore,
  ThumbnailService
} from "@gettersethya/mira/bun"
import { MiraDashboard } from "@gettersethya/mira-dashboard"

type BunImagePipeline = {
  metadata(): Promise<{ readonly width: number; readonly height: number }>
  resize(width: number, height: number): BunImagePipeline
  png(): BunImagePipeline
  bytes(): Promise<Uint8Array>
}

type BunImageConstructor = new (input: Uint8Array) => BunImagePipeline

const isBunImageConstructor = (value: unknown): value is BunImageConstructor => typeof value === "function"

const bunImage = (): BunImageConstructor | undefined => {
  const bun: unknown = Reflect.get(globalThis, "Bun")
  if (typeof bun !== "object" || bun === null) return undefined
  const Image: unknown = Reflect.get(bun, "Image")
  return isBunImageConstructor(Image) ? Image : undefined
}

const BunImage = bunImage()

const EmptyCollectionSchema = Schema.fromJsonString(
  Schema.Struct({ items: Schema.optional(Schema.Array(Schema.Unknown)) })
)
const decodeEmptyCollection = Schema.decodeUnknownSync(EmptyCollectionSchema)
const encodeEmptyCollection = Schema.encodeSync(EmptyCollectionSchema)

const PostListSchema = Schema.fromJsonString(
  Schema.Struct({
    items: Schema.optional(Schema.Array(Schema.Struct({ title: Schema.optional(Schema.String) })))
  })
)
const decodePostList = Schema.decodeUnknownSync(PostListSchema)
const encodePostList = Schema.encodeSync(PostListSchema)

const StorageStateSchema = Schema.fromJsonString(
  Schema.Struct({
    key: Schema.String,
    exists: Schema.Boolean,
    listedKeys: Schema.Array(Schema.String)
  })
)
const encodeStorageState = Schema.encodeSync(StorageStateSchema)

const CreatePostSchema = Schema.fromJsonString(Schema.Struct({ title: Schema.String }))
const encodeCreatePost = Schema.encodeSync(CreatePostSchema)

const startedSmtp = await new Promise<{
  readonly port: number
  readonly received: Array<string>
  readonly close: () => Promise<void>
}>((resolve, reject) => {
  const received: Array<string> = []
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ["AUTH", "STARTTLS"],
    onData(stream, _session, callback) {
      const chunks: Array<Buffer> = []
      stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
      stream.on("end", () => {
        received.push(Buffer.concat(chunks).toString("utf8"))
        callback()
      })
      stream.on("error", callback)
    }
  })
  server.on("error", reject)
  server.listen(0, "127.0.0.1", () => {
    const address = server.server.address()
    if (address === null || typeof address === "string") {
      reject(new Error("SMTP server did not bind a TCP address"))
      return
    }
    resolve({
      port: address.port,
      received,
      close: () => new Promise<void>((done) => server.close(() => done()))
    })
  })
})

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64"
)

const Posts = BaseCollection.define("posts", {
  title: Field.text({ required: true })
})

const rules = defineRule(Posts, (R) => ({
  list: R.public(),
  view: R.public(),
  create: R.public()
}))

const dir = mkdtempSync(join(tmpdir(), "mira-bun-smoke-"))
const blocker = Bun.serve({ port: 0, fetch: () => new Response("occupied") })
const port = blocker.port
if (port === undefined) throw new Error("Bun blocker did not bind a TCP port")
let requestPort = port + 1

const app = Mira.builder()
  .platform(BunPlatform)
  .database(BunSqliteDatabase({ filename: join(dir, "data.db") }))
  .storage(LocalFileStorage({ directory: join(dir, "uploads") }))
  .email(
    SmtpEmail({
      host: "127.0.0.1",
      port: startedSmtp.port,
      secure: false,
      from: "Mira <mira@example.com>"
    })
  )
  .collections([Posts])
  .rules([rules])
  .telemetry(
    makeTelemetryLayer({
      storage: {
        mode: "dedicated",
        database: BunSqliteDatabase({ filename: join(dir, "telemetry.db") })
      }
    })
  )
  .build()
  .extend(MiraDashboard)

const request = (path: string, init?: RequestInit) =>
  Effect.tryPromise({
    try: () => fetch(`http://127.0.0.1:${requestPort}${path}`, init),
    catch: (error) => new Error(`fetch ${path} failed: ${String(error)}`)
  })

const closeEffect = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, never> => {
  // The built app layer closes its requirements at runtime, but the plugin
  // graph widens R to any, so this helper restores the closed run type.
  // oxlint-disable-next-line typescript/consistent-type-assertions
  return effect as Effect.Effect<A, E, never>
}

const program = Effect.gen(function* () {
  const context = yield* Layer.build(app.buildLayer({ port, maxPortAttempts: 5 }))
  requestPort = Context.get(context, AppConfig).port

  // SQLite telemetry: one log and one span must reach the dedicated database.
  yield* Effect.logInfo("bun-smoke-log")
  yield* Effect.void.pipe(Effect.withSpan("bun-smoke-span"))
  yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 250)))
  const store = Context.get(context, TelemetryStore)
  const mainSql = Context.get(context, SqlClient.SqlClient)
  const mainJournal = yield* mainSql<{ journal_mode: string }>`PRAGMA journal_mode`
  if (mainJournal[0]?.journal_mode !== "wal") {
    throw new Error(`main SQLite database is not in WAL mode: ${mainJournal[0]?.journal_mode ?? "missing"}`)
  }
  if (store.read === null) throw new Error("telemetry store has no read capability")
  const logPage = yield* store.read.listLogs({
    limit: 1000,
    after: null,
    filter: null,
    traceId: null
  })
  const spanPage = yield* store.read.listSpans({
    limit: 1000,
    after: null,
    filter: null,
    traceId: null
  })
  const logCount = logPage.total
  const spanCount = spanPage.total
  if (logCount === 0 || spanCount === 0) {
    throw new Error(`telemetry rows missing: logs=${logCount} spans=${spanCount}`)
  }

  // Native Bun crypto: hashing and UUIDv7.
  const sha = yield* sha256Base64Url("hello")
  if (sha !== "LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ") {
    throw new Error(`unexpected SHA-256 vector: ${sha}`)
  }
  const hmac = yield* hmacSha256Base64Url("secret", "hello")
  if (hmac !== "iKqz7ejTrflNJquQ07r9SiCDBww7zOnAFO4EpEOEfAs") {
    throw new Error(`unexpected HMAC-SHA-256 vector: ${hmac}`)
  }
  const cryptoService = Context.get(context, CryptoService)
  const uuid = yield* cryptoService.randomUUID()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuid)) {
    throw new Error(`expected a UUIDv7 from BunCryptoLayer, got ${uuid}`)
  }

  // Native Bun password hashing, including a Node-created scrypt row.
  const auth = Context.get(context, AuthService)
  const passwordHash = yield* auth.hashPassword("correct horse battery staple")
  if (!passwordHash.startsWith("$argon2id$")) {
    throw new Error(`expected an Argon2id hash, got ${passwordHash.slice(0, 24)}`)
  }
  if (!(yield* auth.verifyPassword("correct horse battery staple", passwordHash))) {
    throw new Error("Bun.password could not verify its own hash")
  }
  if (yield* auth.verifyPassword("wrong password", passwordHash)) {
    throw new Error("Bun.password accepted the wrong password")
  }
  const legacySalt = "00112233445566778899aabbccddeeff"
  const legacyHash = `scrypt$${legacySalt}$${scryptSync("legacy password", legacySalt, 64).toString("hex")}`
  if (!(yield* auth.verifyPassword("legacy password", legacyHash))) {
    throw new Error("legacy scrypt verification failed under Bun")
  }
  if (auth.needsRehash?.(legacyHash) !== true) {
    throw new Error("legacy scrypt row should be scheduled for an Argon2id rehash")
  }
  if (auth.needsRehash?.(passwordHash) === true) {
    throw new Error("Argon2id row should not be rehashed")
  }

  if (BunImage === undefined) throw new Error("Bun.Image is unavailable")

  // Native Bun.Image for contain/fill; cover stays on Photon (no native crop).
  const thumbnail = Context.get(context, ThumbnailService)
  const widePng = yield* Effect.tryPromise({
    try: () => new BunImage(png).resize(8, 4).png().bytes(),
    catch: (error) => new Error(`Bun.Image fixture failed: ${String(error)}`)
  })
  const containSpec = parseThumbSpec("4x4b")
  const fillSpec = parseThumbSpec("4x4f")
  const coverSpec = parseThumbSpec("4x4")
  if (containSpec === null || fillSpec === null || coverSpec === null) {
    throw new Error("invalid thumb spec")
  }
  const containBytes = yield* thumbnail.resize(widePng, "image/png", containSpec)
  const fillBytes = yield* thumbnail.resize(widePng, "image/png", fillSpec)
  const coverBytes = yield* thumbnail.resize(widePng, "image/png", coverSpec)
  const readDimensions = (bytes: Uint8Array) =>
    Effect.tryPromise({
      try: () => new BunImage(bytes).metadata(),
      catch: (error) => new Error(`Bun.Image metadata failed: ${String(error)}`)
    })
  const containMeta = yield* readDimensions(containBytes)
  const fillMeta = yield* readDimensions(fillBytes)
  const coverMeta = yield* readDimensions(coverBytes)
  if (containMeta.width !== 4 || containMeta.height !== 2) {
    throw new Error(`contain resize returned ${containMeta.width}x${containMeta.height}`)
  }
  if (fillMeta.width !== 4 || fillMeta.height !== 4) {
    throw new Error(`fill resize returned ${fillMeta.width}x${fillMeta.height}`)
  }
  if (coverMeta.width !== 4 || coverMeta.height !== 4) {
    throw new Error(`cover resize returned ${coverMeta.width}x${coverMeta.height}`)
  }

  // Prove the native path: with Photon fallback disabled, contain must still
  // succeed.
  const strictNative = makeThumbnailServiceBunLive({ allowPhotonFallback: false })
  const nativeContain = yield* Effect.gen(function* () {
    const service = yield* ThumbnailService
    return yield* service.resize(widePng, "image/png", containSpec)
  }).pipe(Effect.provide(strictNative))
  if (nativeContain.length === 0) {
    throw new Error("strict native contain resize produced no bytes")
  }

  // The header budget is enforced before decode and before any Photon fallback.
  const guarded = makeThumbnailServiceBunLive({ maxPixels: 4 })
  const guardResult = yield* Effect.gen(function* () {
    const service = yield* ThumbnailService
    return yield* service.resize(widePng, "image/png", containSpec).pipe(Effect.result)
  }).pipe(Effect.provide(guarded))
  if (Result.isSuccess(guardResult)) {
    throw new Error("maxPixels guard accepted an 8x4 image with maxPixels=4")
  }

  const storage = Context.get(context, FileStorage)
  const key = yield* storage.upload(
    "smoke/hello.txt",
    Stream.make(new TextEncoder().encode("hello storage")),
    "text/plain"
  )
  const stored = yield* storage.read(key)
  const exists = yield* storage.exists(key)
  const listedKeys = yield* storage.list("smoke/")
  yield* storage.delete(key)
  if (new TextDecoder().decode(stored) !== "hello storage" || !exists || !listedKeys.includes(key)) {
    throw new Error(`storage round-trip failed: ${encodeStorageState({ key, exists, listedKeys })}`)
  }

  const limiter = Context.get(context, RateLimiter)
  const policy = {
    name: "bun:smoke",
    limit: 1,
    windowMs: 60_000,
    onStoreError: "allow" as const
  }
  const first = yield* limiter.consume(policy, "smoke-key")
  const second = yield* limiter.consume(policy, "smoke-key")
  if (first.blocked !== null) throw new Error("first rate-limit consume was blocked")
  if (second.blocked === null) throw new Error("second rate-limit consume was not blocked")

  const empty = yield* request("/api/collections/posts")
  if (!empty.ok) throw new Error(`GET /api/collections/posts returned ${empty.status}`)
  const emptyBody = decodeEmptyCollection(yield* Effect.tryPromise(() => empty.text()))
  if (emptyBody.items?.length !== 0) {
    throw new Error(`expected an empty collection, got ${encodeEmptyCollection(emptyBody)}`)
  }

  const created = yield* request("/api/collections/posts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: encodeCreatePost({ title: "hello bun" })
  })
  if (created.status !== 201) {
    throw new Error(`POST /api/collections/posts returned ${created.status}`)
  }

  const listed = yield* request("/api/collections/posts")
  if (!listed.ok) throw new Error(`GET /api/collections/posts returned ${listed.status}`)
  const body = decodePostList(yield* Effect.tryPromise(() => listed.text()))
  if (body.items?.length !== 1 || body.items[0]?.title !== "hello bun") {
    throw new Error(`unexpected list response: ${encodePostList(body)}`)
  }

  const dashboard = yield* request("/_dashboard/api/bootstrap-status")
  if (!dashboard.ok) throw new Error(`dashboard status returned ${dashboard.status}`)

  const email = Context.get(context, EmailService)
  yield* email.send(
    {
      to: "user@example.com",
      subject: "Bun smoke",
      text: "hello from Bun"
    },
    { purpose: "password_reset", collection: "posts" }
  )
  if (startedSmtp.received.length !== 1) {
    throw new Error(`expected one SMTP message, got ${startedSmtp.received.length}`)
  }

  return {
    http: { listed: listed.status, created: created.status, dashboard: dashboard.status },
    thumbnailBytes: containBytes.length + fillBytes.length + coverBytes.length,
    native: {
      password: passwordHash.slice(0, "$argon2id$v=19".length),
      uuidVersion: uuid[14],
      hmac: hmac.slice(0, 8),
      thumbnail: {
        contain: `${containMeta.width}x${containMeta.height}`,
        fill: `${fillMeta.width}x${fillMeta.height}`,
        cover: `${coverMeta.width}x${coverMeta.height}`,
        strictNative: nativeContain.length > 0,
        pixelGuard: Result.isFailure(guardResult)
      }
    },
    emailReceived: startedSmtp.received.length,
    storage: { key, listed: listedKeys.length },
    sqlite: {
      mainJournal: mainJournal[0]?.journal_mode
    },
    telemetry: { logs: logCount, spans: spanCount },
    port: requestPort,
    rateLimit: { first: first.blocked === null, second: second.blocked?.policy }
  }
}).pipe(
  Effect.scoped,
  Effect.ensuring(
    Effect.gen(function* () {
      yield* Effect.promise(() => blocker.stop(true))
      yield* Effect.sync(() => rmSync(dir, { recursive: true, force: true }))
    })
  ),
  Effect.ensuring(Effect.promise(() => startedSmtp.close()))
)

const SmokeResultFields = {
  http: Schema.Struct({ listed: Schema.Finite, created: Schema.Finite, dashboard: Schema.Finite }),
  thumbnailBytes: Schema.Finite,
  native: Schema.Struct({
    password: Schema.String,
    uuidVersion: Schema.String,
    hmac: Schema.String,
    thumbnail: Schema.Struct({
      contain: Schema.String,
      fill: Schema.String,
      cover: Schema.String,
      strictNative: Schema.Boolean,
      pixelGuard: Schema.Boolean
    })
  }),
  emailReceived: Schema.Finite,
  storage: Schema.Struct({ key: Schema.String, listed: Schema.Finite }),
  sqlite: Schema.Struct({ mainJournal: Schema.UndefinedOr(Schema.String) }),
  telemetry: Schema.Struct({ logs: Schema.Finite, spans: Schema.Finite }),
  port: Schema.Finite,
  rateLimit: Schema.Struct({ first: Schema.Boolean, second: Schema.UndefinedOr(Schema.String) })
}

const encodeSmokeResult = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      ok: Schema.Boolean,
      ...SmokeResultFields
    })
  )
)

await Effect.runPromise(closeEffect(program)).then(
  (result) => {
    console.log(encodeSmokeResult({ ok: true, ...result }))
  },
  (error) => {
    console.error(error)
    process.exitCode = 1
  }
)
