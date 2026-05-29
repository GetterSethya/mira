import type { FieldsMap, InferFieldValue } from "@/collection/types.js"
import type { FilterNode } from "./types.js"

/**
 * Operand returned by `Filter.field(name)` — provides comparison methods
 * that each produce a `FilterNode`.
 *
 * The type parameter `V` constrains the value type for comparisons:
 * when used through `FilterBuilder<F>.field(name)`, `V` is the inferred
 * TypeScript type of the field (string, number, boolean, etc.). When used
 * through the untyped `Filter.field(name)`, `V` is `unknown`.
 *
 * Available comparisons:
 * - `.eq(v)` / `.neq(v)` — equality / inequality
 * - `.gt(v)` / `.gte(v)` — greater than / greater or equal
 * - `.lt(v)` / `.lte(v)` — less than / less or equal
 * - `.in(values)` — membership in a list
 * - `.like(pattern)` — SQL LIKE pattern match (always string-valued)
 * - `.null()` / `.notNull()` — IS NULL / IS NOT NULL (no value argument)
 * - `.between(lo, hi)` — compound of `.gte(lo)` + `.lte(hi)`
 *
 * @example
 * import { Filter } from "@gettersethya/mira-collection"
 *
 * Filter.field("age").gte(18)
 * Filter.field("title").like("%effect%")
 * Filter.field("tags").in(["a", "b", "c"])
 * Filter.field("deletedAt").null()
 * Filter.field("price").between(10, 100)
 *
 * @see Filter — entry point to create FieldFilterOperand
 * @see FilterBuilder — typed variant with field-name and value-type safety
 */
export type FieldFilterOperand<V = unknown> = {
  eq(value: V): FilterNode
  neq(value: V): FilterNode
  gt(value: V): FilterNode
  gte(value: V): FilterNode
  lt(value: V): FilterNode
  lte(value: V): FilterNode
  in(values: ReadonlyArray<V>): FilterNode
  like(value: string): FilterNode
  null(): FilterNode
  notNull(): FilterNode
  between(lo: V, hi: V): FilterNode
}

function toFieldOperand(field: string): FieldFilterOperand {
  return {
    eq: (value) => ({ op: "eq" as const, field, value }),
    neq: (value) => ({ op: "neq" as const, field, value }),
    gt: (value) => ({ op: "gt" as const, field, value }),
    gte: (value) => ({ op: "gte" as const, field, value }),
    lt: (value) => ({ op: "lt" as const, field, value }),
    lte: (value) => ({ op: "lte" as const, field, value }),
    in: (values) => ({ op: "in" as const, field, values }),
    like: (value) => ({ op: "like" as const, field, value }),
    null: () => ({ op: "null" as const, field }),
    notNull: () => ({ op: "not_null" as const, field }),
    between: (lo, hi) => ({ op: "and" as const, left: { op: "gte" as const, field, value: lo }, right: { op: "lte" as const, field, value: hi } })
  }
}

/**
 * Typed filter builder constrained to a specific `FieldsMap`.
 * Provides the same methods as `Filter` but narrows field names and value
 * types according to the collection's field definitions.
 *
 * Used inside `CollectionClient.getList({ filter: (f) => ... })` callbacks.
 *
 * @example
 * interface PostFields { title: FieldDef & { kind: "text" }; views: FieldDef & { kind: "number" } }
 * const f: FilterBuilder<PostFields>
 *
 * f.field("title").eq("hello")     // typed — value is string
 * f.field("views").gte(100)        // typed — value is number
 * f.field("views").eq("bad")       // type error — expects number
 * f.field("nonexistent").eq(1)     // type error — field does not exist
 *
 * @see Filter — untyped version of the same DSL
 * @see FieldFilterOperand — the return type of .field()
 */
export type FilterBuilder<F extends FieldsMap = FieldsMap> = {
  field<K extends keyof F & string>(name: K): FieldFilterOperand<InferFieldValue<F[K]>>
  and(left: FilterNode, right: FilterNode): FilterNode
  or(left: FilterNode, right: FilterNode): FilterNode
  not(node: FilterNode): FilterNode
}

/**
 * Filter DSL builder for constructing `FilterNode` expressions.
 *
 * Use `Filter.field(name)` to start a comparison chain, then call a comparison
 * method (`.eq()`, `.neq()`, `.gt()`, etc.) to produce a `FilterNode`.
 * Combine nodes with `Filter.and()`, `Filter.or()`, `Filter.not()`.
 *
 * This is the untyped variant — field names are plain strings and values are
 * `unknown`. For type-safe field access, use `FilterBuilder<F>` via the
 * `CollectionClient` callback pattern.
 *
 * @example
 * import { Filter } from "@gettersethya/mira-collection"
 *
 * // Simple equality
 * const published = Filter.field("published").eq(true)
 *
 * // Range check
 * const popular = Filter.and(
 *   Filter.field("views").gte(100),
 *   Filter.field("views").lte(10_000)
 * )
 *
 * // In-list
 * const draftOrArchived = Filter.field("status").in(["draft", "archived"])
 *
 * // LIKE pattern
 * const search = Filter.field("title").like("%effect%")
 *
 * // Null checks
 * const hasDeletedAt = Filter.field("deletedAt").null()
 * const notDeleted = Filter.field("deletedAt").notNull()
 *
 * // Complex combination
 * const query = Filter.and(
 *   Filter.field("published").eq(true),
 *   Filter.or(
 *     Filter.field("category").eq("tech"),
 *     Filter.field("tags").contains("effect")
 *   )
 * )
 *
 * @see FilterNode — the AST node produced by filter methods
 * @see FilterBuilder — typed variant used in CollectionClient methods
 * @see filterNodeToWhereClause — compiles FilterNode to SQL
 */
export const Filter = {
  /** Start a filter chain for a field by name. Returns a `FieldFilterOperand` with comparison methods. */
  field: <K extends string>(name: K): FieldFilterOperand<unknown> =>
    toFieldOperand(name),

  /** Combine two filter nodes with logical AND. Produces `(left) AND (right)` in SQL. */
  and: (left: FilterNode, right: FilterNode): FilterNode =>
    ({ op: "and" as const, left, right }),

  /** Combine two filter nodes with logical OR. Produces `(left) OR (right)` in SQL. */
  or: (left: FilterNode, right: FilterNode): FilterNode =>
    ({ op: "or" as const, left, right }),

  /** Negate a filter node with logical NOT. Produces `NOT (node)` in SQL. */
  not: (node: FilterNode): FilterNode =>
    ({ op: "not" as const, node })
}
