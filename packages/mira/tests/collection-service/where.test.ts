import { describe, it } from "@effect/vitest"
import { Rule } from "@gettersethya/mira-client"
import { Effect, Result } from "effect"
import { expect } from "vitest"

import type { RequestCtx } from "@/collection-service/context.js"
import type { ResolveOptions } from "@/collection-service/where.js"
import {
  cursorClause,
  extractCtxRefs,
  fieldEqualsClause,
  idClause,
  keysetClause,
  resolveCtxPlaceholders as resolveCtxPlaceholdersRaw,
  resolveFieldRefs,
  seqIdEqualsClause
} from "@/collection-service/where.js"
import { postgresRuleSql } from "@/dialect/dialect-postgres.js"
import { sqliteDialect } from "@/dialect/dialect-sqlite.js"
import { enforceRule } from "@/rule/enforcer.js"

const noCtx: RequestCtx = { headers: {}, query: {} }
const defaultResolveOptions: ResolveOptions = {
  encodeParam: (value) => value,
  quoteIdentifier: sqliteDialect.quoteIdentifier,
  castValue: sqliteDialect.castValue
}
const resolveCtxPlaceholders = (
  result: Parameters<typeof resolveCtxPlaceholdersRaw>[0],
  ctx: Parameters<typeof resolveCtxPlaceholdersRaw>[1],
  collection: Parameters<typeof resolveCtxPlaceholdersRaw>[2],
  action: Parameters<typeof resolveCtxPlaceholdersRaw>[3],
  options?: Partial<ResolveOptions>,
  bodyPlan?: Parameters<typeof resolveCtxPlaceholdersRaw>[5]
) =>
  resolveCtxPlaceholdersRaw(
    result,
    ctx,
    collection,
    action,
    { ...defaultResolveOptions, ...options },
    bodyPlan
  )

