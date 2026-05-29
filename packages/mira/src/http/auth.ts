import * as jose from "jose"
import { Context, Data, Effect } from "effect"

export type JwtPayload = { sub: string; col: string }
export type FileTokenPayload = { sub: string; col: string; filecol: string }

export class AuthError extends Data.TaggedError("AuthError")<{ reason: string }> {}

export class AuthService extends Context.Tag("AuthService")<
  AuthService,
  {
    hashPassword(plain: string): Effect.Effect<string>
    verifyPassword(plain: string, stored: string): Effect.Effect<boolean>
  }
>() {}

export const hashPassword = (plain: string) => Effect.flatMap(AuthService, (auth) => auth.hashPassword(plain))

export const verifyPassword = (plain: string, stored: string) =>
  Effect.flatMap(AuthService, (auth) => auth.verifyPassword(plain, stored))

export function signJwt(payload: JwtPayload, secret: string) {
  return Effect.tryPromise({
    try: async () => {
      const encoder = new TextEncoder()
      return await new jose.SignJWT({ sub: payload.sub, col: payload.col })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt()
        .setExpirationTime("72h")
        .sign(encoder.encode(secret))
    },
    catch: (e) => new AuthError({ reason: String(e) })
  })
}

export function signFileToken(payload: FileTokenPayload, secret: string) {
  return Effect.tryPromise({
    try: async () => {
      const encoder = new TextEncoder()
      return await new jose.SignJWT({ sub: payload.sub, col: payload.col, filecol: payload.filecol })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(encoder.encode(secret))
    },
    catch: (e) => new AuthError({ reason: String(e) })
  })
}

export function verifyFileToken(token: string, secret: string) {
  return Effect.tryPromise({
    try: async () => {
      const encoder = new TextEncoder()
      const { payload } = await jose.jwtVerify(token, encoder.encode(secret))
      const sub = payload.sub
      const col = payload["col"]
      const filecol = payload["filecol"]
      if (typeof sub !== "string" || typeof col !== "string" || typeof filecol !== "string") {
        throw new Error("Missing sub, col, or filecol in file token")
      }
      return { sub, col, filecol }
    },
    catch: (e) => new AuthError({ reason: String(e) })
  })
}

export function verifyJwt(token: string, secret: string) {
  return Effect.tryPromise({
    try: async () => {
      const encoder = new TextEncoder()
      const { payload } = await jose.jwtVerify(token, encoder.encode(secret))
      const sub = payload.sub
      const col = payload["col"]
      if (typeof sub !== "string" || typeof col !== "string") {
        throw new Error("Missing sub or col in JWT")
      }
      return { sub, col }
    },
    catch: (e) => new AuthError({ reason: String(e) })
  })
}
