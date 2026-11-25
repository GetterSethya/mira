import type { CollectionSchema, ExprNode } from "@gettersethya/mira-client"

import type { FieldValueType, RuleSqlDialect } from "@/dialect/dialect.js"
import { transformSqlCode } from "@/sql-text.js"

import type { CompileCtx, FieldRefMode } from "./compiler.js"
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

type RuleAction = keyof NonNullable<CollectionSchema["x-rules"]>

/**
 * Compiles a rule expression into a SQL snippet with `?` placeholders
 * and an ordered array of parameter values, ready for use with `@effect/sql`.
 */
export function enforceRule(
  rule: ExprNode,
  dialect: RuleSqlDialect,
  overrides?: Partial<CompileCtx>
): EnforceResult {
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
  const rawSql = compile(rule, ctx, dialect)
  const sql = transformSqlCode(rawSql, (code) =>
    code.replace(/@p(\d+)/g, () => "?")
  )
  const params: Array<unknown> = []
  for (let j = 0; j < i; j++) {
    params.push(paramRecord[`@p${j}`])
  }
  return { sql, params }
}

const fieldTypeOf = (schema: CollectionSchema) => (field: string): FieldValueType | undefined => {
  const prop = schema.properties[field]
  if (prop === undefined) return undefined
  if (prop["x-kind"] === "seqId") return "bigint"
  if (prop.type === "boolean") return "boolean"
  if (prop.type === "integer") return "integer"
  if (prop.type === "number") return "number"
  if (prop.type === "string") return "text"
  return undefined
}

/**
 * Per-schema, per-dialect, per-mode, per-action compiled-rule cache.
 *
 * A collection schema and a dialect are stable objects created once per app
 * boot, so the weak outer keys hold at most one entry per live pair. The mode
 * separates normal column SQL from payload marker SQL.
 */
const compiledRuleCache = new WeakMap<
  CollectionSchema,
  WeakMap<
    RuleSqlDialect,
    Record<FieldRefMode, Map<RuleAction, EnforceResult | null>>
  >
>()

function compileForAction(
  collection: CollectionSchema,
  action: RuleAction,
  dialect: RuleSqlDialect,
  mode: FieldRefMode
): EnforceResult | null {
  const rules = collection["x-rules"]
  if (rules === undefined) return null
  const rule = rules[action]
  if (rule === undefined) return null
  return enforceRule(rule, dialect, {
    fieldRefMode: mode,
    fieldType: fieldTypeOf(collection)
  })
}

function cachedForAction(
  collection: CollectionSchema,
  action: RuleAction,
  dialect: RuleSqlDialect,
  mode: FieldRefMode
): EnforceResult | null {
  let byDialect = compiledRuleCache.get(collection)
  if (byDialect === undefined) {
    byDialect = new WeakMap()
    compiledRuleCache.set(collection, byDialect)
  }

  let byMode = byDialect.get(dialect)
  if (byMode === undefined) {
    byMode = { column: new Map(), param: new Map() }
    byDialect.set(dialect, byMode)
  }

  const byAction = byMode[mode]
  if (byAction.has(action)) {
    const cached = byAction.get(action)
    return cached === undefined ? null : cached
  }

  const compiled = compileForAction(collection, action, dialect, mode)
  byAction.set(action, compiled)
  return compiled
}

/**
 * Resolves and compiles the normal column-mode rule for an action.
 * Returns `null` if the collection has no `x-rules` or the action has no rule.
 */
export function enforcerForAction(
  collection: CollectionSchema,
  action: RuleAction,
  dialect: RuleSqlDialect
): EnforceResult | null {
  return cachedForAction(collection, action, dialect, "column")
}

/**
 * Resolves and compiles the payload-mode rule for create or manage checks.
 * Field refs become typed `@field_*@` markers consumed by `resolveFieldRefs`.
 */
export function payloadEnforcerForAction(
  collection: CollectionSchema,
  action: "create" | "manage",
  dialect: RuleSqlDialect
): EnforceResult | null {
  return cachedForAction(collection, action, dialect, "param")
}
