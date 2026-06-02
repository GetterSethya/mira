import { Effect, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { CollectionService, hashPassword } from "@gettersethya/mira"
import { Filter } from "@gettersethya/mira-client"
import { requireDashboardAuth } from "./auth.js"
import { SuperAdminCollection } from "../superadmin.js"

const CreateSuperadminSchema = Schema.Struct({
  email: Schema.String,
  password: Schema.String,
})

const adminCtx = { headers: {}, query: {}, admin: true as const }

export const createSuperadminRoute = Effect.gen(function* () {
  yield* requireDashboardAuth

  const req = yield* HttpServerRequest.HttpServerRequest
  const body = yield* req.json.pipe(Effect.flatMap(Schema.decodeUnknown(CreateSuperadminSchema)))
  const svc = yield* CollectionService

  const existing = yield* svc
    .list(SuperAdminCollection, null, 1, adminCtx, Filter.field("email").eq(body.email))
    .pipe(Effect.orElseSucceed(() => ({ items: [] as ReadonlyArray<Record<string, unknown>> })))

  if (existing.items.length > 0) {
    return HttpServerResponse.unsafeJson({ error: "email_taken" }, { status: 409 })
  }

  const hashedPassword = yield* hashPassword(body.password)
  const record = yield* svc.create(SuperAdminCollection, {
    email: body.email,
    password: hashedPassword,
  }, adminCtx)

  return HttpServerResponse.unsafeJson({ id: record["id"], email: record["email"] }, { status: 201 })
})

export const listSuperadminsRoute = Effect.gen(function* () {
  yield* requireDashboardAuth

  const svc = yield* CollectionService
  const result = yield* svc.list(SuperAdminCollection, null, 500, adminCtx)

  const items = result.items.map((r) => ({
    id: String(r["id"]),
    email: String(r["email"]),
    created: String(r["created"]),
  }))

  return HttpServerResponse.unsafeJson({ items }, { status: 200 })
})

export const deleteSuperadminRoute = Effect.flatMap(HttpRouter.RouteContext, (routeCtx) =>
  Effect.gen(function* () {
    yield* requireDashboardAuth

    const id = routeCtx.params["id"]
    if (id === undefined) {
      return HttpServerResponse.unsafeJson({ error: "not_found" }, { status: 404 })
    }

    const svc = yield* CollectionService

    const total = yield* svc
      .list(SuperAdminCollection, null, 2, adminCtx)
      .pipe(Effect.map((r) => r.items.length), Effect.orElseSucceed(() => 0))

    if (total <= 1) {
      return HttpServerResponse.unsafeJson({ error: "last_superadmin" }, { status: 409 })
    }

    yield* svc.delete(SuperAdminCollection, id, adminCtx).pipe(Effect.catchAll(() => Effect.void))

    return HttpServerResponse.empty({ status: 204 })
  })
)
