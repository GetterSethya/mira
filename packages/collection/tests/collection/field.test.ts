import { describe, expect, it } from "vitest"

import { Field } from "@/collection/field.js"
import type { AnyCollectionDef, FieldsMap } from "@/collection/types.js"

function mockCollection(name: string, fields: FieldsMap): AnyCollectionDef {
  return {
    name,
    fields,
    schema: {
      "x-collection-kind": "base",
      type: "object",
      properties: {}
    }
  }
}

describe("Field.text", () => {
  it("defaults", () => {
    const f = Field.text()
    expect(f).toMatchObject({ _tag: "FieldDef", kind: "text" })
    expect(f.required).toBeUndefined()
    expect(f.unique).toBeUndefined()
  })
  it("with options", () => {
    const f = Field.text({ maxLength: 100, unique: true })
    expect(f).toMatchObject({ kind: "text", maxLength: 100, unique: true })
  })
})

describe("Field.number", () => {
  it("defaults", () => {
    const f = Field.number()
    expect(f).toMatchObject({ _tag: "FieldDef", kind: "number" })
  })
  it("with min/max", () => {
    const f = Field.number({ min: 0, max: 100 })
    expect(f).toMatchObject({ kind: "number", min: 0, max: 100 })
  })
})

describe("Field.integer", () => {
  it("defaults", () => {
    const f = Field.integer()
    expect(f).toMatchObject({ _tag: "FieldDef", kind: "integer" })
  })
})

describe("Field.boolean", () => {
  it("defaults", () => {
    const f = Field.boolean()
    expect(f).toMatchObject({ _tag: "FieldDef", kind: "boolean" })
  })
  it("with default", () => {
    const f = Field.boolean({ default: true })
    expect(f).toMatchObject({ kind: "boolean", default: true })
  })
})

describe("Field.date", () => {
  it("defaults", () => {
    const f = Field.date()
    expect(f).toMatchObject({ _tag: "FieldDef", kind: "date" })
  })
})

describe("Field.email", () => {
  it("defaults", () => {
    const f = Field.email()
    expect(f).toMatchObject({ _tag: "FieldDef", kind: "email" })
  })
})

describe("Field.json", () => {
  it("defaults", () => {
    const f = Field.json()
    expect(f).toMatchObject({ _tag: "FieldDef", kind: "json" })
  })
})

describe("Field.file", () => {
  it("defaults", () => {
    const f = Field.file()
    expect(f).toMatchObject({ _tag: "FieldDef", kind: "file" })
  })
  it("with maxSize and mimeTypes", () => {
    const f = Field.file({ maxSize: 1024, mimeTypes: ["image/png"] })
    expect(f).toMatchObject({ kind: "file", maxSize: 1024, mimeTypes: ["image/png"] })
  })
})

describe("Field.seqId", () => {
  it("defaults", () => {
    const f = Field.seqId()
    expect(f).toMatchObject({ _tag: "FieldDef", kind: "seqId" })
    expect(f.required).toBeUndefined()
  })
})

describe("Field.view()", () => {
  it("text field can be marked view-only", () => {
    const f = Field.text().view()
    expect(f._tag).toBe("FieldDef")
    expect(f.kind).toBe("text")
    expect(f.viewOnly).toBe(true)
  })

  it("view-only preserves builder options", () => {
    const f = Field.text({ maxLength: 200 }).view()
    expect(f.maxLength).toBe(200)
    expect(f.viewOnly).toBe(true)
  })

  it("integer field can be marked view-only", () => {
    const f = Field.integer({ min: 0, max: 999 }).view()
    expect(f.viewOnly).toBe(true)
    expect(f.min).toBe(0)
  })

  it("relation field can be marked view-only", () => {
    const col: AnyCollectionDef = { name: "users", fields: {}, schema: { "x-collection-kind": "base", type: "object", properties: {} } }
    const f = Field.relation(col).view()
    expect(f.viewOnly).toBe(true)
    expect(f.kind).toBe("relation")
    expect(f.targetCollection).toBe("users")
  })

  it("boolean default preserved after .view()", () => {
    const f = Field.boolean({ default: true }).view()
    expect(f.default).toBe(true)
    expect(f.viewOnly).toBe(true)
  })

  it("Field.seqId does not expose .view()", () => {
    const f = Field.seqId()
    expect((f as any).view).toBeUndefined()
    expect(f.viewOnly).toBeUndefined()
  })

  it("view() returns a new object, does not mutate", () => {
    const base = Field.text()
    const viewed = base.view()
    expect(base.viewOnly).toBeUndefined()
    expect(viewed.viewOnly).toBe(true)
  })
})

describe("Field.relation", () => {
  it("resolves collection name at call time", () => {
    const Users = mockCollection("users", { email: Field.email() })
    const f = Field.relation(Users)
    expect(f).toMatchObject({ kind: "relation", targetCollection: "users", targetField: "id" })
  })
  it("accepts explicit field", () => {
    const Users = mockCollection("users", { email: Field.email() })
    const f = Field.relation(Users, { field: "email" })
    expect(f.targetField).toBe("email")
  })
})
