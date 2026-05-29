import { describe, expect, it } from "vitest"

import { Field } from "@/collection/field.js"
import { Index } from "@/collection/index-builder.js"
import { toJSONSchema } from "@/collection/serialize.js"
import type { AnyCollectionDef, FieldsMap } from "@/collection/types.js"
import { Rule } from "@/rule/builder.js"

const ID_PROPERTY = { type: "string", "x-system": true }
const SEQID_PROPERTY = { type: "integer", "x-kind": "seqId", "x-system": true, "x-hidden": true }

describe("serialize", () => {
  it("auto-injects id as system primary key before seqId", () => {
    const schema = toJSONSchema("base", "posts", { title: Field.text() }, {})
    const keys = Object.keys(schema.properties)
    expect(schema.properties.id).toEqual(ID_PROPERTY)
    expect(schema.properties.seqId).toEqual(SEQID_PROPERTY)
    expect(keys.indexOf("id")).toBe(0)
    expect(keys.indexOf("seqId")).toBe(1)
    expect(schema.required).not.toContain("id")
    expect(schema.required).not.toContain("seqId")
  })

  it("system fields id and seqId are not indexed", () => {
    const schema = toJSONSchema("base", "posts", { title: Field.text() }, {})

    expect(schema.required).toEqual(["title"])
    expect(schema).not.toHaveProperty("x-indexes")
  })

  it("text field with maxLength", () => {
    const schema = toJSONSchema(
      "base",
      "posts",
      {
        title: Field.text({ maxLength: 200 })
      },
      {}
    )

    expect(schema.properties.title).toEqual({ type: "string", maxLength: 200 })
    expect(schema.required).toContain("title")
  })

  it("field with default is not required", () => {
    const schema = toJSONSchema(
      "base",
      "posts",
      {
        published: Field.boolean({ default: false })
      },
      {}
    )

    expect(schema.required).toBeUndefined()
  })

  it("field with required:false is not required", () => {
    const schema = toJSONSchema(
      "base",
      "posts",
      {
        title: Field.text(),
        content: Field.text({ required: false })
      },
      {}
    )

    expect(schema.required).toEqual(["title"])
    expect(schema.required).not.toContain("content")
  })

  it("unique field produces x-indexes entry, not property annotation", () => {
    const schema = toJSONSchema(
      "base",
      "users",
      {
        email: Field.email({ unique: true })
      },
      {}
    )

    expect(schema["x-indexes"]).toEqual([{ fields: ["email"], unique: true }])
    expect(schema.properties.email).not.toHaveProperty("x-unique")
  })

  it("indexed field produces x-indexes entry", () => {
    const schema = toJSONSchema(
      "base",
      "posts",
      {
        status: Field.text({ indexed: true })
      },
      {}
    )

    expect(schema["x-indexes"]).toEqual([{ fields: ["status"], unique: false }])
  })

  it("collection-level indexes merged after field-level", () => {
    const schema = toJSONSchema(
      "base",
      "posts",
      {
        status: Field.text({ indexed: true }),
        userId: Field.text()
      },
      {
        indexes: [Index.unique("userId", "status")]
      }
    )

    expect(schema["x-indexes"]).toEqual([
      { fields: ["status"], unique: false },
      { fields: ["userId", "status"], unique: true }
    ])
  })

  it("name inferred from object key", () => {
    const schema = toJSONSchema(
      "base",
      "posts",
      {
        myTitle: Field.text()
      },
      {}
    )

    expect(schema.properties).toHaveProperty("myTitle")
  })

  it("relation field", () => {
    const Users: AnyCollectionDef = {
      name: "users",
      fields: {},
      schema: {
        "x-collection-kind": "base",
        type: "object",
        properties: {}
      }
    }
    const schema = toJSONSchema(
      "base",
      "posts",
      {
        userId: Field.relation(Users)
      },
      {}
    )

    expect(schema.properties.userId).toEqual({
      type: "string",
      "x-kind": "relation",
      "x-collection": "users",
      "x-field": "id"
    })
  })

  it("json field has no type", () => {
    const schema = toJSONSchema(
      "base",
      "posts",
      {
        tags: Field.json()
      },
      {}
    )

    expect(schema.properties.tags).toEqual({ "x-kind": "json" })
    expect(schema.properties.tags).not.toHaveProperty("type")
  })

  it("date field produces x-kind date", () => {
    const schema = toJSONSchema(
      "base",
      "posts",
      {
        createdAt: Field.date()
      },
      {}
    )

    expect(schema.properties.createdAt).toEqual({ type: "string", "x-kind": "date" })
  })

  it("email field produces format email", () => {
    const schema = toJSONSchema(
      "base",
      "posts",
      {
        author: Field.email()
      },
      {}
    )

    expect(schema.properties.author).toEqual({ type: "string", format: "email" })
  })

  it("serializes rules into x-rules", () => {
    const schema = toJSONSchema(
      "base",
      "posts",
      {
        title: Field.text()
      },
      {
        rules: {
          list: Rule.field("title").eq(Rule.literal("hello"))
        }
      }
    )
    expect(schema["x-rules"]).toEqual({
      list: {
        op: "eq",
        left: { kind: "field", field: "title" },
        right: { kind: "literal", value: "hello" }
      }
    })
  })

  it("no x-rules key when no rules", () => {
    const schema = toJSONSchema("base", "posts", {}, {})
    expect(schema).not.toHaveProperty("x-rules")
  })

  it("viewOnly field produces x-view-only in serialized property", () => {
    const usersColl: AnyCollectionDef = { name: "users", fields: {}, schema: { "x-collection-kind": "base", type: "object", properties: {} } }
    const schema = toJSONSchema("view", "active_posts", {
      id:       Field.text().view(),
      seqId:    Field.integer().view(),
      title:    Field.text().view(),
      authorId: Field.relation(usersColl).view()
    }, { viewQuery: "SELECT * FROM posts" })

    expect(schema.properties.id["x-view-only"]).toBe(true)
    expect(schema.properties.seqId["x-view-only"]).toBe(true)
    expect(schema.properties.title["x-view-only"]).toBe(true)
    expect(schema.properties.authorId["x-view-only"]).toBe(true)
  })

  it("view collection does not inject system id/seqId when not declared", () => {
    const schema = toJSONSchema("view", "active_posts", {
      title: Field.text().view()
    }, { viewQuery: "SELECT title FROM posts" })

    expect(schema.properties).not.toHaveProperty("id")
    expect(schema.properties).not.toHaveProperty("seqId")
    expect(schema.properties.title["x-view-only"]).toBe(true)
  })

  it("base collection system id/seqId do not have x-view-only", () => {
    const schema = toJSONSchema("base", "posts", {
      title: Field.text()
    }, {})

    expect(schema.properties.title).not.toHaveProperty("x-view-only")
    expect(schema.properties.id).not.toHaveProperty("x-view-only")
    expect(schema.properties.seqId).not.toHaveProperty("x-view-only")
  })
})
