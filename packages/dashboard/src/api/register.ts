import { Effect, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { CollectionService, hashPassword } from "@gettersethya/mira"
import { getRegisterToken } from "../superadmin.js"
import { SuperAdminCollection } from "../superadmin.js"

const RegisterBodySchema = Schema.Struct({
  email: Schema.String,
  password: Schema.String,
  token: Schema.String
})

const adminCtx = { headers: {}, query: {}, admin: true as const }

export const registerRoute = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest
  const body = yield* req.json.pipe(Effect.flatMap(Schema.decodeUnknown(RegisterBodySchema)))
  const svc = yield* CollectionService

  if (body.token !== getRegisterToken()) {
    return HttpServerResponse.unsafeJson({ error: "invalid_token" }, { status: 403 })
  }

  const bootstrapped = yield* svc
    .list(SuperAdminCollection, null, 1, adminCtx)
    .pipe(Effect.orElseSucceed(() => ({ items: [] as ReadonlyArray<Record<string, unknown>> })))

  if (bootstrapped.items.length > 0) {
    return HttpServerResponse.unsafeJson({ error: "already_bootstrapped" }, { status: 403 })
  }

  const hashedPassword = yield* hashPassword(body.password)
  const record = yield* svc.create(
    SuperAdminCollection,
    {
      email: body.email,
      password: hashedPassword
    },
    adminCtx
  )

  return HttpServerResponse.unsafeJson({ id: record["id"], email: record["email"] }, { status: 201 })
})
