import { Effect } from "effect"

import { ValidationError } from "@/collection/errors.js"
import type { CollectionSchema } from "@/collection/types.js"

import type { FilterNode, FilterValueType, WhereClause } from "./types.js"

/**
 * Options controlling how a `FilterNode` is compiled.
 *
 * - `allowHiddenFields` - when `true`, `x-hidden` schema properties may be
 *   referenced (admin callers). Defaults to `false`.
 * - `caseInsensitivePattern` - renders a complete case-insensitive pattern
 *   match for the active dialect (`LIKE` on SQLite, `ILIKE` on PostgreSQL).
 *   It receives the quoted field reference and the `?` placeholder, adds no
 *   wildcards, consumes `right` once, and returns a SQL string without
 *   transforming the pattern value. The pattern stays a bound parameter. The
 *   compiler invokes the renderer as a plain function, so a caller that
 *   supplies a dialect method must bind it with a closure, for example
 *   `(left, right) => dialect.caseInsensitivePattern(left, right)`.
 * - `castValue` - casts a placeholder to the field's scalar type. Omitted,
 *   placeholders stay uncast, which keeps SQLite SQL unchanged because its
 *   `castValue` is the identity.
 * - `encodeValue` - encodes a comparison value before binding, for example
 *   converting a boolean to `0`/`1` on a dialect that stores booleans as
 *   integers. Omitted, values bind unchanged.
 */
export type FilterCompileOptions = {
  allowHiddenFields?: boolean
  /** Wraps a column name in the active dialect's identifier quotes. */
  quoteIdentifier: (field: string) => string
  /** Renders a complete case-insensitive pattern match for the dialect. */
  caseInsensitivePattern: (left: string, right: string) => string
  /** Casts a placeholder expression to the field's scalar type. */
  castValue?: (expr: string, type: FilterValueType) => string
  /** Encodes a comparison value before it is bound. */
  encodeValue?: (field: string, value: unknown) => unknown
}

const fieldRef = (field: string, options: FilterCompileOptions) =>
  `t.${options.quoteIdentifier(field)}`

const INTEGER_PATTERN = /^[+-]?\d+$/
const NUMBER_PATTERN = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/
const INT64_MIN = -9223372036854775808n
const INT64_MAX = 9223372036854775807n

function fieldValueType(
  schema: CollectionSchema,
  field: string
): FilterValueType | undefined {
  const prop = schema.properties[field]
  if (prop === undefined) return undefined
  if (prop["x-kind"] === "seqId") return "bigint"
  switch (prop.type) {
    case "string":
      return "text"
    case "integer":
      return "integer"
    case "number":
      return "number"
    case "boolean":
      return "boolean"
    default:
      return undefined
  }
}

function isValidInteger(value: unknown) {
  if (typeof value === "number") return Number.isInteger(value)
  if (typeof value !== "string") return false
  return INTEGER_PATTERN.test(value.trim())
}

function isValidNumber(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value)
  if (typeof value !== "string") return false
  const text = value.trim()
  return NUMBER_PATTERN.test(text) && Number.isFinite(Number(text))
}

function isValidBoolean(value: unknown) {
  if (typeof value === "boolean") return true
  if (typeof value === "number") return value === 0 || value === 1
  if (typeof value !== "string") return false
  return value === "true" || value === "false" || value === "1" || value === "0"
}

function isValidBigint(value: unknown) {
  if (typeof value === "bigint") return value >= INT64_MIN && value <= INT64_MAX
  if (typeof value === "number") return Number.isSafeInteger(value)
  if (typeof value !== "string") return false
  const text = value.trim()
  if (!INTEGER_PATTERN.test(text)) return false
  const parsed = BigInt(text)
  return parsed >= INT64_MIN && parsed <= INT64_MAX
}

function typedValueIssue(
  field: string,
  value: unknown,
  type: FilterValueType | undefined
): string | undefined {
  switch (type) {
    case "integer":
      return isValidInteger(value)
        ? undefined
        : `Filter value for "${field}" must be an integer`
    case "number":
      return isValidNumber(value) ? undefined : `Filter value for "${field}" must be a number`
    case "boolean":
      return isValidBoolean(value) ? undefined : `Filter value for "${field}" must be a boolean`
    case "bigint":
      return isValidBigint(value) ? undefined : `Filter value for "${field}" must be a bigint`
    case "text":
      return typeof value === "boolean"
        ? `Filter value for "${field}" must be a string or number`
        : undefined
    default:
      return undefined
  }
}

function castPlaceholder(options: FilterCompileOptions, type: FilterValueType | undefined) {
  if (type === undefined || options.castValue === undefined) return "?"
  return options.castValue("?", type)
}

function encodeValue(options: FilterCompileOptions, field: string, value: unknown) {
  return options.encodeValue === undefined ? value : options.encodeValue(field, value)
}

