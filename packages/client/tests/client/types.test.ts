import { describe, expect, it } from "vitest"

import type { AnyCollectionDef, FieldDef } from "@gettersethya/mira-collection"
import { Field } from "@gettersethya/mira-collection"
import type { FilterBuilder } from "@/client/collection.js"
import type { InferRecord, InferCreateInput, WithExpand, RelationKeys } from "@/client/types.js"

describe("InferRecord", () => {
  it("has correct field types and system fields", () => {
    type F = {
      title: { _tag: "FieldDef"; kind: "text"; required: true }
      count: { _tag: "FieldDef"; kind: "integer"; required: true }
      active: { _tag: "FieldDef"; kind: "boolean"; required: true }
      email: { _tag: "FieldDef"; kind: "email"; required: true }
      meta: { _tag: "FieldDef"; kind: "json"; required: true }
      due: { _tag: "FieldDef"; kind: "date"; required: true }
    }

    type Rec = InferRecord<F>

    const _rec: Rec = {
      id: "abc",
      created: "2024-01-01",
      updated: "2024-01-02",
      title: "hello",
      count: 42,
      active: true,
      email: "a@b.com",
      meta: null,
      due: "2024-06-01"
    }

    expect(_rec.id).toBe("abc")
    expect(_rec.title).toBe("hello")
    expect(_rec.count).toBe(42)
  })

  it("excludes seqId from InferRecord", () => {
    type F = {
      title: { _tag: "FieldDef"; kind: "text"; required: true }
      seqId: { _tag: "FieldDef"; kind: "seqId"; required: true }
    }

    type Rec = InferRecord<F>

    const _rec: Rec = {
      id: "abc",
      created: "2024-01-01",
      updated: "2024-01-02",
      title: "hello"
    }

    expect(_rec).not.toHaveProperty("seqId")
  })

  it("optional fields are T | null", () => {
    type F = {
      title: { _tag: "FieldDef"; kind: "text"; required: true }
      subtitle: { _tag: "FieldDef"; kind: "text"; required: false }
    }

    type Rec = InferRecord<F>

    const _rec: Rec = {
      id: "abc",
      created: "2024-01-01",
      updated: "2024-01-02",
      title: "hello",
      subtitle: null
    }

    expect(_rec.subtitle).toBeNull()
  })
})

describe("InferCreateInput", () => {
  it("omits system fields, preserves required/optional shape", () => {
    type F = {
      title: { _tag: "FieldDef"; kind: "text"; required: true }
      subtitle: { _tag: "FieldDef"; kind: "text"; required: false }
    }

    type Input = InferCreateInput<F>

    const _input: Input = {
      title: "hello",
      subtitle: null
    }

    expect(_input.title).toBe("hello")
  })
})

describe("WithExpand", () => {
  it("without expand arg produces no expand property", () => {
    type F = {
      title: { _tag: "FieldDef"; kind: "text"; required: true }
    }

    type Rec = WithExpand<F, []>

    const _rec: Rec = {
      id: "abc",
      created: "2024-01-01",
      updated: "2024-01-02",
      title: "hello"
    }

    expect(_rec).not.toHaveProperty("expand")
  })

  it("with expand produces typed expand.fieldName", () => {
    const Users: AnyCollectionDef = {
      name: "users",
      fields: {
        name: Field.text()
      },
      schema: {
        "x-collection-kind": "auth",
        type: "object",
        properties: {}
      }
    }

    type F = {
      title: { _tag: "FieldDef"; kind: "text"; required: true }
      ownerId: { _tag: "FieldDef"; kind: "relation"; required: true; _target: typeof Users }
    }

    type Rec = WithExpand<F, ["ownerId"]>

    const _rec: Rec = {
      id: "abc",
      created: "2024-01-01",
      updated: "2024-01-02",
      title: "hello",
      ownerId: "user-123",
      expand: {
        ownerId: {
          id: "user-123",
          created: "2024-01-01",
          updated: "2024-01-02",
          name: "Alice"
        }
      }
    }

    expect(_rec.expand.ownerId.name).toBe("Alice")
  })
})

