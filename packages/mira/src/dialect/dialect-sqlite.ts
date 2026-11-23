import type { TimestampUnit } from "@gettersethya/mira-client"
import { Effect } from "effect"

import type { StoreSqlCapabilities, TranslatePlanContext, ViewShape } from "./dialect.js"
import { errorHasCode, hasUniqueViolationReason, translateStep } from "./dialect.js"
import type { DialectType } from "./dialect.js"
import {
  affectedViews,
  fromJoinReferences,
  normalizeIdentifier,
  topologicalViewOrder,
  viewDependencies
} from "./view-dependencies.js"
import { UnsupportedMigrationStepError } from "@/migrator/errors.js"
import type { ColumnDef, IndexShape, MigrationStep, TableShape, TableShapes } from "@/migrator/types.js"

/**
 * SQLite dialect implementation.
 * - Identifiers are double-quoted.
 * - Booleans are stored as INTEGER (0/1).
 * - `dropColumn` uses the native `ALTER TABLE … DROP COLUMN` (SQLite 3.35+).
 * - Changing an existing column's type/nullability/default has no in-place form:
 *   SQLite requires rebuilding the table, which `translatePlan` does by coalescing
 *   every column and index change of an affected table into one rebuild.
 */

/** Prefix of the scratch table a rebuild copies into before recreating the original. */
const REBUILD_PREFIX = "_mira_rebuild_"

/**
 * Steps a table rebuild subsumes, because the rebuild starts from the desired shape
 * and therefore already includes every column and index the plan asks for.
 */
const SUBSUMED_BY_REBUILD: ReadonlySet<MigrationStep["kind"]> = new Set([
  "addColumn",
  "alterColumn",
  "dropColumn",
  "createIndex",
  "dropIndex"
])

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`

const quoteLiteral = (value: unknown) => {
  if (value === null) return "NULL"
  if (typeof value === "boolean") return value ? "1" : "0"
  if (typeof value === "number") return String(value)
  return `'${String(value).replace(/'/g, "''")}'`
}

const isSqliteBusy = (error: unknown) => errorHasCode(error, ["SQLITE_BUSY", "SQLITE_LOCKED"])

const SQLITE_UNIQUE_CODES = [
  "SQLITE_CONSTRAINT_PRIMARYKEY",
  "SQLITE_CONSTRAINT_UNIQUE",
  1555,
  2067
]

export const isSqliteUniqueViolation = (error: unknown) =>
  errorHasCode(error, SQLITE_UNIQUE_CODES)

const STORE_CODE_KEYS = ["code", "errno", "errstr", "errcode", "extendedCode", "rawCode"]

/**
 * Store-only duplicate classifier. It adds the broader code fields and the
 * structured `UniqueViolation` reason fallback the auth email path needs.
 */
export const isSqliteStoreDuplicateKey = (error: unknown) =>
  isSqliteUniqueViolation(error) ||
  hasUniqueViolationReason(error) ||
  errorHasCode(error, SQLITE_UNIQUE_CODES, STORE_CODE_KEYS)

const upsertSql = (
  table: string,
  record: Readonly<Record<string, unknown>>,
  conflictKeys: ReadonlyArray<string>
) => {
  const keys = Object.keys(record)
  const columns = keys.map(quote).join(", ")
  const values = keys.map((key) => quoteLiteral(record[key])).join(", ")
  const updates = keys
    .filter((key) => !conflictKeys.includes(key))
    .map((key) => `${quote(key)} = excluded.${quote(key)}`)
    .join(", ")
  const conflict = conflictKeys.map(quote).join(", ")
  return `INSERT INTO ${quote(table)} (${columns}) VALUES (${values}) ON CONFLICT (${conflict}) ${
    updates.length > 0 ? `DO UPDATE SET ${updates}` : "DO NOTHING"
  }`
}

const nativeTypeOf = (col: ColumnDef) => {
  switch (col.type) {
    case "boolean":
      return "INTEGER"
    case "integer":
      return "INTEGER"
    case "real":
      return "REAL"
    case "text":
      return "TEXT"
  }
}

