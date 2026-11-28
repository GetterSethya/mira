import { AuthCollection, BaseCollection, Field } from "@gettersethya/mira-client"
import { describe, expect, it } from "vitest"

import { authCollectionNames } from "@/api/email-templates.js"

describe("authCollectionNames", () => {
  it("keeps auth collections only", () => {
    const posts = BaseCollection.define("posts", { title: Field.text() })
    const users = AuthCollection.define("users", {})
    const admins = AuthCollection.define("_superadmin", {})

    expect([...authCollectionNames([posts, users, admins])]).toEqual(["users", "_superadmin"])
  })

  it("returns an empty set for a non-auth collection list", () => {
    const posts = BaseCollection.define("posts", { title: Field.text() })
    expect(authCollectionNames([posts]).size).toBe(0)
  })
})
