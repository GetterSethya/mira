import { describe, expect, it } from "vitest"

import { Field } from "@/collection/field.js"
import { ViewCollection, validateViewFields } from "@/collection/view.js"

describe("ViewCollection", () => {
  it("view collection schema", () => {
    const View = ViewCollection.define(
      "posts_with_author",
      "SELECT p.id, p.seqId, p.title, u.email as author_email FROM posts p JOIN users u ON p.user_id = u.id",
      {
        id: Field.text().view(),
        seqId: Field.integer().view(),
        title: Field.text().view(),
        authorEmail: Field.email().view()
      }
    )

    expect(View.schema).toEqual({
      "x-collection-kind": "view",
      "x-view-query": "SELECT p.id, p.seqId, p.title, u.email as author_email FROM posts p JOIN users u ON p.user_id = u.id",
      type: "object",
      properties: {
        id: { type: "string", "x-view-only": true },
        seqId: { type: "integer", "x-view-only": true },
        title: { type: "string", "x-view-only": true },
        authorEmail: { type: "string", format: "email", "x-view-only": true }
      },
      required: ["id", "seqId", "title", "authorEmail"]
    })
  })

  it("view collection has no x-indexes", () => {
    const View = ViewCollection.define("simple_view", "SELECT id, seqId, title FROM posts", {
      id: Field.text().view(),
      seqId: Field.integer().view(),
      title: Field.text().view()
    })
    expect(View.schema).not.toHaveProperty("x-indexes")
  })
})

describe("ViewCollection.define() guard", () => {
  it("throws when id is missing", () => {
    expect(() =>
      validateViewFields("v", {
        seqId: Field.integer().view(),
        title: Field.text().view()
      })
    ).toThrow(/"id" must be declared with \.view\(\)/)
  })

  it("throws when seqId is missing", () => {
    expect(() =>
      validateViewFields("v", {
        id:    Field.text().view(),
        title: Field.text().view()
      })
    ).toThrow(/"seqId" must be declared with \.view\(\)/)
  })

  it("throws when id is present but not .view()", () => {
    expect(() =>
      validateViewFields("v", {
        id:    Field.text(),
        seqId: Field.integer().view()
      })
    ).toThrow(/"id" must be declared with \.view\(\)/)
  })

  it("throws when seqId is present but not .view()", () => {
    expect(() =>
      validateViewFields("v", {
        id:    Field.text().view(),
        seqId: Field.integer()
      })
    ).toThrow(/"seqId" must be declared with \.view\(\)/)
  })

  it("succeeds with valid id and seqId", () => {
    expect(() =>
      validateViewFields("active_posts", {
        id:    Field.text().view(),
        seqId: Field.integer().view()
      })
    ).not.toThrow()
  })
})
