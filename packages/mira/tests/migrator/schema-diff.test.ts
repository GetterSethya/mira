import { describe, expect, it } from "vitest"
import type { CollectionSchema } from "@gettersethya/mira-client"
import { computePlan, diffSchemas, propertyToColumnType, schemaToColumns } from "@/migrator/schema-diff.js"
import type { NamedSchema } from "@/migrator/types.js"

describe("propertyToColumnType", () => {
  it("maps string to text", () => {
    expect(propertyToColumnType({ type: "string" })).toBe("text")
  })

  it("maps email string to text", () => {
    expect(propertyToColumnType({ type: "string", format: "email" })).toBe("text")
  })

  it("maps integer to integer", () => {
    expect(propertyToColumnType({ type: "integer" })).toBe("integer")
  })

  it("maps number to real", () => {
    expect(propertyToColumnType({ type: "number" })).toBe("real")
  })

  it("maps boolean to boolean", () => {
    expect(propertyToColumnType({ type: "boolean" })).toBe("boolean")
  })

  it("maps seqId to integer", () => {
    expect(propertyToColumnType({ type: "integer", "x-kind": "seqId", "x-system": true })).toBe("integer")
  })
})

describe("schemaToColumns", () => {
  it("includes all properties in order", () => {
    const schema: CollectionSchema = {
      "x-collection-kind": "base",
      type: "object",
      properties: {
        seqId: { type: "integer", "x-kind": "seqId", "x-system": true },
        title: { type: "string" },
        count: { type: "integer" }
      },
      required: ["title"]
    }
    const columns = schemaToColumns(schema)
    expect(columns).toEqual([
      { name: "seqId", type: "integer", nullable: false, xSystem: true, xKind: "seqId", primaryKey: true, autoIncrement: true },
      { name: "title", type: "text", nullable: false },
      { name: "count", type: "integer", nullable: true }
    ])
  })

  it("sets nullable:true for fields not in required", () => {
    const schema: CollectionSchema = {
      "x-collection-kind": "base",
      type: "object",
      properties: {
        seqId: { type: "integer", "x-kind": "seqId", "x-system": true },
        title: { type: "string" },
        content: { type: "string" }
      },
      required: ["title"]
    }
    const cols = schemaToColumns(schema)
    expect(cols.find((c) => c.name === "content")!.nullable).toBe(true)
    expect(cols.find((c) => c.name === "title")!.nullable).toBe(false)
  })
})

