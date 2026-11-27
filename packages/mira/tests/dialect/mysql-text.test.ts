import { describe, it } from "@effect/vitest"
import type { CollectionSchema, ExprNode } from "@gettersethya/mira-client"
import { Filter, Rule, filterNodeToWhereClause } from "@gettersethya/mira-client"
import { Effect } from "effect"
import { expect } from "vitest"

import type { RuleSqlDialect } from "@/dialect/dialect.js"
import { mysqlCaseInsensitiveLike, mysqlFilterSql } from "@/dialect/dialect-mysql-text.js"
import type { CompileCtx } from "@/rule/compiler.js"
import { compile } from "@/rule/compiler.js"

const schema: CollectionSchema = {
  "x-collection-kind": "base",
  type: "object",
  properties: {
    title: { type: "string" }
  },
  required: ["title"]
}

const ruleDialect: RuleSqlDialect = {
  quoteIdentifier: (name) => `\`${name}\``,
  currentTimestamp: () => "NOW()",
  timestampAdd: (expr) => expr,
  timestampDiff: () => "0",
  caseInsensitiveLike: mysqlCaseInsensitiveLike,
  castValue: (expr) => expr
}

const compileRule = (node: ExprNode) => {
  let index = 0
  const ctx: CompileCtx = {
    columnOfField: (field) => field,
    nextParam: () => `@p${index++}`,
    params: {},
    collectionSchemas: { t: schema }
  }
  const sql = compile(node, ctx, ruleDialect)
  return { sql, params: ctx.params }
}

describe("mysql text LIKE rendering", () => {
  it("renders prefix and contains with LOWER and CONCAT", () => {
    expect(mysqlCaseInsensitiveLike("`title`", "?", "prefix")).toBe(
      "LOWER(`title`) LIKE LOWER(CONCAT(?, '%'))"
    )
    expect(mysqlCaseInsensitiveLike("`title`", "?", "contains")).toBe(
      "LOWER(`title`) LIKE LOWER(CONCAT('%', ?, '%'))"
    )
  })

  it("renders a complete pattern without transforming it", () => {
    expect(mysqlFilterSql.caseInsensitivePattern("`title`", "?")).toBe(
      "LOWER(`title`) LIKE LOWER(?)"
    )
  })

  it("compiles a startsWith rule through the existing rule compiler", () => {
    const { sql, params } = compileRule(
      Rule.field("title").startsWith(Rule.literal("adm"))
    )
    expect(sql).toBe("LOWER(`title`) LIKE LOWER(CONCAT(@p0, '%'))")
    expect(params).toEqual({ "@p0": "adm" })
  })

  it.effect("compiles a like filter through the existing filter compiler", () =>
    Effect.gen(function* () {
      const result = yield* filterNodeToWhereClause(
        Filter.field("title").like("%adm%"),
        schema,
        "posts",
        {
          quoteIdentifier: (name) => `\`${name}\``,
          caseInsensitivePattern: (left, right) =>
            mysqlFilterSql.caseInsensitivePattern(left, right)
        }
      )
      expect(result.sql).toBe("LOWER(t.`title`) LIKE LOWER(?)")
      expect(result.params).toEqual(["%adm%"])
    })
  )
})
