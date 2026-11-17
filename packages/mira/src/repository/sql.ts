import type { DialectType, Quote } from "@/dialect/dialect.js"
import { rewritePlaceholders } from "@/dialect/dialect.js"
import type {
  AccessPredicate,
  ExpandDef,
  FilterOptions,
  ListOptions,
  SortOrder,
  WhereClause
} from "@/repository/types.js"
import { transformSqlCode } from "@/sql-text.js"

type Rendered = { sql: string; params: ReadonlyArray<unknown> }

const joinAlias = (localField: string) => `_e_${localField}`

export function orderFrag(quote: Quote, sort?: SortOrder, tieBreaker?: string): string {
  if (!sort) return ""
  const dir = sort.direction === "desc" ? "DESC" : "ASC"
  const secondary =
    tieBreaker !== undefined && tieBreaker !== sort.field
      ? `, t.${quote(tieBreaker)} ${dir}`
      : ""
  return ` ORDER BY t.${quote(sort.field)} ${dir}${secondary}`
}

export function buildSelect(
  quote: Quote,
  fields?: ReadonlyArray<string>,
  expand?: ReadonlyArray<ExpandDef>
): string {
  if (!fields && !expand) return "SELECT *"

  const cols: Array<string> = []
  if (fields && fields.length > 0) {
    cols.push(...fields.map((field) => `t.${quote(field)}`))
  } else {
    cols.push("t.*")
  }

  if (expand) {
    for (const item of expand) {
      const alias = quote(joinAlias(item.localField))
      for (const column of item.targetColumns) {
        cols.push(
          `${alias}.${quote(column)} AS ${quote(`__e_${item.localField}__${column}`)}`
        )
      }
    }
  }

  return cols.length === 0 ? "SELECT *" : `SELECT ${cols.join(", ")}`
}

export function buildJoins(
  quote: Quote,
  expand?: ReadonlyArray<ExpandDef>
): { sql: string; params: ReadonlyArray<unknown> } {
  if (!expand || expand.length === 0) return { sql: "", params: [] }

  let sql = ""
  const params: Array<unknown> = []
  for (const item of expand) {
    const alias = quote(joinAlias(item.localField))
    const target = quote(item.targetTable)
    const on = item.onClause
    if (on !== undefined) {
      const scoped = transformSqlCode(on.sql, (code) =>
        code.replace(/\bt\./g, () => `${alias}.`)
      )
      sql += ` LEFT JOIN ${target} ${alias} ON ${alias}.${quote("id")} = t.${quote(item.localField)} AND (${scoped})`
      params.push(...on.params)
    } else {
      sql += ` LEFT JOIN ${target} ${alias} ON ${alias}.${quote("id")} = t.${quote(item.localField)}`
    }
  }
  return { sql, params }
}

function renderWhere(where: WhereClause) {
  return ` WHERE ${where.sql}`
}

export function renderView(quote: Quote, table: string, id: string): Rendered {
  return {
    sql: `SELECT * FROM ${quote(table)} t WHERE t.${quote("id")} = ? LIMIT 1`,
    params: [id]
  }
}

export function renderViewFilter(
  quote: Quote,
  table: string,
  filter: FilterOptions
): Rendered {
  const select = buildSelect(quote, filter.fields, filter.expand)
  const joins = buildJoins(quote, filter.expand)
  const order = orderFrag(quote, filter.sort, filter.tieBreaker)
  return {
    sql: `${select} FROM ${quote(table)} t${joins.sql}${renderWhere(filter.where)}${order}`,
    params: [...joins.params, ...filter.where.params]
  }
}

export function renderList(
  quote: Quote,
  table: string,
  limit: number,
  options?: ListOptions
): Rendered {
  const select = buildSelect(quote, options?.fields, options?.expand)
  const joins = buildJoins(quote, options?.expand)
  const order = orderFrag(quote, options?.sort, options?.tieBreaker)
  const where = options?.where
  const whereSql = where === undefined ? "" : renderWhere(where)
  return {
    sql: `${select} FROM ${quote(table)} t${joins.sql}${whereSql}${order} LIMIT ?`,
    params: [
      ...joins.params,
      ...(where?.params ?? []),
      limit
    ]
  }
}

export function renderViewWithAccess(
  quote: Quote,
  table: string,
  id: string,
  predicates: readonly [AccessPredicate, ...Array<AccessPredicate>]
): Rendered {
  const select = buildSelect(quote, undefined, undefined)
  const params: Array<unknown> = []
  const access = predicates.map((predicate) => {
    params.push(...predicate.where.params)
    return `CASE WHEN (${predicate.where.sql}) THEN 1 ELSE 0 END AS ${quote(`__mira_access_${predicate.name}`)}`
  })
  return {
    sql: `${select}, ${access.join(", ")} FROM ${quote(table)} t WHERE t.${quote("id")} = ? LIMIT 1`,
    params: [...params, id]
  }
}

export function renderExists(quote: Quote, table: string, id: string): Rendered {
  return {
    sql: `SELECT 1 FROM ${quote(table)} t WHERE t.${quote("id")} = ? LIMIT 1`,
    params: [id]
  }
}

export function renderDelete(quote: Quote, table: string, id: string): Rendered {
  return {
    sql: `DELETE FROM ${quote(table)} WHERE ${quote("id")} = ?`,
    params: [id]
  }
}

export function renderDeleteReturning(
  quote: Quote,
  table: string,
  id: string
): Rendered {
  return {
    sql: `DELETE FROM ${quote(table)} WHERE ${quote("id")} = ? RETURNING ${quote("id")}`,
    params: [id]
  }
}

export function renderRuleCheck(
  where: WhereClause,
  dialect: Pick<DialectType, "placeholder">
): Rendered {
  return {
    sql: `SELECT 1 AS ok WHERE ${rewritePlaceholders(where.sql, dialect)}`,
    params: where.params
  }
}
