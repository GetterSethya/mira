/**
 * MySQL/MariaDB migration capability (issue #68).
 *
 * MySQL and MariaDB commit DDL implicitly, so the migrator cannot rely on a
 * single transaction. This module supplies the statement-mode capability: a
 * catalog-guarded renderer, a post-apply verifier, and a parameterized metadata
 * upsert. It has no driver dependency and is not exported from the package
 * barrel.
 *
 * #30 composes it into the MySQL preset. #71 replaces the provisional text
 * mapping (`VARCHAR(255)` for indexed text, `LONGTEXT` otherwise) with a
 * declared length and collation strategy, and adds physical reconciliation for
 * columns created under the provisional mapping.
 */
import { Effect, Schema } from "effect"

import { UnsupportedMigrationStepError } from "@/migrator/errors.js"
import type { ColumnDef, IndexShape, MigrationStep } from "@/migrator/types.js"

import type {
  MigrationModel,
  ParameterizedStatement,
  StatementMigrationDialect,
  TranslatePlanContext,
  ViewShape
} from "./dialect.js"
import { errorHasCode } from "./dialect.js"
import {
  mysqlEmailCollation,
  mysqlMaxIndexKeyBytes,
  mysqlMaxIndexedTextLength,
  mysqlTextCollation
} from "./dialect-mysql-text.js"
import {
  affectedViews,
  normalizeIdentifier,
  topologicalViewOrder,
  viewDependencies
} from "./view-dependencies.js"

/** MySQL and MariaDB cap identifiers at 64 characters. */
const MAX_IDENTIFIER_CODE_POINTS = 64

/** The length #68 rendered for a keyed text column before #71. */
const PROVISIONAL_TEXT_LENGTH = 255

/** The character set used by every text column. */
const MYSQL_TEXT_CHARSET = "utf8mb4"

const effectiveTextCollation = (col: ColumnDef) => col.collation ?? mysqlTextCollation

/** The retryable statement-conflict codes from design section 9. */
const RETRYABLE_CONFLICT_CODES = [1050, 1060, 1061, 1091, 1205, 1213] as const

/** Catalog types that cannot back a full-column index without #71's strategy. */
const UNBOUNDED_TEXT_TYPES: ReadonlySet<string> = new Set([
  "tinytext",
  "text",
  "mediumtext",
  "longtext"
])

const quoteIdentifier = (name: string) => `\`${name.replaceAll("`", "``")}\``

const quoteLiteral = (value: unknown): string => {
  if (value === null || value === undefined) return "NULL"
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE"
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL"
  return `'${String(value).replaceAll("\\", "\\\\").replaceAll("'", "''")}'`
}

const codePointLength = (value: string) => [...value].length

const truncateCodePoints = (value: string, budget: number) =>
  [...value].slice(0, budget).join("")

const fnv1a64 = (value: string) => {
  let hash = 0xcbf29ce484222325n
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte)
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return hash.toString(16).padStart(16, "0")
}

/**
 * Deterministic index name. Names over 64 code points are truncated with a
 * stable 64-bit FNV-1a suffix; they are never rejected.
 */
const indexNameOf = (table: string, fields: ReadonlyArray<string>) => {
  const raw = `idx_${table}_${fields.join("_")}`
  if (codePointLength(raw) <= MAX_IDENTIFIER_CODE_POINTS) return raw

  const suffix = `_${fnv1a64(raw)}`
  const budget = MAX_IDENTIFIER_CODE_POINTS - codePointLength(suffix)
  return `${truncateCodePoints(raw, budget)}${suffix}`
}

const isKeyedColumn = (col: ColumnDef, indexes: ReadonlyArray<IndexShape>) =>
  col.primaryKey === true ||
  col.unique === true ||
  indexes.some((index) => index.fields.includes(col.name))

/**
 * The catalog type the renderer expects for a column. Shared by the renderer
 * and the comparator so a column never drifts against its own DDL.
 */
const expectedCatalogType = (col: ColumnDef, indexes: ReadonlyArray<IndexShape>) => {
  switch (col.type) {
    case "boolean":
      return "tinyint(1)"
    case "integer":
      return col.autoIncrement === true ? "bigint" : "int"
    case "real":
      return "double"
    case "text":
      return isKeyedColumn(col, indexes)
        ? `varchar(${col.maxLength ?? PROVISIONAL_TEXT_LENGTH})`
        : "longtext"
  }
}

const nativeTypeOf = (
  col: ColumnDef,
  indexes: ReadonlyArray<IndexShape>,
  step: MigrationStep["kind"]
) => {
  switch (col.type) {
    case "boolean":
      return "BOOLEAN"
    case "integer":
      return col.autoIncrement === true ? "BIGINT" : "INT"
    case "real":
      return "DOUBLE"
    case "text":
      if (!isKeyedColumn(col, indexes)) return "LONGTEXT"
      if (col.maxLength === undefined) {
        throw new UnsupportedMigrationStepError({
          step,
          detail: `text column "${col.name}" is indexed but has no maxLength; declare Field.text({ maxLength: n }) with n <= ${mysqlMaxIndexedTextLength}, or remove the index`
        })
      }
      return `VARCHAR(${col.maxLength})`
  }
}

/**
 * Lower-cases a catalog `COLUMN_TYPE` and strips the display width from the
 * integer family, except for `tinyint(1)`, which is the boolean marker.
 */
const normalizeCatalogType = (raw: string) => {
  const lower = raw.trim().toLowerCase()
  const match = /^(tinyint|smallint|mediumint|int|bigint)\((\d+)\)/.exec(lower)
  if (match === null) return lower
  const base = match[1] ?? ""
  const width = match[2] ?? ""
  if (base === "tinyint" && width === "1") return "tinyint(1)"
  return `${base}${lower.slice(match[0].length)}`
}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

const showDefaultValue = (value: unknown) => encodeJson(value) ?? String(value)

const coerceNumber = (value: unknown): number | undefined => {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined
  if (typeof value === "string" && value.trim() !== "") {
    const number = Number(value)
    return Number.isFinite(number) ? number : undefined
  }
  return undefined
}

const coerceBoolean = (value: unknown): boolean | undefined => {
  if (value === true || value === 1) return true
  if (value === false || value === 0) return false
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase()
    if (lower === "1" || lower === "true" || lower === "b'1'") return true
    if (lower === "0" || lower === "false" || lower === "b'0'") return false
  }
  return undefined
}

type DefaultRendering =
  | { readonly ok: true; readonly value: string | undefined }
  | { readonly ok: false; readonly reason: string }

/**
 * The single default validator and renderer. Numbers are bare, booleans are
 * `TRUE`/`FALSE`, and text is parenthesized because MySQL rejects a bare
 * literal default on a `TEXT` column.
 */
const renderDefault = (col: ColumnDef): DefaultRendering => {
  const value = col.default
  if (value === undefined) return { ok: true, value: undefined }
  if (value === null) {
    if (!col.nullable) {
      return { ok: false, reason: `is not valid for a NOT NULL column: ${showDefaultValue(value)}` }
    }
    return { ok: true, value: "NULL" }
  }

  switch (col.type) {
    case "boolean": {
      const boolean = coerceBoolean(value)
      if (boolean === undefined) {
        return { ok: false, reason: `is not valid for type boolean: ${showDefaultValue(value)}` }
      }
      return { ok: true, value: boolean ? "TRUE" : "FALSE" }
    }
    case "integer": {
      const number = coerceNumber(value)
      if (number === undefined || !Number.isInteger(number)) {
        return { ok: false, reason: `is not valid for type integer: ${showDefaultValue(value)}` }
      }
      if (number < -2147483648 || number > 2147483647) {
        return { ok: false, reason: `is out of range for type integer: ${showDefaultValue(value)}` }
      }
      return { ok: true, value: String(number) }
    }
    case "real": {
      const number = coerceNumber(value)
      if (number === undefined) {
        return { ok: false, reason: `is not valid for type real: ${showDefaultValue(value)}` }
      }
      return { ok: true, value: String(number) }
    }
    case "text": {
      if (typeof value !== "string") {
        return { ok: false, reason: `is not valid for type text: ${showDefaultValue(value)}` }
      }
      return { ok: true, value: `(${quoteLiteral(value)})` }
    }
  }
}

const unescapeSqlText = (value: string) => {
  let result = ""
  let index = 0
  while (index < value.length) {
    const character = value.charAt(index)
    if (character === "\\" && index + 1 < value.length) {
      result += value.charAt(index + 1)
      index += 2
      continue
    }
    if (character === "'" && value.charAt(index + 1) === "'") {
      result += "'"
      index += 2
      continue
    }
    result += character
    index++
  }
  return result
}

/** Strips one outer parenthesized pair, a charset introducer, and quotes. */
const normalizeTextDefault = (raw: string) => {
  let value = raw
  if (value.length >= 2 && value.startsWith("(") && value.endsWith(")")) {
    value = value.slice(1, -1)
  }
  value = value.replace(/^_[A-Za-z0-9]+/, "")
  // Some drivers return an escaped form such as `\'\\'` for an empty literal.
  value = value.replaceAll("\\'", "'").replaceAll("\\\\", "\\")
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return unescapeSqlText(value.slice(1, -1))
  }
  return value
}

/**
 * Canonical default tag, branching on the column type first so a boolean `1`
 * is not tagged as numeric. Both the desired default (through its rendered
 * literal) and the catalog `COLUMN_DEFAULT` run through here.
 */
const normalizeDefault = (col: ColumnDef, raw: unknown): string => {
  if (raw === null || raw === undefined) return "null"
  if (typeof raw === "string" && raw.trim().toUpperCase() === "NULL") return "null"

  switch (col.type) {
    case "boolean": {
      const boolean = coerceBoolean(raw)
      return boolean === undefined ? `invalid:${String(raw)}` : `bool:${boolean}`
    }
    case "integer":
    case "real": {
      const number = coerceNumber(raw)
      return number === undefined ? `invalid:${String(raw)}` : `num:${String(number)}`
    }
    case "text": {
      if (typeof raw !== "string") return `invalid:${String(raw)}`
      return `text:${normalizeTextDefault(raw)}`
    }
  }
}

/** The desired default tag, rendered first so text defaults share one form. */
const defaultTagOf = (col: ColumnDef) => {
  const rendered = renderDefault(col)
  if (!rendered.ok) return `invalid:${rendered.reason}`
  return normalizeDefault(col, rendered.value)
}

const describeExpectedColumn = (col: ColumnDef, indexes: ReadonlyArray<IndexShape>) => {
  const parts = [expectedCatalogType(col, indexes)]
  if (col.type === "text") parts.push(`${MYSQL_TEXT_CHARSET}/${effectiveTextCollation(col)}`)
  parts.push(col.nullable ? "NULL" : "NOT NULL")
  if (col.autoIncrement === true) parts.push("AUTO_INCREMENT")
  const rendered = renderDefault(col)
  if (rendered.ok && rendered.value !== undefined) parts.push(`DEFAULT ${rendered.value}`)
  return parts.join(" ")
}

const describeCatalogColumn = (col: CatalogColumn) => {
  const parts = [col.columnType]
  if (col.characterSetName !== null || col.collationName !== null) {
    parts.push(`${col.characterSetName ?? "?"}/${col.collationName ?? "?"}`)
  }
  parts.push(col.nullable ? "NULL" : "NOT NULL")
  if (col.autoIncrement) parts.push("AUTO_INCREMENT")
  if (col.defaultRaw !== null) parts.push(`DEFAULT ${col.defaultRaw}`)
  return parts.join(" ")
}

