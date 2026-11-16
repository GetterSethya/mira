import { describe, expect, it } from "vitest"

import type { CollectionSchema } from "../ui/src/lib/dashboard-api.js"
import {
  indexFindings,
  indexRows,
  ruleRows,
  schemaIndexes,
  templateSourceLabel,
  type RuleInspection
} from "../ui/src/lib/schema-inspection.js"

function baseSchema(overrides: Partial<CollectionSchema> = {}): CollectionSchema {
  return {
    name: "posts",
    kind: "base",
    fields: {
      id: { type: "string", "x-system": true, "x-generated": true },
      title: { type: "string" },
      ownerId: { type: "string" },
      published: { type: "boolean" },
      password: { type: "string", "x-hidden": true }
    },
    required: ["title"],
    ...overrides
  }
}

function authSchema(overrides: Partial<CollectionSchema> = {}): CollectionSchema {
  return {
    name: "users",
    kind: "auth",
    fields: {
      id: { type: "string", "x-system": true, "x-generated": true },
      email: { type: "string", format: "email", "x-system": true },
      password: { type: "string", "x-system": true, "x-hidden": true, "x-kind": "password" }
    },
    ...overrides
  }
}

function viewSchema(overrides: Partial<CollectionSchema> = {}): CollectionSchema {
  return {
    name: "publishedPosts",
    kind: "view",
    fields: {
      id: { type: "string", "x-view-only": true },
      title: { type: "string", "x-view-only": true }
    },
    ...overrides
  }
}

function rowFor(inspection: RuleInspection, action: string) {
  const row = inspection.rows.find((candidate) => candidate.action === action)
  if (row === undefined) throw new Error(`missing rule row for ${action}`)
  return row
}

describe("ruleRows", () => {
  it("reports missing rules as visible deny rows", () => {
    const inspection = ruleRows(baseSchema())

    expect(inspection.rulesReported).toBe(false)
    expect(inspection.rulesConfigured).toBe(false)
    expect(inspection.rows.map((row) => row.action)).toEqual(["list", "view", "create", "update", "delete"])
    for (const row of inspection.rows) {
      expect(row.kind).toBe("deny")
      expect(row.verdict).toBe("Denied — no rule")
      expect(row.raw).toBeNull()
    }
  })

  it("marks public rules as allowing everyone", () => {
    const inspection = ruleRows(baseSchema({ rules: { list: { op: "public" } } }))

    expect(inspection.rulesReported).toBe(true)
    expect(inspection.rulesConfigured).toBe(true)
    const list = rowFor(inspection, "list")
    expect(list.kind).toBe("public")
    expect(list.verdict).toBe("Public — allows everyone")
    expect(list.raw).toEqual({ op: "public" })
    expect(rowFor(inspection, "view").verdict).toBe("Denied — no rule")
  })

  it("labels simple expressions as restricted", () => {
    const inspection = ruleRows(
      baseSchema({
        rules: {
          view: {
            op: "eq",
            left: { kind: "field", field: "ownerId" },
            right: { kind: "authId", collection: "users" }
          }
        }
      })
    )

    const view = rowFor(inspection, "view")
    expect(view.kind).toBe("expr")
    expect(view.verdict).toBe("Restricted")
    expect(view.fields).toEqual(["ownerId"])
  })

  it("labels nested boolean conditions", () => {
    const inspection = ruleRows(
      baseSchema({
        rules: {
          view: {
            op: "and",
            left: {
              op: "eq",
              left: { kind: "field", field: "ownerId" },
              right: { kind: "authId", collection: "users" }
            },
            right: {
              op: "eq",
              left: { kind: "field", field: "published" },
              right: { kind: "literal", value: true }
            }
          }
        }
      })
    )

    const view = rowFor(inspection, "view")
    expect(view.kind).toBe("expr")
    expect(view.verdict).toBe("Nested condition")
    expect(view.fields).toEqual(["ownerId", "published"])
  })

  it("prefers server-computed summaries over local derivation", () => {
    const inspection = ruleRows(
      baseSchema({
        rules: {
          view: {
            op: "and",
            left: { op: "eq", left: { kind: "field", field: "ownerId" }, right: { kind: "literal", value: 1 } },
            right: { op: "eq", left: { kind: "field", field: "title" }, right: { kind: "literal", value: "x" } }
          }
        },
        ruleSummary: [{ action: "view", kind: "expr", fields: ["ownerId"] }]
      })
    )

    const view = rowFor(inspection, "view")
    expect(view.fields).toEqual(["ownerId"])
    expect(view.verdict).toBe("Nested condition")
  })

  it("adds the manage row for auth collections", () => {
    const inspection = ruleRows(authSchema({ rules: { list: { op: "public" }, manage: { op: "public" } } }))

    expect(inspection.rows.map((row) => row.action)).toEqual(["list", "view", "create", "update", "delete", "manage"])
    expect(rowFor(inspection, "manage").verdict).toBe("Public — allows everyone")
  })

  it("keeps view collections to list and view", () => {
    const inspection = ruleRows(viewSchema())

    expect(inspection.rows.map((row) => row.action)).toEqual(["list", "view"])
  })
})

