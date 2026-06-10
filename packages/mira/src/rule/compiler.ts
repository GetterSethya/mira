import type { CollectionSchema, ExprNode, OperandNode } from "@gettersethya/mira-client"

/**
 * Context passed through the compilation pipeline.
 * Manages parameter generation, table aliasing, and field mapping.
 */
export type CompileCtx = {
  /** Maps field names to their database column names. */
  columnOfField: (field: string) => string
  /** Table alias prefix (e.g., `"t"`). `undefined` omits the prefix. */
  tableAlias?: string
  /** Generates the next placeholder name (e.g., `@p0`, `@p1`). */
  nextParam: () => string
  /** Accumulator for parameter bindings (placeholder → value). */
  params: Record<string, unknown>
  /** Map of all collection schemas for subquery resolution. */
  collectionSchemas: Record<string, CollectionSchema>
  /** Name of the auth collection for `@auth_*` placeholders. */
  authCollection?: string
}

/**
 * Compiles a rule expression tree into a SQL WHERE clause string.
 * Parameter values are written into `ctx.params` as side effects.
 *
 * @example
 * const ctx = {
 *   tableAlias: "t",
 *   nextParam: () => `@p${i++}`,
 *   params: {},
 *   columnOfField: (f) => f,
 *   collectionSchemas: {},
 *   authCollection: "users"
 * }
 * compile(Rule.field("age").gt(Rule.literal(18)), ctx)
 * // => "t.age > @p0"
 */
export function compile(node: ExprNode, ctx: CompileCtx): string {
  switch (node.op) {
    case "public":
      return "1 = 1"
    case "eq":
      return `${compileOperand(node.left, ctx)} = ${compileOperand(node.right, ctx)}`
    case "neq":
      return `${compileOperand(node.left, ctx)} != ${compileOperand(node.right, ctx)}`
    case "gt":
      return `${compileOperand(node.left, ctx)} > ${compileOperand(node.right, ctx)}`
    case "gte":
      return `${compileOperand(node.left, ctx)} >= ${compileOperand(node.right, ctx)}`
    case "lt":
      return `${compileOperand(node.left, ctx)} < ${compileOperand(node.right, ctx)}`
    case "lte":
      return `${compileOperand(node.left, ctx)} <= ${compileOperand(node.right, ctx)}`
    case "in": {
      const leftSql = compileOperand(node.left, ctx)
      if (node.right.kind === "literal" && Array.isArray(node.right.value)) {
        const items = node.right.value as Array<unknown>
        if (items.length === 0) return "1 = 0"
        const placeholders = items.map((item) => {
          const param = ctx.nextParam()
          ctx.params[param] = item
          return param
        })
        return `${leftSql} IN (${placeholders.join(", ")})`
      }
      return `${leftSql} IN (${compileOperand(node.right, ctx)})`
    }
    case "and":
      return `(${compile(node.left, ctx)}) AND (${compile(node.right, ctx)})`
    case "or":
      return `(${compile(node.left, ctx)}) OR (${compile(node.right, ctx)})`
    case "not":
      return `NOT (${compile(node.expr, ctx)})`
    case "startsWith":
      return `${compileOperand(node.left, ctx)} LIKE (${compileOperand(node.right, ctx)} || '%')`
    case "contains":
      return `${compileOperand(node.left, ctx)} LIKE ('%' || ${compileOperand(node.right, ctx)} || '%')`
  }
}

/**
 * Compiles an operand node (value expression) into its SQL representation.
 * Handles field references, literals, auth tokens, subqueries, date functions, and request values.
 *
 * - `field` → `t.columnName` (with optional table alias and `columnOfField` mapping)
 * - `literal` → `@pN` (stored in `ctx.params`)
 * - `auth` → `@auth_fieldName`
 * - `authId` → `@auth_id`
 * - `request` → `@request_source_key`
 * - `now` → `datetime('now')`
 * - `dateAdd` → `datetime(expr, '+N days')`
 * - `dateDiff` → `(julianday(a) - julianday(b))`
 * - `subquery` → `SELECT field FROM collection WHERE ...`
 */
export function compileOperand(node: OperandNode, ctx: CompileCtx): string {
  switch (node.kind) {
    case "field": {
      const col = ctx.columnOfField(node.field)
      if (ctx.tableAlias !== undefined && node.collection === undefined) {
        return `${ctx.tableAlias}.${col}`
      }
      return col
    }
    case "literal": {
      const param = ctx.nextParam()
      ctx.params[param] = node.value
      return param
    }
    case "auth":
      return `@auth_${node.field}`
    case "authId":
      return `@auth_id`
    case "authCollection":
      return `@auth_collection`
    case "request":
      return `@request_${node.source}_${node.key}`
    case "now":
      return `datetime('now')`
    case "subquery": {
      const { tableAlias: _alias, ...subCtx } = ctx
      const whereSql = compile(node.where, subCtx)
      return `SELECT ${node.field} FROM ${node.collection} WHERE ${whereSql}`
    }
    case "dateAdd": {
      const operandSql = compileOperand(node.operand, ctx)
      const sign = node.amount >= 0 ? "+" : ""
      return `datetime(${operandSql}, '${sign}${node.amount} ${node.unit}s')`
    }
    case "dateDiff": {
      const leftSql = compileOperand(node.left, ctx)
      const rightSql = compileOperand(node.right, ctx)
      return `(julianday(${leftSql}) - julianday(${rightSql}))`
    }
  }
}