describe("resolveCtxPlaceholders body resolution", () => {
  it.effect("create-style ctx with body resolves @request_body_* from the payload", () =>
    Effect.gen(function* () {
      const ctx: RequestCtx = { ...noCtx, body: { user: "user-1" } }
      const out = yield* resolveCtxPlaceholders(
        { sql: "@request_body_user = ?", params: ["user-1"] },
        ctx,
        "posts",
        "create"
      )
      expect(out.sql).toBe("? = ?")
      expect(out.params).toEqual(["user-1", "user-1"])
    }))

  it.effect("update-style merged body falls back to the stored value for patch-missing keys", () =>
    Effect.gen(function* () {
      // Simulates the service-built update body { ...stored, ...patch } where
      // the patch changed only `title`, so `ownerId` falls back to stored.
      const ctx: RequestCtx = { ...noCtx, body: { ownerId: "stored-owner", title: "New title" } }
      const out = yield* resolveCtxPlaceholders(
        { sql: "@request_body_ownerId = ?", params: ["stored-owner"] },
        ctx,
        "posts",
        "update"
      )
      expect(out.params).toEqual(["stored-owner", "stored-owner"])
    }))

  it.effect("body key missing everywhere resolves to null", () =>
    Effect.gen(function* () {
      const ctx: RequestCtx = { ...noCtx, body: { title: "x" } }
      const out = yield* resolveCtxPlaceholders(
        { sql: "@request_body_ownerId = ?", params: ["stored-owner"] },
        ctx,
        "posts",
        "update"
      )
      expect(out.params).toEqual([null, "stored-owner"])
    }))

  it.effect("absent body (bodiless action) resolves to null", () =>
    Effect.gen(function* () {
      const out = yield* resolveCtxPlaceholders(
        { sql: "t.ownerId = @request_body_ownerId", params: [] },
        noCtx,
        "posts",
        "view"
      )
      expect(out.sql).toBe("t.ownerId = ?")
      expect(out.params).toEqual([null])
    }))

  it.effect("array body value takes element [0], mirroring query", () =>
    Effect.gen(function* () {
      const ctx: RequestCtx = { ...noCtx, body: { tag: ["a", "b"] } }
      const out = yield* resolveCtxPlaceholders(
        { sql: "t.tag = @request_body_tag", params: [] },
        ctx,
        "posts",
        "create"
      )
      expect(out.params).toEqual(["a"])
    }))

  it.effect("query and header sources still resolve alongside body", () =>
    Effect.gen(function* () {
      const ctx: RequestCtx = {
        headers: { xtenant: "t1" },
        query: { filter: "active" },
        body: { ownerId: "u1" }
      }
      const out = yield* resolveCtxPlaceholders(
        { sql: "@request_query_filter AND @request_header_xtenant AND @request_body_ownerId", params: [] },
        ctx,
        "posts",
        "create"
      )
      expect(out.sql).toBe("? AND ? AND ?")
      expect(out.params).toEqual(["active", "t1", "u1"])
    }))

  it.effect("body plan binds patch keys as params and absent keys as quoted columns", () =>
    Effect.gen(function* () {
      const out = yield* resolveCtxPlaceholders(
        { sql: "@request_body_title = t.title AND t.ownerId = @request_body_ownerId", params: [] },
        noCtx,
        "posts",
        "update",
        undefined,
        new Map([
          ["title", { _tag: "param" as const, value: "New title" }],
          ["ownerId", { _tag: "column" as const, column: "ownerId" }]
        ])
      )
      expect(out.sql).toBe('? = t.title AND t.ownerId = t."ownerId"')
      expect(out.params).toEqual(["New title"])
    }))

  it.effect("a repeated body key binds one param per occurrence", () =>
    Effect.gen(function* () {
      const out = yield* resolveCtxPlaceholders(
        { sql: "@request_body_ownerId = @request_body_ownerId", params: [] },
        noCtx,
        "posts",
        "update",
        undefined,
        new Map([["ownerId", { _tag: "param" as const, value: "u1" }]])
      )
      expect(out.sql).toBe("? = ?")
      expect(out.params).toEqual(["u1", "u1"])
    }))

  it.effect("returns a fresh clause for a placeholder-free public rule", () =>
    Effect.gen(function* () {
      const input = { sql: "1 = 1", params: [] }
      const out = yield* resolveCtxPlaceholders(input, noCtx, "posts", "update")
      expect(out).not.toBe(input)
      expect(out.sql).toBe("1 = 1")
      expect(out.params).toEqual([])
    }))

  it.effect("does not fast-return a positional placeholder with no bound params", () =>
    Effect.gen(function* () {
      const out = yield* resolveCtxPlaceholders(
        { sql: "t.title = ?", params: [] },
        noCtx,
        "posts",
        "update"
      )
      expect(out.sql).toBe("t.title = ?")
      expect(out.params).toEqual([undefined])
    }))

  it.effect("still encodes raw params when the clause is not placeholder-free", () =>
    Effect.gen(function* () {
      const out = yield* resolveCtxPlaceholders(
        { sql: "t.published = ?", params: [true] },
        noCtx,
        "posts",
        "update",
        { encodeParam: (value) => (value === true ? 1 : value) }
      )
      expect(out.params).toEqual([1])
    }))

  it.effect("zero-param auth placeholder still fails closed without auth", () =>
    Effect.gen(function* () {
      const result = yield* resolveCtxPlaceholders(
        { sql: "t.ownerId = @auth_id", params: [] },
        noCtx,
        "posts",
        "update"
      ).pipe(Effect.result)
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) expect(result.failure._tag).toBe("ForbiddenError")
    }))

  it.effect("zero-param unknown source still fails closed", () =>
    Effect.gen(function* () {
      const result = yield* resolveCtxPlaceholders(
        { sql: "t.key = @request_cookie_session", params: [] },
        noCtx,
        "posts",
        "update"
      ).pipe(Effect.result)
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) expect(result.failure._tag).toBe("ForbiddenError")
    }))

  it.effect("unknown request source fails closed with ForbiddenError", () =>
    Effect.gen(function* () {
      const result = yield* resolveCtxPlaceholders(
        { sql: "@request_cookie_session = ?", params: [] },
        noCtx,
        "posts",
        "create"
      ).pipe(Effect.result)
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("ForbiddenError")
        if (result.failure._tag === "ForbiddenError") {
          expect(result.failure.action).toBe("create")
        }
      }
    }))
})

