import { describe, expect, it } from "vitest"

import { BaseCollection, Field } from "@gettersethya/mira-client"

import { applyRulesToCollections, defineRule } from "@/app/index.js"
import { buildCtxCacheTag as buildCtxCacheTagRaw } from "@/cache/ctx-key.js"
import type { RequestCtx } from "@/collection-service/context.js"
import { postgresRuleSql } from "@/dialect/dialect-postgres.js"
import { sqliteDialect } from "@/dialect/dialect-sqlite.js"

const buildCtxCacheTag = (
  collection: Parameters<typeof buildCtxCacheTagRaw>[0],
  action: Parameters<typeof buildCtxCacheTagRaw>[1],
  ctx: Parameters<typeof buildCtxCacheTagRaw>[2]
) => buildCtxCacheTagRaw(collection, action, ctx, sqliteDialect)

const docsDef = BaseCollection.define("docs", {
  owner: Field.text({ required: false })
})
const docsRules = defineRule(docsDef, (R) => ({
  list: R.public(),
  view: R.field("owner").eq(R.request("body", "owner")),
  create: R.public(),
  update: R.public(),
  delete: R.public()
}))
const Docs = applyRulesToCollections([docsDef], [docsRules])[0]

const plainDocsDef = BaseCollection.define("plain_docs", {
  owner: Field.text({ required: false })
})
const plainDocsRules = defineRule(plainDocsDef, (R) => ({
  list: R.public(),
  view: R.public(),
  create: R.public(),
  update: R.public(),
  delete: R.public()
}))
const PlainDocs = applyRulesToCollections([plainDocsDef], [plainDocsRules])[0]

describe("buildCtxCacheTag body segment", () => {
  it("b: segment reflects body values", () => {
    const alice: RequestCtx = { headers: {}, query: {}, body: { owner: "alice" } }
    const bob: RequestCtx = { headers: {}, query: {}, body: { owner: "bob" } }
    const tagAlice = buildCtxCacheTag(Docs, "view", alice)
    const tagBob = buildCtxCacheTag(Docs, "view", bob)
    expect(tagAlice).toContain("b:owner=alice")
    expect(tagBob).toContain("b:owner=bob")
    expect(tagAlice).not.toBe(tagBob)
  })

  it("absent body yields an empty body value, not a crash", () => {
    const tag = buildCtxCacheTag(Docs, "view", { headers: {}, query: {} })
    expect(tag).toContain("b:owner=")
  })

  it("collections without body refs carry no b: segment", () => {
    const tag = buildCtxCacheTag(PlainDocs, "view", { headers: {}, query: {}, body: { owner: "alice" } })
    expect(tag).not.toContain("b:")
  })
})

describe("cache tag after dialect rendering", () => {
  it("captures the same refs for SQLite and PostgreSQL", () => {
    const ctx = { headers: {}, query: {}, body: { owner: "alice" } }
    const sqliteTag = buildCtxCacheTagRaw(Docs, "view", ctx, sqliteDialect)
    const pgTag = buildCtxCacheTagRaw(Docs, "view", ctx, postgresRuleSql)
    expect(pgTag).toBe(sqliteTag)
    expect(sqliteTag).toContain("b:owner=alice")
  })
})
