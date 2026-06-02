import { Effect } from "effect"
import { HttpServerResponse } from "@effect/platform"
import type { AnyCollectionDef } from "@gettersethya/mira-client"
import { requireDashboardAuth } from "./auth.js"

export function makeSchemaRoute(collections: ReadonlyArray<AnyCollectionDef>) {
  return Effect.gen(function* () {
    yield* requireDashboardAuth

    const schemas = collections.map((c) => ({
      name: c.name,
      kind: c.schema["x-collection-kind"],
      fields: c.schema.properties,
      required: c.schema.required,
      indexes: c.schema["x-indexes"],
      rules: c.schema["x-rules"],
      viewQuery: c.schema["x-view-query"],
    }))
    return HttpServerResponse.unsafeJson(schemas, { status: 200 })
  })
}
