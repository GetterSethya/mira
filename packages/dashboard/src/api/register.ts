import { Effect, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { CollectionService } from "@gettersethya/mira"
import { getRegisterToken } from "../superadmin.js"
import { SuperAdminCollection } from "../superadmin.js"

const RegisterBodySchema = Schema.Struct({
  email: Schema.String,
  password: Schema.String,
  name: Schema.String,
  token: Schema.String
})

const adminCtx = { headers: {}, query: {}, admin: true as const }

export const registerRoute = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest
  const body = yield* req.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(RegisterBodySchema)))
  const svc = yield* CollectionService

  if (body.token !== getRegisterToken()) {
    return HttpServerResponse.jsonUnsafe({ error: "invalid_token" }, { status: 403 })
  }

  const bootstrapped = yield* svc
    .list(SuperAdminCollection, null, 1, adminCtx)
    .pipe(Effect.orElseSucceed(() => ({ items: [] as ReadonlyArray<Record<string, unknown>> })))

  if (bootstrapped.items.length > 0) {
    return HttpServerResponse.jsonUnsafe({ error: "already_bootstrapped" }, { status: 403 })
  }

  const record = yield* svc.create(
    SuperAdminCollection,
    {
      email: body.email,
      password: body.password,
      name: body.name
    },
    adminCtx
  )

  return HttpServerResponse.jsonUnsafe({ id: record["id"], email: record["email"] }, { status: 201 })
})
