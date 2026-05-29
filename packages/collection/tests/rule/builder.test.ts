import { describe, expect, it } from "vitest"

import type { AnyCollectionDef, FieldsMap } from "@/collection/types.js"
import { Rule } from "@/rule/builder.js"

const Users: AnyCollectionDef = {
  name: "users",
  fields: {},
  schema: {
    "x-collection-kind": "auth",
    type: "object",
    properties: {}
  }
}

describe("Rule.field", () => {
  it("produces field operand", () => {
    const f = Rule.field("ownerId")
    expect(f).toMatchObject({ kind: "field", field: "ownerId" })
  })
})

describe("Rule.eq via chaining", () => {
  it("Rule.field('a').eq(Rule.literal(1))", () => {
    const expr = Rule.field("a").eq(Rule.literal(1))
    expect(expr).toEqual({
      op: "eq",
      left: { kind: "field", field: "a" },
      right: { kind: "literal", value: 1 }
    })
  })
})

describe("Rule.or / Rule.and / Rule.not", () => {
  it("nested boolean", () => {
    const expr = Rule.or(
      Rule.field("x").eq(Rule.literal(1)),
      Rule.and(Rule.field("y").eq(Rule.literal(2)), Rule.field("z").neq(Rule.literal(3)))
    )
    expect(expr).toEqual({
      op: "or",
      left: { op: "eq", left: { kind: "field", field: "x" }, right: { kind: "literal", value: 1 } },
      right: {
        op: "and",
        left: { op: "eq", left: { kind: "field", field: "y" }, right: { kind: "literal", value: 2 } },
        right: { op: "neq", left: { kind: "field", field: "z" }, right: { kind: "literal", value: 3 } }
      }
    })
  })
})

describe("Rule.subquery", () => {
  it("produces subquery operand", () => {
    const Members: AnyCollectionDef = {
      name: "members",
      fields: {},
      schema: {
        "x-collection-kind": "base",
        type: "object",
        properties: {}
      }
    }
    const expr = Rule.subquery(Members, "teamId").where(Rule.field("userId").eq(Rule.authId(Users)))
    expect(expr).toEqual({
      kind: "subquery",
      collection: "members",
      field: "teamId",
      where: {
        op: "eq",
        left: { kind: "field", field: "userId" },
        right: { kind: "authId", collection: "users" }
      }
    })
  })

  it("produces subquery operand with typed callback", () => {
    const Members: AnyCollectionDef & { fields: FieldsMap } = {
      name: "members",
      fields: { userId: { _tag: "FieldDef", kind: "text" }, role: { _tag: "FieldDef", kind: "text" } },
      schema: {
        "x-collection-kind": "base",
        type: "object",
        properties: {}
      }
    }
    const expr = Rule.subquery(Members, "teamId").where(
      (Q) => Q.field("userId").eq(Rule.authId(Users))
    )
    expect(expr).toEqual({
      kind: "subquery",
      collection: "members",
      field: "teamId",
      where: {
        op: "eq",
        left: { kind: "field", field: "userId" },
        right: { kind: "authId", collection: "users" }
      }
    })
  })

  it("produces subquery operand with typed callback using nested boolean", () => {
    const Members: AnyCollectionDef & { fields: FieldsMap } = {
      name: "members",
      fields: { userId: { _tag: "FieldDef", kind: "text" }, role: { _tag: "FieldDef", kind: "text" } },
      schema: {
        "x-collection-kind": "base",
        type: "object",
        properties: {}
      }
    }
    const expr = Rule.subquery(Members, "teamId").where(
      (Q) => Rule.and(
        Q.field("userId").eq(Rule.authId(Users)),
        Q.field("role").in(Rule.literal(["admin", "owner"]))
      )
    )
    expect(expr).toEqual({
      kind: "subquery",
      collection: "members",
      field: "teamId",
      where: {
        op: "and",
        left: {
          op: "eq",
          left: { kind: "field", field: "userId" },
          right: { kind: "authId", collection: "users" }
        },
        right: {
          op: "in",
          left: { kind: "field", field: "role" },
          right: { kind: "literal", value: ["admin", "owner"] }
        }
      }
    })
  })
})

