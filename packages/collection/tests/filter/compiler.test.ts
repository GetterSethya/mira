import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { filterNodeToWhereClause } from "@/filter/compiler.js"
import { Filter } from "@/filter/builder.js"
import type { FilterNode } from "@/filter/types.js"
import type { CollectionSchema } from "@/collection/types.js"
import { ValidationError } from "@/collection/errors.js"

const testSchema: CollectionSchema = {
  "x-collection-kind": "base",
  type: "object",
  properties: {
    title: { type: "string" },
    age: { type: "integer" },
    score: { type: "number" },
    published: { type: "boolean" },
    email: { type: "string", format: "email" }
  },
  required: ["title"]
}

describe("filterNodeToWhereClause", () => {
  it("eq produces correct SQL and params", () =>
    Effect.gen(function* () {
      const node: FilterNode = { op: "eq", field: "title", value: "hello" }
      const result = yield* filterNodeToWhereClause(node, testSchema, "testCollection")
      expect(result.sql).toBe('t."title" = ?')
      expect(result.params).toEqual(["hello"])
    }).pipe(Effect.runPromise))

  it("neq produces correct SQL and params", () =>
    Effect.gen(function* () {
      const node: FilterNode = { op: "neq", field: "title", value: "bye" }
      const result = yield* filterNodeToWhereClause(node, testSchema, "testCollection")
      expect(result.sql).toBe('t."title" != ?')
      expect(result.params).toEqual(["bye"])
    }).pipe(Effect.runPromise))

  it("gt produces correct SQL and params", () =>
    Effect.gen(function* () {
      const node: FilterNode = { op: "gt", field: "age", value: 18 }
      const result = yield* filterNodeToWhereClause(node, testSchema, "testCollection")
      expect(result.sql).toBe('t."age" > ?')
      expect(result.params).toEqual([18])
    }).pipe(Effect.runPromise))

  it("gte produces correct SQL and params", () =>
    Effect.gen(function* () {
      const node: FilterNode = { op: "gte", field: "score", value: 90.5 }
      const result = yield* filterNodeToWhereClause(node, testSchema, "testCollection")
      expect(result.sql).toBe('t."score" >= ?')
      expect(result.params).toEqual([90.5])
    }).pipe(Effect.runPromise))

  it("lt produces correct SQL and params", () =>
    Effect.gen(function* () {
      const node: FilterNode = { op: "lt", field: "age", value: 65 }
      const result = yield* filterNodeToWhereClause(node, testSchema, "testCollection")
      expect(result.sql).toBe('t."age" < ?')
      expect(result.params).toEqual([65])
    }).pipe(Effect.runPromise))

  it("lte produces correct SQL and params", () =>
    Effect.gen(function* () {
      const node: FilterNode = { op: "lte", field: "age", value: 30 }
      const result = yield* filterNodeToWhereClause(node, testSchema, "testCollection")
      expect(result.sql).toBe('t."age" <= ?')
      expect(result.params).toEqual([30])
    }).pipe(Effect.runPromise))

  it("in produces correct IN clause", () =>
    Effect.gen(function* () {
      const node: FilterNode = { op: "in", field: "title", values: ["a", "b", "c"] }
      const result = yield* filterNodeToWhereClause(node, testSchema, "testCollection")
      expect(result.sql).toBe('t."title" IN (?, ?, ?)')
      expect(result.params).toEqual(["a", "b", "c"])
    }).pipe(Effect.runPromise))

  it("like produces correct SQL and params", () =>
    Effect.gen(function* () {
      const node: FilterNode = { op: "like", field: "title", value: "%hello%" }
      const result = yield* filterNodeToWhereClause(node, testSchema, "testCollection")
      expect(result.sql).toBe('t."title" LIKE ?')
      expect(result.params).toEqual(["%hello%"])
    }).pipe(Effect.runPromise))

  it("null produces IS NULL", () =>
    Effect.gen(function* () {
      const node: FilterNode = { op: "null", field: "email" }
      const result = yield* filterNodeToWhereClause(node, testSchema, "testCollection")
      expect(result.sql).toBe('t."email" IS NULL')
      expect(result.params).toEqual([])
    }).pipe(Effect.runPromise))

  it("not_null produces IS NOT NULL", () =>
    Effect.gen(function* () {
      const node: FilterNode = { op: "not_null", field: "email" }
      const result = yield* filterNodeToWhereClause(node, testSchema, "testCollection")
      expect(result.sql).toBe('t."email" IS NOT NULL')
      expect(result.params).toEqual([])
    }).pipe(Effect.runPromise))

  it("and produces nested SQL with params from both sides", () =>
    Effect.gen(function* () {
      const node: FilterNode = {
        op: "and",
        left: { op: "eq", field: "title", value: "hello" },
        right: { op: "gt", field: "age", value: 18 }
      }
      const result = yield* filterNodeToWhereClause(node, testSchema, "testCollection")
      expect(result.sql).toBe('(t."title" = ?) AND (t."age" > ?)')
      expect(result.params).toEqual(["hello", 18])
    }).pipe(Effect.runPromise))

  it("or produces nested SQL with params from both sides", () =>
    Effect.gen(function* () {
      const node: FilterNode = {
        op: "or",
        left: { op: "eq", field: "title", value: "hello" },
        right: { op: "eq", field: "title", value: "bye" }
      }
      const result = yield* filterNodeToWhereClause(node, testSchema, "testCollection")
      expect(result.sql).toBe('(t."title" = ?) OR (t."title" = ?)')
      expect(result.params).toEqual(["hello", "bye"])
    }).pipe(Effect.runPromise))

  it("not produces NOT (inner) SQL", () =>
    Effect.gen(function* () {
      const node: FilterNode = {
        op: "not",
        node: { op: "eq", field: "title", value: "secret" }
      }
      const result = yield* filterNodeToWhereClause(node, testSchema, "testCollection")
      expect(result.sql).toBe('NOT (t."title" = ?)')
      expect(result.params).toEqual(["secret"])
    }).pipe(Effect.runPromise))

  it("nested and/or with mixed ops", () =>
    Effect.gen(function* () {
      const node: FilterNode = {
        op: "and",
        left: {
          op: "or",
          left: { op: "eq", field: "title", value: "a" },
          right: { op: "eq", field: "title", value: "b" }
        },
        right: { op: "gte", field: "age", value: 21 }
      }
      const result = yield* filterNodeToWhereClause(node, testSchema, "testCollection")
      expect(result.sql).toBe('((t."title" = ?) OR (t."title" = ?)) AND (t."age" >= ?)')
      expect(result.params).toEqual(["a", "b", 21])
    }).pipe(Effect.runPromise))

  it("empty in array produces always-false clause", () =>
    Effect.gen(function* () {
      const node: FilterNode = { op: "in", field: "title", values: [] }
      const result = yield* filterNodeToWhereClause(node, testSchema, "testCollection")
      expect(result.sql).toBe("1 = 0")
      expect(result.params).toEqual([])
    }).pipe(Effect.runPromise))

  it("unknown field returns ValidationError", () =>
    Effect.gen(function* () {
      const node: FilterNode = { op: "eq", field: "nonexistent", value: "x" }
      const result = yield* Effect.either(
        filterNodeToWhereClause(node, testSchema, "testCollection")
      )
      expect(result._tag).toBe("Left")
      if (result._tag === "Left" && result.left instanceof ValidationError) {
        expect(result.left.issues[0]).toContain("nonexistent")
      } else {
        expect.fail("Expected a Left<ValidationError>")
      }
    }).pipe(Effect.runPromise))

  it("between produces AND of gte and lte", () =>
    Effect.gen(function* () {
      const node = Filter.field("age").between(18, 65)
      const result = yield* filterNodeToWhereClause(node, testSchema, "testCollection")
      expect(result.sql).toBe('(t."age" >= ?) AND (t."age" <= ?)')
      expect(result.params).toEqual([18, 65])
    }).pipe(Effect.runPromise))

  it("unknown field in nested and returns ValidationError", () =>
    Effect.gen(function* () {
      const node: FilterNode = {
        op: "and",
        left: { op: "eq", field: "title", value: "ok" },
        right: { op: "eq", field: "bogus", value: "x" }
      }
      const result = yield* Effect.either(
        filterNodeToWhereClause(node, testSchema, "testCollection")
      )
      expect(result._tag).toBe("Left")
      expect(result._tag === "Left" && result.left instanceof ValidationError).toBe(true)
    }).pipe(Effect.runPromise))
})