describe("diffSchemas", () => {
  it("createTable when stored is null", () => {
    const schema: CollectionSchema = {
      "x-collection-kind": "base",
      type: "object",
      properties: {
        seqId: { type: "integer", "x-kind": "seqId", "x-system": true },
        title: { type: "string" }
      },
      required: ["title"]
    }
    const steps = diffSchemas("posts", null, schema)
    expect(steps).toHaveLength(1)
    expect(steps[0].kind).toBe("createTable")
  })

  it("no changes when schemas match", () => {
    const schema: CollectionSchema = {
      "x-collection-kind": "base",
      type: "object",
      properties: { seqId: { type: "integer", "x-kind": "seqId", "x-system": true }, title: { type: "string" } },
      required: ["title"]
    }
    const steps = diffSchemas("posts", schema, schema)
    expect(steps).toEqual([])
  })

  it("detects added column", () => {
    const stored: CollectionSchema = {
      "x-collection-kind": "base",
      type: "object",
      properties: { seqId: { type: "integer", "x-kind": "seqId", "x-system": true }, title: { type: "string" } },
      required: ["title"]
    }
    const desired: CollectionSchema = {
      "x-collection-kind": "base",
      type: "object",
      properties: {
        seqId: { type: "integer", "x-kind": "seqId", "x-system": true },
        title: { type: "string" },
        published: { type: "boolean", default: false }
      },
      required: ["title"]
    }
    const steps = diffSchemas("posts", stored, desired)
    expect(steps).toHaveLength(1)
    expect(steps[0]).toMatchObject({ kind: "addColumn", table: "posts" })
  })

  it("detects removed column", () => {
    const stored: CollectionSchema = {
      "x-collection-kind": "base",
      type: "object",
      properties: {
        seqId: { type: "integer", "x-kind": "seqId", "x-system": true },
        title: { type: "string" },
        obsolete: { type: "string" }
      },
      required: ["title"]
    }
    const desired: CollectionSchema = {
      "x-collection-kind": "base",
      type: "object",
      properties: { seqId: { type: "integer", "x-kind": "seqId", "x-system": true }, title: { type: "string" } },
      required: ["title"]
    }
    const steps = diffSchemas("posts", stored, desired)
    expect(steps).toHaveLength(1)
    expect(steps[0]).toMatchObject({ kind: "dropColumn", table: "posts", column: "obsolete" })
  })

  it("detects changed column type", () => {
    const stored: CollectionSchema = {
      "x-collection-kind": "base",
      type: "object",
      properties: { seqId: { type: "integer", "x-kind": "seqId", "x-system": true }, price: { type: "integer" } },
      required: []
    }
    const desired: CollectionSchema = {
      "x-collection-kind": "base",
      type: "object",
      properties: { seqId: { type: "integer", "x-kind": "seqId", "x-system": true }, price: { type: "number" } },
      required: []
    }
    const steps = diffSchemas("products", stored, desired)
    expect(steps).toHaveLength(1)
    expect(steps[0]).toMatchObject({ kind: "alterColumn", table: "products" })
  })

  it("detects added index", () => {
    const stored: CollectionSchema = {
      "x-collection-kind": "base",
      type: "object",
      properties: {
        seqId: { type: "integer", "x-kind": "seqId", "x-system": true },
        email: { type: "string", format: "email" }
      }
    }
    const desired: CollectionSchema = {
      "x-collection-kind": "base",
      type: "object",
      properties: {
        seqId: { type: "integer", "x-kind": "seqId", "x-system": true },
        email: { type: "string", format: "email" }
      },
      "x-indexes": [{ fields: ["email"], unique: true }]
    }
    const steps = diffSchemas("users", stored, desired)
    expect(steps).toHaveLength(1)
    expect(steps[0]).toMatchObject({ kind: "createIndex", table: "users", fields: ["email"], unique: true })
  })

  it("detects removed index", () => {
    const stored: CollectionSchema = {
      "x-collection-kind": "base",
      type: "object",
      properties: { seqId: { type: "integer", "x-kind": "seqId", "x-system": true }, status: { type: "string" } },
      "x-indexes": [{ fields: ["status"], unique: false }]
    }
    const desired: CollectionSchema = {
      "x-collection-kind": "base",
      type: "object",
      properties: { seqId: { type: "integer", "x-kind": "seqId", "x-system": true }, status: { type: "string" } }
    }
    const steps = diffSchemas("items", stored, desired)
    expect(steps).toHaveLength(1)
    expect(steps[0]).toMatchObject({ kind: "dropIndex", table: "items" })
  })

  it("does not drop x-system columns", () => {
    const stored: CollectionSchema = {
      "x-collection-kind": "auth",
      type: "object",
      properties: {
        seqId: { type: "integer", "x-kind": "seqId", "x-system": true },
        email: { type: "string", format: "email", "x-system": true },
        displayName: { type: "string" }
      },
      required: ["email"]
    }
    const desired: CollectionSchema = {
      "x-collection-kind": "auth",
      type: "object",
      properties: {
        seqId: { type: "integer", "x-kind": "seqId", "x-system": true },
        email: { type: "string", format: "email", "x-system": true }
      },
      required: ["email"]
    }
    const steps = diffSchemas("users", stored, desired)
    expect(steps).toHaveLength(1)
    expect(steps[0]).toMatchObject({ kind: "dropColumn", table: "users", column: "displayName" })
  })
})

