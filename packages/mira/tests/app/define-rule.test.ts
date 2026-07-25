import { describe, expect, it } from "vitest"
import { BaseCollection, AuthCollection, ViewCollection, Field } from "@gettersethya/mira-client"
import { Rule } from "@gettersethya/mira-client"
import { defineRule, applyRulesToCollections } from "@/app/index.js"

const Posts = BaseCollection.define("posts", {
  title: Field.text({ maxLength: 200 }),
})
const Users = AuthCollection.define("users", {
  name: Field.text(),
})
const ActivePosts = ViewCollection.define(
  "active_posts",
  "SELECT id, seqId, title FROM posts WHERE status = 'active'",
  {
    id: Field.text().view(),
    seqId: Field.integer().view(),
    title: Field.text().view(),
  }
)

describe("defineRule", () => {
  it("returns RuleBinding with correct collectionName", () => {
    const rb = defineRule(Posts, (R) => ({ list: R.public() }))
    expect(rb._tag).toBe("RuleBinding")
    expect(rb.collectionName).toBe("posts")
    expect(rb.ruleMap).toBeDefined()
  })

  it("ruleMap contains the rules returned by callback", () => {
    const rb = defineRule(Posts, (R) => ({
      list: R.public(),
      view: R.field("title").eq(R.literal("hello")),
    }))
    expect(rb.ruleMap.list).toEqual({ op: "public" })
    expect(rb.ruleMap.view).toEqual({
      op: "eq",
      left: { kind: "field", field: "title" },
      right: { kind: "literal", value: "hello" },
    })
  })

  it("callback receives RuleBuilder with collection fields", () => {
    const rb = defineRule(Posts, (R) => {
      const op = R.field("title")
      expect(op).toMatchObject({ kind: "field", field: "title" })
      return {}
    })
    expect(rb._tag).toBe("RuleBinding")
  })

  it("callback receives system fields on base collection", () => {
    defineRule(Posts, (R) => {
      expect(R.field("id")).toMatchObject({ kind: "field", field: "id" })
      expect(R.field("created")).toMatchObject({ kind: "field", field: "created" })
      expect(R.field("updated")).toMatchObject({ kind: "field", field: "updated" })
      expect(R.field("seqId")).toMatchObject({ kind: "field", field: "seqId" })
      return {}
    })
  })

  it("callback receives auth system fields on auth collection", () => {
    defineRule(Users, (R) => {
      expect(R.field("email")).toMatchObject({ kind: "field", field: "email" })
      expect(R.field("emailVerified")).toMatchObject({ kind: "field", field: "emailVerified" })
      return {}
    })
  })

  it("selfId() available for auth collections", () => {
    defineRule(Users, (R) => {
      expect(R.selfId()).toMatchObject({ kind: "authId", collection: "users" })
      return {}
    })
  })

  it("empty callback returns empty RuleMap", () => {
    const rb = defineRule(Posts, () => ({}))
    expect(rb.ruleMap).toEqual({})
  })

  it("view collection gets base system fields", () => {
    defineRule(ActivePosts, (R) => {
      const idOp = R.field("id")
      const seqIdOp = R.field("seqId")
      expect(idOp.kind).toBe("field")
      expect(seqIdOp.kind).toBe("field")
      return {}
    })
  })
})

describe("applyRulesToCollections", () => {
  it("merges rules into matching collection schema", () => {
    const rb = defineRule(Posts, (R) => ({ list: R.public() }))
    const [merged] = applyRulesToCollections([Posts], [rb])
    expect(merged.schema["x-rules"]).toBeDefined()
    expect(merged.schema["x-rules"]!.list).toEqual({ op: "public" })
  })

  it("collection without RuleBinding has no x-rules", () => {
    const merged = applyRulesToCollections([Posts, Users], [])
    expect(merged[0]!.schema).not.toHaveProperty("x-rules")
    expect(merged[1]!.schema).not.toHaveProperty("x-rules")
  })

  it("no rules array at all — all collections have no x-rules", () => {
    const merged = applyRulesToCollections([Posts, Users], [])
    for (const c of merged) {
      expect(c.schema).not.toHaveProperty("x-rules")
    }
  })

  it("RuleBinding for unknown collection name throws", () => {
    const rb = defineRule(Posts, (R) => ({ list: R.public() }))
    const unknown = { ...rb, collectionName: "nonexistent" }
    expect(() => applyRulesToCollections([Posts], [unknown])).toThrow(
      'RuleBinding references unknown collection "nonexistent"'
    )
  })

  it("returns a new array with original collections unmodified", () => {
    const rb = defineRule(Posts, (R) => ({ list: R.public() }))
    const merged = applyRulesToCollections([Posts], [rb])
    expect(merged).not.toBe([Posts] as any)
    expect(Posts.schema).not.toHaveProperty("x-rules")
  })
})
