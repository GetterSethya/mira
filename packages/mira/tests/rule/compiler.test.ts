import { describe, expect, it } from "vitest"

import type { AnyCollectionDef } from "@gettersethya/mira-client"
import { Rule } from "@gettersethya/mira-client"
import type { CompileCtx } from "@/rule/compiler.js"
import { compile, compileOperand } from "@/rule/compiler.js"

const Users: AnyCollectionDef = {
  name: "users",
  fields: {},
  schema: {
    "x-collection-kind": "auth",
    type: "object",
    properties: {}
  }
}

function makeCtx(overrides?: Partial<CompileCtx>): CompileCtx {
  let i = 0
  const ctx: CompileCtx = {
    tableAlias: "t",
    nextParam: () => `@p${i++}`,
    params: {},
    columnOfField: (f) => f,
    collectionSchemas: {},
    authCollection: "users",
  }
  if (overrides) {
    Object.assign(ctx, overrides)
  }
  return ctx
}

describe("compiler", () => {
  it("field = literal", () => {
    const ctx = makeCtx()
    const sql = compile(Rule.field("ownerId").eq(Rule.literal("abc")), ctx)
    expect(sql).toBe("t.ownerId = @p0")
    expect(ctx.params).toEqual({ "@p0": "abc" })
  })

  it("and / or with nesting", () => {
    const ctx = makeCtx()
    const expr = Rule.or(Rule.field("isPublic").eq(Rule.literal(true)), Rule.field("ownerId").eq(Rule.authId(Users)))
    const sql = compile(expr, ctx)
    expect(sql).toBe("(t.isPublic = @p0) OR (t.ownerId = @auth_id)")
  })

  it("not", () => {
    const ctx = makeCtx()
    const sql = compile(Rule.not(Rule.field("status").eq(Rule.literal("archived"))), ctx)
    expect(sql).toBe("NOT (t.status = @p0)")
  })

  it("startsWith", () => {
    const ctx = makeCtx()
    const sql = compile(Rule.field("title").startsWith(Rule.literal("Hello")), ctx)
    expect(sql).toBe("t.title LIKE (@p0 || '%')")
  })

  it("contains", () => {
    const ctx = makeCtx()
    const sql = compile(Rule.field("content").contains(Rule.literal("keyword")), ctx)
    expect(sql).toBe("t.content LIKE ('%' || @p0 || '%')")
  })

  it("in with literal array", () => {
    const ctx = makeCtx()
    const sql = compile(Rule.field("role").in(Rule.literal(["admin", "owner"])), ctx)
    expect(sql).toBe("t.role IN (@p0, @p1)")
    expect(ctx.params).toEqual({ "@p0": "admin", "@p1": "owner" })
  })

  it("subquery", () => {
    const ctx = makeCtx()
    const Members: AnyCollectionDef = {
      name: "members",
      fields: {},
      schema: {
        "x-collection-kind": "base",
        type: "object",
        properties: {}
      }
    }
    const expr = Rule.field("teamId").in(
      Rule.subquery(Members, "teamId").where(Rule.field("userId").eq(Rule.authId(Users)))
    )
    const sql = compile(expr, ctx)
    expect(sql).toBe("t.teamId IN (SELECT teamId FROM members WHERE userId = @auth_id)")
  })

  it("public", () => {
    const ctx = makeCtx()
    const sql = compile(Rule.public(), ctx)
    expect(sql).toBe("1 = 1")
  })

  it("now", () => {
    const ctx = makeCtx()
    const sql = compileOperand({ kind: "now" }, ctx)
    expect(sql).toBe("datetime('now')")
  })

  it("dateAdd", () => {
    const ctx = makeCtx()
    const sql = compileOperand(Rule.dateAdd(Rule.now(), 7, "day"), ctx)
    expect(sql).toBe("datetime(datetime('now'), '+7 days')")
  })

  it("dateDiff", () => {
    const ctx = makeCtx()
    const expr = Rule.dateDiff(Rule.field("created"), Rule.now(), "day")
    const sql = compileOperand(expr, ctx)
    expect(sql).toBe("(julianday(t.created) - julianday(datetime('now')))")
  })

  it("request header", () => {
    const ctx = makeCtx()
    const expr = Rule.request("header", "x-api-key").eq(Rule.literal("secret"))
    const sql = compile(expr, ctx)
    expect(sql).toBe("@request_header_x-api-key = @p0")
  })

  it("neq", () => {
    const ctx = makeCtx()
    const sql = compile(Rule.field("status").neq(Rule.literal("archived")), ctx)
    expect(sql).toBe("t.status != @p0")
  })

  it("gt / gte / lt / lte", () => {
    const ctx1 = makeCtx()
    expect(compile(Rule.field("age").gt(Rule.literal(18)), ctx1)).toBe("t.age > @p0")
    const ctx2 = makeCtx()
    expect(compile(Rule.field("age").gte(Rule.literal(18)), ctx2)).toBe("t.age >= @p0")
    const ctx3 = makeCtx()
    expect(compile(Rule.field("age").lt(Rule.literal(65)), ctx3)).toBe("t.age < @p0")
    const ctx4 = makeCtx()
    expect(compile(Rule.field("age").lte(Rule.literal(65)), ctx4)).toBe("t.age <= @p0")
  })

  it("deeply nested boolean — or(and, and)", () => {
    const ctx = makeCtx()
    const expr = Rule.or(
      Rule.and(Rule.field("a").eq(Rule.literal(1)), Rule.field("b").eq(Rule.literal(2))),
      Rule.and(Rule.field("c").eq(Rule.literal(3)), Rule.field("d").eq(Rule.literal(4)))
    )
    const sql = compile(expr, ctx)
    expect(sql).toBe("((t.a = @p0) AND (t.b = @p1)) OR ((t.c = @p2) AND (t.d = @p3))")
  })

  it("not(or(eq, and(gt, lt))) — 4 levels", () => {
    const ctx = makeCtx()
    const expr = Rule.not(
      Rule.or(
        Rule.field("status").eq(Rule.literal("archived")),
        Rule.and(Rule.field("age").gt(Rule.literal(100)), Rule.field("score").lt(Rule.literal(0)))
      )
    )
    const sql = compile(expr, ctx)
    expect(sql).toBe("NOT ((t.status = @p0) OR ((t.age > @p1) AND (t.score < @p2)))")
  })

  it("complex boolean with mixed comparison types", () => {
    const ctx = makeCtx()
    const expr = Rule.and(
      Rule.and(
        Rule.or(Rule.field("isPublic").eq(Rule.literal(true)), Rule.field("ownerId").eq(Rule.authId(Users))),
        Rule.field("status").neq(Rule.literal("archived"))
      ),
      Rule.field("title").contains(Rule.literal("report"))
    )
    const sql = compile(expr, ctx)
    expect(sql).toBe(
      "(((t.isPublic = @p0) OR (t.ownerId = @auth_id)) AND (t.status != @p1)) AND (t.title LIKE ('%' || @p2 || '%'))"
    )
  })

  it("literals: null, 0, false, empty string", () => {
    const ctx1 = makeCtx()
    expect(compile(Rule.field("deletedAt").eq(Rule.literal(null)), ctx1)).toBe("t.deletedAt = @p0")
    const ctx2 = makeCtx()
    expect(compile(Rule.field("count").eq(Rule.literal(0)), ctx2)).toBe("t.count = @p0")
    const ctx3 = makeCtx()
    expect(compile(Rule.field("active").eq(Rule.literal(false)), ctx3)).toBe("t.active = @p0")
    const ctx4 = makeCtx()
    expect(compile(Rule.field("name").neq(Rule.literal("")), ctx4)).toBe("t.name != @p0")
  })

  it("auth field operand", () => {
    const ctx = makeCtx()
    const sql = compile(Rule.auth(Users, "role").eq(Rule.literal("admin")), ctx)
    expect(sql).toBe("@auth_role = @p0")
  })

  it("request query and body sources", () => {
    const ctx1 = makeCtx()
    expect(compile(Rule.request("query", "filter").eq(Rule.literal("active")), ctx1)).toBe(
      "@request_query_filter = @p0"
    )
    const ctx2 = makeCtx()
    expect(compile(Rule.request("body", "email").neq(Rule.literal("")), ctx2)).toBe("@request_body_email != @p0")
  })

  it("in with subquery combined with and", () => {
    const ctx = makeCtx()
    const Members: AnyCollectionDef = {
      name: "members",
      fields: {},
      schema: { "x-collection-kind": "base", type: "object", properties: {} }
    }
    const expr = Rule.and(
      Rule.field("isPublic").eq(Rule.literal(true)),
      Rule.field("teamId").in(
        Rule.subquery(Members, "teamId").where(
          Rule.and(Rule.field("userId").eq(Rule.authId(Users)), Rule.field("role").eq(Rule.literal("admin")))
        )
      )
    )
    const sql = compile(expr, ctx)
    expect(sql).toBe(
      "(t.isPublic = @p0) AND (t.teamId IN (SELECT teamId FROM members WHERE (userId = @auth_id) AND (role = @p1)))"
    )
  })

  it("contains and startsWith with field operands as right side", () => {
    const ctx = makeCtx()
    const sql1 = compile(Rule.field("title").startsWith(Rule.field("prefix")), ctx)
    expect(sql1).toBe("t.title LIKE (t.prefix || '%')")
    const ctx2 = makeCtx()
    const sql2 = compile(Rule.field("title").contains(Rule.field("keyword")), ctx2)
    expect(sql2).toBe("t.title LIKE ('%' || t.keyword || '%')")
  })

  it("dateAdd with field operand", () => {
    const ctx = makeCtx()
    const sql = compileOperand(Rule.dateAdd(Rule.field("publishedAt"), 7, "day"), ctx)
    // tableAlias is stripped in compileOperand since it's not an ExprNode path
    expect(sql).toBe("datetime(t.publishedAt, '+7 days')")
  })

  it("dateDiff between two fields", () => {
    const ctx = makeCtx()
    const sql = compileOperand(Rule.dateDiff(Rule.field("start"), Rule.field("end"), "day"), ctx)
    expect(sql).toBe("(julianday(t.start) - julianday(t.end))")
  })

  it("dateDiff in comparison", () => {
    const ctx = makeCtx()
    const expr = Rule.field("created").gte(Rule.dateAdd(Rule.now(), -90, "day"))
    const sql = compile(expr, ctx)
    expect(sql).toBe("t.created >= datetime(datetime('now'), '-90 days')")
  })

  it("dateAdd with positive amount", () => {
    const ctx = makeCtx()
    const sql = compileOperand(Rule.dateAdd(Rule.field("publishedAt"), 7, "day"), ctx)
    expect(sql).toBe("datetime(t.publishedAt, '+7 days')")
  })

  it("columnOfField mapping", () => {
    const ctx = makeCtx({
      columnOfField: (f) => (f === "createdAt" ? "created_at" : f)
    })
    const sql = compile(Rule.field("createdAt").eq(Rule.literal("2024-01-01")), ctx)
    expect(sql).toBe("t.created_at = @p0")
  })

  it("multiple params accumulate correctly", () => {
    const ctx = makeCtx()
    compile(Rule.field("a").eq(Rule.literal(1)), ctx)
    compile(Rule.field("b").eq(Rule.literal(2)), ctx)
    compile(Rule.field("c").eq(Rule.literal(3)), ctx)
    expect(ctx.params).toEqual({ "@p0": 1, "@p1": 2, "@p2": 3 })
  })

  it("subquery without tableAlias", () => {
    const ctx = makeCtx()
    delete ctx.tableAlias
    const Members: AnyCollectionDef = {
      name: "members",
      fields: {},
      schema: { "x-collection-kind": "base", type: "object", properties: {} }
    }
    const expr = Rule.field("teamId").in(
      Rule.subquery(Members, "teamId").where(Rule.field("userId").eq(Rule.literal("u1")))
    )
    const sql = compile(expr, ctx)
    expect(sql).toBe("teamId IN (SELECT teamId FROM members WHERE userId = @p0)")
  })
})
