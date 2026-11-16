import { describe, it } from "@effect/vitest"
import { AuthCollection, BaseCollection, Field } from "@gettersethya/mira-client"
import { Effect } from "effect"
import { expect } from "vitest"

import {
  makeListRowMapper,
  makeProjectedListRowMapper,
  makeRowDecoder,
  makeRowDecoderSync,
  makeRowEncoder,
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

describe("makeRowDecoder", () => {
  it.effect("storesBooleanAsInteger: true — converts 0/1 to false/true", () =>
    Effect.gen(function* () {
      const decode = makeRowDecoder(Posts.schema, true)
      const result = yield* decode({ id: "1", title: "X", published: 1 })
      expect(result["published"]).toBe(true)
    })
  )

  it.effect("storesBooleanAsInteger: false — passes the record through unchanged", () =>
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

describe("makeRowEncoder", () => {
  it("storesBooleanAsInteger: true — converts booleans to 0/1", () => {
    const encode = makeRowEncoder(Posts.schema, true)
    const result = encode({ title: "X", published: true })
    expect(result["published"]).toBe(1)
  })

  it("storesBooleanAsInteger: false — passes the record through unchanged (future-Postgres path)", () => {
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
