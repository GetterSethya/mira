import { describe, it } from "@effect/vitest"
import { AuthCollection, BaseCollection, Field, ViewCollection } from "@gettersethya/mira-client"
import { Effect } from "effect"
import { expect } from "vitest"

import {
  decodeViewRow,
  makeListRowMapper,
  makeProjectedListRowMapper,
  makeRowDecoder,
  makeRowDecoderSync,
  makeRowEncoder,
  normalizeSeqId,
  stripHiddenFields,
  toPublicRecord
} from "@/collection-service/decode.js"

const Posts = BaseCollection.define("posts", {
  title: Field.text(),
  published: Field.boolean({ default: false })
})

const Users = AuthCollection.define("users", {
  name: Field.text()
})

const PostStats = ViewCollection.define(
  "post_stats",
  "SELECT id, seqId FROM posts",
  {
    id: Field.text().view(),
    seqId: Field.integer().view(),
    title: Field.text().view(),
    total: Field.integer().view(),
    totalViews: Field.number().view(),
    published: Field.boolean().view(),
    meta: Field.json().view()
  }
)

describe("makeRowDecoder", () => {
  it.effect("storesBooleanAsInteger: true - converts 0/1 to false/true", () =>
    Effect.gen(function* () {
      const decode = makeRowDecoder(Posts.schema, true)
      const result = yield* decode({ id: "1", title: "X", published: 1 })
      expect(result["published"]).toBe(true)
    })
  )

  it.effect("storesBooleanAsInteger: false - passes the record through unchanged", () =>
    Effect.gen(function* () {
      const decode = makeRowDecoder(Posts.schema, false)
      const record = { id: "1", title: "X", published: true }
      const result = yield* decode(record)
      expect(result).toBe(record)
    })
  )
})

describe("makeRowDecoderSync", () => {
  it("converts stored 0/1 to booleans, preserves other fields, and does not mutate the input", () => {
    const decode = makeRowDecoderSync(Posts.schema, true)
    const original = { id: "1", seqId: 7, title: "X", published: 1, score: 0 }

    const result = decode(original)

    expect(result).toEqual({ id: "1", seqId: 7, title: "X", published: true, score: 0 })
    expect(result).not.toBe(original)
    expect(original["published"]).toBe(1)
  })

  it("leaves a non-boolean column that happens to hold 0/1 untouched", () => {
    const decode = makeRowDecoderSync(Posts.schema, true)
    const result = decode({ title: "X", published: 0, score: 1 })
    expect(result["published"]).toBe(false)
    expect(result["score"]).toBe(1)
  })

  it("is the identity function when the dialect does not store booleans as integers", () => {
    const decode = makeRowDecoderSync(Posts.schema, false)
    const record = { title: "X", published: true }
    expect(decode(record)).toBe(record)
  })
})

describe("makeListRowMapper", () => {
  it("strips seqId and decodes booleans in one pass without mutating the source row", () => {
    const mapRow = makeListRowMapper(Posts.schema, true)
    const row = { id: "1", seqId: 3, title: "X", published: 1 }

    const item = mapRow(row)

    expect(item).toEqual({ id: "1", title: "X", published: true })
    expect("seqId" in item).toBe(false)
    expect(row).toEqual({ id: "1", seqId: 3, title: "X", published: 1 })
  })

  it("still strips seqId when booleans need no conversion", () => {
    const mapRow = makeListRowMapper(Posts.schema, false)
    expect(mapRow({ id: "1", seqId: 3, published: false })).toEqual({ id: "1", published: false })
  })
})

describe("makeProjectedListRowMapper", () => {
  it("preserves SELECT order, drops seqId, and never emits non-projected keys", () => {
    const mapRow = makeProjectedListRowMapper(Posts.schema, true, [
      "title",
      "id",
      "published",
      "seqId"
    ])
    const item = mapRow({
      title: "X",
      id: "1",
      published: 1,
      seqId: 9,
      secret: "must-not-leak"
    })

    expect(Object.keys(item)).toEqual(["title", "id", "published"])
    expect(item).toStrictEqual({ title: "X", id: "1", published: true })
  })

  it("keeps a null value and only decodes boolean-valued 0/1", () => {
    const mapRow = makeProjectedListRowMapper(Posts.schema, true, [
      "title",
      "published",
      "views"
    ])
    const item = mapRow({ title: null, published: 0, views: 1 })
    expect(item).toStrictEqual({ title: null, published: false, views: 1 })
  })

  it("copies expand when the repository added it", () => {
    const mapRow = makeProjectedListRowMapper(Posts.schema, true, ["id", "title", "seqId"])
    const item = mapRow({
      id: "1",
      title: "X",
      seqId: 2,
      expand: { author: { id: "u1", name: "A" } }
    })
    expect(Object.keys(item)).toEqual(["id", "title", "expand"])
    expect(item["expand"]).toEqual({ author: { id: "u1", name: "A" } })
  })
})

