import type { CollectionSchema, FieldSchema } from "$lib/dashboard-api.js"

/**
 * A field the server generates and manages itself (`id`, `seqId`, `created`,
 * `updated`). Never editable and never shown in a record form.
 */
export function isGeneratedField(field: FieldSchema | undefined): boolean {
  return field?.["x-generated"] === true
}

/**
 * A field that must not be rendered as data in tables (e.g. `password`,
 * `seqId`). It is still available to forms when it is write-only, so the form
 * input can collect it.
 */
export function isHiddenField(field: FieldSchema | undefined): boolean {
  return field?.["x-hidden"] === true
}

/** A write-only credential field (`x-kind: "password"`). */
export function isPasswordField(field: FieldSchema | undefined): boolean {
  return field?.["x-kind"] === "password"
}

/**
 * The internal cursor column. Never shown as a table column or form input.
 * Note: on view collections `id`/`seqId` are `x-view-only` — that annotation
 * means "maps to a query column", not "hide", so it is deliberately not used
 * for filtering.
 */
export function isSeqIdField(field: FieldSchema | undefined): boolean {
  return field?.["x-kind"] === "seqId"
}

/**
 * A field sourced from a view collection's SQL query (`x-view-only`). Every
 * field on a view collection carries this, so view collections expose no
 * writable form inputs.
 */
export function isViewOnlyField(field: FieldSchema | undefined): boolean {
  return field?.["x-view-only"] === true
}

/** True when a field should not appear as a data column in a table. */
export function isTableHiddenField(field: FieldSchema | undefined): boolean {
  return isHiddenField(field) || isSeqIdField(field)
}

export function isSystemField(field: FieldSchema | undefined): boolean {
  return field?.["x-system"] === true
}

export function fieldKind(field: FieldSchema): string {
  if (field["x-kind"]) return field["x-kind"]
  if (field.format === "date-time") return "date"
  if (field.type === "number" || field.type === "integer") return "number"
  if (field.type === "boolean") return "bool"
  if (field.type === "object") return "json"
  return "text"
}

export type FieldEntry = {
  name: string
  kind: string
  label: string
  readOnly: boolean
  collectionName: string | null
}

function label(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1)
}

/**
 * Fields to render in a record form. Generated fields are always excluded;
 * hidden write-only fields (e.g. auth `password`) are included so the input can
 * collect a value, while hidden and view-only fields are skipped.
 */
export function fieldEntries(schema: CollectionSchema): FieldEntry[] {
  return Object.entries(schema.fields)
    .filter(([, field]) => !isGeneratedField(field))
    .filter(([, field]) => !isViewOnlyField(field))
    .filter(([, field]) => !isHiddenField(field) || isPasswordField(field))
    .map(([name, field]) => ({
      name,
      kind: fieldKind(field),
      label: label(name),
      readOnly: false,
      collectionName: field["x-collection"] ?? null,
    }))
}

export function buildDefaultValues(
  schema: CollectionSchema,
  record: Record<string, unknown> | null
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [name, field] of Object.entries(schema.fields)) {
    if (isGeneratedField(field)) continue
    if (isViewOnlyField(field)) continue
    // Never prefill a credential field — the stored value is a hash, and
    // leaving it blank keeps the existing password on update.
    if (isPasswordField(field)) {
      result[name] = ""
      continue
    }
    if (record !== null) {
      result[name] = record[name] ?? null
    } else {
      const kind = fieldKind(field)
      if (kind === "number") result[name] = 0
      else if (kind === "bool") result[name] = false
      else result[name] = ""
    }
  }
  return result
}

export function hasFileField(schema: CollectionSchema): boolean {
  return Object.values(schema.fields).some((f) => f["x-kind"] === "file")
}

export function toFormData(values: Record<string, unknown>): FormData {
  const fd = new FormData()
  for (const [key, val] of Object.entries(values)) {
    if (val instanceof File) {
      fd.append(key, val)
    } else if (val !== null && val !== undefined) {
      fd.append(key, String(val))
    }
  }
  return fd
}

export function kindToFieldComponent(kind: string): string {
  switch (kind) {
    case "number": return "NumberField"
    case "bool": return "BoolField"
    case "date": return "DateField"
    case "json": return "JsonField"
    case "file": return "FileField"
    case "relation": return "RelationField"
    case "password": return "PasswordField"
    default: return "TextField"
  }
}