const columnMatchesCatalog = (
  desired: ColumnDef,
  actual: CatalogColumn,
  indexes: ReadonlyArray<IndexShape>
) =>
  expectedCatalogType(desired, indexes) === actual.columnType &&
  desired.nullable === actual.nullable &&
  (desired.autoIncrement === true) === actual.autoIncrement &&
  (desired.type !== "text" ||
    (actual.characterSetName === MYSQL_TEXT_CHARSET &&
      actual.collationName === effectiveTextCollation(desired))) &&
  defaultTagOf(desired) === normalizeDefault(desired, actual.defaultRaw)

const columnMatchesDefinition = (
  desired: ColumnDef,
  actual: ColumnDef,
  indexes: ReadonlyArray<IndexShape>
) =>
  expectedCatalogType(desired, indexes) === expectedCatalogType(actual, indexes) &&
  desired.nullable === actual.nullable &&
  (desired.autoIncrement === true) === (actual.autoIncrement === true) &&
  defaultTagOf(desired) === defaultTagOf(actual)

const columnDefinition = (
  col: ColumnDef,
  indexes: ReadonlyArray<IndexShape>,
  step: MigrationStep["kind"]
) => {
  const rendered = renderDefault(col)
  if (!rendered.ok) {
    throw new UnsupportedMigrationStepError({
      step,
      detail: `default for column "${col.name}" ${rendered.reason}`
    })
  }

  const parts = [quoteIdentifier(col.name), nativeTypeOf(col, indexes, step)]
  if (col.type === "text") {
    parts.push(`CHARACTER SET ${MYSQL_TEXT_CHARSET} COLLATE ${effectiveTextCollation(col)}`)
  }
  if (!col.nullable) parts.push("NOT NULL")
  if (rendered.value !== undefined) parts.push(`DEFAULT ${rendered.value}`)
  if (col.autoIncrement === true) parts.push("AUTO_INCREMENT")
  if (col.unique === true && col.primaryKey !== true) parts.push("UNIQUE")
  if (col.primaryKey === true) parts.push("PRIMARY KEY")
  return parts.join(" ")
}

const createTableSql = (
  table: string,
  columns: ReadonlyArray<ColumnDef>,
  indexes: ReadonlyArray<IndexShape>,
  step: Extract<MigrationStep["kind"], "createTable" | "createSystemTable">
) => {
  const ifNotExists = step === "createSystemTable"
  const definitions = columns.map((column) => columnDefinition(column, indexes, step))
  return `CREATE TABLE ${ifNotExists ? "IF NOT EXISTS " : ""}${quoteIdentifier(table)} (\n  ${definitions.join(",\n  ")}\n) ENGINE=InnoDB`
}

const createIndexSql = (
  table: string,
  fields: ReadonlyArray<string>,
  unique: boolean
) =>
  `CREATE ${unique ? "UNIQUE " : ""}INDEX ${quoteIdentifier(indexNameOf(table, fields))} ON ${quoteIdentifier(table)} (${fields.map(quoteIdentifier).join(", ")})`

const backfillLiteral = (col: ColumnDef) =>
  col.type === "boolean" ? "FALSE" : col.type === "text" ? "('')" : "0"

/**
 * A non-null column without a default cannot be added in one statement on a
 * table that may already hold rows: add it nullable, backfill, then make it
 * `NOT NULL`.
 */
const addColumnStatements = (
  table: string,
  col: ColumnDef,
  indexes: ReadonlyArray<IndexShape>
) => {
  const tableSql = quoteIdentifier(table)
  const columnSql = quoteIdentifier(col.name)

  if (col.autoIncrement === true) {
    return [`ALTER TABLE ${tableSql} ADD COLUMN ${columnDefinition(col, indexes, "addColumn")}`]
  }

  if (!col.nullable && col.default === undefined) {
    const intermediate: ColumnDef = {
      name: col.name,
      type: col.type,
      nullable: true,
      ...(col.maxLength !== undefined ? { maxLength: col.maxLength } : {}),
      ...(col.collation !== undefined ? { collation: col.collation } : {})
    }
    return [
      `ALTER TABLE ${tableSql} ADD COLUMN ${columnDefinition(intermediate, indexes, "addColumn")}`,
      `UPDATE ${tableSql} SET ${columnSql} = ${backfillLiteral(col)} WHERE ${columnSql} IS NULL`,
      `ALTER TABLE ${tableSql} MODIFY COLUMN ${columnDefinition(col, indexes, "addColumn")}`
    ]
  }

  return [`ALTER TABLE ${tableSql} ADD COLUMN ${columnDefinition(col, indexes, "addColumn")}`]
}

const alterColumnStatements = (
  step: Extract<MigrationStep, { kind: "alterColumn" }>,
  indexes: ReadonlyArray<IndexShape>
) => {
  const tableSql = quoteIdentifier(step.table)
  const columnSql = quoteIdentifier(step.to.name)
  const statements: Array<string> = []

  if (step.from.nullable && !step.to.nullable) {
    const rendered = renderDefault(step.to)
    if (rendered.ok && rendered.value !== undefined && rendered.value !== "NULL") {
      statements.push(
        `UPDATE ${tableSql} SET ${columnSql} = ${rendered.value} WHERE ${columnSql} IS NULL`
      )
    }
  }

  const algorithm = step.to.type === "text" ? ", ALGORITHM=COPY, LOCK=SHARED" : ""
  statements.push(
    `ALTER TABLE ${tableSql} MODIFY COLUMN ${columnDefinition(step.to, indexes, "alterColumn")}${algorithm}`
  )
  return statements
}

const translate = (step: MigrationStep): Array<string> => {
  switch (step.kind) {
    case "createTable":
      return [createTableSql(step.table, step.columns, [], "createTable")]
    case "createSystemTable":
      return [createTableSql(step.table, step.columns, [], "createSystemTable")]
    case "dropTable":
      return [`DROP TABLE IF EXISTS ${quoteIdentifier(step.table)}`]
    case "renameTable":
      return [
        `RENAME TABLE ${quoteIdentifier(step.from)} TO ${quoteIdentifier(step.to)}`
      ]
    case "addColumn":
      return addColumnStatements(step.table, step.column, [])
    case "dropColumn":
      return [
        `ALTER TABLE ${quoteIdentifier(step.table)} DROP COLUMN ${quoteIdentifier(step.column)}`
      ]
    case "renameColumn":
      return [
        `ALTER TABLE ${quoteIdentifier(step.table)} RENAME COLUMN ${quoteIdentifier(step.from)} TO ${quoteIdentifier(step.to)}`
      ]
    case "alterColumn":
      return alterColumnStatements(step, [])
    case "createIndex":
      return [createIndexSql(step.table, step.fields, step.unique)]
    case "dropIndex":
      return [
        `DROP INDEX ${quoteIdentifier(indexNameOf(step.table, step.fields))} ON ${quoteIdentifier(step.table)}`
      ]
    case "createView":
      return [`CREATE OR REPLACE VIEW ${quoteIdentifier(step.view)} AS ${step.query}`]
    case "dropView":
      return [`DROP VIEW IF EXISTS ${quoteIdentifier(step.view)}`]
  }
}

const identifierIssue = (name: string): string | undefined => {
  if (name.length === 0) return "identifier must not be empty"
  const length = codePointLength(name)
  if (length > MAX_IDENTIFIER_CODE_POINTS) {
    return `identifier "${name}" is ${length} code points; MySQL identifiers must be at most ${MAX_IDENTIFIER_CODE_POINTS} code points`
  }
  return undefined
}

const firstIdentifierIssue = (names: ReadonlyArray<string>): string | undefined => {
  for (const name of names) {
    const issue = identifierIssue(name)
    if (issue !== undefined) return issue
  }
  return undefined
}

const firstDefaultIssue = (
  table: string,
  columns: ReadonlyArray<ColumnDef>
): string | undefined => {
  for (const column of columns) {
    const rendered = renderDefault(column)
    if (!rendered.ok) {
      return `default for "${table}"."${column.name}" ${rendered.reason}`
    }
  }
  return undefined
}

const desiredIndexesFor = (ctx: TranslatePlanContext, table: string) => {
  const shapes = ctx.tables.get(table)
  return shapes === undefined ? [] : shapes.desired.indexes
}

/** Columns supplied by a create step when the table is not in `ctx.tables`. */
const stepColumnsOf = (steps: ReadonlyArray<MigrationStep>) => {
  const columns = new Map<string, ReadonlyArray<ColumnDef>>()
  for (const step of steps) {
    if (step.kind === "createTable" || step.kind === "createSystemTable") {
      columns.set(step.table, step.columns)
    }
  }
  return columns
}

const desiredColumnsFor = (
  ctx: TranslatePlanContext,
  stepColumns: ReadonlyMap<string, ReadonlyArray<ColumnDef>>,
  table: string
): ReadonlyArray<ColumnDef> | undefined =>
  ctx.tables.get(table)?.desired.columns ?? stepColumns.get(table)

/** Tables that survive the plan and have a desired shape. */
const candidateTables = (
  steps: ReadonlyArray<MigrationStep>,
  ctx: TranslatePlanContext,
  stepColumns: ReadonlyMap<string, ReadonlyArray<ColumnDef>>
) => {
  const dropped = new Set<string>()
  const renamedSources = new Set<string>()
  const renamedTargets = new Set<string>()
  for (const step of steps) {
    if (step.kind === "dropTable") dropped.add(step.table)
    if (step.kind === "renameTable") {
      renamedSources.add(step.from)
      renamedTargets.add(step.to)
    }
  }
  const tables = new Set<string>()
  for (const step of steps) {
    if (
      step.kind === "createTable" ||
      step.kind === "createSystemTable" ||
      step.kind === "addColumn" ||
      step.kind === "alterColumn" ||
      step.kind === "createIndex" ||
      step.kind === "dropIndex" ||
      step.kind === "dropColumn" ||
      step.kind === "renameColumn"
    ) {
      if (!dropped.has(step.table) && !renamedSources.has(step.table) && !renamedTargets.has(step.table)) {
        tables.add(step.table)
      }
    }
  }
  // A table with no desired shape (a view or a table only being dropped) is
  // not a candidate.
  return [...tables].filter((table) => desiredColumnsFor(ctx, stepColumns, table) !== undefined)
}

const textKeyBytes = (col: ColumnDef): number | undefined => {
  switch (col.type) {
    case "text":
      return col.maxLength === undefined ? undefined : col.maxLength * 4
    case "integer":
      return col.autoIncrement === true ? 8 : 4
    case "real":
      return 8
    case "boolean":
      return 1
  }
}

const textLengthDetail = (table: string, col: ColumnDef): string | undefined => {
  const label = `"${table}"."${col.name}"`
  if (col.xKind === "json") {
    return `text field ${label} is JSON and cannot be indexed on MySQL/MariaDB; extract the value into a Field.text({ maxLength }) or remove the index`
  }
  if (col.maxLength === undefined) {
    return `text field ${label} is indexed but has no maxLength; declare Field.text({ maxLength: n }) with n <= ${mysqlMaxIndexedTextLength}, or remove the index`
  }
  if (!Number.isInteger(col.maxLength) || col.maxLength < 1) {
    return `text field ${label} has invalid maxLength ${col.maxLength}; declare a positive integer`
  }
  if (col.maxLength > mysqlMaxIndexedTextLength) {
    return `text field ${label} has maxLength ${col.maxLength}; MySQL/MariaDB indexed text is limited to ${mysqlMaxIndexedTextLength} characters (${mysqlMaxIndexKeyBytes} bytes)`
  }
  if (typeof col.default === "string" && codePointLength(col.default) > col.maxLength) {
    return `text field ${label} has a default of ${codePointLength(col.default)} characters, longer than its maxLength ${col.maxLength}`
  }
  return undefined
}

