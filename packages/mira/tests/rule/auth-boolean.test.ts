import { AuthCollection, Field } from "@gettersethya/mira-client"
import { describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { expect } from "vitest"

import { defineRule } from "@/app/index.js"
import { resolveCtxPlaceholders } from "@/collection-service/where.js"
import { enforceRule } from "@/rule/enforcer.js"

const Users = AuthCollection.define("users", { name: Field.text({ default: "" }) })
const binding = defineRule(Users, (R) => ({
  list: R.auth(Users, "emailVerified").eq(R.literal(true))
}))
const rule = binding.ruleMap.list
if (rule === undefined) throw new Error("Expected a list rule")

describe("auth boolean rules", () => {
  it.effect("encodes the boolean literal and resolves the stored auth value", () =>
    Effect.gen(function* () {
      const compiled = enforceRule(rule)
      expect(compiled.sql).toContain("@auth_emailVerified")
      const resolved = yield* resolveCtxPlaceholders(
        compiled,
        { auth: { collection: "users", record: { emailVerified: 1 } }, headers: {}, query: {} },
        "users",
        "list",
        {
          encodeParam: (value) => (typeof value === "boolean" ? (value ? 1 : 0) : value)
        }
      )
      expect(resolved.params).toEqual([1, 1])
    })
  )
})
