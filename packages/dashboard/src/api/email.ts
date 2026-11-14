import { Effect, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { AppConfig, EmailService } from "@gettersethya/mira"
import { requireDashboardAuth } from "./auth.js"

const TestEmailBody = Schema.Struct({
  to: Schema.optional(Schema.String)
})

const testEmailRate = new Map<string, Array<number>>()

const rateLimited = (sub: string) => {
  const now = Date.now()
  const recent = (testEmailRate.get(sub) ?? []).filter((at) => at > now - 60 * 60 * 1000)
  if (recent.length >= 5) return true
  recent.push(now)
  testEmailRate.set(sub, recent)
  return false
}

export const emailTestRoute = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest
  const body = yield* req.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(TestEmailBody)))
  const auth = yield* requireDashboardAuth
  const ownEmail = auth.record["email"]
  if (typeof ownEmail !== "string" || ownEmail.length === 0) {
    return HttpServerResponse.jsonUnsafe({ error: "no_email" }, { status: 400 })
  }
  if (body.to !== undefined && body.to !== ownEmail) {
    return HttpServerResponse.jsonUnsafe({ error: "forbidden" }, { status: 403 })
  }
  if (rateLimited(auth.sub)) {
    return HttpServerResponse.jsonUnsafe({ error: "rate_limited" }, { status: 429 })
  }

  const email = yield* EmailService
  if (!email.enabled) {
    return HttpServerResponse.jsonUnsafe({ error: "email_not_configured" }, { status: 503 })
  }
  const config = yield* AppConfig
  return yield* email
    .send(
      {
        to: ownEmail,
        subject: `${config.appName} test email`,
        text: "This is a test email from the Mira dashboard.",
        html: "<p>This is a test email from the Mira dashboard.</p>"
      },
      { purpose: "custom" }
    )
    .pipe(
      Effect.as(HttpServerResponse.jsonUnsafe({ ok: true }, { status: 202 })),
      Effect.catchTag("EmailNotConfiguredError", () =>
        Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "email_not_configured" }, { status: 503 }))
      ),
      Effect.catchTag("EmailSendError", () =>
        Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "email_unavailable" }, { status: 502 }))
      )
    )
})
