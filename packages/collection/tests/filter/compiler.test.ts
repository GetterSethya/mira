import { it as effectIt } from "@effect/vitest"
import { Effect, Result } from "effect"
import { describe, expect, it } from "vitest"

import type { CollectionSchema } from "@/collection/types.js"
import { Filter } from "@/filter/builder.js"
import { filterNodeToWhereClause as filterNodeToWhereClauseRaw } from "@/filter/compiler.js"
import type { FilterCompileOptions } from "@/filter/compiler.js"
import type { FilterNode } from "@/filter/types.js"

const filterNodeToWhereClause = (
  node: FilterNode,
  schema: CollectionSchema,
  collectionName: string,
  options: Partial<FilterCompileOptions> = {}
) =>
  filterNodeToWhereClauseRaw(node, schema, collectionName, {
    quoteIdentifier: (field) => `"${field}"`,
    caseInsensitivePattern: (left, right) => `${left} LIKE ${right}`,
    ...options
  })

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

  effectIt.effect("like calls the supplied case-insensitive pattern renderer", () =>
    Effect.gen(function* () {
      const calls: Array<{ left: string; right: string }> = []
      const node: FilterNode = { op: "like", field: "title", value: "%hello%" }
      const result = yield* filterNodeToWhereClause(node, testSchema, "testCollection", {
        caseInsensitivePattern: (left, right) => {
          calls.push({ left, right })
          return `${left} SENTINEL_PATTERN ${right}`
        }
      })
      expect(calls).toEqual([{ left: 't."title"', right: "?" }])
      expect(result.sql).toBe('t."title" SENTINEL_PATTERN ?')
      expect(result.sql).not.toContain("LIKE")
      expect(result.params).toEqual(["%hello%"])
    })
  )

  effectIt.effect("like keeps wildcard and backslash patterns in one placeholder", () =>
    Effect.gen(function* () {
      const pattern = "100\\%_"
      const node: FilterNode = { op: "like", field: "title", value: pattern }
      const result = yield* filterNodeToWhereClause(node, testSchema, "testCollection")
      expect(result.sql).toBe('t."title" LIKE ?')
      expect(result.sql.match(/\?/g)?.length).toBe(1)
      expect(result.sql).not.toContain("ESCAPE")
      expect(result.params).toEqual([pattern])
    })
  )

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
      const result = yield* Effect.result(
        filterNodeToWhereClause(node, testSchema, "testCollection")
      )
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result) && result.failure._tag === "ValidationError") {
        expect(result.failure.issues[0]).toContain("nonexistent")
      } else {
        expect.fail("Expected a Failure<ValidationError>")
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
      const result = yield* Effect.result(
        filterNodeToWhereClause(node, testSchema, "testCollection")
      )
      expect(Result.isFailure(result)).toBe(true)
      expect(Result.isFailure(result) && result.failure._tag === "ValidationError").toBe(true)
    }).pipe(Effect.runPromise))

  it("uses a dialect quote function and keeps ? placeholders", () =>
    Effect.gen(function* () {
      const node: FilterNode = {
        op: "and",
        left: { op: "eq", field: "title", value: "ok" },
        right: { op: "in", field: "age", values: [18, 65] }
      }
      const result = yield* filterNodeToWhereClause(node, testSchema, "testCollection", {
        quoteIdentifier: (field) => `\`${field}\``
      })
      expect(result.sql).toBe('(t.`title` = ?) AND (t.`age` IN (?, ?))')
      expect(result.params).toEqual(["ok", 18, 65])
    }).pipe(Effect.runPromise))
})
