import { Effect } from "effect"
import type { CollectionSchema } from "@gettersethya/mira-client"
import type { EnforceResult } from "@/rule/enforcer.js"
import type { RepoRecord, SortOrder, WhereClause } from "@/repository/types.js"
import type { RequestCtx } from "./context.js"
import { ForbiddenError } from "./errors.js"

/** Combines two WHERE clauses with AND. Both inputs are trusted internal code. */
export function andWhere(a: WhereClause, b: WhereClause): WhereClause {
  return {
    sql: `(${a.sql}) AND (${b.sql})`,
    params: [...a.params, ...b.params]
  }
}

/** Produces a WHERE clause that matches a single record by id. */
export function idClause(id: string): WhereClause {
  return { sql: "t.id = ?", params: [id] }
}

/** Produces a WHERE clause for cursor pagination: seqId strictly after the given cursor. */
export function cursorClause(after: number): WhereClause {
  return { sql: "t.seqId > ?", params: [after] }
}

/** Shared pattern for the `@auth_<field>` / `@request_<source>_<key>` placeholders emitted by the rule compiler. */
const CTX_PLACEHOLDER_PATTERN = String.raw`@auth_(\w+)|@request_(\w+)_(\w+)`

/**
 * Resolves `@auth_<field>` and `@request_<source>_<key>` placeholders produced by the
 * rule compiler into positional `?` params bound from `RequestCtx`.
 *
 * The replacement is done in a single left-to-right pass so that the param array stays
 * in the same order as the `?` placeholders in the resulting SQL.
 *
 * Returns `ForbiddenError` if the rule references auth but `ctx.auth` is absent.
 */
export function resolveCtxPlaceholders(result: EnforceResult, ctx: RequestCtx, collection: string, action: string) {
  return Effect.gen(function* () {
    const needsAuth = /@auth_\w+/.test(result.sql)
    if (needsAuth && ctx.auth === undefined) {
      return yield* new ForbiddenError({ collection, action })
    }

    const resolved: Array<unknown> = []
    let pIdx = 0
    const { params } = result

    // Single-pass left-to-right replacement preserves param ordering.
    // Groups: (1) @auth field, (2) @request source, (3) @request key
    const newSql = result.sql.replace(new RegExp(`\\?|${CTX_PLACEHOLDER_PATTERN}`, "g"), (match, g1, g2, g3): string => {
      const authField = typeof g1 === "string" ? g1 : undefined
      const reqSource = typeof g2 === "string" ? g2 : undefined
      const reqKey = typeof g3 === "string" ? g3 : undefined

      if (match === "?") {
        resolved.push(params[pIdx++])
      } else if (authField === "collection") {
        resolved.push(ctx.auth?.collection ?? null)
      } else if (authField !== undefined) {
        resolved.push(ctx.auth?.record[authField] ?? null)
      } else if (reqSource !== undefined && reqKey !== undefined) {
        const val = reqSource === "query" ? ctx.query[reqKey] : ctx.headers[reqKey]
        resolved.push(Array.isArray(val) ? val[0] : (val ?? null))
      }
      return "?"
    })

    return yield* Effect.succeed({ sql: newSql, params: resolved })
  })
}

/** The set of `RequestCtx`-derived values a compiled rule's SQL actually references. */
export type CtxRefs = {
  authFields: ReadonlyArray<string>
  queryKeys: ReadonlyArray<string>
  headerKeys: ReadonlyArray<string>
}

/**
 * Scans compiled rule SQL for `@auth_<field>` / `@request_<source>_<key>` placeholders
 * and returns exactly which `RequestCtx` fields they reference — used to build a cache
 * key that captures everything a rule could depend on without serializing all of `ctx`.
 */
export function extractCtxRefs(sql: string): CtxRefs {
  const authFields = new Set<string>()
  const queryKeys = new Set<string>()
  const headerKeys = new Set<string>()

  for (const match of sql.matchAll(new RegExp(CTX_PLACEHOLDER_PATTERN, "g"))) {
    const [, authField, reqSource, reqKey] = match
    if (authField !== undefined) {
      authFields.add(authField)
    } else if (reqSource !== undefined && reqKey !== undefined) {
      if (reqSource === "query") {
        queryKeys.add(reqKey)
      } else {
        headerKeys.add(reqKey)
      }
    }
  }

  return {
    authFields: [...authFields].sort(),
    queryKeys: [...queryKeys].sort(),
    headerKeys: [...headerKeys].sort()
  }
}

/**
 * Replaces `t.<fieldName>` column references in a WHERE clause with `?` params
 * bound to the corresponding values in `record`.
 *
 * Used for the `create` permission pre-check: `SELECT 1 WHERE <rule>` without a FROM.
 * The replacement is done left-to-right to preserve param ordering with existing `?`.
 */
export function resolveFieldRefs(clause: WhereClause, record: RepoRecord): WhereClause {
  const resolved: Array<unknown> = []
  let pIdx = 0
  const { params } = clause

  const newSql = clause.sql.replace(/\?|\bt\.(\w+)\b/g, (_, g1): string => {
    const field = typeof g1 === "string" ? g1 : undefined
    if (field !== undefined) {
      resolved.push(record[field] ?? null)
    } else {
      resolved.push(params[pIdx++])
    }
    return "?"
  })

  return { sql: newSql, params: resolved }
}

export function buildUserSort(
  query: RequestCtx["query"],
  schema: CollectionSchema
): SortOrder | null {
  const sortField = typeof query["sort"] === "string" ? query["sort"] : null
  if (sortField === null || !schema.properties[sortField]) return null
  const rawOrder = typeof query["order"] === "string" ? query["order"] : null
  const direction = rawOrder === "desc" ? "desc" : "asc"
  return { field: sortField, direction }
}