const relationLengthDetail = (
  ctx: TranslatePlanContext,
  stepColumns: ReadonlyMap<string, ReadonlyArray<ColumnDef>>,
  table: string,
  col: ColumnDef
): string | undefined => {
  if (col.xKind !== "relation" || col.xCollection === undefined) return undefined
  const target = desiredColumnsFor(ctx, stepColumns, col.xCollection)
  if (target === undefined) return undefined
  const targetField = target.find((candidate) => candidate.name === (col.xField ?? "id"))
  if (targetField === undefined || targetField.maxLength === undefined) return undefined
  if ((col.maxLength ?? PROVISIONAL_TEXT_LENGTH) >= targetField.maxLength) return undefined
  return `relation field "${table}"."${col.name}" targets "${col.xCollection}"."${targetField.name}" with maxLength ${targetField.maxLength}, but its own maxLength is ${col.maxLength ?? PROVISIONAL_TEXT_LENGTH}; raise Field.relation({ maxLength })`
}

const textPreflightError = (
  steps: ReadonlyArray<MigrationStep>,
  ctx: TranslatePlanContext
): UnsupportedMigrationStepError | undefined => {
  const stepColumns = stepColumnsOf(steps)
  const checkedTables = new Set<string>()

  const fail = (detail: string) =>
    new UnsupportedMigrationStepError({ step: "alterColumn", detail })

  const renamedTables = new Set<string>()
  const renamedColumns = new Set<string>()
  for (const step of steps) {
    if (step.kind === "renameTable") {
      renamedTables.add(step.from)
      renamedTables.add(step.to)
    }
    if (step.kind === "renameColumn") {
      renamedColumns.add(`${step.table}\u0000${step.from}`)
      renamedColumns.add(`${step.table}\u0000${step.to}`)
    }
  }
  for (const step of steps) {
    if (step.kind !== "createIndex") continue
    if (renamedTables.has(step.table) || step.fields.some((field) => renamedColumns.has(`${step.table}\u0000${field}`))) {
      return fail(
        `cannot combine a rename of "${step.table}" with a same-plan index step; split the rename and the index into separate migrations`
      )
    }
    if (desiredColumnsFor(ctx, stepColumns, step.table) === undefined) {
      return fail(
        `cannot verify index "${indexNameOf(step.table, step.fields)}" on "${step.table}"; no desired column shape was supplied`
      )
    }
  }

  for (const table of candidateTables(steps, ctx, stepColumns)) {
    if (checkedTables.has(table)) continue
    checkedTables.add(table)
    const columns = desiredColumnsFor(ctx, stepColumns, table) ?? []
    const indexes = desiredIndexesFor(ctx, table)
    const keyed = new Set(
      columns
        .filter((column) => isKeyedColumn(column, indexes))
        .map((column) => column.name)
    )

    for (const column of columns) {
      if (column.type !== "text") continue
      if (column.xKind === "relation") {
        const detail = relationLengthDetail(ctx, stepColumns, table, column)
        if (detail !== undefined) return fail(detail)
      }
      const lengthDetail = keyed.has(column.name)
        ? textLengthDetail(table, column)
        : column.maxLength !== undefined && typeof column.default === "string" &&
            codePointLength(column.default) > column.maxLength
          ? textLengthDetail(table, column)
          : undefined
      if (lengthDetail !== undefined) return fail(lengthDetail)
    }

    for (const index of indexes) {
      let bytes = 0
      for (const field of index.fields) {
        const column = columns.find((candidate) => candidate.name === field)
        if (column === undefined) {
          return fail(`index "${indexNameOf(table, index.fields)}" on "${table}" names unknown field "${field}"`)
        }
        if (column.type === "text") {
          const detail = textLengthDetail(table, column)
          if (detail !== undefined) return fail(detail)
        }
        bytes += textKeyBytes(column) ?? 0
      }
      if (bytes > mysqlMaxIndexKeyBytes) {
        return fail(
          `index "${indexNameOf(table, index.fields)}" on "${table}" needs ${bytes} key bytes; MySQL/MariaDB allows ${mysqlMaxIndexKeyBytes}`
        )
      }
    }

    for (const step of steps) {
      if (step.kind !== "createIndex" || step.table !== table) continue
      let bytes = 0
      for (const field of step.fields) {
        const column = columns.find((candidate) => candidate.name === field)
        if (column === undefined) {
          return fail(`index "${indexNameOf(step.table, step.fields)}" on "${step.table}" names unknown field "${field}"`)
        }
        if (column.type === "text") {
          const detail = textLengthDetail(step.table, column)
          if (detail !== undefined) return fail(detail)
        }
        bytes += textKeyBytes(column) ?? 0
      }
      if (bytes > mysqlMaxIndexKeyBytes) {
        return fail(
          `index "${indexNameOf(step.table, step.fields)}" on "${step.table}" needs ${bytes} key bytes; MySQL/MariaDB allows ${mysqlMaxIndexKeyBytes}`
        )
      }
    }
  }

  return undefined
}

const participatesInUniqueIndex = (
  ctx: TranslatePlanContext,
  table: string,
  column: string
) =>
  desiredIndexesFor(ctx, table).some(
    (index) => index.unique && index.fields.includes(column)
  )

/**
 * Pure preflight. It runs before the catalog read and before any SQL is
 * produced, so a rejected identifier or default never reaches the driver.
 */
const collectPreflightError = (
  steps: ReadonlyArray<MigrationStep>,
  ctx: TranslatePlanContext
): UnsupportedMigrationStepError | undefined => {
  for (const step of steps) {
    const fail = (detail: string) =>
      new UnsupportedMigrationStepError({ step: step.kind, detail })

    switch (step.kind) {
      case "createTable":
      case "createSystemTable": {
        const names = firstIdentifierIssue([
          step.table,
          ...step.columns.map((column) => column.name)
        ])
        if (names !== undefined) return fail(names)
        const defaults = firstDefaultIssue(step.table, step.columns)
        if (defaults !== undefined) return fail(defaults)
        break
      }
      case "dropTable": {
        const names = firstIdentifierIssue([step.table])
        if (names !== undefined) return fail(names)
        break
      }
      case "renameTable": {
        const names = firstIdentifierIssue([step.from, step.to])
        if (names !== undefined) return fail(names)
        break
      }
      case "addColumn": {
        const names = firstIdentifierIssue([step.table, step.column.name])
        if (names !== undefined) return fail(names)
        const defaults = firstDefaultIssue(step.table, [step.column])
        if (defaults !== undefined) return fail(defaults)
        if (
          !step.column.nullable &&
          step.column.default === undefined &&
          (step.column.unique === true ||
            participatesInUniqueIndex(ctx, step.table, step.column.name))
        ) {
          return fail(
            `adding NOT NULL column "${step.table}"."${step.column.name}" without a default would give every existing row the same value and collide in a unique index; provide a default, add the column as nullable, or backfill unique values out of band`
          )
        }
        break
      }
      case "dropColumn": {
        const names = firstIdentifierIssue([step.table, step.column])
        if (names !== undefined) return fail(names)
        break
      }
      case "renameColumn": {
        const names = firstIdentifierIssue([step.table, step.from, step.to])
        if (names !== undefined) return fail(names)
        break
      }
      case "alterColumn": {
        const names = firstIdentifierIssue([step.table, step.from.name, step.to.name])
        if (names !== undefined) return fail(names)
        const defaults = firstDefaultIssue(step.table, [step.from, step.to])
        if (defaults !== undefined) return fail(defaults)
        if (step.from.autoIncrement === true || step.to.autoIncrement === true) {
          return fail(
            `changing identity column "${step.table}"."${step.to.name}" is not supported`
          )
        }
        break
      }
      case "createIndex":
      case "dropIndex": {
        const names = firstIdentifierIssue([step.table, ...step.fields])
        if (names !== undefined) return fail(names)
        break
      }
      case "createView": {
        const names = firstIdentifierIssue([step.view])
        if (names !== undefined) return fail(names)
        if (step.query.trim() === "") return fail(`createView "${step.view}" has no query`)
        break
      }
      case "dropView": {
        const names = firstIdentifierIssue([step.view])
        if (names !== undefined) return fail(names)
        break
      }
    }
  }
  return undefined
}

type CatalogColumn = {
  readonly name: string
  readonly columnType: string
  readonly nullable: boolean
  readonly defaultRaw: string | null
  readonly autoIncrement: boolean
  readonly characterSetName: string | null
  readonly collationName: string | null
  readonly columnComment: string | null
  readonly extra: string
  readonly generationExpression: string | null
}

type CatalogIndexPart = {
  readonly name: string | null
  readonly hasSubPart: boolean
}

type CatalogIndex = {
  readonly name: string
  readonly unique: boolean
  readonly columns: ReadonlyArray<CatalogIndexPart>
}

type CatalogTable = {
  readonly type: "base" | "view" | "other"
  readonly columns: Map<string, CatalogColumn>
  readonly indexes: Array<CatalogIndex>
  readonly sizeBytes: number
}

type CatalogView = {
  readonly name: string
  readonly definition: string | null
}

const stringValue = (value: unknown): string | null =>
  typeof value === "string" ? value : null

const numberValue = (value: unknown): number => {
  if (typeof value === "number") return value
  if (typeof value === "bigint") return Number(value)
  if (typeof value === "string") {
    const number = Number(value)
    return Number.isFinite(number) ? number : 0
  }
  return 0
}

const hasValue = (value: unknown) => value !== null && value !== undefined && value !== ""

const isUniqueFlag = (value: unknown) => {
  if (typeof value === "number") return value === 0
  if (typeof value === "bigint") return value === 0n
  if (typeof value === "string") return Number(value) === 0
  return false
}

const defaultRawValue = (value: unknown): string | null => {
  if (value === null || value === undefined) return null
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "bigint") return String(value)
  if (typeof value === "boolean") return value ? "1" : "0"
  return null
}

const tableTypeOf = (value: unknown): CatalogTable["type"] => {
  const raw = stringValue(value)
  if (raw === null) return "other"
  const upper = raw.toUpperCase()
  if (upper === "BASE TABLE") return "base"
  if (upper === "VIEW") return "view"
  return "other"
}

const ensureTable = (tables: Map<string, CatalogTable>, name: string) => {
  const existing = tables.get(name)
  if (existing !== undefined) return existing
  const created: CatalogTable = { type: "base", columns: new Map(), indexes: [], sizeBytes: 0 }
  tables.set(name, created)
  return created
}

type IndexPartBuilder = {
  readonly name: string | null
  readonly hasSubPart: boolean
  readonly seq: number
}

type IndexBuilder = {
  readonly unique: boolean
  readonly parts: Array<IndexPartBuilder>
}

/**
 * Batched catalog read for every table and view touched by the plan. Columns
 * and indexes are skipped when the plan only creates or drops views.
 */
