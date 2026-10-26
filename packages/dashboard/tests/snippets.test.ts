import { describe, expect, it } from "vitest"

import type { ApiCollectionSchema } from "@gettersethya/mira-client"

import type { SnippetBlock, SnippetSection } from "../src/snippets.js"
import { curlSections, fetchSections, sdkSections } from "../src/snippets.js"

const users: ApiCollectionSchema = {
  name: "users",
  kind: "auth",
  required: ["email", "password", "displayName"],
  indexes: [{ fields: ["email"], unique: true }],
  fields: {
    id: { type: "string", "x-system": true, "x-generated": true },
    seqId: { type: "integer", "x-kind": "seqId", "x-system": true, "x-hidden": true, "x-generated": true },
    email: { type: "string", format: "email", "x-system": true },
    password: { type: "string", "x-system": true, "x-hidden": true, "x-kind": "password" },
    emailVerified: { type: "boolean", "x-system": true, default: false },
    displayName: { type: "string", maxLength: 100 },
    created: { type: "string", "x-system": true, "x-generated": true },
    updated: { type: "string", "x-system": true, "x-generated": true }
  }
}

const posts: ApiCollectionSchema = {
  name: "posts",
  kind: "base",
  required: ["title", "authorId"],
  indexes: [{ fields: ["published"], unique: false }],
  fields: {
    id: { type: "string", "x-system": true, "x-generated": true },
    seqId: { type: "integer", "x-kind": "seqId", "x-system": true, "x-hidden": true, "x-generated": true },
    title: { type: "string", maxLength: 200 },
    body: { type: "string" },
    published: { type: "boolean", default: false },
    authorId: { type: "string", "x-kind": "relation", "x-collection": "users", "x-field": "id" },
    cover: { type: "string", "x-kind": "file", "x-maxSize": 5242880, "x-mimeTypes": ["image/*"] },
    created: { type: "string", "x-system": true, "x-generated": true },
    updated: { type: "string", "x-system": true, "x-generated": true }
  }
}

const publishedPosts: ApiCollectionSchema = {
  name: "published_posts",
  kind: "view",
  viewQuery: "SELECT p.id, CAST(ROW_NUMBER() OVER (ORDER BY p.seqId) AS INTEGER) AS seqId, p.title FROM posts p WHERE p.published = 1",
  fields: {
    id: { type: "string", "x-view-only": true },
    seqId: { type: "integer", "x-kind": "seqId", "x-view-only": true },
    title: { type: "string", "x-view-only": true }
  }
}

const all = [users, posts, publishedPosts]
const baseUrl = "https://mira.example.com:9000"

function options(schema: ApiCollectionSchema) {
  return { schema, allSchemas: all, baseUrl }
}

function blocks(sections: ReadonlyArray<SnippetSection>): ReadonlyArray<SnippetBlock> {
  return sections.flatMap((section) => section.blocks)
}

function block(
  sections: ReadonlyArray<SnippetSection>,
  id: string
): SnippetBlock | undefined {
  return blocks(sections).find((candidate) => candidate.id === id)
}

function requiredBlock(sections: ReadonlyArray<SnippetSection>, id: string): SnippetBlock {
  const found = block(sections, id)
  if (found === undefined) throw new Error(`missing snippet block: ${id}`)
  return found
}

type FilterAst = {
  readonly op: string
  readonly field: string
  readonly value: unknown
}

function isFilterAst(value: unknown): value is FilterAst {
  return (
    typeof value === "object" &&
    value !== null &&
    "op" in value &&
    "field" in value &&
    "value" in value
  )
}

describe("sdkSections", () => {
  it("builds plain, server, and adapter sections", () => {
    const sections = sdkSections(options(posts))

    expect(sections.map((section) => section.id)).toEqual(["plain", "server", "adapter"])
    expect(requiredBlock(sections, "install").code).toBe(
      "pnpm add @gettersethya/mira-client"
    )
    expect(requiredBlock(sections, "client").code).toContain(
      "createMiraClient(\"https://mira.example.com:9000\").withCollections(collections)"
    )
    expect(requiredBlock(sections, "server-client").code).toContain('{ type: "server" }')
    expect(requiredBlock(sections, "server-token").code).toContain("mira.auth.setToken")
    expect(requiredBlock(sections, "adapter-setup").code).toContain("collectionAdapter")
    expect(requiredBlock(sections, "adapter-query").code).toContain(
      "mira.posts.getList().queryOptions"
    )
    expect(requiredBlock(sections, "adapter-mutation").code).toContain(
      "mira.posts.create().mutationOptions"
    )
  })

  it("adds a typed filter when a suitable field exists", () => {
    const list = requiredBlock(sdkSections(options(posts)), "list")

    expect(list.code).toContain('filter: (f) => f.field("title").eq("<title>"),')
    expect(list.code).toContain('sort: "title",')
  })

  it("adds an upload block when the collection has a file field", () => {
    const sections = sdkSections(options(posts))

    expect(requiredBlock(sections, "upload").code).toContain("cover: file")
  })

  it("adds login, register, and me for auth collections", () => {
    const sections = sdkSections(options(users))
    const ids = blocks(sections).map((candidate) => candidate.id)

    expect(ids).toContain("login")
    expect(ids).toContain("register")
    expect(ids).toContain("me")
    expect(requiredBlock(sections, "login").code).toContain("authWithPassword().raw")
    expect(requiredBlock(sections, "register").code).toContain("passwordConfirm")
  })

  it("keeps view collections read-only", () => {
    const sections = sdkSections(options(publishedPosts))
    const ids = blocks(sections).map((candidate) => candidate.id)

    expect(ids).toContain("list")
    expect(ids).toContain("get-one")
    expect(ids).toContain("note")
    expect(ids).not.toContain("create")
    expect(ids).not.toContain("update")
    expect(ids).not.toContain("delete")
    expect(ids).not.toContain("upload")
    expect(ids).not.toContain("adapter-mutation")
  })
})

