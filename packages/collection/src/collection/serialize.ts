import type { RuleMap } from "@/rule/types.js"
import type { IndexEntry } from "./index-builder.js"
import type { CollectionSchema, FieldDef, FieldsMap, JsonSchemaProperty } from "./types.js"

const ID_PROPERTY: JsonSchemaProperty = {
  type: "string",
  "x-system": true
}

const SEQID_PROPERTY: JsonSchemaProperty = {
  type: "integer",
  "x-kind": "seqId",
  "x-system": true,
  "x-hidden": true
}

const CREATED_PROPERTY: JsonSchemaProperty = {
  type: "string",
  "x-system": true
}

const UPDATED_PROPERTY: JsonSchemaProperty = {
  type: "string",
  "x-system": true
}

/**
 * Converts a user-facing field definition map into a JSON Schema `CollectionSchema`.
 *
 * - Automatically injects `seqId` as the first property.
 - Injects system fields (e.g., auth email/password) before user fields.
 - Collects `required` from fields without defaults.
 - Normalizes `unique`/`indexed` flags into `x-indexes`.
 - Merges collection-level indexes from `options.indexes`.
 - Passes through `x-rules` and `x-view-query` if provided.
 *
 * Used internally by `BaseCollection.define()`, `AuthCollection.define()`, and `ViewCollection.define()`.
 */
export function toJSONSchema<K extends "base" | "auth" | "view">(
  kind: K,
  _name: string,
  fields: FieldsMap,
  options: {
    indexes?: Array<IndexEntry<string>>
    rules?: RuleMap
    viewQuery?: string
    systemFields?: Record<string, JsonSchemaProperty>
  }
): CollectionSchema & { "x-collection-kind": K } {
  const xIndexes: Array<{ fields: Array<string>; unique: boolean }> = []
  const required: Array<string> = []
  const properties: Record<string, JsonSchemaProperty> = {}

  for (const [key, prop] of Object.entries(options.systemFields ?? {})) {
    if (prop.default === undefined) {
      required.push(key)
    }
  }

  for (const [key, field] of Object.entries(fields)) {
    const name = field.name ?? key

    const prop = fieldToProperty(field)

    if (field.required !== false && field.default === undefined) {
      required.push(name)
    }

    if (field.unique) {
      xIndexes.push({ fields: [name], unique: true })
    }
    if (field.indexed) {
      xIndexes.push({ fields: [name], unique: false })
    }

    properties[name] = prop
  }

  for (const idx of options.indexes ?? []) {
    xIndexes.push({ fields: [...idx.fields], unique: idx.unique })
  }

  const result: CollectionSchema & { "x-collection-kind": K } = {
    "x-collection-kind": kind,
    ...(xIndexes.length > 0 ? { "x-indexes": xIndexes } : {}),
    ...(options.rules !== undefined ? { "x-rules": options.rules } : {}),
    ...(options.viewQuery !== undefined ? { "x-view-query": options.viewQuery } : {}),
    type: "object",
    properties: {
      ...(kind !== "view" ? { id: ID_PROPERTY, seqId: SEQID_PROPERTY } : {}),
      ...(options.systemFields ?? {}),
      ...properties,
      ...(kind !== "view" ? { created: CREATED_PROPERTY, updated: UPDATED_PROPERTY } : {})
    },
    ...(required.length > 0 ? { required } : {})
  }

  return result
}

/** Converts a single `FieldDef` to its JSON Schema property representation. */
function fieldToProperty(field: FieldDef): JsonSchemaProperty {
  const base: JsonSchemaProperty = (() => {
    switch (field.kind) {
    case "text":
      return {
        type: "string",
        ...(field.minLength !== undefined ? { minLength: field.minLength } : {}),
        ...(field.maxLength !== undefined ? { maxLength: field.maxLength } : {})
      }
    case "literalText":
      return {
        type: "string",
        "x-kind": "literalText",
        ...(field.literal !== undefined ? { "x-literal": field.literal } : {})
      }
    case "number":
      return {
        type: "number",
        ...(field.min !== undefined ? { minimum: field.min } : {}),
        ...(field.max !== undefined ? { maximum: field.max } : {})
      }
    case "integer":
      return {
        type: "integer",
        ...(field.min !== undefined ? { minimum: field.min } : {}),
        ...(field.max !== undefined ? { maximum: field.max } : {})
      }
    case "boolean":
      return {
        type: "boolean",
        ...(field.default !== undefined ? { default: field.default } : {})
      }
    case "email":
      return { type: "string", format: "email" }
    case "date":
      return { type: "string", "x-kind": "date" }
    case "json":
      return { "x-kind": "json" }
    case "relation":
      return {
        type: "string",
        "x-kind": "relation",
        "x-collection": field.targetCollection!,
        "x-field": field.targetField ?? "id"
      }
    case "seqId":
      return { type: "integer", "x-kind": "seqId", "x-system": true }
    case "file":
      return {
        type: "string",
        "x-kind": "file",
        ...(field.maxSize !== undefined ? { "x-maxSize": field.maxSize } : {}),
        ...(field.mimeTypes !== undefined ? { "x-mimeTypes": field.mimeTypes } : {}),
        ...(field.protected === true ? { "x-protected": true } : {})
      }
  }
  })()
  return field.viewOnly ? { ...base, "x-view-only": true } : base
}