const readCatalog = (
  ctx: TranslatePlanContext,
  names: ReadonlySet<string>,
  includeShapes: boolean
) =>
  Effect.gen(function* () {
    const tables = new Map<string, CatalogTable>()
    if (names.size === 0) return tables

    const nameList = [...names].map(quoteLiteral).join(", ")
    const tableRows = yield* ctx.readonlyQuery(
      `SELECT TABLE_NAME AS table_name, TABLE_TYPE AS table_type, DATA_LENGTH AS data_length, INDEX_LENGTH AS index_length FROM information_schema.tables WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${nameList})`
    )

    for (const row of tableRows) {
      const name = stringValue(row["table_name"])
      if (name === null) continue
      const table = ensureTable(tables, name)
      const type = tableTypeOf(row["table_type"])
      const sizeBytes = numberValue(row["data_length"]) + numberValue(row["index_length"])
      if (type !== table.type || sizeBytes !== table.sizeBytes) {
        tables.set(name, { type, columns: table.columns, indexes: table.indexes, sizeBytes })
      }
    }

    if (!includeShapes) return tables

    const columnRows = yield* ctx.readonlyQuery(
      `SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name, COLUMN_TYPE AS column_type, IS_NULLABLE AS is_nullable, COLUMN_DEFAULT AS column_default, EXTRA AS extra, CHARACTER_SET_NAME AS character_set_name, COLLATION_NAME AS collation_name, COLUMN_COMMENT AS column_comment, GENERATION_EXPRESSION AS generation_expression FROM information_schema.columns WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${nameList})`
    )

    for (const row of columnRows) {
      const tableName = stringValue(row["table_name"])
      const columnName = stringValue(row["column_name"])
      if (tableName === null || columnName === null) continue
      const table = ensureTable(tables, tableName)
      const extra = stringValue(row["extra"]) ?? ""
      table.columns.set(columnName, {
        name: columnName,
        columnType: normalizeCatalogType(stringValue(row["column_type"]) ?? ""),
        nullable: (stringValue(row["is_nullable"]) ?? "NO").toUpperCase() === "YES",
        defaultRaw: defaultRawValue(row["column_default"]),
        autoIncrement: extra.toLowerCase().includes("auto_increment"),
        characterSetName: stringValue(row["character_set_name"]),
        collationName: stringValue(row["collation_name"]),
        columnComment: stringValue(row["column_comment"]),
        extra,
        generationExpression: stringValue(row["generation_expression"])
      })
    }

    const indexRows = yield* ctx.readonlyQuery(
      `SELECT TABLE_NAME AS table_name, INDEX_NAME AS index_name, NON_UNIQUE AS non_unique, SEQ_IN_INDEX AS seq_in_index, COLUMN_NAME AS column_name, SUB_PART AS sub_part FROM information_schema.statistics WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${nameList}) ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`
    )

    const indexBuilders = new Map<string, Map<string, IndexBuilder>>()
    for (const row of indexRows) {
      const tableName = stringValue(row["table_name"])
      const indexName = stringValue(row["index_name"])
      if (tableName === null || indexName === null) continue
      ensureTable(tables, tableName)

      let tableIndexes = indexBuilders.get(tableName)
      if (tableIndexes === undefined) {
        tableIndexes = new Map()
        indexBuilders.set(tableName, tableIndexes)
      }

      let builder = tableIndexes.get(indexName)
      if (builder === undefined) {
        builder = { unique: isUniqueFlag(row["non_unique"]), parts: [] }
        tableIndexes.set(indexName, builder)
      }

      builder.parts.push({
        name: stringValue(row["column_name"]),
        hasSubPart: hasValue(row["sub_part"]),
        seq: numberValue(row["seq_in_index"])
      })
    }

    for (const [tableName, tableIndexes] of indexBuilders) {
      const table = tables.get(tableName)
      if (table === undefined) continue
      for (const [indexName, builder] of tableIndexes) {
        const parts = [...builder.parts]
          .sort((left, right) => left.seq - right.seq)
          .map((part) => ({ name: part.name, hasSubPart: part.hasSubPart }))
        table.indexes.push({ name: indexName, unique: builder.unique, columns: parts })
      }
    }

    return tables
  })

const readViewDefinitions = (ctx: TranslatePlanContext) =>
  Effect.gen(function* () {
    const rows = yield* ctx.readonlyQuery(
      "SELECT TABLE_NAME AS table_name, VIEW_DEFINITION AS view_definition FROM information_schema.views WHERE TABLE_SCHEMA = DATABASE()"
    )
    const views: Array<CatalogView> = []
    for (const row of rows) {
      const name = stringValue(row["table_name"])
      if (name === null) continue
      views.push({ name, definition: stringValue(row["view_definition"]) })
    }
    return views
  })

const indexColumnsMatch = (
  index: CatalogIndex,
  fields: ReadonlyArray<string>
) =>
  index.columns.length === fields.length &&
  index.columns.every(
    (part, position) => part.name === fields[position] && !part.hasSubPart
  )

const indexShapeMatches = (
  index: CatalogIndex,
  fields: ReadonlyArray<string>,
  unique: boolean
) => index.unique === unique && indexColumnsMatch(index, fields)

const describeIndex = (index: CatalogIndex) =>
  `${index.unique ? "UNIQUE " : ""}(${index.columns
    .map((part) => part.name ?? "<expression>")
    .join(", ")})`

const findIndexByName = (table: CatalogTable, name: string) =>
  table.indexes.find((index) => index.name.toLowerCase() === name.toLowerCase())

const catalogTextLength = (columnType: string): number | undefined => {
  const match = /^varchar\((\d+)\)$/.exec(columnType)
  return match === null ? undefined : Number(match[1])
}

const isExpressionDefault = (raw: string): boolean => {
  const value = raw.trim()
  if (value.toUpperCase() === "NULL") return false
  if (value.startsWith("'") || value.startsWith('"')) return false
  if (value.startsWith("_")) return false
  return true
}

/**
 * Reads data only for objects the catalog already contains. It never probes a
 * table or column that the same plan creates.
 */
const textDataPreflight = (
  steps: ReadonlyArray<MigrationStep>,
  ctx: TranslatePlanContext,
  catalog: ReadonlyMap<string, CatalogTable>
) =>
  Effect.gen(function* () {
    if (ctx.skipDataPreflight === true) return
    const stepColumns = stepColumnsOf(steps)
    const excluded = new Set<string>()
    for (const step of steps) {
      if (step.kind === "addColumn") excluded.add(`${step.table}\u0000${step.column.name}`)
      if (step.kind === "renameColumn") excluded.add(`${step.table}\u0000${step.to}`)
    }

    const fail = (step: MigrationStep["kind"], detail: string) =>
      Effect.fail(new UnsupportedMigrationStepError({ step, detail }))

    const narrowing = new Map<
      string,
      Array<{ readonly column: string; readonly maxLength: number }>
    >()

    for (const table of candidateTables(steps, ctx, stepColumns)) {
      const catalogTable = catalog.get(table)
      if (catalogTable === undefined || catalogTable.type !== "base") continue
      const columns = desiredColumnsFor(ctx, stepColumns, table) ?? []
      const indexes = desiredIndexesFor(ctx, table)

      for (const column of columns) {
        if (column.type !== "text") continue
        const actual = catalogTable.columns.get(column.name)
        if (actual === undefined) continue
        if (excluded.has(`${table}\u0000${column.name}`)) continue

        const extra = actual.extra.toLowerCase()
        if (
          (actual.columnComment ?? "") !== "" ||
          extra.includes("invisible") ||
          extra.includes("virtual generated") ||
          extra.includes("stored generated") ||
          (actual.generationExpression ?? "") !== ""
        ) {
          return yield* fail(
            "alterColumn",
            `column "${table}"."${column.name}" has a comment, invisible flag, or generated expression; automatic reconciliation would lose it. Use a manual ALTER`
          )
        }

        if (column.maxLength !== undefined && actual.defaultRaw !== null) {
          const raw = actual.defaultRaw
          if (raw.trim().toUpperCase() !== "NULL") {
            if (isExpressionDefault(raw)) {
              return yield* fail(
                "alterColumn",
                `column "${table}"."${column.name}" has an expression default; automatic reconciliation does not rewrite expression defaults. Use a manual ALTER`
              )
            }
            const value = normalizeTextDefault(raw)
            if (codePointLength(value) > column.maxLength) {
              return yield* fail(
                "alterColumn",
                `column "${table}"."${column.name}" has a catalog default of ${codePointLength(value)} characters, longer than maxLength ${column.maxLength}`
              )
            }
          }
        }

        if (!isKeyedColumn(column, indexes) || column.maxLength === undefined) continue
        const actualLength = catalogTextLength(actual.columnType)
        if (actualLength === undefined || actualLength > column.maxLength) {
          const list = narrowing.get(table) ?? []
          if (!list.some((entry) => entry.column === column.name)) {
            list.push({ column: column.name, maxLength: column.maxLength })
            narrowing.set(table, list)
          }
        }
      }
    }

    for (const [table, columns] of narrowing) {
      const select = columns
        .map((entry, index) =>
          `MAX(CHAR_LENGTH(${quoteIdentifier(entry.column)})) AS ${quoteIdentifier(`c${index}`)}`
        )
        .join(", ")
      const rows = yield* ctx.readonlyQuery(
        `SELECT ${select} FROM ${quoteIdentifier(table)}`
      )
      const row = rows[0]
      if (row === undefined) continue
      for (let index = 0; index < columns.length; index++) {
        const column = columns[index]
        if (column === undefined) continue
        const max = numberValue(row[`c${index}`])
        if (max > column.maxLength) {
          return yield* fail(
            "alterColumn",
            `column "${table}"."${column.column}" holds ${max} characters; cannot narrow to VARCHAR(${column.maxLength})`
          )
        }
      }
    }

    for (const step of steps) {
      if (step.kind !== "createIndex" || !step.unique) continue
      const catalogTable = catalog.get(step.table)
      if (catalogTable === undefined || catalogTable.type !== "base") continue
      if (catalogTable.indexes.some((index) => indexShapeMatches(index, step.fields, true))) {
        continue
      }
      if (step.fields.some((field) => !catalogTable.columns.has(field))) continue

      const columns = desiredColumnsFor(ctx, stepColumns, step.table) ?? []
      const where = step.fields
        .filter((field) => catalogTable.columns.get(field)?.nullable === true)
        .map((field) => `${quoteIdentifier(field)} IS NOT NULL`)
      const group = step.fields.map((field) => {
        const column = columns.find((candidate) => candidate.name === field)
        return column?.type === "text"
          ? `CONVERT(${quoteIdentifier(field)} USING utf8mb4) COLLATE ${effectiveTextCollation(column)}`
          : quoteIdentifier(field)
      })
      const whereSql = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""
      const rows = yield* ctx.readonlyQuery(
        `SELECT 1 AS hit FROM ${quoteIdentifier(step.table)}${whereSql} GROUP BY ${group.join(", ")} HAVING COUNT(*) > 1 LIMIT 1`
      )
      if (rows.length > 0) {
        return yield* fail(
          "createIndex",
          `unique index "${indexNameOf(step.table, step.fields)}" on "${step.table}" would collapse existing rows; resolve the duplicates before migrating`
        )
      }
    }

    for (const step of steps) {
      if (step.kind !== "addColumn") continue
      const catalogTable = catalog.get(step.table)
      if (catalogTable === undefined || catalogTable.type !== "base") continue
      const participates =
        step.column.unique === true ||
        desiredIndexesFor(ctx, step.table).some(
          (index) => index.unique && index.fields.includes(step.column.name)
        )
      if (!participates) continue
      if (step.column.nullable && (step.column.default === undefined || step.column.default === null)) {
        continue
      }
      const rows = yield* ctx.readonlyQuery(
        `SELECT 1 AS hit FROM ${quoteIdentifier(step.table)} LIMIT 2`
      )
      if (rows.length > 1) {
        return yield* fail(
          "addColumn",
          `cannot add unique column "${step.table}"."${step.column.name}" with a backfill value to a table with more than one row; the values would collide`
        )
      }
    }
  })

