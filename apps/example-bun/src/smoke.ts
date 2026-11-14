import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { SMTPServer } from "smtp-server"
import { Context, Effect, Layer, Stream } from "effect"
import {
  AppConfig,
  BaseCollection,
  BunPlatform,
  BunSqliteDatabase,
  defineRule,
  EmailService,
  Field,
  FileStorage,
  LocalFileStorage,
  Mira,
  parseThumbSpec,
  RateLimiter,
  SmtpEmail,
  ThumbnailService
} from "@gettersethya/mira/bun"
import { MiraDashboard } from "@gettersethya/mira-dashboard"

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

  const thumbnail = Context.get(context, ThumbnailService)
  const spec = parseThumbSpec("2x2")
  if (spec === null) throw new Error("invalid thumb spec")
  const resized = yield* thumbnail.resize(png, "image/png", spec)
  if (resized.length === 0) throw new Error("thumbnail output is empty")

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
    thumbnailBytes: resized.length,
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
