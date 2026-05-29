/**
 * The kind of constraint that failed validation on a field.
 * Passed to the `error` callback on `FieldDef` so callers can return
 * a per-constraint custom message.
 */
export type ConstraintKind =
  | "type"       // value has wrong JS type
  | "required"   // field is absent but required (create mode only)
  | "minLength"  // string shorter than minLength
  | "maxLength"  // string longer than maxLength
  | "email"      // string fails email format check
  | "minimum"    // number/integer below minimum
  | "maximum"    // number/integer above maximum
  | "int"        // number is not an integer
  | "literal"    // value not in the allowed set

/** Constraint kinds that can fire on a `Field.text()` field. */
export type TextConstraintKind = "type" | "required" | "minLength" | "maxLength"

/** Constraint kinds that can fire on a `Field.email()` field. */
export type EmailConstraintKind = "type" | "required" | "email"

/** Constraint kinds that can fire on a `Field.number()` field. */
export type NumberConstraintKind = "type" | "required" | "minimum" | "maximum"

/** Constraint kinds that can fire on a `Field.integer()` field. */
export type IntegerConstraintKind = "type" | "required" | "int" | "minimum" | "maximum"

/** Constraint kinds that can fire on a `Field.literalText()` field. */
export type LiteralTextConstraintKind = "type" | "required" | "literal"

/** Constraint kinds that can fire on simple fields (boolean, date, json, file, relation). */
export type SimpleConstraintKind = "type" | "required"

/** Supported field kinds that define the data type of a collection field. */
export type FieldKind =
  | "text"
  | "literalText"
  | "number"
  | "integer"
  | "boolean"
  | "email"
  | "date"
  | "json"
  | "relation"
  | "file"
  | "seqId"

/**
 * Describes a single field in a collection definition.
 * Created via `Field.*()` builders — never constructed directly.
 *
 * @example
 * Field.text({ maxLength: 200 })
 * Field.relation(Users, { field: "id" })
 */
export type FieldDef = {
  _tag: "FieldDef"
  kind: FieldKind
  name?: string
  required?: boolean
  unique?: boolean
  indexed?: boolean
  default?: unknown
  minLength?: number
  maxLength?: number
  min?: number
  max?: number
  targetCollection?: string
  targetField?: string
  maxSize?: number
  mimeTypes?: Array<string>
  viewOnly?: boolean
  protected?: boolean
  literal?: readonly string[]
  _literal?: readonly string[]
  _target?: AnyCollectionDef
  error?(kind: ConstraintKind): string | undefined
}

/** A database index on one or more fields, either unique or non-unique. */
export type IndexDef = {
  fields: Array<string>
  unique: boolean
}

import type { RuleMap } from "@/rule/types.js"

/**
 * The JSON Schema representation of a collection.
 * This is the serialized format stored in the `_collections` table.
 * TypeScript field definitions are compiled down to this format.
 */
export type CollectionSchema = {
  "x-collection-kind": "base" | "auth" | "view"
  "x-indexes"?: Array<IndexDef>
  "x-rules"?: RuleMap
  "x-view-query"?: string
  type: "object"
  properties: Record<string, JsonSchemaProperty>
  required?: Array<string>
}

/** A single property within a JSON Schema collection definition. */
export type JsonSchemaProperty = {
  type?: "string" | "number" | "integer" | "boolean"
  format?: "email"
  default?: unknown
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  "x-kind"?: "date" | "json" | "relation" | "file" | "seqId" | "literalText"
  "x-collection"?: string
  "x-field"?: string
  "x-maxSize"?: number
  "x-mimeTypes"?: Array<string>
  "x-protected"?: boolean
  "x-system"?: boolean
  "x-hidden"?: boolean
  "x-view-only"?: boolean
  "x-literal"?: ReadonlyArray<string>
}

/**
 * A record mapping field names to their `FieldDef` definitions.
 * Used when defining collection fields.
 *
 * @example
 * { title: Field.text(), published: Field.boolean() }
 */
export type FieldsMap = Record<string, FieldDef>

/**
 * The user-facing output of a collection definition.
 * Returned by `BaseCollection.define()`, `AuthCollection.define()`, and `ViewCollection.define()`.
 */
export type AnyCollectionDef = {
  name: string
  fields: FieldsMap
  schema: CollectionSchema
}

/** Maps each FieldKind to its corresponding TypeScript scalar type. */
export type FieldKindToType = {
  text:     string
  literalText: string
  number:   number
  integer:  number
  boolean:  boolean
  email:    string
  date:     string
  json:     unknown
  relation: string
  file:     string
  seqId:    number
}

/** Infers the TypeScript value type for a given FieldDef. */
export type InferFieldValue<T extends FieldDef> =
  T["kind"] extends "literalText"
    ? T extends { _literal: readonly (infer V)[] } ? V : string
    : FieldKindToType[T["kind"]]
