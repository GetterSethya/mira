import type { CollectionSchema, JsonSchemaProperty } from "@gettersethya/mira-client"
import { Schema } from "effect"

import type { ColumnDef, IndexShape, MigrationPlan, MigrationStep, NamedSchema } from "./types.js"

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

function jsonKeysDiffer(a: unknown, b: unknown) {
  if (a === b) return false
  return encodeJson(a) !== encodeJson(b)
}

/** Maps a JSON Schema property to the appropriate SQL column type. */
export function propertyToColumnType(prop: JsonSchemaProperty) {
  if (prop["x-kind"] === "seqId") return "integer"
  if (prop.type === "integer") return "integer"
  if (prop.type === "number") return "real"
  if (prop.type === "boolean") return "boolean"
  return "text"
}

/**
 * The declared character length for a text property. Explicit `maxLength`
 * wins; otherwise Mira fills the lengths it already controls. JSON has no
 * safe implicit length and stays unbounded.
 */
function textMaxLength(prop: JsonSchemaProperty): number | undefined {
  if (prop.maxLength !== undefined) return prop.maxLength
  if (prop["x-kind"] === "literalText") {
    const values = prop["x-literal"] ?? []
    if (values.length === 0) return undefined
    return Math.max(1, ...values.map((value) => [...value].length))
  }
  if (prop.format === "email") return 320
  switch (prop["x-kind"]) {
    case "relation":
      return 320
    case "date":
      return 64
    case "file":
      return 255
    case "json":
      return undefined
    default:
      break
  }
  if (prop["x-system"] === true) return 255
  return undefined
}

/** The field names used as keys: column flags plus every index field. */
export function keyedFieldNames(
  columns: ReadonlyArray<ColumnDef>,
  indexes: ReadonlyArray<IndexShape>
): Set<string> {
  const names = new Set(indexes.flatMap((index) => index.fields))
  for (const column of columns) {
    if (column.primaryKey === true || column.unique === true) names.add(column.name)
  }
  return names
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
      if (col.type === "text") {
        const maxLength = textMaxLength(prop)
        if (maxLength !== undefined) col.maxLength = maxLength
        if (prop.format === "email") col.collation = "utf8mb4_0900_as_ci"
      }
      if (prop["x-collection"] !== undefined) col.xCollection = prop["x-collection"]
      if (prop["x-field"] !== undefined) col.xField = prop["x-field"]
      return col
    })
}

/** Extracts the index shapes from a schema's `x-indexes`. */
export function schemaToIndexEntries(schema: CollectionSchema): Array<IndexShape> {
  return (schema["x-indexes"] ?? []).map((idx) => ({ fields: idx.fields, unique: idx.unique }))
}

/**
 * Identity of an index within a table, used to compare stored against desired.
 *
 * Dialects derive the SQL name from the same two inputs, so nothing here needs to
 * agree with a dialect's naming scheme.
 */
function indexKey(idx: IndexShape) {
  return `${idx.unique ? "unique" : "index"}:${idx.fields.join("\u0000")}`
}

