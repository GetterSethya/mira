import { Effect } from "effect"

import type { FieldValueType, Quote } from "@/dialect/dialect.js"
import { forEachSqlCode, sqlCodeMatches, transformSqlCode } from "@/sql-text.js"
import type { RepoRecord, SortOrder, WhereClause } from "@/repository/types.js"
import type { EnforceResult } from "@/rule/enforcer.js"

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
export function idClause(id: string, quote: Quote): WhereClause {
  return { sql: `t.${quote("id")} = ?`, params: [id] }
}

/** Produces a WHERE clause for cursor pagination: seqId strictly after the cursor. */
export function cursorClause(after: number, quote: Quote): WhereClause {
  return { sql: `t.${quote("seqId")} > ?`, params: [after] }
}

/** Produces an equality lookup for the row at a seqId cursor. */
export function seqIdEqualsClause(seqId: number, quote: Quote): WhereClause {
  return { sql: `t.${quote("seqId")} = ?`, params: [seqId] }
}

/** Produces an equality lookup on one field. */
export function fieldEqualsClause(field: string, value: unknown, quote: Quote): WhereClause {
  return { sql: `t.${quote(field)} = ?`, params: [value] }
}

/**
 * Produces a row-value keyset predicate for a sorted cursor:
 * `(field, seqId) > (value, after)` for ASC, `<` for DESC.
 *
 * The caller must resolve `value` from the cursor row and reject nullable sort
 * fields; SQL row comparison with NULL is unknown, and null ordering differs by
 * dialect. The field name is validated against the schema before this point.
 */
export function keysetClause(
  sort: SortOrder,
  value: unknown,
  after: number,
  quote: Quote
): WhereClause {
  const op = sort.direction === "asc" ? ">" : "<"
  return {
    sql: `(t.${quote(sort.field)}, t.${quote("seqId")}) ${op} (?, ?)`,
    params: [value, after]
  }
}

/** Shared pattern for the `@auth_<field>` / `@request_<source>_<key>` placeholders emitted by the rule compiler. */
const CTX_PLACEHOLDER_PATTERN = String.raw`@auth_(\w+)|@request_(\w+)_(\w+)`

/**
 * Resolves `@auth_<field>` and `@request_<source>_<key>` placeholders produced by the
 * rule compiler into positional `?` params bound from `RequestCtx`.
 *
 * The replacement is done in a single left-to-right pass so that the param array stays
 * in the same order as the `?` placeholders in the resulting SQL. Quoted identifiers
 * and string literals are skipped.
 *
 * Request sources resolve explicitly: `"query"` reads `ctx.query`, `"header"` reads
 * `ctx.headers`, and `"body"` reads `ctx.body` (absent for bodiless actions, in which
 * case the value resolves to `null`). Array values take element `[0]`, mirroring query.
 *
 * Returns `ForbiddenError` if the rule references auth but `ctx.auth` is absent, or if
 * the rule references an unknown request source (fail closed).
 */
export interface ResolveOptions {
  /** Dialect-aware encoder for bound values (e.g. boolean -> 0/1 on SQLite). */
  readonly encodeParam: (value: unknown) => unknown
  /** Dialect-aware identifier quoter for body-column bindings. */
  readonly quoteIdentifier: Quote
  /** Dialect-aware cast for typed payload comparisons. */
  readonly castValue: (expr: string, type: FieldValueType) => string
}

/**
 * How an update rule's `@request_body_<key>` placeholder should bind when the
 * rule is evaluated as part of the stored-row query.
 *
 * `param` is used when the patch supplies the key. `column` is used when the key
 * is absent from the patch: the rule reads the stored row through `t."<key>"`
 * instead of a parameter, so the existence + rule check stays one SELECT.
 */
export type BodyBinding =
  | { readonly _tag: "param"; readonly value: unknown }
  | { readonly _tag: "column"; readonly column: string }

export type BodyBindingPlan = ReadonlyMap<string, BodyBinding>

export function resolveCtxPlaceholders(
  result: EnforceResult,
  ctx: RequestCtx,
  collection: string,
  action: string,
  options: ResolveOptions,
  bodyPlan?: BodyBindingPlan
) {
  const encode = options.encodeParam
  // A clause with no request placeholders and no positional params is already
  // resolved. Return a fresh object so a future caller cannot mutate the
  // enforcer's cached EnforceResult.
  if (result.params.length === 0 && !sqlCodeMatches(result.sql, /[@?]/)) {
    return Effect.succeed({ sql: result.sql, params: [] })
  }
  return Effect.gen(function* () {
    const needsAuth = sqlCodeMatches(result.sql, /@auth_\w+/)
    if (needsAuth && ctx.auth === undefined) {
      return yield* new ForbiddenError({ collection, action })
    }

    let unknownSource = false
    forEachSqlCode(result.sql, (code) => {
      for (const match of code.matchAll(new RegExp(CTX_PLACEHOLDER_PATTERN, "g"))) {
        const reqSource = match[2]
        if (
          reqSource !== undefined &&
          reqSource !== "query" &&
          reqSource !== "header" &&
          reqSource !== "body"
        ) {
          unknownSource = true
        }
      }
    })
    if (unknownSource) {
      return yield* new ForbiddenError({ collection, action })
    }

    const resolved: Array<unknown> = []
    let pIdx = 0
    const { params } = result

    // Single-pass left-to-right replacement preserves param ordering.
    // Groups: (1) @auth field, (2) @request source, (3) @request key
    const newSql = transformSqlCode(result.sql, (code) =>
      code.replace(
        new RegExp(`\\?|${CTX_PLACEHOLDER_PATTERN}`, "g"),
        (match, g1, g2, g3): string => {
          const authField = typeof g1 === "string" ? g1 : undefined
          const reqSource = typeof g2 === "string" ? g2 : undefined
          const reqKey = typeof g3 === "string" ? g3 : undefined

          if (match === "?") {
            resolved.push(encode(params[pIdx++]))
          } else if (authField === "collection") {
            resolved.push(encode(ctx.auth?.collection ?? null))
          } else if (authField !== undefined) {
            resolved.push(encode(ctx.auth?.record[authField] ?? null))
          } else if (reqSource === "query" && reqKey !== undefined) {
            const val = ctx.query[reqKey]
            resolved.push(encode(Array.isArray(val) ? val[0] : (val ?? null)))
          } else if (reqSource === "header" && reqKey !== undefined) {
            resolved.push(encode(ctx.headers[reqKey] ?? null))
          } else if (reqSource === "body" && reqKey !== undefined) {
            const binding = bodyPlan?.get(reqKey)
            if (binding?._tag === "column") {
              return `t.${options.quoteIdentifier(binding.column)}`
            }
            const val = binding?._tag === "param" ? binding.value : ctx.body?.[reqKey]
            resolved.push(encode(Array.isArray(val) ? val[0] : (val ?? null)))
          }
          return "?"
        }
      )
    )

    return yield* Effect.succeed({ sql: newSql, params: resolved })
  })
}