describe("indexRows", () => {
  it("labels single, composite, unique, and system indexes", () => {
    const rows = indexRows(
      baseSchema({
        indexes: [
          { fields: ["ownerId"], unique: false },
          { fields: ["title", "ownerId"], unique: true },
          { fields: ["email"], unique: true, system: true }
        ]
      })
    )

    expect(rows.map((row) => row.kind)).toEqual(["single", "composite", "single"])
    expect(rows[0]?.unique).toBe(false)
    expect(rows[1]?.unique).toBe(true)
    expect(rows[2]?.system).toBe(true)
  })

  it("reports no rows when the server omits indexes", () => {
    expect(indexRows(baseSchema())).toEqual([])
  })
})

describe("indexFindings", () => {
  it("reports unknown fields", () => {
    const findings = indexFindings(baseSchema(), { fields: ["nope"], unique: false })

    expect(findings).toEqual(["Unknown field `nope` — this collection has no such field."])
  })

  it("reports references to hidden fields", () => {
    const findings = indexFindings(baseSchema(), { fields: ["password"], unique: false })

    expect(findings).toEqual(["References hidden field `password`."])
  })

  it("reports duplicate indexes", () => {
    const schema = baseSchema({
      indexes: [
        { fields: ["title"], unique: false },
        { fields: ["title"], unique: false }
      ]
    })
    const first = schemaIndexes(schema)[0]
    if (first === undefined) throw new Error("expected an index")

    expect(indexFindings(schema, first)).toContain("Duplicate index — another index covers the same fields.")
  })

  it("reports redundant left prefixes", () => {
    const schema = baseSchema({
      indexes: [
        { fields: ["title"], unique: false },
        { fields: ["title", "ownerId"], unique: false }
      ]
    })
    const composite = schemaIndexes(schema)[1]
    if (composite === undefined) throw new Error("expected a composite index")

    expect(indexFindings(schema, composite)).toContain("Redundant left prefix — an index on (title) already covers it.")
  })

  it("returns nothing for a clean index", () => {
    const schema = baseSchema({ indexes: [{ fields: ["ownerId"], unique: false }] })
    const index = schemaIndexes(schema)[0]
    if (index === undefined) throw new Error("expected an index")

    expect(indexFindings(schema, index)).toEqual([])
  })
})

describe("templateSourceLabel", () => {
  it("labels each template source", () => {
    expect(templateSourceLabel("builtin")).toBe("Built-in")
    expect(templateSourceLabel("global")).toBe("Global override")
    expect(templateSourceLabel("collection")).toBe("Collection override")
  })
})
