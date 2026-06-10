import * as jose from "jose"
import { Data, Effect, Redacted, Schema } from "effect"
import { HttpServerRequest } from "@effect/platform"
import { AppConfig } from "@gettersethya/mira"

export class DashboardUnauthorizedError extends Data.TaggedError("DashboardUnauthorizedError")<{}> {}

export type DashboardJwtPayload = {
  readonly sub: string
  readonly email: string
  readonly role: string
  readonly col: string
}

export function signDashboardJwt(payload: DashboardJwtPayload, secret: string) {
  return Effect.tryPromise({
    try: async () => {
      const encoder = new TextEncoder()
      return await new jose.SignJWT({ sub: payload.sub, email: payload.email, role: payload.role, col: payload.col })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt()
        .setExpirationTime("7d")
        .sign(encoder.encode(secret))
    },
    catch: () => new DashboardUnauthorizedError()
  })
}

const VerifyDashboardJwtSchema = Schema.Struct({
  sub: Schema.String,
  email: Schema.String,
  role: Schema.String
})

function verifyDashboardJwt(token: string, secret: string) {
  return Effect.gen(function* () {
    const { payload } = yield* Effect.tryPromise({
      try: async () => {
        const encoder = new TextEncoder()
        return await jose.jwtVerify(token, encoder.encode(secret))
      },
      catch: () => new DashboardUnauthorizedError()
    })

    const result = yield* Schema.decodeUnknown(VerifyDashboardJwtSchema)({
      sub: payload.sub,
      email: payload["email"],
      role: payload["role"]
    }).pipe(Effect.catchTag("ParseError", () => new DashboardUnauthorizedError()))

    return result
  })
}

export const requireDashboardAuth = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest
  const authHeader = req.headers["authorization"]
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return yield* new DashboardUnauthorizedError()
  }
  const token = authHeader.slice(7)
  const config = yield* AppConfig
  const payload = yield* verifyDashboardJwt(token, Redacted.value(config.jwtSecret))
  if (payload.role !== "superadmin") {
    return yield* new DashboardUnauthorizedError()
  }
  return payload
})
