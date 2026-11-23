import type { TimestampUnit } from "@gettersethya/mira-client"
import { Effect, Schema } from "effect"

import { UnsupportedMigrationStepError } from "@/migrator/errors.js"
import type { ColumnDef, MigrationStep } from "@/migrator/types.js"

import type {
  DdlSqlDialect,
  DialectType,
  FieldValueType,
  Quote,
  RuleSqlDialect,
  StoreSqlCapabilities,
  TranslatePlanContext,
  ViewShape
} from "./dialect.js"
import {
  errorHasCode,
  hasUniqueViolationReason,
  retryableByCauseCode,
  translateStep
} from "./dialect.js"
import {
  affectedViews,
  normalizeIdentifier,
  topologicalViewOrder,
  viewDependencies
} from "./view-dependencies.js"

const quote: Quote = (name) => `"${name.replaceAll('"', '""')}"`

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

const isoFormat = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`

const castValue = (expr: string, type: FieldValueType) =>
  `${expr}::${type === "number" ? "double precision" : type}`

const timestampAdd = (
  expr: string,
  amount: number,
  unit: TimestampUnit
) =>
  `to_char(((${expr})::timestamptz + interval '${amount} ${unit}') AT TIME ZONE 'UTC', ${isoFormat})`

const timestampDiff = (
  left: string,
  right: string,
  unit: TimestampUnit
): string => {
  const divisor = unit === "day" ? 86400 : unit === "hour" ? 3600 : 60
  return `(EXTRACT(EPOCH FROM ((${left})::timestamptz - (${right})::timestamptz)) / ${divisor})`
}

/**
 * PostgreSQL rule-SQL renderer. This is a pure capability object, not a
 * `DialectType` and not a database preset. #29 composes it into the full
 * PostgreSQL dialect.
 */
export const postgresRuleSql: RuleSqlDialect = {
  quoteIdentifier: quote,
  currentTimestamp: () =>
    `to_char(now() AT TIME ZONE 'UTC', ${isoFormat})`,
  timestampAdd,
  timestampDiff,
  caseInsensitiveLike: (left, right, mode) =>
    mode === "prefix"
      ? `${left} ILIKE (${right} || '%')`
      : `${left} ILIKE ('%' || ${right} || '%')`,
  castValue
}

/**
 * PostgreSQL filter-SQL renderer. This is a pure capability object, not a
 * `DialectType` and not a database preset. #29 composes it into the full
 * PostgreSQL dialect. `ILIKE` is case-insensitive in PostgreSQL, so the user
 * filter `like` operator keeps the same meaning as on SQLite.
 */
export const postgresFilterSql: Pick<DialectType, "caseInsensitivePattern"> = {
  caseInsensitivePattern: (left, right) => `${left} ILIKE ${right}`
}

const quoteLiteral = (value: unknown): string => {
  if (value === null || value === undefined) return "NULL"
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE"
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "NULL"
  }
  return `'${String(value).replaceAll("'", "''")}'`
}

/** SQLSTATE 23505 is `unique_violation`; the reason tag is a driver fallback. */
export const isPostgresUniqueViolation = (error: unknown) =>
  errorHasCode(error, ["23505"]) || hasUniqueViolationReason(error)

/**
 * Store capability for the future PostgreSQL dialect. It is intentionally a
 * capability object, not a full `DialectType`; #29 composes it.
 */
export const postgresStoreSql: StoreSqlCapabilities = {
  bootstrapMode: "transaction",
  bootstrapSql: [
    "SET LOCAL lock_timeout = '5s'",
    "SELECT pg_advisory_xact_lock(hashtextextended('mira.system-tables', 0))"
  ],
  columnExistsSql: (table, column) =>
    `SELECT 1 AS present FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = ${quoteLiteral(table)}
       AND column_name = ${quoteLiteral(column)}
     LIMIT 1`,
  isRetryable: retryableByCauseCode(["40001", "40P01", "55P03"]),
  isDuplicateKey: isPostgresUniqueViolation,
  transactionLockTimeoutSql: "SET LOCAL lock_timeout = '2s'"
}

const nativeTypeOf = (col: ColumnDef): string => {
  switch (col.type) {
    case "boolean":
      return "BOOLEAN"
    case "integer":
      return "INTEGER"
    case "real":
      return "DOUBLE PRECISION"
    case "text":
      return "TEXT"
  }
}

class DefaultError extends Error {
  constructor(
    readonly reason: "invalid" | "range",
    readonly value: unknown
  ) {
    super(reason)
    this.name = "DefaultError"
  }
}

