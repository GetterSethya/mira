import type { CollectionSchema, ExprNode, OperandNode } from "@gettersethya/mira-client"

import type { FieldValueType, RuleSqlDialect } from "@/dialect/dialect.js"

/** How a top-level field operand is rendered. */
export type FieldRefMode = "column" | "param"

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
  /** Accumulator for parameter bindings (placeholder -> value). */
  params: Record<string, unknown>
  /** Map of all collection schemas for subquery resolution. */
  collectionSchemas: Record<string, CollectionSchema>
  /** Name of the auth collection for `@auth_*` placeholders. */
  authCollection?: string
  /** Column mode renders `t."field"`; payload mode renders a typed marker. */
  fieldRefMode?: FieldRefMode
  /** Schema value type for a field, used by typed comparisons. */
  fieldType?: (field: string) => FieldValueType | undefined
}

type OperandInfo = {
  type: FieldValueType | undefined
  isLiteral: boolean
  isColumn: boolean
  isString: boolean
}

const literalType = (value: unknown): FieldValueType | undefined => {
  if (typeof value === "boolean") return "boolean"
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number"
  if (typeof value === "string") return "text"
  return undefined
}

const encodeFieldToken = (field: string): string => {
  const bytes = new TextEncoder().encode(field)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
}

const hintForComparison = (left: OperandInfo, right: OperandInfo) => {
  if (left.isColumn && right.isColumn) return undefined

  const columnType = left.isLiteral ? right.type : left.type
  const literals = [left, right].filter((operand) => operand.isLiteral)

  if (
    columnType !== undefined &&
    columnType !== "text" &&
    literals.some((operand) => operand.isString)
  ) {
    return "text"
  }

  if (columnType === "integer" && literals.some((operand) => operand.type === "number")) {
    return "number"
  }

  if (columnType !== undefined) return columnType

  if (literals.length === 0) return undefined
  if (literals.some((operand) => operand.isString)) return "text"
  if (literals.some((operand) => operand.type === "number")) return "number"
  if (literals.some((operand) => operand.type === "integer")) return "integer"
  if (literals.some((operand) => operand.type === "boolean")) return "boolean"
  return undefined
}

function operandInfo(node: OperandNode, ctx: CompileCtx): OperandInfo {
  switch (node.kind) {
    case "field":
      return {
        type: ctx.fieldType?.(node.field),
        isLiteral: false,
        isColumn: ctx.fieldRefMode !== "param",
        isString: false
      }
    case "literal":
      return {
        type: literalType(node.value),
        isLiteral: true,
        isColumn: false,
        isString: typeof node.value === "string"
      }
    case "auth":
      return { type: undefined, isLiteral: false, isColumn: false, isString: false }
    case "authId":
    case "authCollection":
    case "request":
      return { type: "text", isLiteral: false, isColumn: false, isString: false }
    case "now":
    case "dateAdd":
      return { type: "text", isLiteral: false, isColumn: false, isString: false }
    case "dateDiff":
      return { type: "number", isLiteral: false, isColumn: false, isString: false }
    case "subquery":
      return { type: undefined, isLiteral: false, isColumn: false, isString: false }
  }
}

const typedParam = (
  placeholder: string,
  hint: FieldValueType | undefined,
  dialect: RuleSqlDialect
) => (hint === undefined ? placeholder : dialect.castValue(placeholder, hint))

function comparison(
  op: "=" | "!=" | ">" | ">=" | "<" | "<=",
  left: OperandNode,
  right: OperandNode,
  ctx: CompileCtx,
  dialect: RuleSqlDialect
) {
  const hint = hintForComparison(operandInfo(left, ctx), operandInfo(right, ctx))
  return `${compileOperand(left, ctx, dialect, hint)} ${op} ${compileOperand(right, ctx, dialect, hint)}`
}

/**
 * Compiles a rule expression tree into a SQL WHERE clause string.
 * Parameter values are written into `ctx.params` as side effects.
 */
