import { Effect } from "effect"
import { describe, it } from "@effect/vitest"
import { expect } from "vitest"
import { BaseCollection, Field } from "@gettersethya/mira-client"
import { makeRowDecoder, makeRowEncoder } from "@/collection-service/decode.js"

const Posts = BaseCollection.define("posts", {
  title: Field.text(),
  published: Field.boolean({ default: false })
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
