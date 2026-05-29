import type { CollectionSchema, ExprNode } from "@gettersethya/mira-client"
import type { CompileCtx } from "./compiler.js"
import { compile } from "./compiler.js"

/** Result of compiling a rule for runtime enforcement: SQL string + ordered params. */
export type EnforceResult = {
  sql: string
  params: ReadonlyArray<unknown>
}

/** Context values available to rule evaluation at enforcement time. */
export type EnforcementCtx = {
  auth?: { collection: string; record: Record<string, unknown> }
  headers: Record<string, string>
  query: Record<string, string | Array<string>>
}

/**
 * Compiles a rule expression into a SQL snippet with `?` placeholders
 * and an ordered array of parameter values, ready for use with `@effect/sql`.
 *
 * @example
 * const { sql, params } = enforceRule(
 *   Rule.field("ownerId").eq(Rule.authId(Users))
 * )
 * // sql: "t.ownerId = ?"
 * // params: []
 *
 * const { sql, params } = enforceRule(
 *   Rule.field("status").eq(Rule.literal("active"))
 * )
 * // sql: "t.status = ?"
 * // params: ["active"]
 */
export function enforceRule(rule: ExprNode, overrides?: Partial<CompileCtx>): EnforceResult {
  let i = 0
  const paramRecord: Record<string, unknown> = {}
  const ctx: CompileCtx = {
    tableAlias: "t",
    nextParam: () => `@p${i++}`,
    params: paramRecord,
    columnOfField: (f) => f,
    collectionSchemas: {},
    ...overrides
  }
  const rawSql = compile(rule, ctx)
  const sql = rawSql.replace(/@p(\d+)/g, "?")
  const params: Array<unknown> = []
  for (let j = 0; j < i; j++) {
    params.push(paramRecord[`@p${j}`])
  }
  return { sql, params }
}

/**
 * Resolves and compiles the rule for a specific action on a collection schema.
 * Returns `null` if the collection has no `x-rules` or the action has no rule defined.
 *
 * @example
 * const schema = Posts.schema // CollectionSchema with x-rules
 * const result = enforcerForAction(schema, "list")
 * if (result) {
 *   sql.unsafe(`SELECT * FROM posts WHERE ${result.sql}`, result.params)
 * }
 */
export function enforcerForAction(
  collection: CollectionSchema,
  action: keyof NonNullable<CollectionSchema["x-rules"]>
): EnforceResult | null {
  const rules = collection["x-rules"]
  if (rules === undefined) {
    return null
  }
  const rule = rules[action]
  if (rule === undefined) {
    return null
  }
  return enforceRule(rule)
}
