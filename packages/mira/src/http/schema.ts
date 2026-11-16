import type { AnyCollectionDef } from "@gettersethya/mira-client"
import { Effect } from "effect"
import { HttpServerResponse } from "effect/http"

import { makeRuleSummary } from "./rule-summary.js"

/**
 * Normalizes `x-indexes` for the schema inspector.
 *
 * Auth collections always carry an injected unique `email` index; the dashboard
 * needs to distinguish it from operator-declared indexes, so it is marked
 * `system: true` here rather than in the serialized schema.
 */
const schemaIndexes = (collection: AnyCollectionDef) => {
  const kind = collection.schema["x-collection-kind"]
  return (collection.schema["x-indexes"] ?? []).map((index) => {
    const system =
      kind === "auth" && index.unique && index.fields.length === 1 && index.fields[0] === "email"
    return {
      fields: [...index.fields],
      unique: index.unique,
      ...(system ? { system: true } : {})
    }
  })
}

/**
 * The JSON payload of `GET /api/_schema`, extracted so tests and other callers
 * can inspect it without mounting an HTTP server.
 */
export function schemaSnapshot(collections: ReadonlyArray<AnyCollectionDef>) {
  return collections.map((c) => {
    const kind = c.schema["x-collection-kind"]
    const rules = c.schema["x-rules"]
    return {
      name: c.name,
      kind,
      // Annotations (x-system / x-hidden / x-generated / x-kind) are preserved
      // rather than pre-filtered so consumers (e.g. the dashboard) can decide
      // what to render: hidden fields in tables, generated fields nowhere,
      // write-only password fields in forms only.
      fields: c.schema.properties,
      required: c.schema.required,
      indexes: schemaIndexes(c),
      rules: rules ?? null,
      ruleSummary: makeRuleSummary(kind, rules),
      auth: c.schema["x-auth"],
      viewQuery: c.schema["x-view-query"]
    }
  })
}

export function makeSchemaRoute(collections: ReadonlyArray<AnyCollectionDef>) {
  return Effect.succeed(HttpServerResponse.jsonUnsafe(schemaSnapshot(collections), { status: 200 }))
}
