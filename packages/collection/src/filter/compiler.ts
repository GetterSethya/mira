import { Effect } from "effect"
import type { CollectionSchema } from "@/collection/types.js"
import { ValidationError } from "@/collection/errors.js"
import type { FilterNode, WhereClause } from "./types.js"

/**
 * Compile a `FilterNode` AST into a `WhereClause` (`{ sql, params }`) suitable
 * for splicing into an Effect SQL template literal via `unsafeFragment`.
 *
 * Validates each referenced field against the collection schema. Unknown fields
 * produce a `ValidationError` in the Effect error channel.
 *
 * Field names are SQL-identifier-quoted (double-quoted as `t."fieldName"`).
 * Values use `?`-style positional placeholders with params in the returned array.
 *
 * Edge cases:
 * - `IN ()` with an empty array produces `1 = 0` (always false) instead of
 *   invalid SQL like `IN ()`.
 * - The `like` pattern is passed through verbatim — the caller is responsible
 *   for adding `%` wildcards.
 * - All column references use the hardcoded table alias `t`.
 *
 * @param node - The filter AST to compile
 * @param schema - The collection schema (used for field validation)
 * @param collectionName - Collection name (used only in error messages)
 * @returns Effect that resolves to a WhereClause, or fails with ValidationError
 *          if any field name in the filter does not exist in the schema
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
 *   "posts"
 * )
 * // Resolves to: { sql: 't."title" = ?', params: ["hello"] }
 *
 * @see FilterNode — the AST type consumed by this function
 * @see WhereClause — the output type
 */
export function filterNodeToWhereClause(
  node: FilterNode,
  schema: CollectionSchema,
  collectionName: string
): Effect.Effect<WhereClause, ValidationError> {
  return compileNode(node, schema, collectionName)
}

function compileNode(
  node: FilterNode,
  schema: CollectionSchema,
  collection: string
): Effect.Effect<WhereClause, ValidationError> {
  switch (node.op) {
    case "eq":
    case "neq":
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return compileComparison(node, collection, schema)

    case "in":
      return compileIn(node, collection, schema)

    case "like":
      return compileLike(node, collection, schema)

    case "null":
    case "not_null":
      return compileNull(node, collection, schema)

    case "and":
    case "or":
      return compileLogical(node, schema, collection)

    case "not":
      return compileNot(node, schema, collection)
  }
}

function validateField(
  field: string,
  collection: string,
  schema: CollectionSchema
): Effect.Effect<void, ValidationError> {
  if (!schema.properties[field]) {
    return Effect.fail(
      new ValidationError({
        collection,
        issues: [`Unknown field in filter: "${field}"`]
      })
    )
  }
  return Effect.void
}

function compileComparison(
  node: FilterNode & { op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte"; field: string; value: unknown },
  collection: string,
  schema: CollectionSchema
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
    yield* validateField(node.field, collection, schema)
    return { sql: `t."${node.field}" ${opMap[node.op]} ?`, params: [node.value] }
  })
}

function compileIn(
  node: FilterNode & { op: "in"; field: string; values: ReadonlyArray<unknown> },
  collection: string,
  schema: CollectionSchema
): Effect.Effect<WhereClause, ValidationError> {
  return Effect.gen(function* () {
    yield* validateField(node.field, collection, schema)
    if (node.values.length === 0) return { sql: "1 = 0", params: [] }
    const placeholders = node.values.map(() => "?").join(", ")
    return { sql: `t."${node.field}" IN (${placeholders})`, params: [...node.values] }
  })
}

function compileLike(
  node: FilterNode & { op: "like"; field: string; value: string },
  collection: string,
  schema: CollectionSchema
): Effect.Effect<WhereClause, ValidationError> {
  return Effect.gen(function* () {
    yield* validateField(node.field, collection, schema)
    return { sql: `t."${node.field}" LIKE ?`, params: [node.value] }
  })
}

function compileNull(
  node: FilterNode & { op: "null" | "not_null"; field: string },
  collection: string,
  schema: CollectionSchema
): Effect.Effect<WhereClause, ValidationError> {
  return Effect.gen(function* () {
    yield* validateField(node.field, collection, schema)
    if (node.op === "null") {
      return { sql: `t."${node.field}" IS NULL`, params: [] }
    }
    return { sql: `t."${node.field}" IS NOT NULL`, params: [] }
  })
}

function compileLogical(
  node: FilterNode & { op: "and" | "or"; left: FilterNode; right: FilterNode },
  schema: CollectionSchema,
  collection: string
): Effect.Effect<WhereClause, ValidationError> {
  return Effect.gen(function* () {
    const left = yield* compileNode(node.left, schema, collection)
    const right = yield* compileNode(node.right, schema, collection)
    const op = node.op.toUpperCase()
    return { sql: `(${left.sql}) ${op} (${right.sql})`, params: [...left.params, ...right.params] }
  })
}

function compileNot(
  node: FilterNode & { op: "not"; node: FilterNode },
  schema: CollectionSchema,
  collection: string
): Effect.Effect<WhereClause, ValidationError> {
  return Effect.gen(function* () {
    const inner = yield* compileNode(node.node, schema, collection)
    return { sql: `NOT (${inner.sql})`, params: inner.params }
  })
}
