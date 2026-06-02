import { Effect } from "effect"
import { HttpServerResponse } from "@effect/platform"
import { CollectionService } from "@gettersethya/mira"
import { SuperAdminCollection } from "../superadmin.js"

export const bootstrapStatusRoute = Effect.gen(function* () {
  const svc = yield* CollectionService
  const result = yield* svc.list(SuperAdminCollection, null, 1, { headers: {}, query: {}, admin: true })
  const hasAdmin = result.items.length > 0
  return HttpServerResponse.unsafeJson({
    bootstrapped: hasAdmin,
    message: hasAdmin ? undefined : "No superadmin found. Register the first superadmin account."
  })
})