const coerceNumber = (value: unknown): number | undefined => {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined
  if (typeof value === "string" && value.trim() !== "") {
    const number = Number(value)
    return Number.isFinite(number) ? number : undefined
  }
  return undefined
}

/**
 * The single validation and coercion path for column defaults. It returns the
 * SQL literal used by `CREATE TABLE`, `ADD COLUMN`, `SET DEFAULT`, and the
 * nullable-to-NOT NULL backfill.
 */
const defaultLiteral = (column: ColumnDef): string | undefined => {
  const value = column.default
  if (value === undefined) return undefined
  if (value === null) {
    if (!column.nullable) throw new DefaultError("invalid", value)
    return "NULL"
  }

  switch (column.type) {
    case "boolean": {
      if (typeof value === "boolean") return value ? "TRUE" : "FALSE"
      if (value === 0 || value === "0") return "FALSE"
      if (value === 1 || value === "1") return "TRUE"
      if (typeof value === "string") {
        const normalized = value.toLowerCase()
        if (normalized === "true") return "TRUE"
        if (normalized === "false") return "FALSE"
      }
      throw new DefaultError("invalid", value)
    }
    case "integer": {
      const number = coerceNumber(value)
      if (number === undefined || !Number.isInteger(number)) {
        throw new DefaultError("invalid", value)
      }
      if (number < -2147483648 || number > 2147483647) {
        throw new DefaultError("range", value)
      }
      return String(number)
    }
    case "real": {
      const number = coerceNumber(value)
      if (number === undefined) throw new DefaultError("invalid", value)
      return String(number)
    }
    case "text": {
      if (typeof value !== "string") throw new DefaultError("invalid", value)
      return quoteLiteral(value)
    }
  }
}

const validateColumn = (
  column: ColumnDef,
  table: string,
  step: MigrationStep["kind"]
): UnsupportedMigrationStepError | undefined => {
  try {
    defaultLiteral(column)
  } catch (error) {
    if (!(error instanceof DefaultError)) throw error
    const json = encodeJson(error.value) ?? String(error.value)
    const detail =
      error.reason === "range"
        ? `default for "${table}"."${column.name}" is out of range for type integer: ${json}`
        : `default for "${table}"."${column.name}" is not valid for type ${column.type}: ${json}`
    return new UnsupportedMigrationStepError({ step, detail })
  }
  return undefined
}

const columnSql = (col: ColumnDef, syntheticDefault = false) => {
  if (col.autoIncrement) {
    const parts = [`${quote(col.name)} BIGINT GENERATED BY DEFAULT AS IDENTITY`]
    if (col.primaryKey) parts.push("PRIMARY KEY")
    else if (col.unique) parts.push("UNIQUE")
    return parts.join(" ")
  }

  const parts = [quote(col.name), nativeTypeOf(col)]
  if (!col.nullable) parts.push("NOT NULL")
  if (col.unique) parts.push("UNIQUE")

  const literal = defaultLiteral(col)
  if (literal !== undefined) {
    parts.push(`DEFAULT ${literal}`)
  } else if (syntheticDefault) {
    const fallback = col.type === "text" ? "''" : col.type === "boolean" ? "FALSE" : "0"
    parts.push(`DEFAULT ${fallback}`)
  }

  if (col.primaryKey) parts.push("PRIMARY KEY")
  return parts.join(" ")
}

const createTableSql = (
  table: string,
  columns: ReadonlyArray<ColumnDef>,
  ifNotExists = false
) => {
  const cols = columns.map((column) => columnSql(column))
  return `CREATE TABLE ${ifNotExists ? "IF NOT EXISTS " : ""}${quote(table)} (\n  ${cols.join(",\n  ")}\n)`
}

const utf8ByteLength = (value: string) => new TextEncoder().encode(value).length

const truncateUtf8 = (value: string, budget: number) => {
  const encoder = new TextEncoder()
  let result = ""
  let bytes = 0
  for (const character of value) {
    const size = encoder.encode(character).length
    if (bytes + size > budget) break
    result += character
    bytes += size
  }
  return result
}

const fnv1a64 = (value: string) => {
  let hash = 0xcbf29ce484222325n
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte)
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return hash.toString(16).padStart(16, "0")
}

const indexNameOf = (table: string, fields: ReadonlyArray<string>) => {
  const raw = `idx_${table}_${fields.join("_")}`
  if (utf8ByteLength(raw) <= 63) return raw

  const suffix = `_${fnv1a64(raw)}`
  const budget = 63 - utf8ByteLength(suffix)
  return `${truncateUtf8(raw, budget)}${suffix}`
}