/** The set of `RequestCtx`-derived values a compiled rule's SQL actually references. */
export type CtxRefs = {
  authFields: ReadonlyArray<string>
  queryKeys: ReadonlyArray<string>
  headerKeys: ReadonlyArray<string>
  bodyKeys: ReadonlyArray<string>
  /** A rule contains a SELECT/EXISTS subquery; absent body keys must fall back. */
  hasSubquery: boolean
  /** A rule references a request source other than query/header/body (fail closed). */
  hasUnknownSource: boolean
}

/**
 * Memoizes {@link extractCtxRefs} by compiled SQL string. The number of distinct
 * rule compilations is bounded by the number of collection/action rules in the
 * app, so the map stays small; a regex scan per request is avoided entirely.
 *
 * The returned refs (and their arrays) are frozen because they are shared across
 * requests.
 */
const ctxRefsCache = new Map<string, CtxRefs>()

/**
 * Scans compiled rule SQL for `@auth_<field>` / `@request_<source>_<key>` placeholders
 * and returns exactly which `RequestCtx` fields they reference. Quoted identifiers
 * and string literals are skipped.
 */
export function extractCtxRefs(sql: string): CtxRefs {
  const cached = ctxRefsCache.get(sql)
  if (cached !== undefined) return cached

  const authFields = new Set<string>()
  const queryKeys = new Set<string>()
  const headerKeys = new Set<string>()
  const bodyKeys = new Set<string>()
  let hasUnknownSource = false

  forEachSqlCode(sql, (code) => {
    for (const match of code.matchAll(new RegExp(CTX_PLACEHOLDER_PATTERN, "g"))) {
      const [, authField, reqSource, reqKey] = match
      if (authField !== undefined) {
        authFields.add(authField)
      } else if (reqSource !== undefined && reqKey !== undefined) {
        if (reqSource === "query") {
          queryKeys.add(reqKey)
        } else if (reqSource === "body") {
          bodyKeys.add(reqKey)
        } else if (reqSource === "header") {
          headerKeys.add(reqKey)
        } else {
          hasUnknownSource = true
          headerKeys.add(reqKey)
        }
      }
    }
  })

  const refs: CtxRefs = Object.freeze({
    authFields: Object.freeze([...authFields].sort()),
    queryKeys: Object.freeze([...queryKeys].sort()),
    headerKeys: Object.freeze([...headerKeys].sort()),
    bodyKeys: Object.freeze([...bodyKeys].sort()),
    hasSubquery: sqlCodeMatches(sql, /\b(?:SELECT|EXISTS)\b/i),
    hasUnknownSource
  })
  ctxRefsCache.set(sql, refs)
  return refs
}

const decodeFieldToken = (token: string): string => {
  const base64 = token.replaceAll("-", "+").replaceAll("_", "/")
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")
  const binary = atob(padded)
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

const PAYLOAD_FIELD =
  /@field_(text|integer|number|boolean)_([A-Za-z0-9_-]+)@|\?/g

/**
 * Replaces compiler payload markers with `?` params bound to `record`.
 *
 * This runs only on SQL compiled with `fieldRefMode: "param"`. It never parses
 * quoted identifiers, so a field named `a?b` or `note@auth_id` cannot shift the
 * bind order.
 */
export function resolveFieldRefs(
  clause: WhereClause,
  record: RepoRecord,
  options: ResolveOptions
): WhereClause {
  const encode = options.encodeParam
  const resolved: Array<unknown> = []
  let pIdx = 0
  const { params } = clause

  const newSql = transformSqlCode(clause.sql, (code) =>
    code.replace(PAYLOAD_FIELD, (match, type: FieldValueType | undefined, token: string | undefined): string => {
      if (match === "?") {
        resolved.push(encode(params[pIdx++]))
        return "?"
      }
      const field = decodeFieldToken(token ?? "")
      resolved.push(encode(record[field] ?? null))
      return options.castValue("?", type ?? "text")
    })
  )

  return { sql: newSql, params: resolved }
}
