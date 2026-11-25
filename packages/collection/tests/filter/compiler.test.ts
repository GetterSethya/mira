import { it as effectIt } from "@effect/vitest"
import { Effect, Result } from "effect"
import { describe, expect, it } from "vitest"

import type { ValidationError } from "@/collection/errors.js"
import type { CollectionSchema } from "@/collection/types.js"
import { Filter } from "@/filter/builder.js"
import { filterNodeToWhereClause as filterNodeToWhereClauseRaw } from "@/filter/compiler.js"
import type { FilterCompileOptions } from "@/filter/compiler.js"
import type { FilterNode, FilterValueType, WhereClause } from "@/filter/types.js"

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
    seqId: { type: "integer", "x-kind": "seqId" },
    email: { type: "string", format: "email" }
  },
  required: ["title"]
}

function expectIssue(
  result: Result.Result<WhereClause, ValidationError>,
  issue: string
) {
  expect(Result.isFailure(result)).toBe(true)
  if (!Result.isFailure(result)) return expect.fail("Expected a Failure<ValidationError>")
  expect(result.failure._tag).toBe("ValidationError")
  if (result.failure._tag !== "ValidationError") {
    return expect.fail("Expected a Failure<ValidationError>")
  }
  expect(result.failure.issues).toEqual([issue])
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

describe("type-aware filter compilation", () => {
  const castValue = (expr: string, type: FilterValueType) =>
    `${expr}::${type === "number" ? "double precision" : type}`

  it("casts a number on a text field to text", () =>
    Effect.gen(function* () {
      const node: FilterNode = { op: "eq", field: "title", value: 5 }
      const result = yield* filterNodeToWhereClause(node, testSchema, "testCollection", {
        castValue
      })
      expect(result.sql).toBe('t."title" = ?::text')
      expect(result.params).toEqual([5])
    }).pipe(Effect.runPromise))

  it("casts a string on an integer field to integer", () =>
    Effect.gen(function* () {
      const node: FilterNode = { op: "gt", field: "age", value: "18" }
      const result = yield* filterNodeToWhereClause(node, testSchema, "testCollection", {
        castValue
      })
      expect(result.sql).toBe('t."age" > ?::integer')
      expect(result.params).toEqual(["18"])
    }).pipe(Effect.runPromise))

  it("casts IN placeholders to the field type", () =>
    Effect.gen(function* () {
      const node: FilterNode = { op: "in", field: "age", values: ["1", "2"] }
      const result = yield* filterNodeToWhereClause(node, testSchema, "testCollection", {
        castValue
      })
      expect(result.sql).toBe('t."age" IN (?::integer, ?::integer)')
      expect(result.params).toEqual(["1", "2"])
    }).pipe(Effect.runPromise))

  it("casts a non-text like column and the pattern to text", () =>
    Effect.gen(function* () {
      const node: FilterNode = { op: "like", field: "age", value: "1%" }
      const result = yield* filterNodeToWhereClause(node, testSchema, "testCollection", {
        castValue
      })
      expect(result.sql).toBe('t."age"::text LIKE ?::text')
      expect(result.params).toEqual(["1%"])
    }).pipe(Effect.runPromise))

  it("leaves a text like column uncast and casts the pattern to text", () =>
    Effect.gen(function* () {
      const node: FilterNode = { op: "like", field: "title", value: "%hello%" }
      const result = yield* filterNodeToWhereClause(node, testSchema, "testCollection", {
        castValue
      })
      expect(result.sql).toBe('t."title" LIKE ?::text')
      expect(result.params).toEqual(["%hello%"])
    }).pipe(Effect.runPromise))

  it("accepts and casts boolean values", () =>
    Effect.gen(function* () {
      const node: FilterNode = { op: "eq", field: "published", value: true }
      const result = yield* filterNodeToWhereClause(node, testSchema, "testCollection", {
        castValue
      })
      expect(result.sql).toBe('t."published" = ?::boolean')
      expect(result.params).toEqual([true])
    }).pipe(Effect.runPromise))

  it("encodes boolean values before binding", () =>
    Effect.gen(function* () {
      const node: FilterNode = { op: "eq", field: "published", value: true }
      const result = yield* filterNodeToWhereClause(node, testSchema, "testCollection", {
        encodeValue: (_field, value) =>
          typeof value === "boolean" ? (value ? 1 : 0) : value
      })
      expect(result.sql).toBe('t."published" = ?')
      expect(result.params).toEqual([1])
    }).pipe(Effect.runPromise))

  it("keeps the default identity path unchanged", () =>
    Effect.gen(function* () {
      const node: FilterNode = { op: "gt", field: "age", value: "18" }
      const result = yield* filterNodeToWhereClause(node, testSchema, "testCollection")
      expect(result.sql).toBe('t."age" > ?')
      expect(result.params).toEqual(["18"])
    }).pipe(Effect.runPromise))

  it("casts a bigint string to a bigint placeholder", () =>
    Effect.gen(function* () {
      const node: FilterNode = { op: "gt", field: "seqId", value: "9007199254740993" }
      const result = yield* filterNodeToWhereClause(node, testSchema, "testCollection", {
        castValue
      })
      expect(result.sql).toBe('t."seqId" > ?::bigint')
      expect(result.params).toEqual(["9007199254740993"])
    }).pipe(Effect.runPromise))

  it("leaves a null comparison placeholder uncast", () =>
    Effect.gen(function* () {
      const node: FilterNode = { op: "eq", field: "age", value: null }
      const result = yield* filterNodeToWhereClause(node, testSchema, "testCollection", {
        castValue
      })
      expect(result.sql).toBe('t."age" = ?')
      expect(result.params).toEqual([null])
    }).pipe(Effect.runPromise))

  it("rejects an invalid integer string", () =>
    Effect.gen(function* () {
      const node: FilterNode = { op: "eq", field: "age", value: "not-an-integer" }
      const result = yield* Effect.result(
        filterNodeToWhereClause(node, testSchema, "testCollection", { castValue })
      )
      expectIssue(result, 'Filter value for "age" must be an integer')
    }).pipe(Effect.runPromise))

  it("rejects an invalid number string", () =>
    Effect.gen(function* () {
      const node: FilterNode = { op: "eq", field: "score", value: "not-a-number" }
      const result = yield* Effect.result(
        filterNodeToWhereClause(node, testSchema, "testCollection", { castValue })
      )
      expectIssue(result, 'Filter value for "score" must be a number')
    }).pipe(Effect.runPromise))

  it("rejects an invalid boolean string", () =>
    Effect.gen(function* () {
      const node: FilterNode = { op: "eq", field: "published", value: "yes" }
      const result = yield* Effect.result(
        filterNodeToWhereClause(node, testSchema, "testCollection", { castValue })
      )
      expectIssue(result, 'Filter value for "published" must be a boolean')
    }).pipe(Effect.runPromise))

  it("rejects an invalid bigint string", () =>
    Effect.gen(function* () {
      const node: FilterNode = { op: "eq", field: "seqId", value: "not-a-bigint" }
      const result = yield* Effect.result(
        filterNodeToWhereClause(node, testSchema, "testCollection", { castValue })
      )
      expectIssue(result, 'Filter value for "seqId" must be a bigint')
    }).pipe(Effect.runPromise))

  it("rejects an unsafe bigint number", () =>
    Effect.gen(function* () {
      const node: FilterNode = {
        op: "eq",
        field: "seqId",
        value: Number.MAX_SAFE_INTEGER + 2
      }
      const result = yield* Effect.result(
        filterNodeToWhereClause(node, testSchema, "testCollection", { castValue })
      )
      expectIssue(result, 'Filter value for "seqId" must be a bigint')
    }).pipe(Effect.runPromise))

  it("rejects a non-scalar value with the updated message", () =>
    Effect.gen(function* () {
      const node: FilterNode = { op: "eq", field: "title", value: ["a"] }
      const result = yield* Effect.result(
        filterNodeToWhereClause(node, testSchema, "testCollection")
      )
      expectIssue(
        result,
        'Filter value for "title" must be a string, number, boolean, or null'
      )
    }).pipe(Effect.runPromise))
})