function diffViewSchemas(
  name: string,
  stored: CollectionSchema | null,
  desired: CollectionSchema
): Array<MigrationStep> {
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

/** Options that make text length a physical property on an opt-in dialect. */
export type SchemaDiffOptions = {
  /**
   * Compare the physical text shape. Despite the name, this gates both the
   * keyed-status alter and the length alter. SQLite/PostgreSQL leave it false.
   */
  compareTextLength?: boolean
}

/** Full plan options: diff options plus destructive-plan control. */
export type PlanOptions = SchemaDiffOptions & {
  allowDestructive?: boolean
}

/**
 * Computes the `MigrationStep`s needed to bring `stored` up to `desired` for a single collection.
 * Pass `null` for `stored` to generate a full `createTable`.
 */
export function diffSchemas(
  name: string,
  stored: CollectionSchema | null,
  desired: CollectionSchema,
  options?: SchemaDiffOptions
) {
  if (desired["x-collection-kind"] === "view") {
    return diffViewSchemas(name, stored, desired)
  }

  const steps: Array<MigrationStep> = []

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

    const storedIndexes = schemaToIndexEntries(stored)
    const desiredIndexes = schemaToIndexEntries(desired)
    const storedKeyed = keyedFieldNames(storedCols, storedIndexes)
    const desiredKeyed = keyedFieldNames(desiredCols, desiredIndexes)

    for (const dc of desiredCols) {
      const sc = storedMap.get(dc.name)
      if (!sc) {
        steps.push({ kind: "addColumn", table: name, column: dc })
        continue
      }
      const physicalTextChange =
        options?.compareTextLength === true &&
        dc.type === "text" &&
        (
          storedKeyed.has(dc.name) !== desiredKeyed.has(dc.name) ||
          ((storedKeyed.has(dc.name) || desiredKeyed.has(dc.name)) && sc.maxLength !== dc.maxLength)
        )
      if (
        sc.type !== dc.type ||
        sc.nullable !== dc.nullable ||
        jsonKeysDiffer(sc.default, dc.default) ||
        physicalTextChange
      ) {
        steps.push({ kind: "alterColumn", table: name, from: sc, to: dc })
      }
    }

    for (const sc of storedCols) {
      if (!desiredMap.has(sc.name) && !sc.xSystem) {
        steps.push({ kind: "dropColumn", table: name, column: sc.name })
      }
    }

    const storedKeys = new Set(storedIndexes.map(indexKey))
    const desiredKeys = new Set(desiredIndexes.map(indexKey))

    for (const di of desiredIndexes) {
      if (!storedKeys.has(indexKey(di))) {
        steps.push({ kind: "createIndex", table: name, fields: di.fields, unique: di.unique })
      }
    }
    for (const si of storedIndexes) {
      if (!desiredKeys.has(indexKey(si))) {
        steps.push({ kind: "dropIndex", table: name, fields: si.fields, unique: si.unique })
      }
    }
  }

  return steps
}

/**
 * Order in which a whole plan's steps are emitted.
 *
 * What blocks a change goes first, what depends on the result goes last: SQLite
 * refuses to drop a column that is still indexed, and a view cannot be created
 * before the columns it selects exist. Ordering globally — instead of per
 * collection, in declaration order — makes a plan independent of how the
 * collections happen to be listed.
 */
const STEP_PRIORITY: Record<MigrationStep["kind"], number> = {
  dropView: 0,
  dropIndex: 1,
  createTable: 2,
  dropTable: 2,
  renameTable: 2,
  createSystemTable: 2,
  addColumn: 2,
  alterColumn: 2,
  dropColumn: 2,
  renameColumn: 2,
  createIndex: 3,
  createView: 4
}

/**
 * Whether a step can lose or rewrite data that is already stored.
 *
 * Relaxing `NOT NULL` and changing a default cannot, so they do not require
 * `allowDestructive` — demanding it would skip the whole plan, since a plan is
 * applied all-or-nothing.
 */
export function isDestructiveStep(step: MigrationStep): boolean {
  switch (step.kind) {
    case "dropTable":
    case "dropColumn":
      return true
    case "alterColumn":
      return step.from.type !== step.to.type || (step.from.nullable && !step.to.nullable)
    default:
      return false
  }
}

/**
 * Builds a full `MigrationPlan` for a set of desired schemas against the currently stored schemas.
 * When `allowDestructive` is true, tables absent from `schemas` are dropped.
 */
export function computePlan(
  schemas: Array<NamedSchema>,
  stored: Record<string, CollectionSchema>,
  options?: PlanOptions
): MigrationPlan {
  const steps: Array<MigrationStep> = []

  for (const { name, schema } of schemas) {
    steps.push(...diffSchemas(name, stored[name] ?? null, schema, options))
  }

  if (options?.allowDestructive) {
    const desiredNames = new Set(schemas.map((s) => s.name))
    for (const name of Object.keys(stored)) {
      if (desiredNames.has(name)) continue
      steps.push(
        stored[name]["x-collection-kind"] === "view"
          ? { kind: "dropView", view: name }
          : { kind: "dropTable", table: name }
      )
    }
  }

  steps.sort((a, b) => STEP_PRIORITY[a.kind] - STEP_PRIORITY[b.kind])

  return { steps, destructive: steps.some(isDestructiveStep) }
}
