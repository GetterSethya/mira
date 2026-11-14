import { SMTPServer } from "smtp-server"
import { describe, it } from "@effect/vitest"
import { Effect, Exit, Layer, Option, Redacted } from "effect"
import { expect } from "vitest"

import { AppConfig } from "@/config/index.js"
import { EmailService, SmtpEmail } from "@/email/index.js"
import { NodeAuthServiceLayer } from "@/http/auth-node.js"
import { NodePlatformLayer } from "@/platforms/node.js"

interface FakeSmtp {
  readonly port: number
  readonly raw: () => string
  readonly close: () => Promise<void>
}

const startFakeSmtp = () =>
  Effect.tryPromise({
    try: () =>
      new Promise<FakeSmtp>((resolve, reject) => {
        let captured = ""
        const server = new SMTPServer({
          authOptional: true,
          disabledCommands: ["STARTTLS"],
          onData(stream, _session, callback) {
            const chunks: Array<Buffer> = []
            stream.on("data", (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)))
            stream.on("end", () => {
              captured = Buffer.concat(chunks).toString("utf8")
              callback()
            })
            stream.on("error", (error) => callback(error))
          }
        })
        server.on("error", reject)
        server.listen(0, "127.0.0.1", () => {
          const address = server.server.address()
          if (address === null || typeof address === "string") {
            reject(new Error("No TCP address"))
            return
          }
          resolve({
            port: address.port,
            raw: () => captured,
            close: () => new Promise<void>((done) => server.close(() => done()))
          })
        })
      }),
    catch: (error) => error
  })

const withSmtp = <A, E, R>(use: (smtp: FakeSmtp) => Effect.Effect<A, E, R>) =>
  Effect.acquireRelease(startFakeSmtp(), (smtp) => Effect.promise(() => smtp.close())).pipe(
    Effect.flatMap(use),
    Effect.scoped
  )

const AppConfigTest = Layer.succeed(
  AppConfig,
  AppConfig.of({
    appName: "test",
    port: 8080,
    applicationUrl: "http://localhost:8080",
    jwtSecret: Redacted.make("test-secret"),
    useS3: false,
    s3Config: Option.none(),
    logRetentionDays: 30
  })
)

const makeLayer = (port: number) =>
  SmtpEmail({
    host: "127.0.0.1",
    port,
    secure: false,
    from: "Mira <no-reply@mira.local>"
  }).layer.pipe(
    Layer.provide(Layer.mergeAll(NodePlatformLayer, NodeAuthServiceLayer)),
    Layer.provide(AppConfigTest)
  )

describe("SmtpEmail", () => {
  it.effect("verifies and sends text + html through a local SMTP server", () =>
    withSmtp((smtp) =>
      Effect.gen(function* () {
        const email = yield* EmailService
        expect(email.enabled).toBe(true)
        const description = email.describe()
        expect(description.transport).toBe("smtp")
        expect(description.host).toBe("127.0.0.1")
        expect(description.passwordResetUrl).toContain("{{token}}")

        yield* email.verify()
        const result = yield* email.send(
          {
            to: "agent@email.com",
            subject: "Mira SMTP test",
            text: "Plain text body",
            html: "<p>HTML body</p>"
          },
          { purpose: "custom" }
        )
        expect(result.accepted).toContain("agent@email.com")
        const raw = smtp.raw()
        expect(raw).toContain("Subject: Mira SMTP test")
        expect(raw).toContain("Plain text body")
        expect(raw).toContain("HTML body")
      }).pipe(Effect.provide(makeLayer(smtp.port)))
    )
  )

  it.effect("maps a refused connection to EmailSendError", () =>
    Effect.gen(function* () {
      const email = yield* EmailService
      const result = yield* email
        .send(
          { to: "agent@email.com", subject: "fail", text: "fail" },
          { purpose: "custom" }
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
    }).pipe(Effect.provide(makeLayer(1)))
  )
})
