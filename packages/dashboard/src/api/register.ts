import { Effect, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { Repository, hashPassword } from "@gettersethya/mira"
import { getRegisterToken } from "../superadmin.js"

const RegisterBodySchema = Schema.Struct({
  email: Schema.String,
  password: Schema.String,
  token: Schema.String
})

export const registerRoute = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest
  const body = yield* req.json.pipe(Effect.flatMap(Schema.decodeUnknown(RegisterBodySchema)))
  const repo = yield* Repository

  if (body.token !== getRegisterToken()) {
    return HttpServerResponse.unsafeJson({ error: "invalid_token" }, { status: 403 })
  }

  const existing = yield* repo
    .viewFilter("_superadmin", { where: { sql: "email = ?", params: [body.email] } })
    .pipe(Effect.orElseSucceed(() => []))

  if (existing.length > 0) {
    return HttpServerResponse.unsafeJson({ error: "email_taken" }, { status: 409 })
  }

  const hashedPassword = yield* hashPassword(body.password)
  const record = yield* repo.create("_superadmin", {
    email: body.email,
    password: hashedPassword
  })

  return HttpServerResponse.unsafeJson({ id: record["id"], email: record["email"] }, { status: 201 })
})