describe("extractCtxRefs", () => {
  it("buckets body keys into bodyKeys, not headerKeys", () => {
    const refs = extractCtxRefs(
      "t.tenantId = @request_query_tenant AND t.owner = @request_body_user AND t.key = @request_header_xkey"
    )
    expect(refs.queryKeys).toEqual(["tenant"])
    expect(refs.bodyKeys).toEqual(["user"])
    expect(refs.headerKeys).toEqual(["xkey"])
    expect(refs.authFields).toEqual([])
  })

  it("returns empty bodyKeys when no body placeholders are present", () => {
    const refs = extractCtxRefs("t.ownerId = @auth_id AND t.key = @request_header_xkey")
    expect(refs.bodyKeys).toEqual([])
    expect(refs.authFields).toEqual(["id"])
  })

  it("marks subquery rules and unknown request sources", () => {
    const subquery = extractCtxRefs(
      "EXISTS (SELECT 1 FROM t2 WHERE t2.id = @request_body_ownerId)"
    )
    expect(subquery.hasSubquery).toBe(true)
    expect(subquery.hasUnknownSource).toBe(false)

    const unknown = extractCtxRefs("t.key = @request_cookie_session")
    expect(unknown.hasUnknownSource).toBe(true)
  })
})

describe("dialect-aware predicates and payload markers", () => {
  const backtick = (name: string) => `\`${name}\``
  const pgOptions: ResolveOptions = {
    encodeParam: (value) => value,
    quoteIdentifier: postgresRuleSql.quoteIdentifier,
    castValue: postgresRuleSql.castValue
  }

  it("quotes id, cursor, keyset, and field predicates", () => {
    expect(idClause("p1", backtick).sql).toBe("t.`id` = ?")
    expect(cursorClause(7, backtick).sql).toBe("t.`seqId` > ?")
    expect(seqIdEqualsClause(7, backtick).sql).toBe("t.`seqId` = ?")
    expect(keysetClause({ field: "name", direction: "asc" }, "a", 7, backtick).sql).toBe(
      "(t.`name`, t.`seqId`) > (?, ?)"
    )
    expect(fieldEqualsClause("email", "a@b.c", backtick).sql).toBe("t.`email` = ?")
  })

  it("keeps string cursors and supports descending seqId", () => {
    expect(cursorClause("2", backtick)).toEqual({
      sql: "t.`seqId` > ?",
      params: ["2"]
    })
    expect(cursorClause("9007199254740993", backtick)).toEqual({
      sql: "t.`seqId` > ?",
      params: ["9007199254740993"]
    })
    expect(cursorClause("2", backtick, "desc")).toEqual({
      sql: "t.`seqId` < ?",
      params: ["2"]
    })
    expect(seqIdEqualsClause("2", backtick)).toEqual({
      sql: "t.`seqId` = ?",
      params: ["2"]
    })
    expect(keysetClause({ field: "name", direction: "asc" }, "a", "2", backtick)).toEqual({
      sql: "(t.`name`, t.`seqId`) > (?, ?)",
      params: ["a", "2"]
    })
  })

  it.effect("does not rewrite tokens inside quoted identifiers", () =>
    Effect.gen(function* () {
      const refs = extractCtxRefs('t."note@auth_id" = ? AND t."a?b" = ?')
      expect(refs.authFields).toEqual([])
      const result = { sql: 't."note@auth_id" = ? AND t."a?b" = ?', params: [1, 2] }
      const resolved = yield* resolveCtxPlaceholders(result, noCtx, "posts", "list")
      expect(resolved.sql).toBe(result.sql)
    }))

  it("resolves typed payload markers", () => {
    const compiled = enforceRule(
      Rule.field("age").gt(Rule.literal(10)),
      postgresRuleSql,
      { fieldRefMode: "param", fieldType: (field) => field === "age" ? "integer" : "text" }
    )
    expect(compiled.sql).toContain("@field_integer_")
    const resolved = resolveFieldRefs(compiled, { age: 20 }, pgOptions)
    expect(resolved.sql).toBe("?::integer > ?::integer")
    expect(resolved.params).toEqual([20, 10])
  })

  it("resolves a seqId payload rule with a large bigint value", () => {
    const compiled = enforceRule(
      Rule.field("seqId").gt(Rule.literal("9007199254740993")),
      postgresRuleSql,
      { fieldRefMode: "param", fieldType: (field) => field === "seqId" ? "bigint" : "text" }
    )
    expect(compiled.sql).toContain("@field_bigint_")
    const resolved = resolveFieldRefs(
      compiled,
      { seqId: 9007199254740993n },
      pgOptions
    )
    expect(resolved.sql).toBe("?::bigint > ?::bigint")
    expect(resolved.params).toEqual([9007199254740993n, "9007199254740993"])
  })
})