describe("normalizeSeqId", () => {
  it("converts a bigint seqId through cursorFromSeqId", () => {
    const record = { id: "1", seqId: 9007199254740993n, title: "X" }
    const result = normalizeSeqId(record)
    expect(result).toEqual({ id: "1", seqId: "9007199254740993", title: "X" })
    expect(record["seqId"]).toBe(9007199254740993n)
  })

  it("returns the original record when seqId is already a number or string", () => {
    const numeric = { id: "1", seqId: 3 }
    const string = { id: "1", seqId: "3" }
    expect(normalizeSeqId(numeric)).toBe(numeric)
    expect(normalizeSeqId(string)).toBe(string)
  })

  it("leaves an out-of-range bigint and a missing seqId untouched", () => {
    const outOfRange = { id: "1", seqId: 9223372036854775808n }
    const missing = { id: "1", title: "X" }
    expect(normalizeSeqId(outOfRange)).toBe(outOfRange)
    expect(normalizeSeqId(missing)).toBe(missing)
  })

  it("normalizes nested expand records without mutating the source", () => {
    const expand = { author: { id: "u1", seqId: 5n } }
    const record = { id: "1", seqId: 2n, expand }
    const result = normalizeSeqId(record)
    expect(result["seqId"]).toBe("2")
    expect(result["expand"]).toEqual({ author: { id: "u1", seqId: "5" } })
    expect(result["expand"]).not.toBe(expand)
    expect(expand.author["seqId"]).toBe(5n)
  })

  it("keeps expand by identity when no nested record changes", () => {
    const expand = { author: { id: "u1", seqId: 5 } }
    const record = { id: "1", seqId: 2, expand }
    expect(normalizeSeqId(record)).toBe(record)
  })
})

describe("normalizesBigintSeqId", () => {
  it.effect("normalizes a bigint seqId in the async row decoder", () =>
    Effect.gen(function* () {
      const decode = makeRowDecoder(Posts.schema, false, true)
      const record = { id: "1", seqId: 9007199254740993n, title: "X", published: true }
      const result = yield* decode(record)
      expect(result["seqId"]).toBe("9007199254740993")
      expect(record["seqId"]).toBe(9007199254740993n)
    }))

  it("keeps the identity fast path when the flag is false and the schema is not a view", () => {
    const decode = makeRowDecoderSync(Posts.schema, false, false)
    const record = { id: "1", seqId: 3n, title: "X" }
    expect(decode(record)).toBe(record)
  })

  it("decodes booleans and seqId in one pass without mutating the input", () => {
    const decode = makeRowDecoderSync(Posts.schema, true, true)
    const original = { id: "1", seqId: 7n, title: "X", published: 1 }
    const result = decode(original)
    expect(result).toEqual({ id: "1", seqId: "7", title: "X", published: true })
    expect(original["seqId"]).toBe(7n)
    expect(original["published"]).toBe(1)
  })
})

describe("decodeViewRow", () => {
  it("decodes integer and number columns from bigints and numeric strings", () => {
    const result = decodeViewRow(
      { id: "p1", seqId: 42n, total: 9007199254740993n, totalViews: "12.5" },
      PostStats.schema
    )
    expect(result["seqId"]).toBe("42")
    expect(result["total"]).toBe("9007199254740993")
    expect(result["totalViews"]).toBe(12.5)
  })

  it("decodes safe integer strings and leaves over-2^53 integer strings canonical", () => {
    const safe = decodeViewRow({ id: "p1", seqId: 1, total: "42" }, PostStats.schema)
    const large = decodeViewRow(
      { id: "p1", seqId: 1, total: "9007199254740993" },
      PostStats.schema
    )
    expect(safe["total"]).toBe(42)
    expect(large["total"]).toBe("9007199254740993")
  })

  it("decodes booleans, encodes JSON values, and leaves non-string text values alone", () => {
    const result = decodeViewRow(
      { id: "p1", seqId: 5, title: 7, published: 1, meta: { a: 1 } },
      PostStats.schema
    )
    expect(result["published"]).toBe(true)
    expect(result["title"]).toBe(7)
    expect(result["meta"]).toBe('{"a":1}')
  })

  it("keeps boolean values and existing JSON strings unchanged", () => {
    const result = decodeViewRow(
      { id: "p1", seqId: 5, published: false, meta: '{"a":1}' },
      PostStats.schema
    )
    expect(result["published"]).toBe(false)
    expect(result["meta"]).toBe('{"a":1}')
  })

  it("does not coerce seqId to the declared integer type", () => {
    const result = decodeViewRow({ id: "p1", seqId: 9007199254740993n }, PostStats.schema)
    expect(result["seqId"]).toBe("9007199254740993")
  })

  it("returns the original record when every declared value already matches", () => {
    const record = {
      id: "p1",
      seqId: 5,
      total: 2,
      totalViews: 1.5,
      published: true,
      title: "X",
      meta: '{"a":1}'
    }
    expect(decodeViewRow(record, PostStats.schema)).toBe(record)
  })
})

