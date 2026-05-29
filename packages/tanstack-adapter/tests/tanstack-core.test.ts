import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { MutableRef } from "effect"
import { HttpClientRequest } from "@effect/platform"
import { ActionKeys, createCollectionAdapter, enrichMutation, enrichQuery } from "../src/_core.js"
import type { QueryKey } from "../src/_core.js"
import { makeClientHandler, makeMutationHandler } from "@gettersethya/mira-client"
import { makeCollectionClient } from "@gettersethya/mira-client"
import type { ExecuteFn } from "@gettersethya/mira-client"
import { MiraError } from "@gettersethya/mira-client"
import { BaseCollection } from "@gettersethya/mira-client"
import { Field } from "@gettersethya/mira-client"

const Posts = BaseCollection.define("posts", { title: Field.text() })

function makeTestClient() {
  const execute: ExecuteFn = <T>(req: HttpClientRequest.HttpClientRequest) =>
    Effect.gen(function* () {
      if (req.method === "DELETE") return undefined as T
      if (req.url.includes("auth-with-password")) return { token: "tok", record: { id: "1", created: "", updated: "", title: "" } } as T
      if (req.method === "GET") return { items: [], nextCursor: null } as T
      return { id: "1", created: "", updated: "", title: "test" } as T
    })

  return makeCollectionClient({
    collectionName: "posts",
    schema: Posts.schema,
    fields: Posts.fields,
    execute,
    baseUrl: "http://localhost",
    authTokenRef: null,
    loggedInRef: null,
    fileTokenCacheRef: MutableRef.make(new Map()),
    isAuth: false,
  })
}

const identity = <T>(opts: T): T => opts
const adapter = createCollectionAdapter(identity, identity)

describe("ActionKeys", () => {
  it("has the correct constant values", () => {
    expect(ActionKeys.GetList).toBe("getList")
    expect(ActionKeys.GetOne).toBe("getOne")
    expect(ActionKeys.GetFirstOrNone).toBe("getFirstOrNone")
    expect(ActionKeys.GetFullList).toBe("getFullList")
  })
})

describe("enrichQuery", () => {
  it("attaches queryKey and queryOptions to handler", async () => {
    const handler = makeClientHandler(Effect.succeed(42))
    const enriched = enrichQuery(handler, ["col", "getList", {}], identity)
    expect(enriched.queryKey).toEqual(["col", "getList", {}])
    expect(enriched.queryOptions.queryKey).toEqual(["col", "getList", {}])
    expect(await enriched.queryOptions.queryFn()).toBe(42)
  })
})

describe("enrichMutation", () => {
  it("attaches mutationOptions to handler", async () => {
    const handler = makeMutationHandler((x: string) =>
      Effect.succeed(x.toUpperCase())
    )
    const enriched = enrichMutation(handler, identity)
    expect(await enriched.mutationOptions.mutationFn("hello")).toBe("HELLO")
  })
})

describe("createCollectionAdapter", () => {
  const client = makeTestClient()
  const adapted = adapter(client, "posts")

  it("getList — query key shape [name, GetList, options]", () => {
    const handler = adapted.getList({ limit: 5 })
    expect(handler.queryKey).toEqual(["posts", ActionKeys.GetList, { limit: 5 }])
  })

  it("getList with no options — options defaults to {}", () => {
    const handler = adapted.getList()
    expect(handler.queryKey).toEqual(["posts", ActionKeys.GetList, {}])
  })

  it("getList — queryOptions.queryKey matches queryKey", () => {
    const handler = adapted.getList()
    expect(handler.queryOptions.queryKey).toEqual(handler.queryKey)
  })

  it("getList — queryOptions.queryFn resolves the raw value", async () => {
    const handler = adapted.getList()
    const result = await handler.queryOptions.queryFn()
    expect(result).toEqual({ items: [], nextCursor: null })
  })

  it("getOne — query key shape [name, GetOne, id, options]", () => {
    const handler = adapted.getOne("abc123")
    expect(handler.queryKey[0]).toBe("posts")
    expect(handler.queryKey[1]).toBe(ActionKeys.GetOne)
    expect(handler.queryKey[2]).toBe("abc123")
  })

  it("getFirstOrNone — query key shape includes options", () => {
    const handler = adapted.getFirstOrNone(
      (f) => f.field("title").eq("hi"),
      { sort: "title" }
    )
    expect(handler.queryKey[1]).toBe(ActionKeys.GetFirstOrNone)
    expect(handler.queryKey[2]).toEqual({ sort: "title" })
  })

  it("getFullList — query key shape", () => {
    const handler = adapted.getFullList()
    expect(handler.queryKey).toEqual(["posts", ActionKeys.GetFullList, {}])
  })

  it("create — mutationOptions.mutationFn delegates to handler.raw", async () => {
    const result = await adapted.create().mutationOptions.mutationFn({ title: "hi" })
    expect(result).toMatchObject({ id: "1" })
  })

  it("update — mutationOptions.mutationFn delegates to handler.raw", async () => {
    const result = await adapted.update().mutationOptions.mutationFn({ id: "x", data: { title: "new" } })
    expect(result).toMatchObject({ id: "1" })
  })

  it("delete — mutationOptions.mutationFn delegates to handler.raw", async () => {
    const result = await adapted.delete().mutationOptions.mutationFn("abc")
    expect(result).toBeUndefined()
  })

  it("invalidateAll calls invalidateQueries with collection key", () => {
    const calls: Array<{ queryKey: QueryKey }> = []
    const mockQC = { invalidateQueries: (opts: { queryKey: QueryKey }) => { calls.push(opts) } }
    adapted.invalidateAll(mockQC)
    expect(calls[0]).toEqual({ queryKey: ["posts"] })
  })

  it("invalidateOne calls invalidateQueries with [name, GetOne, id]", () => {
    const calls: Array<{ queryKey: QueryKey }> = []
    const mockQC = { invalidateQueries: (opts: { queryKey: QueryKey }) => { calls.push(opts) } }
    adapted.invalidateOne(mockQC, "rec-1")
    expect(calls[0]).toEqual({ queryKey: ["posts", ActionKeys.GetOne, "rec-1"] })
  })

  it("non-overridden fields pass through from original client", () => {
    const original = makeTestClient()
    const wrapped = adapter(original, "posts")
    expect(wrapped.fields).toBe(original.fields)
  })
})
