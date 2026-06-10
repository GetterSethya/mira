import { Effect, Redacted, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { AppConfig, CollectionService, verifyPassword } from "@gettersethya/mira"
import { Filter } from "@gettersethya/mira-client"
import { signDashboardJwt } from "./auth.js"
import { SuperAdminCollection } from "../superadmin.js"

const LoginBodySchema = Schema.Struct({
  email: Schema.String,
  password: Schema.String
})

const adminCtx = { headers: {}, query: {}, admin: true as const }

export const loginRoute = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest
  const body = yield* req.json.pipe(Effect.flatMap(Schema.decodeUnknown(LoginBodySchema)))
  const svc = yield* CollectionService

  const result = yield* svc
    .list(SuperAdminCollection, null, 1, adminCtx, Filter.field("email").eq(body.email))
    .pipe(Effect.orElseSucceed(() => ({ items: [] as ReadonlyArray<Record<string, unknown>> })))

  if (result.items.length === 0) {
    return HttpServerResponse.unsafeJson({ error: "invalid_credentials" }, { status: 401 })
  }

  const record = result.items[0]
  const passwordHash = String(record["password"] ?? "")
  const valid = yield* verifyPassword(body.password, passwordHash)

  if (!valid) {
    return HttpServerResponse.unsafeJson({ error: "invalid_credentials" }, { status: 401 })
  }

  const config = yield* AppConfig
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
  const token = yield* signDashboardJwt(
    { sub: String(record["id"]), email: body.email, role: "superadmin", col: "_superadmin" },
    Redacted.value(config.jwtSecret)
  )

  return HttpServerResponse.unsafeJson({ token, expiresAt }, { status: 200 })
})
