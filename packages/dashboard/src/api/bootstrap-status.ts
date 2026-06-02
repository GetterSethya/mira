import { Effect } from "effect"
import { HttpServerResponse } from "@effect/platform"
import { Repository } from "@gettersethya/mira"

export const bootstrapStatusRoute = Effect.gen(function* () {
  const repo = yield* Repository
  const rows = yield* repo.list("_superadmin", 1).pipe(
    Effect.map((r) => r.items),
    Effect.orElseSucceed(() => [])
  )
  const hasAdmin = rows.length > 0
  return HttpServerResponse.unsafeJson({
    bootstrapped: hasAdmin,
    message: hasAdmin ? undefined : "No superadmin found. Register the first superadmin account."
  })
})
