import { describe, expect, it } from "vitest"

import { BaseCollection } from "@/collection/base.js"
import { Bytes } from "@/collection/bytes.js"
import { Field } from "@/collection/field.js"

const ID_PROPERTY = { type: "string", "x-system": true, "x-generated": true }
const SEQID_PROPERTY = { type: "integer", "x-kind": "seqId", "x-system": true, "x-hidden": true, "x-generated": true }
const CREATED_PROPERTY = { type: "string", "x-system": true, "x-generated": true }
const UPDATED_PROPERTY = { type: "string", "x-system": true, "x-generated": true }

describe("BaseCollection", () => {
  it("full base collection schema matches expected", () => {
    const Users = BaseCollection.define("users", { email: Field.email() })
    const Posts = BaseCollection.define("posts", {
      title: Field.text({ maxLength: 200 }),
      content: Field.text({ required: false }),
      published: Field.boolean({ default: false, indexed: true }),
      userId: Field.relation(Users),
      avatar: Field.file({ maxSize: Bytes.fromMB(5), mimeTypes: ["image/*"] })
    }).indexes((I) => [I.unique("userId", "title")])

    expect(Posts.schema).toEqual({
      "x-collection-kind": "base",
      "x-indexes": [
        { fields: ["published"], unique: false },
        { fields: ["userId", "title"], unique: true }
      ],
      type: "object",
      properties: {
        id: ID_PROPERTY,
        seqId: SEQID_PROPERTY,
        title: { type: "string", maxLength: 200 },
        content: { type: "string" },
        published: { type: "boolean", default: false },
        userId: { type: "string", "x-kind": "relation", "x-collection": "users", "x-field": "id" },
        avatar: { type: "string", "x-kind": "file", "x-maxSize": 5_242_880, "x-mimeTypes": ["image/*"] },
        created: CREATED_PROPERTY,
        updated: UPDATED_PROPERTY
      },
      required: ["title", "userId", "avatar"]
    })
  })

  it("auto-injects id as system primary key before seqId", () => {
    const Col = BaseCollection.define("posts", { title: Field.text() })
    const keys = Object.keys(Col.schema.properties)
    expect(Col.schema.properties.id).toEqual(ID_PROPERTY)
    expect(keys.indexOf("id")).toBe(0)
    expect(keys.indexOf("seqId")).toBe(1)
    expect(Col.schema.required).not.toContain("id")
  })

  it("no indexes key when no indexes defined", () => {
    const Col = BaseCollection.define("simple", { title: Field.text() })
    expect(Col.schema).not.toHaveProperty("x-indexes")
  })

})