const indexNameOf = (table: string, fields: Array<string>) => `idx_${table}_${fields.join("_")}`

/** One column definition. Shared by `createTable`, `createSystemTable` and a rebuild's scratch table. */
function columnSql(col: ColumnDef, syntheticDefault = false) {
  if (col.autoIncrement) {
    return `${quote(col.name)} INTEGER PRIMARY KEY AUTOINCREMENT`
  }
  const parts = [quote(col.name), nativeTypeOf(col)]
  if (!col.nullable) parts.push("NOT NULL")
  if (col.unique) parts.push("UNIQUE")
  if (col.default !== undefined) {
    parts.push(`DEFAULT ${quoteLiteral(col.default)}`)
  } else if (syntheticDefault) {
    // A new NOT NULL column without a default needs a value for existing rows,
    // matching ADD COLUMN. The fallback is not part of the collection schema, but
    // the physical table must accept the copy.
    parts.push(`DEFAULT ${quoteLiteral(col.type === "text" ? "" : 0)}`)
  }
  if (col.primaryKey) parts.push("PRIMARY KEY")
  return parts.join(" ")
}

function createTableSql(
  table: string,
  columns: Array<ColumnDef>,
  ifNotExists = false,
  syntheticDefaults: ReadonlySet<string> = new Set()
) {
  const cols = columns.map((column) => columnSql(column, syntheticDefaults.has(column.name)))
  return `CREATE TABLE ${ifNotExists ? "IF NOT EXISTS " : ""}${quote(table)} (\n  ${cols.join(",\n  ")}\n)`
}

function createIndexSql(table: string, index: IndexShape) {
  const unique = index.unique ? "UNIQUE " : ""
  const cols = index.fields.map(quote).join(", ")
  return `CREATE ${unique}INDEX ${quote(indexNameOf(table, index.fields))} ON ${quote(table)} (${cols})`
}

/**
 * Rejects a unique-index change that would collapse existing rows before the
 * rebuild starts. Only single-field unique indexes are rejected: a composite
 * index may still be unique through its other fields, and the transaction rolls
 * the index creation back if it is not.
 */
function validateUniqueChanges(
  steps: ReadonlyArray<MigrationStep>,
  ctx: TranslatePlanContext
): Effect.Effect<void, UnsupportedMigrationStepError> {
  return Effect.gen(function* () {
    for (const step of steps) {
      if (step.kind !== "addColumn" && step.kind !== "alterColumn") continue
      const shapes = ctx.tables.get(step.table)
      if (shapes === undefined || shapes.stored === null) continue
      const storedNames = new Set(shapes.stored.columns.map((column) => column.name))

      for (const index of shapes.desired.indexes) {
        if (!index.unique || index.fields.length !== 1) continue
        const field = index.fields[0]
        if (field === undefined) continue

        if (step.kind === "addColumn" && step.column.name === field && !storedNames.has(field)) {
          return yield* Effect.fail(
            new UnsupportedMigrationStepError({
              step: step.kind,
              detail: `adding "${step.column.name}" to "${step.table}" cannot satisfy the single-field unique index "${indexNameOf(step.table, index.fields)}" because every existing row would receive the same value`
            })
          )
        }

        if (step.kind === "alterColumn" && step.to.name === field) {
          if (step.from.type !== step.to.type) {
            return yield* Effect.fail(
              new UnsupportedMigrationStepError({
                step: step.kind,
                detail: `changing the type of "${step.table}"."${field}" can collapse values in the single-field unique index "${indexNameOf(step.table, index.fields)}"`
              })
            )
          }
          if (step.from.nullable && !step.to.nullable && step.to.default !== undefined) {
            return yield* Effect.fail(
              new UnsupportedMigrationStepError({
                step: step.kind,
                detail: `making "${step.table}"."${field}" NOT NULL with a default can collapse NULL rows into one value in the single-field unique index "${indexNameOf(step.table, index.fields)}"`
              })
            )
          }
        }
      }
    }
  })
}

/**
 * SQLite's procedure for changing a table's shape.
 *
 * The table is recreated in place instead of renamed: remote libSQL rejects the
 * legacy-alter pragma and cannot rename a table while a view references it. The
 * drop/create/copy order is the same on every SQLite-family connection, so there
 * is one rebuild path to test.
 */
