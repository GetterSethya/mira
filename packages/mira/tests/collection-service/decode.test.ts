import { describe, it } from "@effect/vitest"
import { AuthCollection, BaseCollection, Field } from "@gettersethya/mira-client"
import { Effect } from "effect"
import { expect } from "vitest"

import { makeRowDecoder, makeRowEncoder, stripHiddenFields, toPublicRecord } from "@/collection-service/decode.js"

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