describe("Rule.auth chaining", () => {
  it("Rule.auth(Users, 'role').eq(Rule.literal('admin'))", () => {
    const expr = Rule.auth(Users, "role").eq(Rule.literal("admin"))
    expect(expr).toEqual({
      op: "eq",
      left: { kind: "auth", collection: "users", field: "role" },
      right: { kind: "literal", value: "admin" }
    })
  })

  it("Rule.auth(Users, 'id').in(Rule.literal(['a', 'b']))", () => {
    const expr = Rule.auth(Users, "id").in(Rule.literal(["a", "b"]))
    expect(expr).toEqual({
      op: "in",
      left: { kind: "auth", collection: "users", field: "id" },
      right: { kind: "literal", value: ["a", "b"] }
    })
  })
})

describe("Rule.request chaining", () => {
  it("Rule.request('header', 'x-role').eq(Rule.literal('admin'))", () => {
    const expr = Rule.request("header", "x-role").eq(Rule.literal("admin"))
    expect(expr).toEqual({
      op: "eq",
      left: { kind: "request", source: "header", key: "x-role" },
      right: { kind: "literal", value: "admin" }
    })
  })

  it("Rule.request('query', 'filter').contains(Rule.literal('term'))", () => {
    const expr = Rule.request("query", "filter").contains(Rule.literal("term"))
    expect(expr).toEqual({
      op: "contains",
      left: { kind: "request", source: "query", key: "filter" },
      right: { kind: "literal", value: "term" }
    })
  })

  it("Rule.request('body', 'email').neq(Rule.literal(''))", () => {
    const expr = Rule.request("body", "email").neq(Rule.literal(""))
    expect(expr).toEqual({
      op: "neq",
      left: { kind: "request", source: "body", key: "email" },
      right: { kind: "literal", value: "" }
    })
  })
})

describe("deeply nested boolean", () => {
  it("Rule.or(Rule.and(A, B), Rule.and(C, D)) — 3 levels", () => {
    const expr = Rule.or(
      Rule.and(Rule.field("a").eq(Rule.literal(1)), Rule.field("b").eq(Rule.literal(2))),
      Rule.and(Rule.field("c").eq(Rule.literal(3)), Rule.field("d").eq(Rule.literal(4)))
    )
    expect(expr).toEqual({
      op: "or",
      left: {
        op: "and",
        left: { op: "eq", left: { kind: "field", field: "a" }, right: { kind: "literal", value: 1 } },
        right: { op: "eq", left: { kind: "field", field: "b" }, right: { kind: "literal", value: 2 } }
      },
      right: {
        op: "and",
        left: { op: "eq", left: { kind: "field", field: "c" }, right: { kind: "literal", value: 3 } },
        right: { op: "eq", left: { kind: "field", field: "d" }, right: { kind: "literal", value: 4 } }
      }
    })
  })

  it("nested not(or(and)) — 4 levels", () => {
    const expr = Rule.not(
      Rule.or(
        Rule.field("x").eq(Rule.literal(1)),
        Rule.and(Rule.field("y").gt(Rule.literal(10)), Rule.field("z").lt(Rule.literal(100)))
      )
    )
    expect(expr).toEqual({
      op: "not",
      expr: {
        op: "or",
        left: { op: "eq", left: { kind: "field", field: "x" }, right: { kind: "literal", value: 1 } },
        right: {
          op: "and",
          left: { op: "gt", left: { kind: "field", field: "y" }, right: { kind: "literal", value: 10 } },
          right: { op: "lt", left: { kind: "field", field: "z" }, right: { kind: "literal", value: 100 } }
        }
      }
    })
  })
})

describe("complex subquery", () => {
  it("subquery with nested where (and)", () => {
    const Members: AnyCollectionDef = {
      name: "members",
      fields: {},
      schema: { "x-collection-kind": "base", type: "object", properties: {} }
    }
    const expr = Rule.subquery(Members, "teamId").where(
      Rule.and(Rule.field("userId").eq(Rule.authId(Users)), Rule.field("role").in(Rule.literal(["admin", "owner"])))
    )
    expect(expr).toEqual({
      kind: "subquery",
      collection: "members",
      field: "teamId",
      where: {
        op: "and",
        left: {
          op: "eq",
          left: { kind: "field", field: "userId" },
          right: { kind: "authId", collection: "users" }
        },
        right: {
          op: "in",
          left: { kind: "field", field: "role" },
          right: { kind: "literal", value: ["admin", "owner"] }
        }
      }
    })
  })

  it("subquery in rule expression", () => {
    const Members: AnyCollectionDef = {
      name: "members",
      fields: {},
      schema: { "x-collection-kind": "base", type: "object", properties: {} }
    }
    const expr = Rule.and(
      Rule.field("isPublic").eq(Rule.literal(true)),
      Rule.field("teamId").in(Rule.subquery(Members, "teamId").where(Rule.field("userId").eq(Rule.authId(Users))))
    )
    expect(expr).toEqual({
      op: "and",
      left: { op: "eq", left: { kind: "field", field: "isPublic" }, right: { kind: "literal", value: true } },
      right: {
        op: "in",
        left: { kind: "field", field: "teamId" },
        right: {
          kind: "subquery",
          collection: "members",
          field: "teamId",
          where: {
            op: "eq",
            left: { kind: "field", field: "userId" },
            right: { kind: "authId", collection: "users" }
          }
        }
      }
    })
  })
})