function rebuildStatements(table: string, desired: TableShape, stored: TableShape): Array<string> {
  const scratch = `${REBUILD_PREFIX}${table}`
  const previous = new Map(stored.columns.map((c) => [c.name, c]))
  const copied = desired.columns.filter((c) => previous.has(c.name))
  const storedNames = new Set(previous.keys())
  const syntheticDefaults = new Set(
    desired.columns
      .filter((c) => !storedNames.has(c.name) && !c.nullable && c.default === undefined)
      .map((c) => c.name)
  )

  const statements = [createTableSql(scratch, desired.columns, false, syntheticDefaults)]

  if (copied.length > 0) {
    const columns = copied.map((c) => quote(c.name)).join(", ")
    const projections = copied
      .map((c) => {
        const before = previous.get(c.name)
        // Selecting an explicit NULL does not apply a column's DEFAULT, so a column
        // that becomes NOT NULL with a default needs that default folded in.
        if (before?.nullable === true && !c.nullable && c.default !== undefined) {
          return `COALESCE(${quote(c.name)}, ${quoteLiteral(c.default)})`
        }
        return quote(c.name)
      })
      .join(", ")
    statements.push(`INSERT INTO ${quote(scratch)} (${columns}) SELECT ${projections} FROM ${quote(table)}`)
  }

  if (desired.columns.some((c) => c.autoIncrement === true)) {
    // Dropping the original deletes its `sqlite_sequence` row, which would let the
    // new table hand out ids that were already used. Move the high-water mark onto
    // the scratch table, then move it back before the scratch is dropped.
    statements.push(
      `DELETE FROM "sqlite_sequence" WHERE "name" = ${quoteLiteral(scratch)}`,
      `UPDATE "sqlite_sequence" SET "name" = ${quoteLiteral(scratch)} WHERE "name" = ${quoteLiteral(table)}`
    )
  }

  statements.push(
    `DROP TABLE ${quote(table)}`,
    createTableSql(table, desired.columns, false, syntheticDefaults)
  )

  if (copied.length > 0) {
    const columns = desired.columns.map((c) => quote(c.name)).join(", ")
    statements.push(`INSERT INTO ${quote(table)} (${columns}) SELECT ${columns} FROM ${quote(scratch)}`)
  }

  if (desired.columns.some((c) => c.autoIncrement === true)) {
    statements.push(
      `DELETE FROM "sqlite_sequence" WHERE "name" = ${quoteLiteral(table)}`,
      `UPDATE "sqlite_sequence" SET "name" = ${quoteLiteral(table)} WHERE "name" = ${quoteLiteral(scratch)}`
    )
  }

  statements.push(`DROP TABLE ${quote(scratch)}`)

  for (const index of desired.indexes) {
    statements.push(createIndexSql(table, index))
  }

  return statements
}

const timestampAddSql = (expr: string, amount: number, unit: TimestampUnit) =>
  `datetime(${expr}, '${amount >= 0 ? "+" : ""}${amount} ${unit}s')`

const timestampDiffSql = (left: string, right: string, unit: TimestampUnit) => {
  const factor = unit === "day" ? 1 : unit === "hour" ? 24 : 1440
  const base = `(julianday(${left}) - julianday(${right}))`
  return factor === 1 ? base : `(${base} * ${factor})`
}

const caseInsensitiveLikeSql = (
  left: string,
  right: string,
  mode: "prefix" | "contains"
) =>
  mode === "prefix"
    ? `${left} LIKE (${right} || '%')`
    : `${left} LIKE ('%' || ${right} || '%')`

const sqliteColumnExistsSql = (table: string, column: string) =>
  `SELECT 1 AS present FROM pragma_table_info(${quoteLiteral(table)}) WHERE name = ${quoteLiteral(column)} LIMIT 1`

type ViewLookupEntry = { readonly raw: string; readonly shape: ViewShape }