const createIndexSql = (
  table: string,
  index: { readonly fields: ReadonlyArray<string>; readonly unique: boolean }
) => {
  const unique = index.unique ? "UNIQUE " : ""
  const columns = index.fields.map(quote).join(", ")
  return `CREATE ${unique}INDEX ${quote(indexNameOf(table, index.fields))} ON ${quote(table)} (${columns})`
}

const usingExpression = (from: ColumnDef, to: ColumnDef, column: string) => {
  const col = quote(column)
  switch (`${from.type}->${to.type}`) {
    case "text->integer":
      return `${col}::integer`
    case "text->real":
      return `${col}::double precision`
    case "text->boolean":
      return `${col}::boolean`
    case "integer->real":
      return `${col}::double precision`
    case "integer->boolean":
      return `(${col} <> 0)`
    case "integer->text":
      return `${col}::text`
    case "real->integer":
      return `trunc(${col})::integer`
    case "real->boolean":
      return `(${col} <> 0)`
    case "real->text":
      return `${col}::text`
    case "boolean->integer":
      return `${col}::integer`
    case "boolean->real":
      return `(${col}::integer)::double precision`
    case "boolean->text":
      return `${col}::text`
    default:
      throw new Error(`Unsupported PostgreSQL column conversion: ${from.type} -> ${to.type}`)
  }
}

const sameColumn = (from: ColumnDef, to: ColumnDef) => {
  if (from.type !== to.type || from.nullable !== to.nullable) return false
  try {
    return defaultLiteral(from) === defaultLiteral(to)
  } catch {
    return false
  }
}

const alterColumnSql = (step: Extract<MigrationStep, { kind: "alterColumn" }>) => {
  const statements: Array<string> = []
  const table = quote(step.table)
  const column = quote(step.to.name)
  const typeChanged = step.from.type !== step.to.type

  if (typeChanged) {
    // A prior ADD COLUMN may have left a synthetic default that the stored
    // schema does not record. DROP DEFAULT is a no-op when none exists.
    statements.push(`ALTER TABLE ${table} ALTER COLUMN ${column} DROP DEFAULT`)
    statements.push(
      `ALTER TABLE ${table} ALTER COLUMN ${column} TYPE ${nativeTypeOf(step.to)} USING ${usingExpression(step.from, step.to, step.to.name)}`
    )
    const literal = defaultLiteral(step.to)
    if (literal !== undefined) {
      statements.push(`ALTER TABLE ${table} ALTER COLUMN ${column} SET DEFAULT ${literal}`)
    }
  } else {
    const fromLiteral = defaultLiteral(step.from)
    const toLiteral = defaultLiteral(step.to)
    if (fromLiteral !== undefined && toLiteral === undefined) {
      statements.push(`ALTER TABLE ${table} ALTER COLUMN ${column} DROP DEFAULT`)
    } else if (toLiteral !== undefined && fromLiteral !== toLiteral) {
      statements.push(`ALTER TABLE ${table} ALTER COLUMN ${column} SET DEFAULT ${toLiteral}`)
    }
  }

  if (!step.from.nullable && step.to.nullable) {
    statements.push(`ALTER TABLE ${table} ALTER COLUMN ${column} DROP NOT NULL`)
  } else if (step.from.nullable && !step.to.nullable) {
    const literal = defaultLiteral(step.to)
    if (literal !== undefined) {
      statements.push(`UPDATE ${table} SET ${column} = ${literal} WHERE ${column} IS NULL`)
    }
    statements.push(`ALTER TABLE ${table} ALTER COLUMN ${column} SET NOT NULL`)
  }

  return statements
}

const translate = (step: MigrationStep): Array<string> => {
  switch (step.kind) {
    case "createTable":
      return [createTableSql(step.table, step.columns)]
    case "dropTable":
      return [`DROP TABLE IF EXISTS ${quote(step.table)}`]
    case "renameTable":
      return [`ALTER TABLE ${quote(step.from)} RENAME TO ${quote(step.to)}`]
    case "addColumn":
      return [
        `ALTER TABLE ${quote(step.table)} ADD COLUMN ${columnSql(
          step.column,
          !step.column.nullable && step.column.default === undefined
        )}`
      ]
    case "dropColumn":
      return [`ALTER TABLE ${quote(step.table)} DROP COLUMN ${quote(step.column)}`]
    case "renameColumn":
      return [
        `ALTER TABLE ${quote(step.table)} RENAME COLUMN ${quote(step.from)} TO ${quote(step.to)}`
      ]
    case "alterColumn":
      return alterColumnSql(step)
    case "createIndex":
      return [
        createIndexSql(step.table, { fields: step.fields, unique: step.unique })
      ]
    case "dropIndex":
      return [`DROP INDEX IF EXISTS ${quote(indexNameOf(step.table, step.fields))}`]
    case "createSystemTable":
      return [createTableSql(step.table, step.columns, true)]
    case "createView":
      return [`CREATE VIEW ${quote(step.view)} AS ${step.query}`]
    case "dropView":
      return [`DROP VIEW IF EXISTS ${quote(step.view)}`]
  }
}

