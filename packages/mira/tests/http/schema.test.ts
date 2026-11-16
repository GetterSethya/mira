import { describe, expect, it } from "vitest"
import { AuthCollection, BaseCollection, Field } from "@gettersethya/mira-client"

import { applyRulesToCollections, defineRule } from "@/app/index.js"
import { makeRuleSummary } from "@/http/rule-summary.js"
import { schemaSnapshot } from "@/http/schema.js"

const postsDef = BaseCollection.define("posts", {
  title: Field.text(),
  ownerId: Field.text()
}).indexes((I) => [I.unique("title")])

const postsRules = defineRule(postsDef, (R) => ({
  list: R.public(),
  view: R.and(
    R.field("ownerId").eq(R.literal("user-1")),
    R.field("title").contains(R.literal("release"))
  ),
  update: R.field("ownerId").eq(R.literal("user-1"))
}))

const usersDef = AuthCollection.define("users", {})
const usersRules = defineRule(usersDef, (R) => ({
  list: R.public(),
  manage: R.field("emailVerified").eq(R.literal(true))
}))

const restrictedDef = BaseCollection.define("restricted", { name: Field.text() })

const collections = applyRulesToCollections(
  [postsDef, usersDef, restrictedDef],
  [postsRules, usersRules]
)

const snapshotEntry = (name: string) => {
  const found = schemaSnapshot(collections).find((entry) => entry.name === name)
  if (found === undefined) throw new Error(`Missing snapshot for ${name}`)
  return found
}

describe("schemaSnapshot", () => {
  it("exposes raw rules and a server-computed summary for a base collection", () => {
    const posts = snapshotEntry("posts")
    expect(posts.rules).not.toBeNull()
    expect(posts.ruleSummary).toEqual([
      { action: "list", kind: "public", fields: [] },
      { action: "view", kind: "expr", fields: ["ownerId", "title"] },
      { action: "create", kind: "deny", fields: [] },
      { action: "update", kind: "expr", fields: ["ownerId"] },
      { action: "delete", kind: "deny", fields: [] }
    ])
  })

  it("adds the manage action for auth collections", () => {
    const users = snapshotEntry("users")
    expect(users.ruleSummary.map((row) => row.action)).toEqual([
      "list",
      "view",
      "create",
      "update",
      "delete",
      "manage"
    ])
    expect(users.ruleSummary).toContainEqual({
      action: "manage",
      kind: "expr",
      fields: ["emailVerified"]
    })
    expect(users.ruleSummary).toContainEqual({ action: "view", kind: "deny", fields: [] })
  })

  it("marks the injected auth email index as system and leaves indexes empty by default", () => {
    expect(snapshotEntry("users").indexes).toEqual([
      { fields: ["email"], unique: true, system: true }
    ])
    expect(snapshotEntry("posts").indexes).toEqual([
      { fields: ["title"], unique: true }
    ])
    expect(snapshotEntry("restricted").indexes).toEqual([])
  })

  it("reports missing rules as deny for every action", () => {
    const restricted = snapshotEntry("restricted")
    expect(restricted.rules).toBeNull()
    expect(restricted.ruleSummary.every((row) => row.kind === "deny")).toBe(true)
  })

  it("limits view collections to list and view", () => {
    const summary = makeRuleSummary("view", { list: { op: "public" } })
    expect(summary.map((row) => row.action)).toEqual(["list", "view"])
    expect(summary[1]).toEqual({ action: "view", kind: "deny", fields: [] })
  })
})