/**
 * Compile a `FilterNode` AST into a `WhereClause` (`{ sql, params }`) suitable
 * for splicing into an Effect SQL template literal via `unsafeFragment`.
 *
 * Validates each referenced field against the collection schema. Unknown fields
 * (including keys inherited from `Object.prototype` such as `constructor` /
 * `toString`) and, unless `options.allowHiddenFields` is set, `x-hidden` fields
 * produce a `ValidationError` in the Effect error channel. Non-scalar comparison
 * values (arrays and objects) are likewise rejected; only
 * `string | number | boolean | null` is accepted.
 *
 * A comparison against an `integer`, `number`, `boolean`, or `bigint` field
 * validates the value before execution and rejects a malformed string. A
 * `bigint` (or `seqId`) field rejects an unsafe JavaScript number; supply a
 * decimal string above 2^53.
 *
 * Field names are SQL-identifier-quoted. The default is `t."fieldName"`; a
 * caller can pass `quoteIdentifier` for PostgreSQL/MySQL quoting. Values use
 * `?`-style positional placeholders with params in the returned array; the SQL
 * store rewrites the whole statement to numbered placeholders when needed.
 * When `castValue` is supplied, comparison and `IN` placeholders are cast to
 * the field type. `like` casts its pattern placeholder to text and casts a
 * non-text column to text; the pattern itself stays verbatim.
 *
 * Edge cases:
 * - `IN ()` with an empty array produces `1 = 0` (always false) instead of
 *   invalid SQL like `IN ()`.
 * - The `like` pattern stays a bound parameter and is passed through verbatim;
 *   the renderer owns the operator (`LIKE` or `ILIKE`), adds no wildcards, and
 *   does not transform the value. The caller is responsible for any `%`
 *   wildcards and escape sequences.
 * - All column references use the hardcoded table alias `t`.
 *
 * @param node - The filter AST to compile
 * @param schema - The collection schema (used for field validation)
 * @param collectionName - Collection name (used only in error messages)
 * @param options - Compilation options (see `FilterCompileOptions`)
 * @returns Effect that resolves to a WhereClause, or fails with ValidationError
 *          if any field name in the filter does not exist in the schema, refers
 *          to a hidden field, or carries a non-scalar value
 *
 * @example
 * import { Filter, filterNodeToWhereClause } from "@gettersethya/mira-collection"
 * import type { CollectionSchema } from "@gettersethya/mira-collection"
 *
 * const schema: CollectionSchema = {
 *   type: "object",
 *   properties: { title: { type: "string" } }
 * } as CollectionSchema
 *
 * const effect = filterNodeToWhereClause(
 *   Filter.field("title").eq("hello"),
 *   schema,
 *   "posts",
 *   {
 *     quoteIdentifier: (field) => `"${field}"`,
 *     caseInsensitivePattern: (left, right) => `${left} LIKE ${right}`
 *   }
 * )
 * // Resolves to: { sql: 't."title" = ?', params: ["hello"] }
 *
 * @see FilterNode — the AST type consumed by this function
 * @see WhereClause — the output type
 */
export function filterNodeToWhereClause(
  node: FilterNode,
  schema: CollectionSchema,
  collectionName: string,
  options: FilterCompileOptions
): Effect.Effect<WhereClause, ValidationError> {
  return compileNode(node, schema, collectionName, options)
}

function isScalar(value: unknown) {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
}

function compileNode(
  node: FilterNode,
  schema: CollectionSchema,
  collection: string,
  options: FilterCompileOptions
): Effect.Effect<WhereClause, ValidationError> {
  switch (node.op) {
    case "eq":
    case "neq":
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return compileComparison(node, collection, schema, options)

    case "in":
      return compileIn(node, collection, schema, options)

    case "like":
      return compileLike(node, collection, schema, options)

    case "null":
    case "not_null":
      return compileNull(node, collection, schema, options)

    case "and":
    case "or":
      return compileLogical(node, schema, collection, options)

    case "not":
      return compileNot(node, schema, collection, options)
  }
}

function validateField(
  field: string,
  collection: string,
  schema: CollectionSchema,
  options: FilterCompileOptions
): Effect.Effect<void, ValidationError> {
  // `Object.hasOwn` (not `schema.properties[field]`) so keys inherited from
  // `Object.prototype` (`constructor`, `__proto__`, `toString`, …) are treated
  // as unknown fields rather than slipping through to the SQL layer.
  if (!Object.hasOwn(schema.properties, field)) {
    return Effect.fail(
      new ValidationError({
        collection,
        issues: [`Unknown field in filter: "${field}"`]
      })
    )
  }
  if (options.allowHiddenFields !== true && schema.properties[field]["x-hidden"] === true) {
    return Effect.fail(
      new ValidationError({
        collection,
        issues: [`Hidden field cannot be filtered: "${field}"`]
      })
    )
  }
  return Effect.void
}