describe("fetchSections", () => {
  it("keeps view collections read-only", () => {
    const sections = fetchSections(options(publishedPosts))
    const ids = blocks(sections).map((candidate) => candidate.id)

    expect(sections.map((section) => section.id)).toEqual(["read"])
    expect(ids).toContain("list")
    expect(ids).toContain("get-one")
    expect(ids).not.toContain("create")
    expect(ids).not.toContain("update")
    expect(ids).not.toContain("delete")
    expect(ids).not.toContain("upload")
  })

  it("adds read, write, and auth sections for auth collections", () => {
    const sections = fetchSections(options(users))
    const ids = blocks(sections).map((candidate) => candidate.id)

    expect(sections.map((section) => section.id)).toEqual(["read", "write", "auth"])
    expect(ids).toContain("login")
    expect(ids).toContain("me")
  })

  it("adds an upload block under write when a file field exists", () => {
    const sections = fetchSections(options(posts))
    const write = sections.find((section) => section.id === "write")

    expect(write).toBeDefined()
    expect(write?.blocks.map((candidate) => candidate.id)).toContain("upload")
  })

  it("interpolates the base URL verbatim", () => {
    for (const section of fetchSections(options(users))) {
      for (const candidate of section.blocks) {
        if (candidate.language === "json") continue
        expect(candidate.code).toContain(baseUrl)
      }
    }
  })

  it("carries a valid JSON filter AST", () => {
    const filter = requiredBlock(fetchSections(options(posts)), "filter")

    expect(filter.language).toBe("json")
    const parsed: unknown = JSON.parse(filter.code)
    expect(isFilterAst(parsed)).toBe(true)
    if (!isFilterAst(parsed)) return

    expect(parsed.op).toBe("eq")
    expect(parsed.field).toBe("title")
    expect(parsed.value).toBe("<title>")
  })

  it("includes required fields plus at most one optional non-file field", () => {
    const create = requiredBlock(fetchSections(options(posts)), "create")

    expect(create.code).toContain('title: "<title>"')
    expect(create.code).toContain('authorId: "<users.id>"')
    expect(create.code).toContain('body: "<body>"')
    expect(create.code).not.toContain("cover")
    expect(create.code).not.toContain("published")
  })

  it("adds auth fields to the auth create body", () => {
    const create = requiredBlock(fetchSections(options(users)), "create")

    expect(create.code).toContain('email: "user@example.com"')
    expect(create.code).toContain('password: "secret123"')
    expect(create.code).toContain('passwordConfirm: "secret123"')
    expect(create.code).toContain('displayName: "<displayName>"')
  })

  it("uses list query parameters only when applicable", () => {
    const list = requiredBlock(fetchSections(options(posts)), "list")

    expect(list.code).toContain('limit: "25"')
    expect(list.code).toContain('sort: "title"')
    expect(list.code).toContain('order: "desc"')
    expect(list.code).toContain('select: "title,body,published"')
    expect(list.code).toContain('expand: "authorId"')
  })
})

describe("curlSections", () => {
  it("mirrors the fetch sections with bash blocks", () => {
    const sections = curlSections(options(users))

    expect(sections.map((section) => section.id)).toEqual(["read", "write", "auth"])
    for (const candidate of blocks(sections)) {
      expect(candidate.language).toBe("bash")
    }
  })

  it("keeps view collections read-only", () => {
    const sections = curlSections(options(publishedPosts))
    const ids = blocks(sections).map((candidate) => candidate.id)

    expect(sections.map((section) => section.id)).toEqual(["read"])
    expect(ids).not.toContain("create")
    expect(ids).not.toContain("update")
    expect(ids).not.toContain("delete")
    expect(ids).not.toContain("upload")
  })

  it("adds an upload block for file fields", () => {
    const sections = curlSections(options(posts))
    const write = sections.find((section) => section.id === "write")

    expect(write).toBeDefined()
    expect(write?.blocks.map((candidate) => candidate.id)).toContain("upload")
  })

  it("uses no fetch calls or shell variables", () => {
    for (const schema of all) {
      for (const candidate of blocks(curlSections(options(schema)))) {
        expect(candidate.code).not.toContain("fetch(")
        expect(candidate.code).not.toMatch(/\$[A-Za-z_{]/)
      }
    }
  })

  it("interpolates the base URL verbatim", () => {
    for (const candidate of blocks(curlSections(options(posts)))) {
      expect(candidate.code).toContain(baseUrl)
    }
  })

  it("encodes the filter AST into the URL", () => {
    const filter = requiredBlock(curlSections(options(posts)), "filter")
    const encoded = encodeURIComponent(
      JSON.stringify({ op: "eq", field: "title", value: "<title>" })
    )

    expect(filter.code).toContain(`filter=${encoded}`)
  })
})