describe("schemaToColumns x-view-only", () => {
  it("filters out x-view-only fields", () => {
    const schema: CollectionSchema = {
      "x-collection-kind": "view",
      type: "object",
      properties: {
        id:    { type: "string", "x-view-only": true },
        seqId: { type: "integer", "x-kind": "seqId", "x-view-only": true },
        title: { type: "string", "x-view-only": true }
      }
    }
    const columns = schemaToColumns(schema)
    expect(columns).toEqual([])
  })

  it("x-view-only properties do not mask physical columns", () => {
    const schema: CollectionSchema = {
      "x-collection-kind": "base",
      type: "object",
      properties: {
        seqId: { type: "integer", "x-kind": "seqId", "x-system": true },
        title: { type: "string" },
        computed: { type: "integer", "x-view-only": true }
      },
      required: ["title"]
    }
    const columns = schemaToColumns(schema)
    expect(columns).toHaveLength(2)
    expect(columns.map((c) => c.name)).toEqual(["seqId", "title"])
  })
})

describe("diffSchemas — view collections", () => {
  const viewSchema: CollectionSchema = {
    "x-collection-kind": "view",
    "x-view-query": "SELECT id, seqId, title FROM posts",
    type: "object",
    properties: {
      id:    { type: "string",  "x-view-only": true },
      seqId: { type: "integer", "x-view-only": true },
      title: { type: "string",  "x-view-only": true }
    }
  }

  it("new view (no stored schema) produces createView", () => {
    const steps = diffSchemas("active_posts", null, viewSchema)
    expect(steps).toEqual([
      { kind: "createView", view: "active_posts", query: "SELECT id, seqId, title FROM posts" }
    ])
  })

  it("unchanged view produces no steps", () => {
    const steps = diffSchemas("active_posts", viewSchema, viewSchema)
    expect(steps).toEqual([])
  })

  it("changed query produces dropView then createView", () => {
    const updated: CollectionSchema = {
      ...viewSchema,
      "x-view-query": "SELECT id, seqId, title FROM posts WHERE published = 1"
    }
    const steps = diffSchemas("active_posts", viewSchema, updated)
    expect(steps).toEqual([
      { kind: "dropView",   view: "active_posts" },
      { kind: "createView", view: "active_posts", query: "SELECT id, seqId, title FROM posts WHERE published = 1" }
    ])
  })

  it("orphaned view in computePlan emits dropView, not dropTable", () => {
    const plan = computePlan([], { active_posts: viewSchema }, { allowDestructive: true })
    expect(plan.steps).toEqual([{ kind: "dropView", view: "active_posts" }])
  })

  it("dropView does not set destructive flag", () => {
    const plan = computePlan([], { active_posts: viewSchema }, { allowDestructive: true })
    expect(plan.destructive).toBe(false)
  })
})

describe("computePlan", () => {
  it("produces createTable for new schema", () => {
    const schemas: NamedSchema[] = [
      {
        name: "posts",
        schema: {
          "x-collection-kind": "base",
          type: "object",
          properties: {
            seqId: { type: "integer", "x-kind": "seqId", "x-system": true },
            title: { type: "string" }
          },
          required: ["title"]
        }
      }
    ]
    const plan = computePlan(schemas, {})
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0].kind).toBe("createTable")
    expect(plan.destructive).toBe(false)
  })

  it("detects orphaned tables when allowDestructive", () => {
    const stored: Record<string, CollectionSchema> = {
      old_table: {
        "x-collection-kind": "base",
        type: "object",
        properties: { id: { type: "string" } }
      }
    }
    const plan = computePlan([], stored, { allowDestructive: true })
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0].kind).toBe("dropTable")
    expect(plan.destructive).toBe(true)
  })

  it("does not drop orphaned tables without allowDestructive", () => {
    const stored: Record<string, CollectionSchema> = {
      old_table: {
        "x-collection-kind": "base",
        type: "object",
        properties: { id: { type: "string" } }
      }
    }
    const plan = computePlan([], stored)
    expect(plan.steps).toEqual([])
    expect(plan.destructive).toBe(false)
  })
})