const reconcileDefaultSql = (col: ColumnDef, actual: CatalogColumn): string | undefined => {
  const raw = actual.defaultRaw
  if (raw === null) return undefined
  if (raw.trim().toUpperCase() === "NULL") return "DEFAULT NULL"
  const value = normalizeTextDefault(raw)
  const rendered = renderDefault({ ...col, default: value })
  if (!rendered.ok) {
    throw new UnsupportedMigrationStepError({
      step: "alterColumn",
      detail: `default for column "${col.name}" ${rendered.reason}`
    })
  }
  return rendered.value === undefined ? undefined : `DEFAULT ${rendered.value}`
}

type ReconciliationResult = {
  readonly statements: ReadonlyArray<string>
  readonly notes: ReadonlyArray<string>
  readonly tables: ReadonlySet<string>
  readonly columns: ReadonlySet<string>
}

/**
 * Repairs the physical text shape of every text column on a table the plan
 * touches. Columns with their own add/alter/rename step are left to that step.
 * All MODIFY clauses for one table are batched into one ALTER.
 */
const reconcileTextColumns = (
  steps: ReadonlyArray<MigrationStep>,
  ctx: TranslatePlanContext,
  catalog: ReadonlyMap<string, CatalogTable>
): ReconciliationResult => {
  const stepColumns = stepColumnsOf(steps)
  const excluded = new Set<string>()
  for (const step of steps) {
    if (step.kind === "addColumn") excluded.add(`${step.table}\u0000${step.column.name}`)
    if (step.kind === "alterColumn") excluded.add(`${step.table}\u0000${step.to.name}`)
    if (step.kind === "renameColumn") excluded.add(`${step.table}\u0000${step.to}`)
  }

  const statements: Array<string> = []
  const notes: Array<string> = []
  const tables = new Set<string>()
  const columns = new Set<string>()

  for (const table of candidateTables(steps, ctx, stepColumns)) {
    const catalogTable = catalog.get(table)
    if (catalogTable === undefined || catalogTable.type !== "base") continue
    const desired = desiredColumnsFor(ctx, stepColumns, table) ?? []
    const indexes = desiredIndexesFor(ctx, table)
    const modifies: Array<string> = []
    const staleDrops: Array<string> = []

    for (const column of desired) {
      if (column.type !== "text") continue
      const key = `${table}\u0000${column.name}`
      if (excluded.has(key)) continue
      const actual = catalogTable.columns.get(column.name)
      if (actual === undefined) continue
      const expectedType = expectedCatalogType(column, indexes)
      const matches =
        actual.columnType === expectedType &&
        actual.characterSetName === MYSQL_TEXT_CHARSET &&
        actual.collationName === effectiveTextCollation(column)
      if (matches) continue

      if (!isKeyedColumn(column, indexes)) {
        for (const index of catalogTable.indexes) {
          if (index.name.toUpperCase() === "PRIMARY") continue
          if (!index.columns.some((part) => part.name === column.name)) continue
          const desiredIndex = indexes.some((shape) =>
            indexShapeMatches(index, shape.fields, shape.unique)
          )
          if (desiredIndex) continue
          const planned = steps.some(
            (step) =>
              step.kind === "dropIndex" &&
              step.table === table &&
              indexShapeMatches(index, step.fields, step.unique)
          )
          if (planned) continue
          staleDrops.push(
            `DROP INDEX ${quoteIdentifier(index.name)} ON ${quoteIdentifier(table)}`
          )
        }
      }

      const defaultSql = reconcileDefaultSql(column, actual)
      const type = expectedType.toUpperCase()
      modifies.push(
        `MODIFY COLUMN ${quoteIdentifier(column.name)} ${type} CHARACTER SET ${MYSQL_TEXT_CHARSET} COLLATE ${effectiveTextCollation(column)} ${actual.nullable ? "NULL" : "NOT NULL"}${defaultSql === undefined ? "" : ` ${defaultSql}`}`
      )
      columns.add(key)
    }

    if (staleDrops.length > 0) statements.push(...staleDrops)
    if (modifies.length > 0) {
      statements.push(
        `ALTER TABLE ${quoteIdentifier(table)} ${modifies.join(", ")}, ALGORITHM=COPY, LOCK=SHARED`
      )
      const size =
        catalogTable.sizeBytes > 0
          ? ` (${catalogTable.sizeBytes} bytes; budget similar free space)`
          : ""
      notes.push(`reconcile text shape on ${table}${size}`)
      tables.add(table)
    }
  }

  return { statements, notes, tables, columns }
}

/**
 * Compares one existing base table against the desired create shape. Returns a
 * drift detail or `undefined` when the table already matches.
 */
const compareTableShape = (
  table: string,
  columns: ReadonlyArray<ColumnDef>,
  explicitIndexes: ReadonlyArray<IndexShape>,
  catalog: CatalogTable,
  ignoredTextColumns: ReadonlySet<string> = new Set()
): string | undefined => {
  const desiredNames = columns.map((column) => column.name)
  const catalogNames = [...catalog.columns.keys()]
  const missing = desiredNames.filter((name) => !catalog.columns.has(name))
  const unexpected = catalogNames.filter((name) => !desiredNames.includes(name))
  if (missing.length > 0 || unexpected.length > 0) {
    return `table "${table}" column set differs: expected [${desiredNames.join(", ")}], found [${catalogNames.join(", ")}]`
  }

  for (const column of columns) {
    const actual = catalog.columns.get(column.name)
    if (actual === undefined) continue
    if (ignoredTextColumns.has(column.name) && column.type === "text") {
      const matches =
        column.nullable === actual.nullable &&
        (column.autoIncrement === true) === actual.autoIncrement &&
        defaultTagOf(column) === normalizeDefault(column, actual.defaultRaw)
      if (!matches) {
        return `column "${table}"."${column.name}" differs outside the queued text reconciliation: expected ${describeExpectedColumn(column, explicitIndexes)}, found ${describeCatalogColumn(actual)}`
      }
      continue
    }
    if (!columnMatchesCatalog(column, actual, explicitIndexes)) {
      return `column "${table}"."${column.name}" differs: expected ${describeExpectedColumn(column, explicitIndexes)}, found ${describeCatalogColumn(actual)}`
    }
  }

  const primaryFields = columns
    .filter((column) => column.primaryKey === true)
    .map((column) => column.name)
  const primary = catalog.indexes.find(
    (index) => index.name.toUpperCase() === "PRIMARY"
  )
  if (primaryFields.length > 0) {
    if (primary === undefined) {
      return `table "${table}" is missing its primary key (${primaryFields.join(", ")})`
    }
    if (!indexColumnsMatch(primary, primaryFields)) {
      return `table "${table}" primary key differs: expected (${primaryFields.join(", ")}), found ${describeIndex(primary)}`
    }
  } else if (primary !== undefined) {
    return `table "${table}" has an unexpected primary key ${describeIndex(primary)}`
  }

  const uniqueFields = columns
    .filter((column) => column.unique === true && column.primaryKey !== true)
    .map((column) => column.name)
  for (const field of uniqueFields) {
    const found = catalog.indexes.some(
      (index) =>
        index.unique &&
        index.name.toUpperCase() !== "PRIMARY" &&
        indexColumnsMatch(index, [field])
    )
    if (!found) {
      return `table "${table}" is missing the unique key on "${field}"`
    }
  }

  for (const index of catalog.indexes) {
    if (index.name.toUpperCase() === "PRIMARY") continue

    const first = index.columns[0]
    if (
      index.unique &&
      index.columns.length === 1 &&
      first !== undefined &&
      first.name !== null &&
      !first.hasSubPart &&
      uniqueFields.includes(first.name)
    ) {
      continue
    }

    const planned = explicitIndexes.some(
      (shape) =>
        index.name.toLowerCase() === indexNameOf(table, shape.fields).toLowerCase() &&
        index.unique === shape.unique &&
        indexColumnsMatch(index, shape.fields)
    )
    if (!planned) {
      return `table "${table}" has an unexpected index "${index.name}" ${describeIndex(index)}`
    }
  }

  return undefined
}

const needsViewScan = (steps: ReadonlyArray<MigrationStep>) =>
  steps.some(
    (step) =>
      step.kind === "dropColumn" ||
      step.kind === "dropTable" ||
      step.kind === "dropView" ||
      (step.kind === "alterColumn" && step.from.type !== step.to.type)
  )

const viewTriggerKind = (
  steps: ReadonlyArray<MigrationStep>
): MigrationStep["kind"] => {
  if (steps.some((step) => step.kind === "dropColumn")) return "dropColumn"
  if (steps.some((step) => step.kind === "dropTable")) return "dropTable"
  if (
    steps.some(
      (step) => step.kind === "alterColumn" && step.from.type !== step.to.type
    )
  ) {
    return "alterColumn"
  }
  return "dropView"
}

/**
 * Fails when a view in the current database reads a table or view this plan
 * changes but the plan neither drops nor recreates that view. The scan is
 * table-level and current-schema only.
 */
const dependentViewError = (
  steps: ReadonlyArray<MigrationStep>,
  ctx: TranslatePlanContext,
  catalogViews: ReadonlyArray<CatalogView>,
  extraChangedTables: ReadonlySet<string> = new Set()
): UnsupportedMigrationStepError | undefined => {
  const changedTables = new Set<string>(extraChangedTables)
  const droppedViews = new Set<string>()
  const planViews = new Set<string>()

  for (const step of steps) {
    if (step.kind === "dropColumn" || step.kind === "dropTable") {
      changedTables.add(step.table)
    }
    if (step.kind === "alterColumn" && step.from.type !== step.to.type) {
      changedTables.add(step.table)
    }
    if (step.kind === "dropView") {
      droppedViews.add(normalizeIdentifier(step.view))
      planViews.add(normalizeIdentifier(step.view))
    }
    if (step.kind === "createView") {
      planViews.add(normalizeIdentifier(step.view))
    }
  }

  const views = new Map<string, ViewShape>()
  const rawNames = new Map<string, string>()
  for (const view of catalogViews) {
    views.set(view.name, { stored: { query: view.definition }, desired: null })
    rawNames.set(normalizeIdentifier(view.name), view.name)
  }

  const known = new Set([...views.keys()].map(normalizeIdentifier))
  for (const [name, shape] of ctx.views) {
    const normalized = normalizeIdentifier(name)
    if (known.has(normalized)) continue
    known.add(normalized)
    views.set(name, shape)
    rawNames.set(normalized, name)
  }

  const affected = affectedViews(views, droppedViews, changedTables)
  for (const normalized of [...affected].sort()) {
    if (planViews.has(normalized)) continue
    const raw = rawNames.get(normalized) ?? normalized
    return new UnsupportedMigrationStepError({
      step: viewTriggerKind(steps),
      detail: `view "${raw}" references a table that this plan changes; add its dropView and createView steps to the plan or remove the view before migrating`
    })
  }

  return undefined
}