type ViewAnalysis = {
  readonly changedTablesRaw: ReadonlySet<string>
  readonly changedTables: ReadonlySet<string>
  readonly hasSubsumedDrop: boolean
  readonly droppedViews: ReadonlySet<string>
  readonly explicitDrop: ReadonlyMap<string, string>
  readonly explicitCreate: ReadonlyMap<string, { readonly raw: string; readonly query: string }>
  readonly viewLookup: ReadonlyMap<string, ViewLookupEntry>
  readonly viewNames: ReadonlyArray<string>
  readonly storedViewMap: ReadonlyMap<string, ViewShape>
  readonly sentinelViews: ReadonlySet<string>
  readonly affected: ReadonlySet<string>
}

type ViewCreate = {
  readonly raw: string
  readonly query: string
  readonly properties: ReadonlyArray<string>
  readonly validate: boolean
}

type ViewSynthesis = {
  readonly drops: ReadonlyArray<string>
  readonly creates: ReadonlyArray<ViewCreate>
  readonly notes: ReadonlyArray<string>
}

const hasQuery = (query: string | null | undefined): query is string =>
  query !== null && query !== undefined && query.trim().length > 0

/**
 * Collects the view context a SQLite view plan needs, or returns null when the
 * plan has no `dropColumn` step.
 *
 * The stored-view map may contain sentinel entries for explicitly dropped views
 * that are absent from `ctx.views`. The sentinel makes the name a known view
 * node in the stored dependency graph, so a tracked view that reads the
 * untracked dropped view enters the affected closure.
 */
function analyzeViewPlan(
  steps: ReadonlyArray<MigrationStep>,
  ctx: TranslatePlanContext
): ViewAnalysis | null {
  const changedTablesRaw = new Set<string>()
  for (const step of steps) {
    if (step.kind === "dropColumn") changedTablesRaw.add(step.table)
  }
  if (changedTablesRaw.size === 0) return null

  const changedTables = new Set([...changedTablesRaw].map(normalizeIdentifier))
  const alteredTables = new Set<string>()
  for (const step of steps) {
    if (step.kind === "alterColumn") alteredTables.add(normalizeIdentifier(step.table))
  }
  const hasSubsumedDrop = [...changedTables].some((table) => alteredTables.has(table))

  const droppedViews = new Set<string>()
  const explicitDrop = new Map<string, string>()
  const explicitCreate = new Map<string, { raw: string; query: string }>()
  for (const step of steps) {
    if (step.kind === "dropView") {
      const normalized = normalizeIdentifier(step.view)
      droppedViews.add(normalized)
      explicitDrop.set(normalized, step.view)
    } else if (step.kind === "createView") {
      explicitCreate.set(normalizeIdentifier(step.view), {
        raw: step.view,
        query: step.query
      })
    }
  }

  const viewLookup = new Map<string, ViewLookupEntry>()
  for (const [name, shape] of ctx.views) {
    viewLookup.set(normalizeIdentifier(name), { raw: name, shape })
  }

  const storedViewMap = new Map(ctx.views)
  const sentinelViews = new Set<string>()
  for (const [normalized, raw] of explicitDrop) {
    if (!viewLookup.has(normalized)) {
      storedViewMap.set(raw, { stored: { query: "" }, desired: null })
      sentinelViews.add(normalized)
    }
  }

  return {
    changedTablesRaw,
    changedTables,
    hasSubsumedDrop,
    droppedViews,
    explicitDrop,
    explicitCreate,
    viewLookup,
    viewNames: [...ctx.views.keys()],
    storedViewMap,
    sentinelViews,
    affected: affectedViews(storedViewMap, droppedViews, changedTablesRaw)
  }
}

function createCandidatesFor(analysis: ViewAnalysis): Set<string> {
  const candidates = new Set<string>(analysis.explicitCreate.keys())
  for (const name of analysis.affected) {
    const entry = analysis.viewLookup.get(name)
    if (entry !== undefined && entry.shape.desired !== null) candidates.add(name)
  }
  return candidates
}

