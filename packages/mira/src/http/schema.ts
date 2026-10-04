import type { AnyCollectionDef } from "@gettersethya/mira-client"
import { Effect } from "effect"
import { HttpServerResponse } from "effect/http"

export function makeSchemaRoute(collections: ReadonlyArray<AnyCollectionDef>) {
  const schemas = collections.map((c) => ({
    name: c.name,
    kind: c.schema["x-collection-kind"],
    // Annotations (x-system / x-hidden / x-generated / x-kind) are preserved
    // rather than pre-filtered so consumers (e.g. the dashboard) can decide
    // what to render: hidden fields in tables, generated fields nowhere,
    // write-only password fields in forms only.
    fields: c.schema.properties,
    required: c.schema.required,
    indexes: c.schema["x-indexes"],
    viewQuery: c.schema["x-view-query"],
  }))
  return Effect.succeed(HttpServerResponse.jsonUnsafe(schemas, { status: 200 }))
}