const collectTableNames = (steps: ReadonlyArray<MigrationStep>) => {
  const names = new Set<string>()
  for (const step of steps) {
    switch (step.kind) {
      case "createTable":
      case "createSystemTable":
      case "dropTable":
      case "addColumn":
      case "dropColumn":
      case "renameColumn":
      case "alterColumn":
      case "createIndex":
      case "dropIndex":
        names.add(step.table)
        break
      case "renameTable":
        names.add(step.from)
        names.add(step.to)
        break
      case "createView":
      case "dropView":
        names.add(step.view)
        break
    }
  }
  return names
}

const describeStep = (step: MigrationStep): string => {
  switch (step.kind) {
    case "createTable":
      return `createTable ${step.table}`
    case "createSystemTable":
      return `createSystemTable ${step.table}`
    case "dropTable":
      return `dropTable ${step.table}`
    case "renameTable":
      return `renameTable ${step.from} -> ${step.to}`
    case "addColumn":
      return `addColumn ${step.table}.${step.column.name}`
    case "dropColumn":
      return `dropColumn ${step.table}.${step.column}`
    case "renameColumn":
      return `renameColumn ${step.table}.${step.from} -> ${step.to}`
    case "alterColumn":
      return `alterColumn ${step.table}.${step.to.name}`
    case "createIndex":
      return `createIndex ${step.table} [${step.fields.join(", ")}]`
    case "dropIndex":
      return `dropIndex ${step.table} [${step.fields.join(", ")}]`
    case "createView":
      return `createView ${step.view}`
    case "dropView":
      return `dropView ${step.view}`
  }
}

type StepResult =
  | { readonly status: "done" }
  | { readonly status: "pending"; readonly statements: ReadonlyArray<string> }
  | { readonly status: "drift"; readonly detail: string }

const done = (): StepResult => ({ status: "done" })

const pending = (statements: ReadonlyArray<string> = []): StepResult => ({
  status: "pending",
  statements
})

const drift = (detail: string): StepResult => ({ status: "drift", detail })

type PlanState = {
  readonly ctx: TranslatePlanContext
  readonly catalog: ReadonlyMap<string, CatalogTable>
  readonly plannedColumns: Map<string, ReadonlyArray<ColumnDef>>
  readonly renameSource: Map<string, string>
  readonly reconciledTables: Set<string>
  readonly reconciledColumns: Set<string>
}

const isPlannedTable = (state: PlanState, name: string) =>
  state.plannedColumns.has(name) || state.renameSource.has(name)

/** Resolves a table name through earlier `renameTable` steps in the same plan. */
const resolveTable = (
  state: PlanState,
  name: string
): CatalogTable | undefined => {
  const direct = state.catalog.get(name)
  if (direct !== undefined) return direct

  const seen = new Set<string>()
  let current = state.renameSource.get(name)
  while (current !== undefined && !seen.has(current)) {
    seen.add(current)
    const table = state.catalog.get(current)
    if (table !== undefined) return table
    current = state.renameSource.get(current)
  }
  return undefined
}

const isIntermediateAdd = (
  desired: ColumnDef,
  actual: CatalogColumn,
  indexes: ReadonlyArray<IndexShape>
) =>
  !desired.nullable &&
  desired.default === undefined &&
  actual.nullable &&
  !actual.autoIncrement &&
  expectedCatalogType(desired, indexes) === actual.columnType &&
  normalizeDefault(desired, actual.defaultRaw) === "null"

const textIndexGuard = (
  step: Extract<MigrationStep, { kind: "createIndex" }>,
  table: CatalogTable,
  ctx: TranslatePlanContext
): string | undefined => {
  const desired = ctx.tables.get(step.table)?.desired
  for (const field of step.fields) {
    const column = table.columns.get(field)
    if (column === undefined) continue
    if (!UNBOUNDED_TEXT_TYPES.has(column.columnType)) continue
    const desiredColumn = desired?.columns.find((candidate) => candidate.name === field)
    if (
      desiredColumn?.type === "text" &&
      desiredColumn.maxLength !== undefined &&
      isKeyedColumn(desiredColumn, desired?.indexes ?? [])
    ) {
      continue
    }
    return `cannot create index "${indexNameOf(step.table, step.fields)}" on "${step.table}"."${field}" because the catalog column is ${column.columnType}; declare a maxLength for the text field or remove the index`
  }
  return undefined
}

const evaluateStep = (step: MigrationStep, state: PlanState): StepResult => {
  switch (step.kind) {
    case "createTable":
    case "createSystemTable": {
      const indexes =
        step.kind === "createTable" ? desiredIndexesFor(state.ctx, step.table) : []
      const existing = state.catalog.get(step.table)
      if (existing === undefined) {
        state.plannedColumns.set(step.table, step.columns)
        return pending([createTableSql(step.table, step.columns, indexes, step.kind)])
      }
      if (existing.type !== "base") {
        return drift(
          `table "${step.table}" already exists as ${existing.type === "view" ? "a view" : "a non-table object"}`
        )
      }
      const ignored = new Set(
        step.columns
          .filter(
            (column) =>
              column.type === "text" &&
              state.reconciledColumns.has(`${step.table}\u0000${column.name}`)
          )
          .map((column) => column.name)
      )
      const detail = compareTableShape(step.table, step.columns, indexes, existing, ignored)
      return detail === undefined ? done() : drift(detail)
    }

    case "dropTable": {
      const existing = resolveTable(state, step.table)
      if (existing === undefined) return done()
      if (existing.type === "view") {
        return drift(`"${step.table}" is a view, not a table`)
      }
      return pending([`DROP TABLE IF EXISTS ${quoteIdentifier(step.table)}`])
    }

    case "renameTable": {
      const source = resolveTable(state, step.from)
      const target = resolveTable(state, step.to)
      if (target !== undefined && source === undefined) return done()
      if (source !== undefined && target === undefined) {
        state.renameSource.set(step.to, step.from)
        return pending([
          `RENAME TABLE ${quoteIdentifier(step.from)} TO ${quoteIdentifier(step.to)}`
        ])
      }
      return drift(
        `cannot rename "${step.from}" to "${step.to}": both names already exist or neither exists`
      )
    }

    case "addColumn": {
      const indexes = desiredIndexesFor(state.ctx, step.table)
      const planned = state.plannedColumns.get(step.table)
      if (planned !== undefined) {
        const listed = planned.some((column) => column.name === step.column.name)
        return listed
          ? done()
          : pending(addColumnStatements(step.table, step.column, indexes))
      }

      const table = resolveTable(state, step.table)
      if (table === undefined) {
        return drift(
          `table "${step.table}" does not exist and the plan does not create it`
        )
      }
      if (table.type !== "base") return drift(`"${step.table}" is not a base table`)

      const actual = table.columns.get(step.column.name)
      if (actual === undefined) {
        return pending(addColumnStatements(step.table, step.column, indexes))
      }
      if (columnMatchesCatalog(step.column, actual, indexes)) return done()
      if (isIntermediateAdd(step.column, actual, indexes)) {
        const tableSql = quoteIdentifier(step.table)
        const columnSql = quoteIdentifier(step.column.name)
        return pending([
          `UPDATE ${tableSql} SET ${columnSql} = ${backfillLiteral(step.column)} WHERE ${columnSql} IS NULL`,
          `ALTER TABLE ${tableSql} MODIFY COLUMN ${columnDefinition(step.column, indexes, "addColumn")}`
        ])
      }
      return drift(
        `column "${step.table}"."${step.column.name}" differs: expected ${describeExpectedColumn(step.column, indexes)}, found ${describeCatalogColumn(actual)}`
      )
    }

    case "dropColumn": {
      const planned = state.plannedColumns.get(step.table)
      if (planned !== undefined) {
        const listed = planned.some((column) => column.name === step.column)
        return listed
          ? pending([
              `ALTER TABLE ${quoteIdentifier(step.table)} DROP COLUMN ${quoteIdentifier(step.column)}`
            ])
          : done()
      }

      const table = resolveTable(state, step.table)
      if (table === undefined) return done()
      if (!table.columns.has(step.column)) return done()
      return pending([
        `ALTER TABLE ${quoteIdentifier(step.table)} DROP COLUMN ${quoteIdentifier(step.column)}`
      ])
    }

    case "renameColumn": {
      const planned = state.plannedColumns.get(step.table)
      if (planned !== undefined) {
        const hasSource = planned.some((column) => column.name === step.from)
        const hasTarget = planned.some((column) => column.name === step.to)
        if (hasTarget && !hasSource) return done()
        if (hasSource && !hasTarget) {
          return pending([
            `ALTER TABLE ${quoteIdentifier(step.table)} RENAME COLUMN ${quoteIdentifier(step.from)} TO ${quoteIdentifier(step.to)}`
          ])
        }
        return drift(
          `cannot rename column "${step.table}"."${step.from}" to "${step.to}": both names already exist or neither exists`
        )
      }

      const table = resolveTable(state, step.table)
      if (table === undefined) {
        return drift(
          `table "${step.table}" does not exist and the plan does not create it`
        )
      }
      const hasSource = table.columns.has(step.from)
      const hasTarget = table.columns.has(step.to)
      if (hasTarget && !hasSource) return done()
      if (hasSource && !hasTarget) {
        return pending([
          `ALTER TABLE ${quoteIdentifier(step.table)} RENAME COLUMN ${quoteIdentifier(step.from)} TO ${quoteIdentifier(step.to)}`
        ])
      }
      return drift(
        `cannot rename column "${step.table}"."${step.from}" to "${step.to}": both names already exist or neither exists`
      )
    }

    case "alterColumn": {
      const indexes = desiredIndexesFor(state.ctx, step.table)
      const planned = state.plannedColumns.get(step.table)
      if (planned !== undefined) {
        const actual = planned.find((column) => column.name === step.to.name)
        if (actual === undefined) {
          return drift(
            `column "${step.table}"."${step.to.name}" is not part of the plan's createTable step`
          )
        }
        return columnMatchesDefinition(step.to, actual, indexes)
          ? done()
          : pending(alterColumnStatements(step, indexes))
      }

      const table = resolveTable(state, step.table)
      if (table === undefined) {
        return drift(
          `table "${step.table}" does not exist and the plan does not create it`
        )
      }
      if (table.type !== "base") return drift(`"${step.table}" is not a base table`)

      const actual = table.columns.get(step.to.name)
      if (actual === undefined) {
        return drift(`column "${step.table}"."${step.to.name}" does not exist`)
      }
      if (columnMatchesCatalog(step.to, actual, indexes)) return done()

      const fromIndexes = state.ctx.tables.get(step.table)?.stored?.indexes ?? []
      const structuralTo =
        expectedCatalogType(step.to, indexes) === actual.columnType &&
        step.to.nullable === actual.nullable &&
        (step.to.autoIncrement === true) === actual.autoIncrement
      const provisionalFrom =
        step.from.type === "text" &&
        (isKeyedColumn(step.from, fromIndexes)
          ? actual.columnType === `varchar(${PROVISIONAL_TEXT_LENGTH})`
          : UNBOUNDED_TEXT_TYPES.has(actual.columnType))
      const structuralFrom =
        provisionalFrom ||
        (expectedCatalogType(step.from, fromIndexes) === actual.columnType &&
          step.from.nullable === actual.nullable &&
          (step.from.autoIncrement === true) === actual.autoIncrement)

      if (structuralTo || structuralFrom) {
        return pending(alterColumnStatements(step, indexes))
      }
      return drift(
        `column "${step.table}"."${step.to.name}" differs from both plan shapes: expected ${describeExpectedColumn(step.from, fromIndexes)} or ${describeExpectedColumn(step.to, indexes)}, found ${describeCatalogColumn(actual)}`
      )
    }

    case "createIndex": {
      const table = resolveTable(state, step.table)
      if (table === undefined) {
        if (isPlannedTable(state, step.table)) {
          return pending([createIndexSql(step.table, step.fields, step.unique)])
        }
        return drift(
          `table "${step.table}" does not exist and the plan does not create it`
        )
      }
      if (table.type !== "base") return drift(`"${step.table}" is not a base table`)

      const guard = textIndexGuard(step, table, state.ctx)
      if (guard !== undefined) return drift(guard)

      const expectedName = indexNameOf(step.table, step.fields)
      const found = findIndexByName(table, expectedName)
      if (found === undefined) {
        return pending([createIndexSql(step.table, step.fields, step.unique)])
      }
      if (indexColumnsMatch(found, step.fields) && found.unique === step.unique) {
        return done()
      }
      return drift(
        `index "${expectedName}" on "${step.table}" differs: expected ${step.unique ? "UNIQUE " : ""}(${step.fields.join(", ")}), found ${describeIndex(found)}`
      )
    }

    case "dropIndex": {
      const table = resolveTable(state, step.table)
      if (table === undefined) return done()
      if (table.type !== "base") return done()

      const found = table.indexes.find((index) =>
        indexShapeMatches(index, step.fields, step.unique)
      )
      if (found === undefined) return done()
      return pending([
        `DROP INDEX ${quoteIdentifier(found.name)} ON ${quoteIdentifier(step.table)}`
      ])
    }

    case "createView": {
      const existing = state.catalog.get(step.view)
      if (existing !== undefined && existing.type !== "view") {
        return drift(
          `createView "${step.view}": ${existing.type === "base" ? "a base table" : "a non-view object"} with this name exists`
        )
      }
      return pending()
    }

    case "dropView": {
      const existing = state.catalog.get(step.view)
      if (existing === undefined) return done()
      if (existing.type !== "view") {
        return drift(
          `dropView "${step.view}": ${existing.type === "base" ? "a base table" : "a non-view object"} with this name exists`
        )
      }
      return pending()
    }
  }
}