function collectViewPreflightErrors(
  steps: ReadonlyArray<MigrationStep>,
  analysis: ViewAnalysis
): Array<UnsupportedMigrationStepError> {
  const errors: Array<UnsupportedMigrationStepError> = []

  const names = new Map<string, Set<string>>()
  const addName = (raw: string) => {
    const normalized = normalizeIdentifier(raw)
    const rawNames = names.get(normalized) ?? new Set<string>()
    rawNames.add(raw)
    names.set(normalized, rawNames)
  }
  for (const raw of analysis.viewNames) addName(raw)
  for (const raw of analysis.explicitDrop.values()) addName(raw)
  for (const create of analysis.explicitCreate.values()) addName(create.raw)

  for (const rawNames of names.values()) {
    if (rawNames.size <= 1) continue
    const [first, second] = [...rawNames]
    errors.push(
      new UnsupportedMigrationStepError({
        step: "createView",
        detail: `view names "${first}" and "${second}" collide after case folding`
      })
    )
    return errors
  }

  const seenCreates = new Map<string, { raw: string; query: string }>()
  for (const step of steps) {
    if (step.kind !== "createView") continue
    const normalized = normalizeIdentifier(step.view)
    const previous = seenCreates.get(normalized)
    if (previous !== undefined && previous.query !== step.query) {
      errors.push(
        new UnsupportedMigrationStepError({
          step: "createView",
          detail: `duplicate createView steps for "${step.view}" have different queries`
        })
      )
      return errors
    }
    if (previous === undefined) seenCreates.set(normalized, { raw: step.view, query: step.query })
  }

  if (analysis.hasSubsumedDrop) {
    for (const [name, shape] of analysis.storedViewMap) {
      if (shape.stored === null) continue
      if (analysis.sentinelViews.has(normalizeIdentifier(name))) continue
      if (!hasQuery(shape.stored.query) && !analysis.droppedViews.has(normalizeIdentifier(name))) {
        errors.push(
          new UnsupportedMigrationStepError({
            step: "dropView",
            detail: `stored view "${name}" has no x-view-query`
          })
        )
        return errors
      }
    }
  }

  for (const normalized of createCandidatesFor(analysis)) {
    const entry = analysis.viewLookup.get(normalized)
    const explicit = analysis.explicitCreate.get(normalized)
    const desired = entry?.shape.desired

    if (desired !== null && desired !== undefined && !hasQuery(desired.query)) {
      const raw = entry?.raw ?? explicit?.raw ?? normalized
      errors.push(
        new UnsupportedMigrationStepError({
          step: "createView",
          detail: `desired view "${raw}" has no x-view-query`
        })
      )
      return errors
    }
    if (explicit !== undefined && !hasQuery(explicit.query)) {
      errors.push(
        new UnsupportedMigrationStepError({
          step: "createView",
          detail: `createView "${explicit.raw}" has no query`
        })
      )
      return errors
    }
  }

  for (const normalized of analysis.affected) {
    const entry = analysis.viewLookup.get(normalized)
    if (entry === undefined || entry.shape.desired !== null) continue
    if (analysis.explicitDrop.has(normalized)) continue
    errors.push(
      new UnsupportedMigrationStepError({
        step: "dropView",
        detail: `removed view "${entry.raw}" has no dropView step; pass allowDestructive: true or add an explicit dropView`
      })
    )
    return errors
  }

  return errors
}

function referencesTouched(
  query: string,
  changedTables: ReadonlySet<string>,
  affected: ReadonlySet<string>
): boolean {
  for (const reference of fromJoinReferences(query)) {
    if (changedTables.has(reference) || affected.has(reference)) return true
  }
  return false
}

