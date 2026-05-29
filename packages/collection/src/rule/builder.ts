import type { AnyCollectionDef, FieldsMap, InferFieldValue } from "@/collection/types.js"
import type { ExprNode, OperandNode } from "./types.js"

type FieldOperandMethods<K extends string, V = unknown> = {
  eq(right: OperandNode<any, V>): ExprNode<K>
  neq(right: OperandNode<any, V>): ExprNode<K>
  gt(right: OperandNode<any, V>): ExprNode<K>
  gte(right: OperandNode<any, V>): ExprNode<K>
  lt(right: OperandNode<any, V>): ExprNode<K>
  lte(right: OperandNode<any, V>): ExprNode<K>
  in(right: OperandNode<any, V | ReadonlyArray<V>>): ExprNode<K>
  startsWith(right: OperandNode<any, V>): ExprNode<K>
  contains(right: OperandNode<any, V>): ExprNode<K>
}

/** An operand node with fluent comparison methods attached. */
export type FieldOperand<K extends string, V = unknown> = OperandNode<K, V> & FieldOperandMethods<K, V>

/** Base rule methods shared by Rule and RuleBuilder (excludes field and subquery). */
type RuleBase = {
  request: (source: "header" | "query" | "body", key: string) => FieldOperand<string, string>
  auth: <C extends AnyCollectionDef, K extends keyof C["fields"] & string>(_collection: C, field: K) => FieldOperand<string, string>
  authId: <C extends AnyCollectionDef>(_collection: C) => FieldOperand<any, string>
  literal: <V>(value: V) => OperandNode<any, V>
  now: () => OperandNode<any, string>
  dateAdd: (operand: OperandNode<any>, amount: number, unit: "day" | "hour" | "minute") => OperandNode<any, string>
  dateDiff: (left: OperandNode<any>, right: OperandNode<any>, unit: "day" | "hour" | "minute") => OperandNode<any, number>
  and: <K extends string = string>(...exprs: Array<ExprNode<K>>) => ExprNode<K>
  or: <K extends string = string>(...exprs: Array<ExprNode<K>>) => ExprNode<K>
  not: <K extends string = string>(expr: ExprNode<K>) => ExprNode<K>
  public: <K extends string = string>() => ExprNode<K>
}

/**
 * A narrowed version of the Rule builder where `field()` is constrained to field
 * names defined in `F` and comparison operands are typed to match each field's value type.
 * Used as the argument type for the `rules` callback in collection definers.
 */
export type RuleBuilder<F extends FieldsMap> = RuleBase & {
  field<K extends keyof F & string>(name: K): FieldOperand<K, InferFieldValue<F[K]>>
  subquery: <C extends AnyCollectionDef, K extends keyof C["fields"] & string>(
    _collection: C,
    field: K
  ) => { where: (expr: ExprNode<any> | ((R: RuleBuilder<C["fields"]>) => ExprNode<any>)) => OperandNode<any, string> }
}

function toChainable<K extends string, V>(operand: OperandNode<K, V>): FieldOperand<K, V> {
  const methods: FieldOperandMethods<K, V> = {
    eq(right) { return { op: "eq", left: operand, right } },
    neq(right) { return { op: "neq", left: operand, right } },
    gt(right) { return { op: "gt", left: operand, right } },
    gte(right) { return { op: "gte", left: operand, right } },
    lt(right) { return { op: "lt", left: operand, right } },
    lte(right) { return { op: "lte", left: operand, right } },
    in(right) { return { op: "in", left: operand, right } },
    startsWith(right) { return { op: "startsWith", left: operand, right } },
    contains(right) { return { op: "contains", left: operand, right } }
  }
  return Object.assign({}, operand, methods)
}

/**
 * Rule builder API.
 *
 * Constructs access rule expressions using a fluent builder pattern.
 * Rules are compiled to SQL WHERE clauses at runtime by the rule compiler.
 *
 * @example
 * // Simple field comparison
 * Rule.field("ownerId").eq(Rule.authId(Users))
 *
 * // Boolean combination
 * Rule.or(
 *   Rule.field("isPublic").eq(Rule.literal(true)),
 *   Rule.field("ownerId").eq(Rule.authId(Users))
 * )
 *
 * // Date-based rule
 * Rule.field("createdAt").gte(Rule.dateAdd(Rule.now(), -30, "day"))
 *
 * // Subquery
 * const memberTeams = Rule.subquery(Members, "teamId").where(
 *   Rule.field("userId").eq(Rule.authId(Users))
 * )
 * Rule.field("teamId").in(memberTeams)
 *
 * // Subquery with typed callback
 * Rule.field("id").in(
 *   Rule.subquery(Members, "teamId").where(
 *     (Q) => Q.field("userId").eq(Rule.authId(Users))
 *   )
 * )
 *
 * // Always allow
 * Rule.public()
 */