describe("RuleMap with multiple actions", () => {
  it("defines rules for list, view, create, update, delete", () => {
    const ruleMap = {
      list: Rule.public(),
      view: Rule.field("ownerId").eq(Rule.authId(Users)),
      create: Rule.field("ownerId").eq(Rule.authId(Users)),
      update: Rule.and(
        Rule.field("ownerId").eq(Rule.authId(Users)),
        Rule.field("status").neq(Rule.literal("archived"))
      ),
      delete: Rule.field("ownerId").eq(Rule.authId(Users))
    }
    expect(ruleMap.list).toEqual({ op: "public" })
    expect(ruleMap.view).toMatchObject({ op: "eq" })
    expect(ruleMap.create).toMatchObject({ op: "eq" })
    expect(ruleMap.update).toMatchObject({ op: "and" })
    expect(ruleMap.delete).toMatchObject({ op: "eq" })
  })
})

describe("operator combinations on field", () => {
  it("gt, gte, lt, lte all on same field", () => {
    const age = Rule.field("age")
    expect(age.gt(Rule.literal(18))).toMatchObject({ op: "gt" })
    expect(age.gte(Rule.literal(18))).toMatchObject({ op: "gte" })
    expect(age.lt(Rule.literal(65))).toMatchObject({ op: "lt" })
    expect(age.lte(Rule.literal(65))).toMatchObject({ op: "lte" })
  })

  it("startsWith and contains", () => {
    const title = Rule.field("title")
    expect(title.startsWith(Rule.literal("Hello"))).toMatchObject({ op: "startsWith" })
    expect(title.contains(Rule.literal("world"))).toMatchObject({ op: "contains" })
  })
})

describe("date helpers composition", () => {
  it("dateAdd(dateDiff(...), 1, 'day')", () => {
    const expr = Rule.dateAdd(Rule.dateDiff(Rule.field("created"), Rule.now(), "day"), 1, "day")
    expect(expr).toMatchObject({
      kind: "dateAdd",
      operand: { kind: "dateDiff" },
      amount: 1,
      unit: "day"
    })
  })

  it("dateDiff with dateAdd", () => {
    const expr = Rule.dateDiff(Rule.field("start"), Rule.dateAdd(Rule.field("start"), 7, "day"), "day")
    expect(expr).toMatchObject({
      kind: "dateDiff",
      left: { kind: "field", field: "start" },
      right: { kind: "dateAdd", operand: { kind: "field", field: "start" }, amount: 7 },
      unit: "day"
    })
  })
})

describe("Rule.public", () => {
  it("produces public marker", () => {
    expect(Rule.public()).toEqual({ op: "public" })
  })
})

describe("Rule.date helpers", () => {
  it("now", () => {
    expect(Rule.now()).toEqual({ kind: "now" })
  })
  it("dateAdd", () => {
    expect(Rule.dateAdd(Rule.now(), 7, "day")).toEqual({
      kind: "dateAdd",
      operand: { kind: "now" },
      amount: 7,
      unit: "day"
    })
  })
  it("dateDiff", () => {
    const expr = Rule.dateDiff(Rule.field("created"), Rule.now(), "day")
    expect(expr).toMatchObject({
      kind: "dateDiff",
      left: { kind: "field", field: "created" },
      right: { kind: "now" },
      unit: "day"
    })
  })
})

describe("Rule.request", () => {
  it("header", () => {
    expect(Rule.request("header", "x-api-key")).toMatchObject({
      kind: "request",
      source: "header",
      key: "x-api-key"
    })
  })
  it("query", () => {
    expect(Rule.request("query", "expand")).toMatchObject({
      kind: "request",
      source: "query",
      key: "expand"
    })
  })
})