function buildViewSynthesis(analysis: ViewAnalysis, ctx: TranslatePlanContext): ViewSynthesis {
  const dropOrder = topologicalViewOrder(
    analysis.affected,
    viewDependencies(analysis.storedViewMap, "stored")
  ).reverse()

  const drops: Array<string> = []
  for (const normalized of dropOrder) {
    const entry = analysis.viewLookup.get(normalized)
    const explicit = analysis.explicitDrop.get(normalized)
    const raw = entry?.raw ?? explicit
    if (raw === undefined) continue
    const stored = entry?.shape.stored
    if (
      explicit === undefined &&
      (stored === undefined || stored === null || stored.query === null)
    ) {
      continue
    }
    drops.push(raw)
  }

  const createRaw = new Map<string, ViewCreate>()
  for (const normalized of createCandidatesFor(analysis)) {
    const entry = analysis.viewLookup.get(normalized)
    const explicit = analysis.explicitCreate.get(normalized)
    const raw = entry?.raw ?? explicit?.raw
    if (raw === undefined) continue
    const desired = entry?.shape.desired
    const query = desired?.query ?? explicit?.query
    if (!hasQuery(query)) continue
    const properties = desired?.properties ?? []
    const validate =
      analysis.affected.has(normalized) ||
      (explicit !== undefined && referencesTouched(query, analysis.changedTables, analysis.affected))
    createRaw.set(normalized, { raw, query, properties, validate })
  }

  const effectiveDesired = new Map<string, ViewShape>()
  for (const [name, shape] of ctx.views) {
    const query = shape.desired?.query
    if (!hasQuery(query)) continue
    effectiveDesired.set(normalizeIdentifier(name), {
      stored: null,
      desired: { query }
    })
  }
  for (const [name, create] of createRaw) {
    if (!effectiveDesired.has(name)) {
      effectiveDesired.set(name, {
        stored: null,
        desired: { query: create.query }
      })
    }
  }

  const createOrder = topologicalViewOrder(
    new Set(createRaw.keys()),
    viewDependencies(effectiveDesired, "desired")
  )
  const creates = createOrder.flatMap((name) => {
    const create = createRaw.get(name)
    return create === undefined ? [] : [create]
  })

  const notes: Array<string> = []
  for (const raw of drops) notes.push(`drop view ${raw}`)
  for (const create of creates) notes.push(`create view ${create.raw}`)
  for (const create of creates) {
    if (create.validate) notes.push(`validate view ${create.raw}`)
  }

  return { drops, creates, notes }
}

function validationQuery(raw: string, properties: ReadonlyArray<string>): string {
  const columns = properties.length === 0
    ? ["seqId"]
    : properties.includes("seqId")
      ? properties
      : [...properties, "seqId"]
  return `SELECT ${columns.map(quote).join(", ")} FROM ${quote(raw)} LIMIT 0`
}

export const sqliteStoreSql: StoreSqlCapabilities = {
  bootstrapMode: "plain",
  columnExistsSql: sqliteColumnExistsSql,
  isRetryable: isSqliteBusy,
  isDuplicateKey: isSqliteStoreDuplicateKey
}

