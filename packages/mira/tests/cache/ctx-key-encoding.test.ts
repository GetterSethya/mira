import { describe, expect, it } from "vitest"

import { BaseCollection, Field } from "@gettersethya/mira-client"

import { applyRulesToCollections, defineRule } from "@/app/index.js"
import { buildCtxCacheTag } from "@/cache/ctx-key.js"
import type { RequestCtx } from "@/collection-service/context.js"

// ---------------------------------------------------------------------------
// Regression tests: the per-value encoding of a ctx cache tag must be injective.
//
// A referenced value rendered verbatim could contain the tag's structural
// separators (`=`, `,`, `|`) and mimic a different key/value tuple, so two
// requests with genuinely different rule values (and therefore potentially
// different authorization outcomes) could collapse onto one cache key.
// ---------------------------------------------------------------------------

const oneRefDef = BaseCollection.define("one_ref", {
  token: Field.text({ required: false }),
})
const oneRefRules = defineRule(oneRefDef, (R) => ({
  list: R.public(),
  view: R.field("token").eq(R.request("query", "token")),
  create: R.public(),
  update: R.public(),
  delete: R.public(),
}))
const OneRef = applyRulesToCollections([oneRefDef], [oneRefRules])[0]

const twoRefsDef = BaseCollection.define("two_refs", {
  token: Field.text({ required: false }),
})
const twoRefsRules = defineRule(twoRefsDef, (R) => ({
  list: R.public(),
  view: R.and(
    R.field("token").eq(R.request("query", "a")),
    R.field("token").eq(R.request("query", "b"))
  ),
  create: R.public(),
  update: R.public(),
  delete: R.public(),
}))
const TwoRefs = applyRulesToCollections([twoRefsDef], [twoRefsRules])[0]

const crossSegmentDef = BaseCollection.define("cross_segment", {
  token: Field.text({ required: false }),
  owner: Field.text({ required: false }),
})
const crossSegmentRules = defineRule(crossSegmentDef, (R) => ({
  list: R.public(),
  view: R.and(
    R.field("token").eq(R.request("query", "token")),
    R.field("owner").eq(R.request("body", "owner"))
  ),
  create: R.public(),
  update: R.public(),
  delete: R.public(),
}))
const CrossSegment = applyRulesToCollections([crossSegmentDef], [crossSegmentRules])[0]

const queryCtx = (query: RequestCtx["query"]): RequestCtx => ({ headers: {}, query })

describe("ctx cache tag — injective value encoding", () => {
  it("a value containing a comma cannot impersonate a repeated (element-[0]) value", () => {
    const scalarComma = buildCtxCacheTag(OneRef, "view", queryCtx({ token: "a,b" }))
    const repeated = buildCtxCacheTag(OneRef, "view", queryCtx({ token: ["a", "b"] }))
    const scalar = buildCtxCacheTag(OneRef, "view", queryCtx({ token: "a" }))

    // Same rule value (`"a"`) → same tag; a different rule value must differ.
    expect(repeated).toBe(scalar)
    expect(scalarComma).not.toBe(scalar)
    expect(scalarComma).toContain("q:token=a\\,b")
  })

  it("a value containing `=` cannot impersonate a multi-key tuple", () => {
    const multi = buildCtxCacheTag(TwoRefs, "view", queryCtx({ a: "x", b: "y" }))
    const forged = buildCtxCacheTag(TwoRefs, "view", queryCtx({ a: "x,q:b=y" }))

    expect(multi).toContain("q:a=x,b=y")
    expect(forged).not.toBe(multi)
    expect(forged).toContain("q:a=x\\,q:b\\=y")
  })

  it("a value containing `|` cannot impersonate a following segment", () => {
    const legit = buildCtxCacheTag(CrossSegment, "view", { headers: {}, query: { token: "x" }, body: { owner: "y" } })
    const forged = buildCtxCacheTag(CrossSegment, "view", queryCtx({ token: "x|b:owner=y" }))

    expect(legit).toContain("q:token=x|b:owner=y")
    expect(forged).not.toBe(legit)
    expect(forged).toContain("q:token=x\\|b:owner\\=y")
  })

  it("a missing value differs from an empty-string value", () => {
    const empty = buildCtxCacheTag(OneRef, "view", queryCtx({ token: "" }))
    const missing = buildCtxCacheTag(OneRef, "view", queryCtx({}))

    expect(empty).toContain("q:token=")
    expect(empty).not.toBe(missing)
  })

  it("a present value cannot forge the absent marker", () => {
    const missing = buildCtxCacheTag(OneRef, "view", queryCtx({}))
    const literalBackslashN = buildCtxCacheTag(OneRef, "view", queryCtx({ token: "\\N" }))

    expect(missing).toContain("q:token=\\N")
    expect(literalBackslashN).not.toBe(missing)
    expect(literalBackslashN).toContain("q:token=\\\\N")
  })

  it("NUL, comma, equals, pipe and backslash all round-trip injectively", () => {
    const seen = new Set<string>()
    const values = [
      "",
      "\\N",
      "\\",
      "a,b",
      "a=b",
      "a|b",
      "a\u0000b",
      "a\u0000b,c=d|e\\f",
    ]
    for (const value of values) {
      seen.add(buildCtxCacheTag(OneRef, "view", queryCtx({ token: value })))
    }
    expect(seen.size).toBe(values.length)
  })
})