const translatePlan = (
  steps: ReadonlyArray<MigrationStep>,
  ctx: TranslatePlanContext
) =>
  Effect.gen(function* () {
    if (steps.length === 0) {
      return { statements: [], cleanup: [], notes: [], skipped: [] }
    }

    const preflight = collectPreflightError(steps, ctx)
    if (preflight !== undefined) return yield* Effect.fail(preflight)
    const textPreflight = textPreflightError(steps, ctx)
    if (textPreflight !== undefined) return yield* Effect.fail(textPreflight)

    const includeShapes = steps.some(
      (step) => step.kind !== "createView" && step.kind !== "dropView"
    )
    const catalog = yield* readCatalog(ctx, collectTableNames(steps), includeShapes)
    if (includeShapes) {
      yield* textDataPreflight(steps, ctx, catalog)
    }

    const reconciliation = includeShapes
      ? reconcileTextColumns(steps, ctx, catalog)
      : { statements: [], notes: [], tables: new Set<string>(), columns: new Set<string>() }

    if (needsViewScan(steps) || reconciliation.tables.size > 0) {
      const catalogViews = yield* readViewDefinitions(ctx)
      const viewError = dependentViewError(steps, ctx, catalogViews, reconciliation.tables)
      if (viewError !== undefined) return yield* Effect.fail(viewError)
    }

    const state: PlanState = {
      ctx,
      catalog,
      plannedColumns: new Map(),
      renameSource: new Map(),
      reconciledTables: new Set(reconciliation.tables),
      reconciledColumns: new Set(reconciliation.columns)
    }

    const notes: Array<string> = []
    const skipped: Array<number> = []
    const tableStatements: Array<string> = []
    const pendingDrops: Array<string> = []
    const pendingCreates: Array<{ readonly view: string; readonly query: string }> = []
    let reconciled = false

    for (let index = 0; index < steps.length; index++) {
      const step = steps[index]
      if (step === undefined) continue

      if (
        !reconciled &&
        step.kind !== "dropView" &&
        step.kind !== "dropIndex" &&
        step.kind !== "createView"
      ) {
        tableStatements.push(...reconciliation.statements)
        notes.push(...reconciliation.notes)
        reconciled = true
      }

      const result = evaluateStep(step, state)
      if (result.status === "drift") {
        return yield* Effect.fail(
          new UnsupportedMigrationStepError({ step: step.kind, detail: result.detail })
        )
      }
      if (result.status === "done") {
        notes.push(`skip ${describeStep(step)} (already present)`)
        skipped.push(index)
        continue
      }

      if (step.kind === "dropView") {
        pendingDrops.push(step.view)
      } else if (step.kind === "createView") {
        pendingCreates.push({ view: step.view, query: step.query })
      } else {
        tableStatements.push(...result.statements)
      }
    }

    if (!reconciled && reconciliation.statements.length > 0) {
      tableStatements.push(...reconciliation.statements)
      notes.push(...reconciliation.notes)
    }

    const statements: Array<string> = []

    const dropNames = new Map<string, string>()
    for (const view of pendingDrops) {
      dropNames.set(normalizeIdentifier(view), view)
    }
    const dropOrder = topologicalViewOrder(
      new Set(dropNames.keys()),
      viewDependencies(ctx.views, "stored")
    ).reverse()
    for (const normalized of dropOrder) {
      const raw = dropNames.get(normalized)
      if (raw === undefined) continue
      statements.push(`DROP VIEW IF EXISTS ${quoteIdentifier(raw)}`)
      notes.push(`drop view ${raw}`)
    }

    statements.push(...tableStatements)

    const createNames = new Map<
      string,
      { readonly view: string; readonly query: string }
    >()
    for (const create of pendingCreates) {
      createNames.set(normalizeIdentifier(create.view), create)
    }
    const createOrder = topologicalViewOrder(
      new Set(createNames.keys()),
      viewDependencies(ctx.views, "desired")
    )
    for (const normalized of createOrder) {
      const create = createNames.get(normalized)
      if (create === undefined) continue
      statements.push(
        `CREATE OR REPLACE VIEW ${quoteIdentifier(create.view)} AS ${create.query}`
      )
      notes.push(`create view ${create.view}`)
    }

    return { statements, cleanup: [], notes, skipped }
  })

type PlanShapes = {
  readonly columns: ReadonlyMap<string, ReadonlyArray<ColumnDef>>
  readonly indexes: ReadonlyMap<string, ReadonlyArray<IndexShape>>
}

const collectPlanShapes = (
  steps: ReadonlyArray<MigrationStep>,
  ctx: TranslatePlanContext
): PlanShapes => {
  const stepColumns = stepColumnsOf(steps)
  const columns = new Map<string, ReadonlyArray<ColumnDef>>()
  const indexes = new Map<string, ReadonlyArray<IndexShape>>()
  for (const table of candidateTables(steps, ctx, stepColumns)) {
    const tableColumns = desiredColumnsFor(ctx, stepColumns, table)
    if (tableColumns === undefined) continue
    columns.set(table, tableColumns)
    indexes.set(table, desiredIndexesFor(ctx, table))
  }
  return { columns, indexes }
}

const verifyTextShape = (
  steps: ReadonlyArray<MigrationStep>,
  ctx: TranslatePlanContext,
  catalog: ReadonlyMap<string, CatalogTable>,
  shapes: PlanShapes
) => {
  const stepColumns = stepColumnsOf(steps)
  for (const table of candidateTables(steps, ctx, stepColumns)) {
    const catalogTable = catalog.get(table)
    if (catalogTable === undefined || catalogTable.type !== "base") continue
    const columns = shapes.columns.get(table) ?? []
    const indexes = shapes.indexes.get(table) ?? []
    for (const column of columns) {
      if (column.type !== "text") continue
      const actual = catalogTable.columns.get(column.name)
      if (actual === undefined) {
        return `post-apply verification: text column "${table}"."${column.name}" does not exist`
      }
      if (!columnMatchesCatalog(column, actual, indexes)) {
        return `post-apply verification: text column "${table}"."${column.name}" differs: expected ${describeExpectedColumn(column, indexes)}, found ${describeCatalogColumn(actual)}`
      }
    }
  }
  return undefined
}

const verifyStep = (
  step: MigrationStep,
  ctx: TranslatePlanContext,
  catalog: ReadonlyMap<string, CatalogTable>,
  recreatedViews: ReadonlySet<string>,
  shapes: PlanShapes
): string | undefined => {
  switch (step.kind) {
    case "createTable":
    case "createSystemTable": {
      const table = catalog.get(step.table)
      if (table === undefined) {
        return `post-apply verification: table "${step.table}" does not exist`
      }
      if (table.type !== "base") {
        return `post-apply verification: "${step.table}" is not a base table`
      }
      const indexes = shapes.indexes.get(step.table) ?? []
      const columns = shapes.columns.get(step.table) ?? step.columns
      const detail = compareTableShape(step.table, columns, indexes, table)
      return detail === undefined ? undefined : `post-apply verification: ${detail}`
    }

    case "dropTable": {
      if (catalog.get(step.table) === undefined) return undefined
      return `post-apply verification: table "${step.table}" still exists`
    }

    case "renameTable": {
      const source = catalog.get(step.from)
      const target = catalog.get(step.to)
      if (source === undefined && target !== undefined) return undefined
      return `post-apply verification: rename "${step.from}" to "${step.to}" did not take effect`
    }

    case "addColumn": {
      const table = catalog.get(step.table)
      if (table === undefined) {
        return `post-apply verification: table "${step.table}" does not exist`
      }
      const actual = table.columns.get(step.column.name)
      if (actual === undefined) {
        return `post-apply verification: column "${step.table}"."${step.column.name}" does not exist`
      }
      const indexes = desiredIndexesFor(ctx, step.table)
      if (!columnMatchesCatalog(step.column, actual, indexes)) {
        return `post-apply verification: column "${step.table}"."${step.column.name}" differs: expected ${describeExpectedColumn(step.column, indexes)}, found ${describeCatalogColumn(actual)}`
      }
      return undefined
    }

    case "dropColumn": {
      const table = catalog.get(step.table)
      if (table === undefined) return undefined
      if (!table.columns.has(step.column)) return undefined
      return `post-apply verification: column "${step.table}"."${step.column}" still exists`
    }

    case "renameColumn": {
      const table = catalog.get(step.table)
      if (table === undefined) {
        return `post-apply verification: table "${step.table}" does not exist`
      }
      const hasSource = table.columns.has(step.from)
      const hasTarget = table.columns.has(step.to)
      if (!hasSource && hasTarget) return undefined
      return `post-apply verification: rename column "${step.table}"."${step.from}" to "${step.to}" did not take effect`
    }

    case "alterColumn": {
      const table = catalog.get(step.table)
      if (table === undefined) {
        return `post-apply verification: table "${step.table}" does not exist`
      }
      const actual = table.columns.get(step.to.name)
      if (actual === undefined) {
        return `post-apply verification: column "${step.table}"."${step.to.name}" does not exist`
      }
      const indexes = shapes.indexes.get(step.table) ?? desiredIndexesFor(ctx, step.table)
      if (!columnMatchesCatalog(step.to, actual, indexes)) {
        return `post-apply verification: column "${step.table}"."${step.to.name}" differs: expected ${describeExpectedColumn(step.to, indexes)}, found ${describeCatalogColumn(actual)}`
      }
      return undefined
    }

    case "createIndex": {
      const table = catalog.get(step.table)
      if (table === undefined) {
        return `post-apply verification: table "${step.table}" does not exist`
      }
      if (table.type !== "base") {
        return `post-apply verification: "${step.table}" is not a base table`
      }
      const expectedName = indexNameOf(step.table, step.fields)
      const found = findIndexByName(table, expectedName)
      if (found === undefined) {
        return `post-apply verification: index "${expectedName}" on "${step.table}" does not exist`
      }
      if (!indexColumnsMatch(found, step.fields) || found.unique !== step.unique) {
        return `post-apply verification: index "${expectedName}" on "${step.table}" differs: expected ${step.unique ? "UNIQUE " : ""}(${step.fields.join(", ")}), found ${describeIndex(found)}`
      }
      const columns = shapes.columns.get(step.table)
      if (columns === undefined) {
        return `post-apply verification: cannot verify index field shape on "${step.table}"; no desired column shape`
      }
      const indexes = [
        ...(shapes.indexes.get(step.table) ?? []),
        { fields: step.fields, unique: step.unique }
      ]
      for (const field of step.fields) {
        const desired = columns.find((column) => column.name === field)
        if (desired === undefined) {
          return `post-apply verification: index field "${step.table}"."${field}" has no desired column shape`
        }
        const actual = table.columns.get(field)
        if (actual === undefined) {
          return `post-apply verification: index field "${step.table}"."${field}" does not exist`
        }
        if (!columnMatchesCatalog(desired, actual, indexes)) {
          return `post-apply verification: index field "${step.table}"."${field}" differs: expected ${describeExpectedColumn(desired, indexes)}, found ${describeCatalogColumn(actual)}`
        }
      }
      return undefined
    }

    case "dropIndex": {
      const table = catalog.get(step.table)
      if (table === undefined) return undefined
      const found = table.indexes.find((index) =>
        indexShapeMatches(index, step.fields, step.unique)
      )
      if (found === undefined) return undefined
      return `post-apply verification: index "${found.name}" on "${step.table}" still exists`
    }

    case "createView": {
      const existing = catalog.get(step.view)
      if (existing !== undefined && existing.type === "view") return undefined
      return `post-apply verification: view "${step.view}" does not exist`
    }

    case "dropView": {
      if (catalog.get(step.view) === undefined) return undefined
      if (recreatedViews.has(normalizeIdentifier(step.view))) return undefined
      return `post-apply verification: view "${step.view}" still exists`
    }
  }
}

