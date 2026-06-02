import { Effect, Option, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { Repository, hashPassword } from "@gettersethya/mira"
import { requireDashboardAuth } from "./auth.js"

const CreateSuperadminSchema = Schema.Struct({
  email: Schema.String,
  password: Schema.String,
})

export const createSuperadminRoute = Effect.gen(function* () {
  yield* requireDashboardAuth

  const req = yield* HttpServerRequest.HttpServerRequest
  const body = yield* req.json.pipe(Effect.flatMap(Schema.decodeUnknown(CreateSuperadminSchema)))
  const repo = yield* Repository

  const existing = yield* repo
    .viewFilter("_superadmin", { where: { sql: "email = ?", params: [body.email] } })
    .pipe(Effect.orElseSucceed(() => []))

  if (existing.length > 0) {
    return HttpServerResponse.unsafeJson({ error: "email_taken" }, { status: 409 })
  }

  const hashedPassword = yield* hashPassword(body.password)
  const record = yield* repo.create("_superadmin", {
    email: body.email,
    password: hashedPassword,
  })

  return HttpServerResponse.unsafeJson({ id: record["id"], email: record["email"] }, { status: 201 })
})

export const listSuperadminsRoute = Effect.gen(function* () {
  yield* requireDashboardAuth

  const repo = yield* Repository
  const result = yield* repo.list("_superadmin", 500).pipe(Effect.orElseSucceed(() => ({ items: [] })))

  const items = result.items.map((r) => ({
    id: r["id"],
    email: r["email"],
    created: r["created"],
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

    const repo = yield* Repository

    const total = yield* repo
      .list("_superadmin", 2)
      .pipe(Effect.map((r) => r.items.length), Effect.orElseSucceed(() => 0))

    if (total <= 1) {
      return HttpServerResponse.unsafeJson({ error: "last_superadmin" }, { status: 409 })
    }

    const opt = yield* repo.delete("_superadmin", id).pipe(Effect.catchAll(() => Effect.succeed(Option.none())))
    if (Option.isNone(opt)) {
      return HttpServerResponse.unsafeJson({ error: "not_found" }, { status: 404 })
    }

    return HttpServerResponse.empty({ status: 204 })
  })
)
