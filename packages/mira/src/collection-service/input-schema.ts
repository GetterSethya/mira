import type { AnyCollectionDef, ConstraintKind, FieldDef, JsonSchemaProperty } from "@gettersethya/mira-client"
import { Schema, SchemaIssue } from "effect"

import type { RepoRecord } from "@/repository/types.js"

import { ValidationError } from "./errors.js"

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export type InputSchemas = {
  create: Schema.Codec<RepoRecord, RepoRecord>
  update: Schema.Codec<RepoRecord, RepoRecord>
}

function filterAnnotations(
  kind: ConstraintKind,
  errorFn: ((kind: ConstraintKind) => string | undefined) | undefined
): { message: string } | undefined {
  if (errorFn === undefined) return undefined
  const msg = errorFn(kind)
  if (msg === undefined) return undefined
  return { message: msg }
}

function propertyToSchema(prop: JsonSchemaProperty, fieldDef: FieldDef | undefined): Schema.Codec<unknown, unknown> {
  const errorFn = fieldDef?.error

  if (prop["x-kind"] === "literalText") {
    const typeMsg = errorFn?.("type")
    const base = typeMsg !== undefined
      ? Schema.String.annotate({ message: typeMsg })
      : Schema.String
    const literalValues = prop["x-literal"]
    if (literalValues && literalValues.length > 0) {
      const literalSet = new Set(literalValues)
      return base.pipe(
        Schema.check(
          Schema.makeFilter(
            (a: string): boolean => literalSet.has(a),
            filterAnnotations("literal", errorFn)
          )
        )
      )
    }
    return base
  }

  if (prop["x-kind"] === "json") return Schema.Unknown
  if (
    prop["x-kind"] === "date" ||
    prop["x-kind"] === "relation" ||
    prop["x-kind"] === "file"
  ) return Schema.String

  if (prop.type === "string") {
    const typeMsg = errorFn?.("type")
    const base = typeMsg !== undefined
      ? Schema.String.annotate({ message: typeMsg })
      : Schema.String
    let s = base
    if (prop.format === "email") {
      s = s.pipe(Schema.check(Schema.isPattern(EMAIL_RE, filterAnnotations("email", errorFn))))
    }
    if (prop.minLength !== undefined) {
      s = s.pipe(Schema.check(Schema.isMinLength(prop.minLength, filterAnnotations("minLength", errorFn))))
    }
    if (prop.maxLength !== undefined) {
      s = s.pipe(Schema.check(Schema.isMaxLength(prop.maxLength, filterAnnotations("maxLength", errorFn))))
    }
    return s
  }

  if (prop.type === "integer") {
    const typeMsg = errorFn?.("type")
    const base = typeMsg !== undefined
      ? Schema.Number.annotate({ message: typeMsg })
      : Schema.Number
    let s = base.pipe(Schema.check(Schema.isInt(filterAnnotations("int", errorFn))))
    if (prop.minimum !== undefined) {
      s = s.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(prop.minimum, filterAnnotations("minimum", errorFn))))
    }
    if (prop.maximum !== undefined) {
      s = s.pipe(Schema.check(Schema.isLessThanOrEqualTo(prop.maximum, filterAnnotations("maximum", errorFn))))
    }
    return s
  }

  if (prop.type === "number") {
    const typeMsg = errorFn?.("type")
    const base = typeMsg !== undefined
      ? Schema.Number.annotate({ message: typeMsg })
      : Schema.Number
    let s = base
    if (prop.minimum !== undefined) {
      s = s.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(prop.minimum, filterAnnotations("minimum", errorFn))))
    }
    if (prop.maximum !== undefined) {
      s = s.pipe(Schema.check(Schema.isLessThanOrEqualTo(prop.maximum, filterAnnotations("maximum", errorFn))))
    }
    return s
  }

  if (prop.type === "boolean") {
    const typeMsg = errorFn?.("type")
    return typeMsg !== undefined
      ? Schema.Boolean.annotate({ message: typeMsg })
      : Schema.Boolean
  }

  return Schema.Unknown
}

export function buildInputSchemas(colDef: AnyCollectionDef): InputSchemas {
  const schema = colDef.schema
  const required = new Set(schema.required ?? [])

  const createFields: Record<string, Schema.Codec<unknown, unknown>> = {}
  const updateFields: Record<string, Schema.Codec<unknown, unknown>> = {}

  for (const [key, prop] of Object.entries(schema.properties)) {
    if (prop["x-generated"]) continue

    const fieldDef = colDef.fields[key]
    const errorFn = fieldDef?.error

    const base = propertyToSchema(prop, fieldDef)

    if (required.has(key)) {
      const requiredMsg = errorFn?.("required")
      createFields[key] = requiredMsg !== undefined
        ? base.pipe(Schema.annotateKey({ messageMissingKey: requiredMsg }))
        : base
    } else {
      createFields[key] = Schema.optional(base)
    }
    updateFields[key] = Schema.optional(base)
  }

  return {
    create: Schema.Struct(createFields),
    update: Schema.Struct(updateFields)
  }
}

export function parseErrToValidationError(collection: string) {
  return (err: Schema.SchemaError): ValidationError => {
    const issues = SchemaIssue.makeFormatterStandardSchemaV1()(err.issue).issues.map((i) => {
      const path = i.path ?? []
      const prefix = path.length > 0 ? `${path.join(".")}: ` : ""
      return `${prefix}${i.message}`
    })
    return new ValidationError({ collection, issues })
  }
}
