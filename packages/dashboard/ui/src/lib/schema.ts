import type { CollectionSchema, FieldSchema } from "$lib/client.js"

const SYSTEM_FIELDS = new Set(["id", "seqId", "created", "updated", "password"])

export function isSystemField(name: string): boolean {
  return SYSTEM_FIELDS.has(name)
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

export function fieldEntries(schema: CollectionSchema, forEdit: boolean): FieldEntry[] {
  return Object.entries(schema.fields)
    .filter(([name]) => {
      if (forEdit) return !isSystemField(name) || name === "id"
      return !isSystemField(name)
    })
    .map(([name, field]) => ({
      name,
      kind: fieldKind(field),
      label: name.charAt(0).toUpperCase() + name.slice(1),
      readOnly: forEdit && isSystemField(name),
      collectionName: field["x-relation"] ?? null,
    }))
}

export function buildDefaultValues(
  schema: CollectionSchema,
  record: Record<string, unknown> | null
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [name, field] of Object.entries(schema.fields)) {
    if (isSystemField(name)) continue
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
    default: return "TextField"
  }
}
