import { scryptSync } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { SMTPServer } from "smtp-server"
import { Context, Effect, Layer, Result, Stream } from "effect"
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
  makeThumbnailServiceBunLive,
  Mira,
  parseThumbSpec,
  RateLimiter,
  sha256Base64Url,
  SmtpEmail,
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

const BunImage = (Bun as unknown as { Image?: BunImageConstructor }).Image

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
    const address = (server as unknown as { server: { address(): { port: number } } }).server.address()
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
  .build()
  .extend(MiraDashboard)

const request = (path: string, init?: RequestInit) =>
  Effect.tryPromise({
    try: () => fetch(`http://127.0.0.1:${requestPort}${path}`, init),
    catch: (error) => new Error(`fetch ${path} failed: ${String(error)}`)
  })

const program = Effect.gen(function* () {
  const context = yield* Layer.build(app.buildLayer({ port, maxPortAttempts: 5 }))
  requestPort = Context.get(context, AppConfig).port

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
  if (
    new TextDecoder().decode(stored) !== "hello storage" ||
    !exists ||
    !listedKeys.includes(key)
  ) {
    throw new Error(`storage round-trip failed: ${JSON.stringify({ key, exists, listedKeys })}`)
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
  const emptyBody = (yield* Effect.tryPromise(() => empty.json())) as {
    readonly items?: ReadonlyArray<unknown>
  }
  if (emptyBody.items?.length !== 0) {
    throw new Error(`expected an empty collection, got ${JSON.stringify(emptyBody)}`)
  }

  const created = yield* request("/api/collections/posts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "hello bun" })
  })
  if (created.status !== 201) {
    throw new Error(`POST /api/collections/posts returned ${created.status}`)
  }

  const listed = yield* request("/api/collections/posts")
  if (!listed.ok) throw new Error(`GET /api/collections/posts returned ${listed.status}`)
  const body = (yield* Effect.tryPromise(() => listed.json())) as {
    readonly items?: ReadonlyArray<{ readonly title?: string }>
  }
  if (body.items?.length !== 1 || body.items[0]?.title !== "hello bun") {
    throw new Error(`unexpected list response: ${JSON.stringify(body)}`)
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
    port: requestPort,
    rateLimit: { first: first.blocked === null, second: second.blocked?.policy }
  }
}).pipe(
  Effect.scoped,
  Effect.ensuring(
    Effect.sync(() => {
      blocker.stop(true)
      rmSync(dir, { recursive: true, force: true })
    })
  ),
  Effect.ensuring(Effect.promise(() => startedSmtp.close()))
)

type SmokeResult = {
  readonly http: { readonly listed: number; readonly created: number; readonly dashboard: number }
  readonly thumbnailBytes: number
  readonly native: {
    readonly password: string
    readonly uuidVersion: string
    readonly hmac: string
    readonly thumbnail: {
      readonly contain: string
      readonly fill: string
      readonly cover: string
      readonly strictNative: boolean
      readonly pixelGuard: boolean
    }
  }
  readonly emailReceived: number
  readonly storage: { readonly key: string; readonly listed: number }
  readonly port: number
  readonly rateLimit: { readonly first: boolean; readonly second: string | undefined }
}

await Effect.runPromise(program as Effect.Effect<SmokeResult, unknown, never>).then(
  (result) => {
    console.log(JSON.stringify({ ok: true, ...result }, null, 2))
  },
  (error) => {
    console.error(error)
    process.exitCode = 1
  }
)
