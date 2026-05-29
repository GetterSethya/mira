import { Schema } from "effect"

/**
 * A pre-compiled SQL WHERE fragment with positional `?` placeholders.
 *
 * Produced by `filterNodeToWhereClause()` and consumed by the repository layer.
 * The `sql` string uses `?`-style placeholders; `params` supplies the values
 * in positional order. Pass to `unsafeFragment(w.sql, w.params)` from
 * `@effect/sql/Statement` to splice into a template literal.
 *
 * @example
 * // Output of compiler for Filter.field("title").eq("hello"):
 * const w: WhereClause = { sql: 't."title" = ?', params: ["hello"] }
 *
 * @see FilterNode — the AST type that compiles to WhereClause
 * @see filterNodeToWhereClause — produces WhereClause from FilterNode
 */
export type WhereClause = {
  sql: string
  params: ReadonlyArray<unknown>
}

/**
 * AST node for filter expressions. Discriminated union with 6 variant groups:
 *
 * | Variants | Fields | Description |
 * |---|---|---|
 * | `eq`, `neq`, `gt`, `gte`, `lt`, `lte` | `field`, `value` | Value comparisons |
 * | `in` | `field`, `values` | Membership test |
 * | `like` | `field`, `value` | SQL LIKE pattern match |
 * | `null`, `not_null` | `field` | Null checks (no value operand) |
 * | `and`, `or` | `left`, `right` | Binary logical combinators |
 * | `not` | `node` | Unary negation |
 *
 * Construct via `Filter.field(name).eq(value)` or `Filter.and(left, right)`.
 * Consumed by `filterNodeToWhereClause()` to produce SQL WHERE clauses.
 *
 * @example
 * import { Filter } from "@gettersethya/mira-collection"
 *
 * // Single comparison
 * const node: FilterNode = Filter.field("title").eq("hello")
 *
 * // Logical combination
 * const complex: FilterNode = Filter.and(
 *   Filter.field("published").eq(true),
 *   Filter.field("views").gte(100)
 * )
 *
 * // Null check
 * const deleted: FilterNode = Filter.field("deletedAt").notNull()
 *
 * @see Filter — builder DSL for constructing FilterNode values
 * @see filterNodeToWhereClause — compiles FilterNode to SQL
 */
export type FilterNode =
  | { op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte"; field: string; value: unknown }
  | { op: "in"; field: string; values: ReadonlyArray<unknown> }
  | { op: "like"; field: string; value: string }
  | { op: "null" | "not_null"; field: string }
  | { op: "and" | "or"; left: FilterNode; right: FilterNode }
  | { op: "not"; node: FilterNode }

let _filterNodeSchema: Schema.Schema<FilterNode>

_filterNodeSchema = Schema.Union(
  Schema.Struct({
    op: Schema.Literal("eq", "neq", "gt", "gte", "lt", "lte"),
    field: Schema.String,
    value: Schema.Unknown
  }),
  Schema.Struct({
    op: Schema.Literal("in"),
    field: Schema.String,
    values: Schema.Array(Schema.Unknown)
  }),
  Schema.Struct({
    op: Schema.Literal("like"),
    field: Schema.String,
    value: Schema.String
  }),
  Schema.Struct({
    op: Schema.Literal("null", "not_null"),
    field: Schema.String
  }),
  Schema.Struct({
    op: Schema.Literal("and", "or"),
    left: Schema.suspend(() => _filterNodeSchema),
    right: Schema.suspend(() => _filterNodeSchema)
  }),
  Schema.Struct({
    op: Schema.Literal("not"),
    node: Schema.suspend(() => _filterNodeSchema)
  })
)

/**
 * Effect Schema for `FilterNode`. Used to decode filter query parameters
 * from HTTP request JSON bodies.
 *
 * The schema is self-referential (recursive via `Schema.suspend`) to handle
 * nested `and`/`or`/`not` nodes. This is why the underlying `let` variable
 * exists — the recursive `suspend` needs a forward reference.
 *
 * @example
 * import { Schema } from "effect"
 *
 * const raw = { op: "eq", field: "title", value: "hello" }
 * const filter = Schema.decodeSync(FilterNodeSchema)(raw)
 * // filter: FilterNode — { op: "eq", field: "title", value: "hello" }
 *
 * @see FilterNode — the TypeScript type this schema decodes to
 */
export { _filterNodeSchema as FilterNodeSchema }