describe("RelationKeys", () => {
  it("extracts only relation field keys", () => {
    const Users: AnyCollectionDef = {
      name: "users",
      fields: {},
      schema: { "x-collection-kind": "auth", type: "object", properties: {} }
    }

    type F = {
      title: { _tag: "FieldDef"; kind: "text"; required: true }
      ownerId: { _tag: "FieldDef"; kind: "relation"; required: true; _target: typeof Users }
      tags: { _tag: "FieldDef"; kind: "text"; required: true }
    }

    type Keys = RelationKeys<F>
    const _keys: Keys = "ownerId"
    expect(_keys).toBe("ownerId")
  })
})

describe("FilterBuilder value types", () => {
  type TestFields = {
    title:    FieldDef & { kind: "text" }
    count:    FieldDef & { kind: "integer" }
    score:    FieldDef & { kind: "number" }
    active:   FieldDef & { kind: "boolean" }
    authorId: FieldDef & { kind: "relation" }
  }

  it("text field: eq accepts string", () => {
    const _ok = (f: FilterBuilder<TestFields>) => f.field("title").eq("hello")
    expect(_ok).toBeDefined()
  })

  it("text field: eq rejects number", () => {
    const _bad = (f: FilterBuilder<TestFields>) => {
      // @ts-expect-error number is not assignable to string
      f.field("title").eq(42)
    }
    expect(_bad).toBeDefined()
  })

  it("integer field: eq accepts number", () => {
    const _ok = (f: FilterBuilder<TestFields>) => f.field("count").eq(42)
    expect(_ok).toBeDefined()
  })

  it("integer field: eq rejects string", () => {
    const _bad = (f: FilterBuilder<TestFields>) => {
      // @ts-expect-error string is not assignable to number
      f.field("count").eq("not-a-number")
    }
    expect(_bad).toBeDefined()
  })

  it("boolean field: eq accepts boolean", () => {
    const _ok = (f: FilterBuilder<TestFields>) => f.field("active").eq(true)
    expect(_ok).toBeDefined()
  })

  it("boolean field: eq rejects number", () => {
    const _bad = (f: FilterBuilder<TestFields>) => {
      // @ts-expect-error number is not assignable to boolean
      f.field("active").eq(1)
    }
    expect(_bad).toBeDefined()
  })

  it("relation field: eq accepts string", () => {
    const _ok = (f: FilterBuilder<TestFields>) => f.field("authorId").eq("user-123")
    expect(_ok).toBeDefined()
  })

  it("relation field: eq rejects number", () => {
    const _bad = (f: FilterBuilder<TestFields>) => {
      // @ts-expect-error number is not assignable to string
      f.field("authorId").eq(123)
    }
    expect(_bad).toBeDefined()
  })

  it("in() accepts array of the correct type", () => {
    const _ok = (f: FilterBuilder<TestFields>) => f.field("count").in([1, 2, 3])
    expect(_ok).toBeDefined()
  })

  it("in() rejects array of wrong type", () => {
    const _bad = (f: FilterBuilder<TestFields>) => {
      // @ts-expect-error string[] is not assignable to number[]
      f.field("count").in(["a", "b"])
    }
    expect(_bad).toBeDefined()
  })

  it("between() accepts values of the correct type", () => {
    const _ok = (f: FilterBuilder<TestFields>) => f.field("score").between(1.5, 9.9)
    expect(_ok).toBeDefined()
  })

  it("between() rejects values of wrong type", () => {
    const _bad = (f: FilterBuilder<TestFields>) => {
      // @ts-expect-error string is not assignable to number
      f.field("score").between("low", "high")
    }
    expect(_bad).toBeDefined()
  })
})
