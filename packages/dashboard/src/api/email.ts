import { Effect, Redacted, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import {
  AppConfig,
  EmailRateLimitConfig,
  EmailService,
  RateLimitKeySecret,
  RateLimiter,
  RateLimitedError,
  rateLimitKey,
  RateLimitUnavailableError
} from "@gettersethya/mira"
import { requireDashboardAuth } from "./auth.js"

const TestEmailBody = Schema.Struct({
  to: Schema.optional(Schema.String)
})

const rateLimited = (seconds: number, scope: "request" | "send" | "cooldown" = "request") =>
  HttpServerResponse.jsonUnsafe(
    { error: "rate_limited", retryAfterSeconds: Math.max(1, seconds), scope },
    { status: 429 }
  ).pipe(HttpServerResponse.setHeader("Retry-After", String(Math.max(1, seconds))))

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

  const email = yield* EmailService
  if (!email.enabled) {
    return HttpServerResponse.jsonUnsafe({ error: "email_not_configured" }, { status: 503 })
  }

  const limiter = yield* RateLimiter
  const policies = yield* EmailRateLimitConfig
  const secret = Redacted.value(yield* RateLimitKeySecret)
  const key = yield* rateLimitKey(secret, `superadmin:${auth.sub}`).pipe(
    Effect.catchTag("RateLimitUnavailableError", () => Effect.succeed(null))
  )
  if (key !== null) {
    const decision = yield* limiter
      .consume(policies.dashboardTestEmail, key)
      .pipe(Effect.catchTag("RateLimitUnavailableError", () => Effect.succeed(null)))
    if (decision !== null && decision.blocked !== null) {
      return rateLimited(decision.blocked.retryAfterSeconds)
    }
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
      Effect.catchTags({
        RateLimitedError: (error) =>
          Effect.succeed(rateLimited(error.retryAfterSeconds, error.scope)),
        RateLimitUnavailableError: () =>
          Effect.succeed(
            HttpServerResponse.jsonUnsafe({ error: "rate_limit_unavailable" }, { status: 503 })
          ),
        EmailNotConfiguredError: () =>
          Effect.succeed(
            HttpServerResponse.jsonUnsafe({ error: "email_not_configured" }, { status: 503 })
          ),
        EmailSendError: () =>
          Effect.succeed(
            HttpServerResponse.jsonUnsafe({ error: "email_unavailable" }, { status: 502 })
          )
      })
    )
})