export const Rule: RuleBase & {
  field: <const K extends string>(name: K) => FieldOperand<K, unknown>
  subquery: <C extends AnyCollectionDef, K extends keyof C["fields"] & string>(
    _collection: C,
    field: K
  ) => { where: (expr: ExprNode<any> | ((R: RuleBuilder<C["fields"]>) => ExprNode<any>)) => OperandNode<any, string> }
} = {
  /** Reference a record field by name. Returns a chainable operand. Value type is unknown; use via RuleBuilder for typed comparisons. */
  field: <const K extends string>(name: K): FieldOperand<K, unknown> =>
    toChainable<K, unknown>({ kind: "field", field: name }),

  /** Reference a value from the incoming request (header, query param, or body field). */
  request: (source: "header" | "query" | "body", key: string): FieldOperand<string, string> =>
    toChainable<string, string>({ kind: "request", source, key }),

  /** Reference a field from the authenticated user's record. */
  auth: <C extends AnyCollectionDef, K extends keyof C["fields"] & string>(
    _collection: C,
    field: K
  ): FieldOperand<string, string> => toChainable<string, string>({ kind: "auth", collection: _collection.name, field }),

  /** Reference the ID of the currently authenticated user. */
  authId: <C extends AnyCollectionDef>(_collection: C): FieldOperand<any, string> =>
    toChainable<any, string>({ kind: "authId", collection: _collection.name }),

  /** A literal value for comparison. The value type `V` is inferred from the argument. */
  literal: <V>(value: V): OperandNode<any, V> => ({
    kind: "literal",
    value
  }),

  /**
   * Create a subquery operand into another collection.
   * Call `.where()` on the result to finish the subquery.
   *
   * @example
   * // Bare expression (backward compatible)
   * Rule.subquery(Members, "teamId").where(
   *   Rule.field("userId").eq(Rule.authId(Users))
   * )
   *
   * // Typed callback — Q.field() is scoped to the subquery collection
   * Rule.subquery(Members, "teamId").where(
   *   (Q) => Q.field("userId").eq(Rule.authId(Users))
   * )
   */
  subquery: <C extends AnyCollectionDef, K extends keyof C["fields"] & string>(
    _collection: C,
    field: K
  ): { where: (expr: ExprNode<any> | ((R: RuleBuilder<C["fields"]>) => ExprNode<any>)) => OperandNode<any, string> } => ({
    where: (expr) => ({
      kind: "subquery",
      collection: _collection.name,
      field,
      where: typeof expr === "function" ? expr(makeRuleBuilder<C["fields"]>()) : expr
    })
  }),

  /** Current timestamp operand. Compiles to `datetime('now')` in SQLite. */
  now: (): OperandNode<any, string> => ({ kind: "now" }),

  /** Add a duration to a date operand for date arithmetic. */
  dateAdd: (operand: OperandNode<any>, amount: number, unit: "day" | "hour" | "minute"): OperandNode<any, string> => ({
    kind: "dateAdd",
    operand,
    amount,
    unit
  }),

  /** Compute the difference between two date operands. */
  dateDiff: (left: OperandNode<any>, right: OperandNode<any>, unit: "day" | "hour" | "minute"): OperandNode<any, number> => ({
    kind: "dateDiff",
    left,
    right,
    unit
  }),

  /** Logical AND of expressions. */
  and: <K extends string = string>(...exprs: Array<ExprNode<K>>): ExprNode<K> => {
    if (exprs.length === 0) return { op: "public" }
    if (exprs.length === 1) return exprs[0]!
    return exprs.slice(1).reduce<ExprNode<K>>((acc, curr) => ({ op: "and", left: acc, right: curr }), exprs[0]!)
  },

  /** Logical OR of expressions. */
  or: <K extends string = string>(...exprs: Array<ExprNode<K>>): ExprNode<K> => {
    if (exprs.length === 0) return { op: "public" }
    if (exprs.length === 1) return exprs[0]!
    return exprs.slice(1).reduce<ExprNode<K>>((acc, curr) => ({ op: "or", left: acc, right: curr }), exprs[0]!)
  },

  /** Logical negation of a sub-expression. */
  not: <K extends string = string>(expr: ExprNode<K>): ExprNode<K> => ({ op: "not", expr }),

  /** Always-true rule that allows all access. */
  public: <K extends string = string>(): ExprNode<K> => ({ op: "public" })
}

/**
 * Creates a typed `RuleBuilder<F>` that constrains `field()` to names in `F`
 * and types each comparison operand to the field's value type.
 * Used internally by collection definers and subquery typed callbacks.
 */
export function makeRuleBuilder<F extends FieldsMap>(): RuleBuilder<F> {
  function field<K extends keyof F & string>(name: K): FieldOperand<K, InferFieldValue<F[K]>> {
    return toChainable<K, InferFieldValue<F[K]>>({ kind: "field", field: name })
  }
  const builder: RuleBuilder<F> = { ...Rule, field }
  return builder
}