const verifyPlan = (
  steps: ReadonlyArray<MigrationStep>,
  ctx: TranslatePlanContext
) =>
  Effect.gen(function* () {
    if (steps.length === 0) return

    const includeShapes = steps.some(
      (step) => step.kind !== "createView" && step.kind !== "dropView"
    )
    const catalog = yield* readCatalog(ctx, collectTableNames(steps), includeShapes)

    const recreatedViews = new Set(
      steps
        .filter((step) => step.kind === "createView")
        .map((step) => normalizeIdentifier(step.view))
    )
    const shapes = collectPlanShapes(steps, ctx)
    for (const step of steps) {
      const detail = verifyStep(step, ctx, catalog, recreatedViews, shapes)
      if (detail !== undefined) {
        return yield* Effect.fail(
          new UnsupportedMigrationStepError({ step: step.kind, detail })
        )
      }
    }
    const textDetail = verifyTextShape(steps, ctx, catalog, shapes)
    if (textDetail !== undefined) {
      return yield* Effect.fail(
        new UnsupportedMigrationStepError({ step: "alterColumn", detail: textDetail })
      )
    }
  })

const renderUpsert = (
  table: string,
  record: Readonly<Record<string, unknown>>,
  conflictKeys: ReadonlyArray<string>,
  bound: boolean
): ParameterizedStatement => {
  const keys = Object.keys(record)
  const conflicts = new Set(conflictKeys)
  const updates = keys.filter((key) => !conflicts.has(key))
  if (updates.length === 0) {
    throw new UnsupportedMigrationStepError({
      step: "createSystemTable",
      detail: `upsert into "${table}" has no columns to update because every column is a conflict key`
    })
  }

  const columns = keys.map(quoteIdentifier).join(", ")
  const values = keys
    .map((key) => (bound ? "?" : quoteLiteral(record[key])))
    .join(", ")
  const assignments = updates
    .map((key) => `${quoteIdentifier(key)} = VALUES(${quoteIdentifier(key)})`)
    .join(", ")

  return {
    sql: `INSERT INTO ${quoteIdentifier(table)} (${columns}) VALUES (${values}) ON DUPLICATE KEY UPDATE ${assignments}`,
    params: bound ? keys.map((key) => record[key]) : []
  }
}

const preflightPlan = (
  steps: ReadonlyArray<MigrationStep>,
  ctx: TranslatePlanContext
) =>
  Effect.gen(function* () {
    const preflight = collectPreflightError(steps, ctx)
    if (preflight !== undefined) return yield* Effect.fail(preflight)
    const textPreflight = textPreflightError(steps, ctx)
    if (textPreflight !== undefined) return yield* Effect.fail(textPreflight)

    const rows = yield* ctx.readonlyQuery(
      `SELECT ('a' COLLATE ${mysqlTextCollation}) = ('a ' COLLATE ${mysqlTextCollation}) AS bin_padded, ` +
        `('a' COLLATE ${mysqlEmailCollation}) = ('a ' COLLATE ${mysqlEmailCollation}) AS email_padded, ` +
        `('A' COLLATE ${mysqlEmailCollation}) = ('a' COLLATE ${mysqlEmailCollation}) AS email_case_equal`
    )
    const row = rows[0]
    if (numberValue(row?.["bin_padded"]) === 1 || numberValue(row?.["email_padded"]) === 1) {
      return yield* Effect.fail(
        new UnsupportedMigrationStepError({
          step: "alterColumn",
          detail: `this MySQL/MariaDB server aliases ${mysqlTextCollation} or ${mysqlEmailCollation} to PAD SPACE; the text strategy requires a NO PAD build`
        })
      )
    }
    if (numberValue(row?.["email_case_equal"]) !== 1) {
      return yield* Effect.fail(
        new UnsupportedMigrationStepError({
          step: "alterColumn",
          detail: `${mysqlEmailCollation} is not case-insensitive on this server; the auth email key requires a case-insensitive collation`
        })
      )
    }
  })

const auditTextShape = (ctx: TranslatePlanContext) =>
  Effect.gen(function* () {
    const names = new Set(ctx.tables.keys())
    if (names.size === 0) return []
    const catalog = yield* readCatalog(ctx, names, true)
    const issues: Array<string> = []
    for (const [table, shapes] of ctx.tables) {
      const catalogTable = catalog.get(table)
      if (catalogTable === undefined) {
        issues.push(`table "${table}" is missing`)
        continue
      }
      if (catalogTable.type !== "base") {
        issues.push(`table "${table}" is not a base table`)
        continue
      }
      for (const column of shapes.desired.columns) {
        if (column.type !== "text") continue
        const actual = catalogTable.columns.get(column.name)
        if (actual === undefined) {
          issues.push(`text column "${table}"."${column.name}" is missing`)
          continue
        }
        if (!columnMatchesCatalog(column, actual, shapes.desired.indexes)) {
          issues.push(
            `text column "${table}"."${column.name}" differs: expected ${describeExpectedColumn(column, shapes.desired.indexes)}, found ${describeCatalogColumn(actual)}`
          )
        }
      }
    }
    return issues
  })

const upsert = (
  table: string,
  record: Readonly<Record<string, unknown>>,
  conflictKeys: ReadonlyArray<string>
) => renderUpsert(table, record, conflictKeys, false).sql

const upsertStatement = (
  table: string,
  record: Readonly<Record<string, unknown>>,
  conflictKeys: ReadonlyArray<string>
): ParameterizedStatement => renderUpsert(table, record, conflictKeys, true)

const migrationModel: Extract<MigrationModel, { kind: "statement" }> = {
  kind: "statement",
  systemTableExistsSql: (table) =>
    `SELECT 1 AS present FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ${quoteLiteral(table)} LIMIT 1`,
  isRetryableConflict: (error) =>
    errorHasCode(error, RETRYABLE_CONFLICT_CODES),
  transaction: {
    beginSql: "START TRANSACTION",
    commitSql: "COMMIT",
    rollbackSql: "ROLLBACK"
  },
  session: {
    readSql:
      "SELECT @@SESSION.sql_mode AS sql_mode, @@SESSION.lock_wait_timeout AS lock_wait_timeout, @@SESSION.wait_timeout AS wait_timeout, @@SESSION.max_sort_length AS max_sort_length",
    setupSql: [
      "SET SESSION sql_mode = 'STRICT_ALL_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'",
      "SET SESSION lock_wait_timeout = 5",
      "SET SESSION wait_timeout = 600",
      "SET SESSION max_sort_length = 8192"
    ],
    previewSetupSql: [
      "SET SESSION lock_wait_timeout = 5",
      "SET SESSION wait_timeout = 600",
      "SET SESSION max_sort_length = 8192"
    ],
    restoreSql: (previous) => {
      const restoreValue = (value: unknown) => {
        if (typeof value === "string") return quoteLiteral(value)
        if (typeof value === "number" && Number.isFinite(value)) {
          return quoteLiteral(value)
        }
        return "DEFAULT"
      }
      return [
        `SET SESSION sql_mode = ${restoreValue(previous["sql_mode"])}`,
        `SET SESSION lock_wait_timeout = ${restoreValue(previous["lock_wait_timeout"])}`,
        `SET SESSION wait_timeout = ${restoreValue(previous["wait_timeout"])}`,
        `SET SESSION max_sort_length = ${restoreValue(previous["max_sort_length"])}`
      ]
    }
  },
  lock: {
    databaseNameSql: "SELECT DATABASE() AS database_name",
    namePrefix: "mira.migrations",
    maxNameLength: 64,
    defaultTimeoutSeconds: 60,
    acquireStatement: (name, timeoutSeconds) => ({
      sql: "SELECT GET_LOCK(?, ?) AS acquired",
      params: [name, timeoutSeconds]
    }),
    releaseStatement: (name) => ({
      sql: "SELECT RELEASE_LOCK(?) AS released",
      params: [name]
    }),
    usedStatement: (name) => ({
      sql: "SELECT IS_USED_LOCK(?) = CONNECTION_ID() AS held_by_me",
      params: [name]
    }),
    holderStatement: (name) => ({
      sql: "SELECT IS_USED_LOCK(?) AS holder",
      params: [name]
    }),
    killSelfStatement: {
      sql: "KILL CONNECTION_ID()",
      params: []
    },
    heartbeatIntervalSeconds: 60
  }
}

/**
 * The MySQL/MariaDB migration capability. It is not exported from the package
 * barrel and has no driver dependency.
 */
export const mysqlMigrationDialect: StatementMigrationDialect = {
  quoteIdentifier,
  translate,
  translatePlan,
  verifyPlan,
  upsert,
  upsertStatement,
  migrationModel,
  reconcilesTextLength: true,
  preflightPlan,
  auditTextShape
}