const collectPreflightErrors = (
  steps: ReadonlyArray<MigrationStep>,
  ctx: TranslatePlanContext,
  droppedViews: ReadonlySet<string>,
  changedTables: ReadonlySet<string>
) => {
  const errors: Array<UnsupportedMigrationStepError> = []

  const checkIdentifier = (name: string, step: MigrationStep["kind"]) => {
    if (name.length === 0) {
      errors.push(
        new UnsupportedMigrationStepError({
          step,
          detail: "identifier must not be empty"
        })
      )
      return
    }
    const bytes = utf8ByteLength(name)
    if (bytes > 63) {
      errors.push(
        new UnsupportedMigrationStepError({
          step,
          detail: `identifier "${name}" is ${bytes} bytes; PostgreSQL identifiers must be at most 63 bytes`
        })
      )
    }
  }

  const checkColumn = (
    column: ColumnDef,
    table: string,
    step: MigrationStep["kind"]
  ) => {
    checkIdentifier(column.name, step)
    const error = validateColumn(column, table, step)
    if (error !== undefined) errors.push(error)
  }

  for (const step of steps) {
    switch (step.kind) {
      case "createTable":
      case "createSystemTable":
        checkIdentifier(step.table, step.kind)
        for (const column of step.columns) checkColumn(column, step.table, step.kind)
        break
      case "dropTable":
        checkIdentifier(step.table, step.kind)
        break
      case "renameTable":
        checkIdentifier(step.from, step.kind)
        checkIdentifier(step.to, step.kind)
        break
      case "addColumn":
        checkIdentifier(step.table, step.kind)
        checkColumn(step.column, step.table, step.kind)
        break
      case "dropColumn":
        checkIdentifier(step.table, step.kind)
        checkIdentifier(step.column, step.kind)
        break
      case "renameColumn":
        checkIdentifier(step.table, step.kind)
        checkIdentifier(step.from, step.kind)
        checkIdentifier(step.to, step.kind)
        break
      case "alterColumn":
        checkIdentifier(step.table, step.kind)
        checkColumn(step.from, step.table, step.kind)
        checkColumn(step.to, step.table, step.kind)
        if (step.from.autoIncrement || step.to.autoIncrement) {
          errors.push(
            new UnsupportedMigrationStepError({
              step: step.kind,
              detail: `changing identity column "${step.table}"."${step.to.name}" is not supported`
            })
          )
        }
        if (sameColumn(step.from, step.to)) {
          errors.push(
            new UnsupportedMigrationStepError({
              step: step.kind,
              detail: `alterColumn "${step.table}"."${step.to.name}" has no changes`
            })
          )
        }
        break
      case "createIndex":
      case "dropIndex":
        checkIdentifier(step.table, step.kind)
        for (const field of step.fields) checkIdentifier(field, step.kind)
        break
      case "createView":
        checkIdentifier(step.view, step.kind)
        if (step.query.trim() === "") {
          errors.push(
            new UnsupportedMigrationStepError({
              step: step.kind,
              detail: `createView "${step.view}" has no query`
            })
          )
        }
        break
      case "dropView":
        checkIdentifier(step.view, step.kind)
        break
    }
  }

  for (const [name, shape] of ctx.views) {
    if (
      shape.desired !== null &&
      (shape.desired.query === null || shape.desired.query.trim() === "")
    ) {
      errors.push(
        new UnsupportedMigrationStepError({
          step: "createView",
          detail: `desired view "${name}" has no x-view-query`
        })
      )
    }
    if (
      shape.stored !== null &&
      (shape.stored.query === null || shape.stored.query.trim() === "") &&
      changedTables.size > 0 &&
      !droppedViews.has(normalizeIdentifier(name))
    ) {
      errors.push(
        new UnsupportedMigrationStepError({
          step: "dropView",
          detail: `stored view "${name}" has no x-view-query`
        })
      )
    }
  }

  return errors
}

