import { Effect, Redacted, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { AppConfig, Repository, verifyPassword } from "@gettersethya/mira"
import { signDashboardJwt } from "./auth.js"

const LoginBodySchema = Schema.Struct({
  email: Schema.String,
  password: Schema.String,
})

export const loginRoute = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest
  const body = yield* req.json.pipe(Effect.flatMap(Schema.decodeUnknown(LoginBodySchema)))
  const repo = yield* Repository

  const records = yield* repo
    .viewFilter("_superadmin", { where: { sql: "email = ?", params: [body.email] } })
    .pipe(Effect.orElseSucceed(() => []))

  if (records.length === 0) {
    return HttpServerResponse.unsafeJson({ error: "invalid_credentials" }, { status: 401 })
  }

  const record = records[0]
  const passwordHash = String(record["password"] ?? "")
  const valid = yield* verifyPassword(body.password, passwordHash)

  if (!valid) {
    return HttpServerResponse.unsafeJson({ error: "invalid_credentials" }, { status: 401 })
  }

  const config = yield* AppConfig
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
  const token = yield* signDashboardJwt(
    { sub: String(record["id"]), email: body.email, role: "superadmin" },
    Redacted.value(config.jwtSecret)
  )

  return HttpServerResponse.unsafeJson({ token, expiresAt }, { status: 200 })
})
