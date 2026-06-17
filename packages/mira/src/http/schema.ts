import { Effect } from "effect"
import { HttpServerResponse } from "@effect/platform"
import type { AnyCollectionDef, JsonSchemaProperty } from "@gettersethya/mira-client"

function visibleFields(properties: Record<string, JsonSchemaProperty>): Record<string, JsonSchemaProperty> {
  return Object.fromEntries(Object.entries(properties).filter(([, p]) => !p["x-hidden"]))
}

export function makeSchemaRoute(collections: ReadonlyArray<AnyCollectionDef>) {
  return Effect.gen(function* () {
    const schemas = collections.map((c) => ({
      name: c.name,
      kind: c.schema["x-collection-kind"],
      fields: visibleFields(c.schema.properties),
      required: c.schema.required,
      indexes: c.schema["x-indexes"],
      rules: c.schema["x-rules"],
      viewQuery: c.schema["x-view-query"],
    }))
    return HttpServerResponse.unsafeJson(schemas, { status: 200 })
  })
}
