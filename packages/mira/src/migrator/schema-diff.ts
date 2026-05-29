import type { CollectionSchema, JsonSchemaProperty } from "@gettersethya/mira-client"
import type { ColumnDef, MigrationPlan, MigrationStep, NamedSchema } from "./types.js"

function jsonKeysDiffer(a: unknown, b: unknown) {
  if (a === b) return false
  return JSON.stringify(a) !== JSON.stringify(b)
}

/** Maps a JSON Schema property to the appropriate SQL column type. */
export function propertyToColumnType(prop: JsonSchemaProperty) {
  if (prop["x-kind"] === "seqId") return "integer"
  if (prop.type === "integer") return "integer"
  if (prop.type === "number") return "real"
  if (prop.type === "boolean") return "boolean"
  return "text"
}

/** Converts a `CollectionSchema` to the flat list of `ColumnDef`s that the dialect will render as DDL. */
export function schemaToColumns(schema: CollectionSchema) {
  const requiredSet = new Set(schema.required ?? [])
  return Object.entries(schema.properties)
    .filter(([, prop]) => !prop["x-view-only"])
    .map(([name, prop]): ColumnDef => {
      const col: ColumnDef = {
        name,
        type: propertyToColumnType(prop),
        nullable: !requiredSet.has(name) && !prop["x-system"]
      }
      if (prop.default !== undefined) {
        col.default = prop.default
      }
      if (name === "id") {
        col.unique = true
      }
      if (prop["x-system"]) {
        col.xSystem = true
      }
      if (prop["x-hidden"]) {
        col.xHidden = true
      }
      if (prop["x-kind"]) {
        col.xKind = prop["x-kind"]
        if (prop["x-kind"] === "seqId") {
          col.primaryKey = true
          col.autoIncrement = true
        }
      }
      return col
    })
}

/** Extracts index entries from a schema's `x-indexes`, adding a deterministic name to each. */
export function schemaToIndexEntries(schema: CollectionSchema) {
  return (schema["x-indexes"] ?? []).map((idx) => ({
    ...idx,
    name: `idx_${schema["x-collection-kind"]}_${idx.fields.join("_")}`
  }))
}

function diffViewSchemas(
  name: string,
  stored: CollectionSchema | null,
  desired: CollectionSchema
): MigrationStep[] {
  const query = desired["x-view-query"]
  if (!query) return []

  if (stored === null) {
    return [{ kind: "createView", view: name, query }]
  }

  if (stored["x-view-query"] !== query) {
    return [
      { kind: "dropView",   view: name },
      { kind: "createView", view: name, query }
    ]
  }

  return []
}

/**
 * Computes the `MigrationStep`s needed to bring `stored` up to `desired` for a single collection.
 * Pass `null` for `stored` to generate a full `createTable`.
 */
export function diffSchemas(name: string, stored: CollectionSchema | null, desired: CollectionSchema) {
  if (desired["x-collection-kind"] === "view") {
    return diffViewSchemas(name, stored, desired)
  }

  const steps: MigrationStep[] = []

  if (stored === null) {
    steps.push({ kind: "createTable", table: name, columns: schemaToColumns(desired) })
    for (const idx of schemaToIndexEntries(desired)) {
      steps.push({ kind: "createIndex", table: name, fields: idx.fields, unique: idx.unique })
    }
  } else {
    const storedCols = schemaToColumns(stored)
    const desiredCols = schemaToColumns(desired)
    const storedMap = new Map(storedCols.map((c) => [c.name, c]))
    const desiredMap = new Map(desiredCols.map((c) => [c.name, c]))

    for (const dc of desiredCols) {
      const sc = storedMap.get(dc.name)
      if (!sc) {
        steps.push({ kind: "addColumn", table: name, column: dc })
      } else if (sc.type !== dc.type || sc.nullable !== dc.nullable || jsonKeysDiffer(sc.default, dc.default)) {
        steps.push({ kind: "alterColumn", table: name, column: dc })
      }
    }

    for (const sc of storedCols) {
      if (!desiredMap.has(sc.name) && !sc.xSystem) {
        steps.push({ kind: "dropColumn", table: name, column: sc.name })
      }
    }

    const storedIndexes = schemaToIndexEntries(stored)
    const desiredIndexes = schemaToIndexEntries(desired)
    const storedIdxMap = new Map(storedIndexes.map((i) => [i.name, i]))
    const desiredIdxMap = new Map(desiredIndexes.map((i) => [i.name, i]))

    for (const di of desiredIndexes) {
      if (!storedIdxMap.has(di.name)) {
        steps.push({ kind: "createIndex", table: name, fields: di.fields, unique: di.unique })
      }
    }
    for (const si of storedIndexes) {
      if (!desiredIdxMap.has(si.name)) {
        steps.push({ kind: "dropIndex", table: name, indexName: si.name })
      }
    }
  }

  return steps
}

/**
 * Builds a full `MigrationPlan` for a set of desired schemas against the currently stored schemas.
 * When `allowDestructive` is true, tables absent from `schemas` are dropped.
 */
export function computePlan(
  schemas: NamedSchema[],
  stored: Record<string, CollectionSchema>,
  options?: { allowDestructive?: boolean }
): MigrationPlan {
  const steps: MigrationStep[] = []
  let destructive = false

  for (const { name, schema } of schemas) {
    const storedSchema = stored[name] ?? null
    const diffSteps = diffSchemas(name, storedSchema, schema)
    for (const step of diffSteps) {
      if (step.kind === "dropTable" || step.kind === "dropColumn" || step.kind === "alterColumn") {
        destructive = true
      }
    }
    steps.push(...diffSteps)
  }

  if (options?.allowDestructive) {
    const desiredNames = new Set(schemas.map((s) => s.name))
    for (const name of Object.keys(stored)) {
      if (!desiredNames.has(name)) {
        if (stored[name]["x-collection-kind"] === "view") {
          steps.push({ kind: "dropView", view: name })
        } else {
          steps.push({ kind: "dropTable", table: name })
          destructive = true
        }
      }
    }
  }

  return { steps, destructive }
}