export const sqliteDialect: DialectType = {
  storesBooleanAsInteger: true,
  // SQLite 3.35+ supports DELETE ... RETURNING on both the Node and Bun drivers.
  deleteResult: { _tag: "returning" },

  quoteIdentifier: quote,
  currentTimestamp: () => "datetime('now')",
  timestampAdd: timestampAddSql,
  timestampDiff: timestampDiffSql,
  caseInsensitiveLike: caseInsensitiveLikeSql,
  caseInsensitivePattern: (left, right) => `${left} LIKE ${right}`,
  castValue: (expr) => expr,
  quoteLiteral,
  nativeType: nativeTypeOf,
  indexName: indexNameOf,
  placeholder: () => "?",
  upsert: upsertSql,
  store: sqliteStoreSql,
  telemetry: {
    setup: [
      "PRAGMA journal_mode = WAL",
      "PRAGMA synchronous = NORMAL",
      "PRAGMA busy_timeout = 5000"
    ],
    cleanup: ["PRAGMA wal_checkpoint(TRUNCATE)"],
    isRetryable: isSqliteBusy
  },

  translatePlan: (steps, ctx) =>
    Effect.gen(function* () {
      yield* validateUniqueChanges(steps, ctx)

      const analysis = analyzeViewPlan(steps, ctx)
      if (analysis !== null) {
        const errors = collectViewPreflightErrors(steps, analysis)
        const firstError = errors[0]
        if (firstError !== undefined) return yield* Effect.fail(firstError)
      }
      const synthesis = analysis === null ? null : buildViewSynthesis(analysis, ctx)

      const rebuilds = new Map<string, TableShapes>()
      for (const step of steps) {
        if (step.kind !== "alterColumn") continue
        const shapes = ctx.tables.get(step.table)
        if (shapes === undefined || shapes.stored === null) {
          return yield* Effect.fail(
            new UnsupportedMigrationStepError({
              step: step.kind,
              detail: `changing a column of "${step.table}" requires rebuilding that table, but the plan carries no stored shape for it`
            })
          )
        }
        rebuilds.set(step.table, shapes)
      }

      const statements: Array<string> = []
      const validations: Array<string> = []
      if (synthesis !== null) {
        for (const raw of synthesis.drops) {
          statements.push(`DROP VIEW IF EXISTS ${quote(raw)}`)
        }
      }

      const rebuilt = new Set<string>()
      for (const step of steps) {
        if (synthesis !== null && (step.kind === "createView" || step.kind === "dropView")) {
          continue
        }

        const table = "table" in step ? step.table : null
        const shapes = table === null ? undefined : rebuilds.get(table)

        if (
          table !== null &&
          shapes !== undefined &&
          shapes.stored !== null &&
          SUBSUMED_BY_REBUILD.has(step.kind)
        ) {
          if (!rebuilt.has(table)) {
            rebuilt.add(table)
            statements.push(...rebuildStatements(table, shapes.desired, shapes.stored))
          }
          continue
        }

        statements.push(...(yield* translateStep(sqliteDialect.translate, step)))
      }

      if (synthesis !== null) {
        for (const create of synthesis.creates) {
          statements.push(`CREATE VIEW IF NOT EXISTS ${quote(create.raw)} AS ${create.query}`)
          if (create.validate) {
            validations.push(validationQuery(create.raw, create.properties))
          }
        }
      }

      return {
        statements,
        ...(validations.length > 0 ? { validations } : {}),
        cleanup: [],
        ...(synthesis !== null && synthesis.notes.length > 0 ? { notes: synthesis.notes } : {})
      }
    }),

  translate: (step) => {
    switch (step.kind) {
      case "createTable":
        return [createTableSql(step.table, step.columns)]

      case "dropTable":
        return [`DROP TABLE IF EXISTS ${quote(step.table)}`]

      case "renameTable":
        return [`ALTER TABLE ${quote(step.from)} RENAME TO ${quote(step.to)}`]

      case "addColumn": {
        const c = step.column
        const parts = [quote(c.name), nativeTypeOf(c)]
        if (!c.nullable) parts.push("NOT NULL")
        if (c.default !== undefined) {
          parts.push(`DEFAULT ${quoteLiteral(c.default)}`)
        } else if (!c.nullable) {
          // SQLite rejects ADD COLUMN NOT NULL without a DEFAULT when rows exist.
          const fallback: string | number = c.type === "text" ? "" : 0
          parts.push(`DEFAULT ${quoteLiteral(fallback)}`)
        }
        return [`ALTER TABLE ${quote(step.table)} ADD COLUMN ${parts.join(" ")}`]
      }

      case "dropColumn":
        // SQLite 3.35+ supports native column drops and preserves the table's
        // remaining columns and indexes (unlike the drop-and-recreate workaround).
        return [`ALTER TABLE ${quote(step.table)} DROP COLUMN ${quote(step.column)}`]

      case "renameColumn":
        return [
          `ALTER TABLE ${quote(step.table)} RENAME COLUMN ${quote(step.from)} TO ${quote(step.to)}`
        ]

      case "alterColumn":
        // Unreachable through `translatePlan`, which rebuilds the table instead:
        // this step alone does not carry the table's other columns or its indexes.
        return []

      case "createIndex":
        return [createIndexSql(step.table, { fields: step.fields, unique: step.unique })]

      case "dropIndex":
        return [`DROP INDEX IF EXISTS ${quote(indexNameOf(step.table, step.fields))}`]

      case "createSystemTable":
        return [createTableSql(step.table, step.columns, true)]

      case "createView":
        return [`CREATE VIEW IF NOT EXISTS ${quote(step.view)} AS ${step.query}`]

      case "dropView":
        return [`DROP VIEW IF EXISTS ${quote(step.view)}`]
    }
  }
}