const translatePlan = (
  steps: ReadonlyArray<MigrationStep>,
  ctx: TranslatePlanContext
) =>
  Effect.gen(function* () {
    const changedTables = new Set<string>()
    for (const step of steps) {
      if (step.kind === "dropTable" || step.kind === "dropColumn") {
        changedTables.add(step.table)
      } else if (step.kind === "alterColumn" && step.from.type !== step.to.type) {
        changedTables.add(step.table)
      }
    }

    const droppedViews = new Set<string>()
    const explicitDrop = new Map<string, string>()
    const explicitCreate = new Map<string, { readonly raw: string; readonly query: string }>()
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

    const errors = collectPreflightErrors(steps, ctx, droppedViews, changedTables)
    const firstError = errors[0]
    if (firstError !== undefined) return yield* Effect.fail(firstError)

    const affected = affectedViews(ctx.views, droppedViews, changedTables)

    const lookup = new Map<string, { readonly raw: string; readonly shape: ViewShape }>()
    for (const [name, shape] of ctx.views) {
      lookup.set(normalizeIdentifier(name), { raw: name, shape })
    }

    const dropNames = new Set<string>([...explicitDrop.keys(), ...affected])
    const dropRaw: Array<string> = []
    for (const normalized of dropNames) {
      const entry = lookup.get(normalized)
      const explicit = explicitDrop.get(normalized)
      const raw = entry?.raw ?? explicit
      if (raw === undefined) continue
      const stored = entry?.shape.stored
      if (
        explicit === undefined &&
        (stored === undefined || stored === null || stored.query === null)
      ) {
        continue
      }
      dropRaw.push(raw)
    }

    const createNames = new Set<string>([...explicitCreate.keys(), ...affected])
    const createRaw = new Map<string, string>()
    const createQuery = new Map<string, string>()
    for (const normalized of createNames) {
      const entry = lookup.get(normalized)
      const explicit = explicitCreate.get(normalized)
      const raw = entry?.raw ?? explicit?.raw
      if (raw === undefined) continue
      const desired = entry?.shape.desired?.query
      const query = desired ?? explicit?.query
      if (query === undefined || query === null || query.trim() === "") continue
      createRaw.set(normalized, raw)
      createQuery.set(normalized, query)
    }

    const viewErrors: Array<UnsupportedMigrationStepError> = []
    const checkViewIdentifier = (name: string, step: MigrationStep["kind"]) => {
      const bytes = utf8ByteLength(name)
      if (bytes > 63) {
        viewErrors.push(
          new UnsupportedMigrationStepError({
            step,
            detail: `identifier "${name}" is ${bytes} bytes; PostgreSQL identifiers must be at most 63 bytes`
          })
        )
      }
    }
    for (const raw of dropRaw) checkViewIdentifier(raw, "dropView")
    for (const raw of createRaw.values()) checkViewIdentifier(raw, "createView")
    const firstViewError = viewErrors[0]
    if (firstViewError !== undefined) return yield* Effect.fail(firstViewError)

    const statements: Array<string> = []
    const notes: Array<string> = []

    if (dropRaw.length > 0) {
      statements.push(`DROP VIEW IF EXISTS ${dropRaw.map(quote).join(", ")}`)
      for (const raw of dropRaw) notes.push(`drop view ${raw}`)
    }

    for (const step of steps) {
      if (step.kind === "createView" || step.kind === "dropView") continue
      const rendered = yield* translateStep(translate, step)
      statements.push(...rendered)
    }

    const order = topologicalViewOrder(
      new Set(createRaw.keys()),
      viewDependencies(ctx.views, "desired")
    )
    for (const normalized of order) {
      const raw = createRaw.get(normalized)
      const query = createQuery.get(normalized)
      if (raw === undefined || query === undefined) continue
      statements.push(`CREATE VIEW ${quote(raw)} AS ${query}`)
      notes.push(`create view ${raw}`)
    }

    return { statements, cleanup: [], notes }
  })

/**
 * PostgreSQL DDL capability. It is a pure capability object, not a full
 * `DialectType`; #29 composes it with the rule and store capabilities.
 */
export const postgresDdlSql: DdlSqlDialect = {
  translatePlan,
  translate,
  nativeType: nativeTypeOf,
  quoteIdentifier: quote,
  quoteLiteral,
  indexName: indexNameOf,
  storesBooleanAsInteger: false
}
