import { AuthCollection } from "@/collection/auth.js"
import { BaseCollection } from "@/collection/base.js"
import { Field } from "@/collection/field.js"
import { describe, expect, it } from "vitest"

describe("Index type safety", () => {
  it("BaseCollection: supports callback pattern", () => {
    const Col = BaseCollection.define("posts", { title: Field.text() })
      .indexes((I) => [I.unique("title")])

    const Col2 = BaseCollection.define("posts", { title: Field.text() })
      .indexes((I) => [I.on("title"), I.unique("created")])

    expect(Col.schema["x-indexes"]).toContainEqual({ fields: ["title"], unique: true })
    expect(Col2.schema["x-indexes"]).toContainEqual({ fields: ["title"], unique: false })
    expect(Col2.schema["x-indexes"]).toContainEqual({ fields: ["created"], unique: true })
  })

  it("AuthCollection: supports custom indexes via callback", () => {
    const Users = AuthCollection.define("users", { username: Field.text() })
      .indexes((I) => [I.unique("username")])

    // System index on email should still be present
    expect(Users.schema["x-indexes"]).toContainEqual({ fields: ["email"], unique: true })
    // Custom index should be present
    expect(Users.schema["x-indexes"]).toContainEqual({ fields: ["username"], unique: true })
  })

  it("should catch invalid field names (type-only check)", () => {
    // @ts-expect-error - "invalid" is not a field in the collection
    BaseCollection.define("test", { a: Field.text() }).indexes((I) => [I.on("invalid")])
  })
})
