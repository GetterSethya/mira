import { describe, expect, it } from "vitest"

import { AuthCollection } from "@/collection/auth.js"
import { Field } from "@/collection/field.js"

const ID_PROPERTY = { type: "string", "x-system": true }
const SEQID_PROPERTY = { type: "integer", "x-kind": "seqId", "x-system": true, "x-hidden": true }
const CREATED_PROPERTY = { type: "string", "x-system": true }
const UPDATED_PROPERTY = { type: "string", "x-system": true }

describe("AuthCollection", () => {
  it("auth collection injects system fields", () => {
    const Users = AuthCollection.define("users", { displayName: Field.text({ required: true }) })

    expect(Users.schema).toEqual({
      "x-collection-kind": "auth",
      "x-indexes": [{ fields: ["email"], unique: true }],
      type: "object",
      properties: {
        id: ID_PROPERTY,
        seqId: SEQID_PROPERTY,
        email: { type: "string", format: "email", "x-system": true },
        password: { type: "string", "x-system": true, "x-hidden": true },
        emailVerified: { type: "boolean", "x-system": true, default: false },
        displayName: { type: "string" },
        created: CREATED_PROPERTY,
        updated: UPDATED_PROPERTY
      },
      required: ["email", "password", "displayName"]
    })
  })

  it("auth collection with no extraFields", () => {
    const Users = AuthCollection.define("users", {})
    expect(Users.schema.properties).toHaveProperty("id")
    expect(Users.schema.properties).toHaveProperty("email")
    expect(Users.schema.properties).toHaveProperty("password")
    expect(Users.schema.properties).toHaveProperty("seqId")
  })

  it("auto-injects id as system primary key before seqId", () => {
    const Users = AuthCollection.define("users", {})
    const keys = Object.keys(Users.schema.properties)
    expect(Users.schema.properties.id).toEqual(ID_PROPERTY)
    expect(keys.indexOf("id")).toBe(0)
    expect(keys.indexOf("seqId")).toBe(1)
    expect(Users.schema.required).not.toContain("id")
  })
})