describe("view decode factories", () => {
  it("uses decodeViewRow for view rows even when normalizesBigintSeqId is false", () => {
    const decode = makeRowDecoderSync(PostStats.schema, false)
    const result = decode({ id: "p1", seqId: 5n, total: 3n, published: 1, meta: { a: 1 } })
    expect(result["total"]).toBe(3)
    expect(result["published"]).toBe(true)
    expect(result["meta"]).toBe('{"a":1}')
    expect(result["seqId"]).toBe("5")
  })

  it("decodes view fields in list items and strips seqId", () => {
    const mapRow = makeListRowMapper(PostStats.schema, false)
    const item = mapRow({
      id: "p1",
      seqId: 5n,
      total: 3n,
      totalViews: "1.5",
      published: 0,
      title: "X",
      meta: { a: 1 }
    })
    expect(item).toEqual({
      id: "p1",
      title: "X",
      total: 3,
      totalViews: 1.5,
      published: false,
      meta: '{"a":1}'
    })
  })

  it("decodes view fields in projected list items", () => {
    const mapRow = makeProjectedListRowMapper(PostStats.schema, false, ["title", "total", "seqId"])
    const item = mapRow({ id: "p1", seqId: 5n, title: "X", total: 3n, published: 1 })
    expect(item).toEqual({ title: "X", total: 3 })
  })
})

describe("list mapper expand normalization", () => {
  it("normalizes nested expand seqIds without decoding expanded fields as views", () => {
    const mapRow = makeListRowMapper(Posts.schema, false, true)
    const row = {
      id: "1",
      seqId: 3n,
      title: "X",
      published: true,
      expand: { author: { id: "u1", seqId: 5n, total: 9n } }
    }
    const item = mapRow(row)
    expect(item["expand"]).toEqual({ author: { id: "u1", seqId: "5", total: 9n } })
    expect(item["seqId"]).toBeUndefined()
    expect(row["expand"]).toEqual({ author: { id: "u1", seqId: 5n, total: 9n } })
  })

  it("normalizes nested expand seqIds in projected list items", () => {
    const mapRow = makeProjectedListRowMapper(Posts.schema, false, ["title", "id"], true)
    const item = mapRow({
      id: "1",
      seqId: 3n,
      title: "X",
      expand: { author: { id: "u1", seqId: 5n, total: 9n } }
    })
    expect(Object.keys(item)).toEqual(["title", "id", "expand"])
    expect(item["expand"]).toEqual({ author: { id: "u1", seqId: "5", total: 9n } })
  })
})

describe("makeRowEncoder", () => {
  it("storesBooleanAsInteger: true - converts booleans to 0/1", () => {
    const encode = makeRowEncoder(Posts.schema, true)
    const result = encode({ title: "X", published: true })
    expect(result["published"]).toBe(1)
  })

  it("storesBooleanAsInteger: false - passes the record through unchanged (future-Postgres path)", () => {
    const encode = makeRowEncoder(Posts.schema, false)
    const record = { title: "X", published: true }
    const result = encode(record)
    expect(result).toBe(record)
    expect(result["published"]).toBe(true)
  })
})

describe("stripHiddenFields", () => {
  it("drops x-hidden fields and any key with no schema property", () => {
    const result = stripHiddenFields(Users.schema, {
      id: "1",
      email: "a@b.com",
      password: "hashed",
      seqId: 5,
      unknown: "x"
    })
    expect(result).toEqual({ id: "1", email: "a@b.com" })
  })
})

describe("toPublicRecord", () => {
  it.effect("decodes booleans and strips hidden fields", () =>
    Effect.gen(function* () {
      const result = yield* toPublicRecord(Users.schema, true, {
        id: "1",
        email: "a@b.com",
        emailVerified: 1,
        password: "hashed",
        seqId: 5
      })
      expect(result).toEqual({ id: "1", email: "a@b.com", emailVerified: true })
    })
  )

  it.effect("leaves booleans untouched when storesBooleanAsInteger is false", () =>
    Effect.gen(function* () {
      const result = yield* toPublicRecord(Users.schema, false, {
        id: "1",
        email: "a@b.com",
        emailVerified: false,
        password: "hashed"
      })
      expect(result).toEqual({ id: "1", email: "a@b.com", emailVerified: false })
    })
  )
})