function validateScalar(
  collection: string,
  field: string,
  value: unknown
): Effect.Effect<void, ValidationError> {
  if (isScalar(value)) return Effect.void
  return Effect.fail(
    new ValidationError({
      collection,
      issues: [`Filter value for "${field}" must be a string, number, boolean, or null`]
    })
  )
}

function validateTypedValue(
  collection: string,
  field: string,
  value: unknown,
  type: FilterValueType | undefined
): Effect.Effect<void, ValidationError> {
  if (value === null) return Effect.void
  const issue = typedValueIssue(field, value, type)
  if (issue === undefined) return Effect.void
  return Effect.fail(new ValidationError({ collection, issues: [issue] }))
}

function compileComparison(
  node: FilterNode & { op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte"; field: string; value: unknown },
  collection: string,
  schema: CollectionSchema,
  options: FilterCompileOptions
): Effect.Effect<WhereClause, ValidationError> {
  const opMap: Record<string, string> = {
    eq: "=",
    neq: "!=",
    gt: ">",
    gte: ">=",
    lt: "<",
    lte: "<="
  }
  return Effect.gen(function* () {
    yield* validateField(node.field, collection, schema, options)
    yield* validateScalar(collection, node.field, node.value)
    const type = fieldValueType(schema, node.field)
    yield* validateTypedValue(collection, node.field, node.value, type)
    const placeholder = node.value === null ? "?" : castPlaceholder(options, type)
    return {
      sql: `${fieldRef(node.field, options)} ${opMap[node.op]} ${placeholder}`,
      params: [encodeValue(options, node.field, node.value)]
    }
  })
}

function compileIn(
  node: FilterNode & { op: "in"; field: string; values: ReadonlyArray<unknown> },
  collection: string,
  schema: CollectionSchema,
  options: FilterCompileOptions
): Effect.Effect<WhereClause, ValidationError> {
  return Effect.gen(function* () {
    yield* validateField(node.field, collection, schema, options)
    if (node.values.length === 0) return { sql: "1 = 0", params: [] }
    const type = fieldValueType(schema, node.field)
    for (const value of node.values) {
      yield* validateScalar(collection, node.field, value)
      yield* validateTypedValue(collection, node.field, value, type)
    }
    const placeholders = node.values
      .map((value) => (value === null ? "?" : castPlaceholder(options, type)))
      .join(", ")
    return {
      sql: `${fieldRef(node.field, options)} IN (${placeholders})`,
      params: node.values.map((value) => encodeValue(options, node.field, value))
    }
  })
}

function compileLike(
  node: FilterNode & { op: "like"; field: string; value: string },
  collection: string,
  schema: CollectionSchema,
  options: FilterCompileOptions
): Effect.Effect<WhereClause, ValidationError> {
  return Effect.gen(function* () {
    yield* validateField(node.field, collection, schema, options)
    const renderPattern = options.caseInsensitivePattern
    const cast = options.castValue
    const type = fieldValueType(schema, node.field)
    const column = type !== undefined && type !== "text" && cast !== undefined
      ? cast(fieldRef(node.field, options), "text")
      : fieldRef(node.field, options)
    const pattern = cast === undefined ? "?" : cast("?", "text")
    return {
      sql: renderPattern(column, pattern),
      params: [node.value]
    }
  })
}

function compileNull(
  node: FilterNode & { op: "null" | "not_null"; field: string },
  collection: string,
  schema: CollectionSchema,
  options: FilterCompileOptions
): Effect.Effect<WhereClause, ValidationError> {
  return Effect.gen(function* () {
    yield* validateField(node.field, collection, schema, options)
    if (node.op === "null") {
      return { sql: `${fieldRef(node.field, options)} IS NULL`, params: [] }
    }
    return { sql: `${fieldRef(node.field, options)} IS NOT NULL`, params: [] }
  })
}

function compileLogical(
  node: FilterNode & { op: "and" | "or"; left: FilterNode; right: FilterNode },
  schema: CollectionSchema,
  collection: string,
  options: FilterCompileOptions
): Effect.Effect<WhereClause, ValidationError> {
  return Effect.gen(function* () {
    const left = yield* compileNode(node.left, schema, collection, options)
    const right = yield* compileNode(node.right, schema, collection, options)
    const op = node.op.toUpperCase()
    return { sql: `(${left.sql}) ${op} (${right.sql})`, params: [...left.params, ...right.params] }
  })
}

function compileNot(
  node: FilterNode & { op: "not"; node: FilterNode },
  schema: CollectionSchema,
  collection: string,
  options: FilterCompileOptions
): Effect.Effect<WhereClause, ValidationError> {
  return Effect.gen(function* () {
    const inner = yield* compileNode(node.node, schema, collection, options)
    return { sql: `NOT (${inner.sql})`, params: inner.params }
  })
}