export function compile(node: ExprNode, ctx: CompileCtx, dialect: RuleSqlDialect): string {
  switch (node.op) {
    case "public":
      return "1 = 1"
    case "eq":
      return comparison("=", node.left, node.right, ctx, dialect)
    case "neq":
      return comparison("!=", node.left, node.right, ctx, dialect)
    case "gt":
      return comparison(">", node.left, node.right, ctx, dialect)
    case "gte":
      return comparison(">=", node.left, node.right, ctx, dialect)
    case "lt":
      return comparison("<", node.left, node.right, ctx, dialect)
    case "lte":
      return comparison("<=", node.left, node.right, ctx, dialect)
    case "in": {
      if (node.right.kind === "literal" && Array.isArray(node.right.value)) {
        const items: Array<unknown> = node.right.value
        if (items.length === 0) return "1 = 0"
        const firstType = literalType(items[0])
        const hint =
          firstType === undefined
            ? undefined
            : accessHint(node.left, {
                type: firstType,
                isLiteral: true,
                isColumn: false,
                isString: firstType === "text"
              }, ctx)
        const leftSql = compileOperand(node.left, ctx, dialect, hint)
        const placeholders = items.map((item) => {
          const param = ctx.nextParam()
          ctx.params[param] = item
          return typedParam(param, hint, dialect)
        })
        return `${leftSql} IN (${placeholders.join(", ")})`
      }
      return `${compileOperand(node.left, ctx, dialect)} IN (${compileOperand(node.right, ctx, dialect)})`
    }
    case "and":
      return `(${compile(node.left, ctx, dialect)}) AND (${compile(node.right, ctx, dialect)})`
    case "or":
      return `(${compile(node.left, ctx, dialect)}) OR (${compile(node.right, ctx, dialect)})`
    case "not":
      return `NOT (${compile(node.expr, ctx, dialect)})`
    case "startsWith":
      return dialect.caseInsensitiveLike(
        compileOperand(node.left, ctx, dialect, "text"),
        compileOperand(node.right, ctx, dialect, "text"),
        "prefix"
      )
    case "contains":
      return dialect.caseInsensitiveLike(
        compileOperand(node.left, ctx, dialect, "text"),
        compileOperand(node.right, ctx, dialect, "text"),
        "contains"
      )
  }
}

function accessHint(
  left: OperandNode,
  right: OperandInfo,
  ctx: CompileCtx
): FieldValueType | undefined {
  return hintForComparison(operandInfo(left, ctx), right)
}

/**
 * Compiles an operand node (value expression) into its SQL representation.
 */
export function compileOperand(
  node: OperandNode,
  ctx: CompileCtx,
  dialect: RuleSqlDialect,
  typeHint?: FieldValueType
): string {
  switch (node.kind) {
    case "field": {
      const isTopLevel = ctx.tableAlias !== undefined && node.collection === undefined
      if (ctx.fieldRefMode === "param" && isTopLevel) {
        const type = typeHint ?? ctx.fieldType?.(node.field) ?? "text"
        return `@field_${type}_${encodeFieldToken(node.field)}@`
      }

      const col = ctx.columnOfField(node.field)
      const quoted = dialect.quoteIdentifier(col)
      const expr = isTopLevel ? `${ctx.tableAlias}.${quoted}` : quoted
      const columnType = ctx.fieldType?.(node.field)
      if (typeHint !== undefined && columnType !== undefined && columnType !== typeHint) {
        return dialect.castValue(expr, typeHint)
      }
      return expr
    }
    case "literal": {
      const param = ctx.nextParam()
      ctx.params[param] = node.value
      return typedParam(param, typeHint, dialect)
    }
    case "auth":
      return typedParam(`@auth_${node.field}`, typeHint, dialect)
    case "authId":
      return typedParam("@auth_id", typeHint, dialect)
    case "authCollection":
      return typedParam("@auth_collection", typeHint, dialect)
    case "request":
      return typedParam(`@request_${node.source}_${node.key}`, typeHint, dialect)
    case "now":
      return dialect.currentTimestamp()
    case "subquery": {
      const { tableAlias: _alias, ...subCtx } = ctx
      const whereSql = compile(node.where, subCtx, dialect)
      return `SELECT ${dialect.quoteIdentifier(node.field)} FROM ${dialect.quoteIdentifier(node.collection)} WHERE ${whereSql}`
    }
    case "dateAdd":
      return dialect.timestampAdd(
        compileOperand(node.operand, ctx, dialect),
        node.amount,
        node.unit
      )
    case "dateDiff":
      return dialect.timestampDiff(
        compileOperand(node.left, ctx, dialect),
        compileOperand(node.right, ctx, dialect),
        node.unit
      )
  }
}
