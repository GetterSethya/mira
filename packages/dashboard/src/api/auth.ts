import * as jose from "jose"
import { Data, Effect, Redacted } from "effect"
import { HttpServerRequest } from "@effect/platform"
import { AppConfig } from "@gettersethya/mira"

export class DashboardUnauthorizedError extends Data.TaggedError("DashboardUnauthorizedError")<{}> {}

export type DashboardJwtPayload = {
  readonly sub: string
  readonly email: string
  readonly role: string
}

export function signDashboardJwt(payload: DashboardJwtPayload, secret: string) {
  return Effect.tryPromise({
    try: async () => {
      const encoder = new TextEncoder()
      return await new jose.SignJWT({ sub: payload.sub, email: payload.email, role: payload.role })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt()
        .setExpirationTime("7d")
        .sign(encoder.encode(secret))
    },
    catch: () => new DashboardUnauthorizedError(),
  })
}

function verifyDashboardJwt(token: string, secret: string) {
  return Effect.tryPromise({
    try: async () => {
      const encoder = new TextEncoder()
      const { payload } = await jose.jwtVerify(token, encoder.encode(secret))
      const sub = payload.sub
      const email = payload["email"]
      const role = payload["role"]
      if (typeof sub !== "string" || typeof email !== "string" || typeof role !== "string") {
        throw new Error("invalid payload")
      }
      return { sub, email, role }
    },
    catch: () => new DashboardUnauthorizedError(),
  })
}

export const requireDashboardAuth = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest
  const authHeader = req.headers["authorization"]
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return yield* Effect.fail(new DashboardUnauthorizedError())
  }
  const token = authHeader.slice(7)
  const config = yield* AppConfig
  const payload = yield* verifyDashboardJwt(token, Redacted.value(config.jwtSecret))
  if (payload.role !== "superadmin") {
    return yield* Effect.fail(new DashboardUnauthorizedError())
  }
  return payload
})
