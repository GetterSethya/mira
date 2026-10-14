import type { InferRecord } from "@gettersethya/mira-client"
import { BaseCollection, createMiraClient, Field } from "@gettersethya/mira-client"
import { describe, expect, expectTypeOf, it } from "vitest"

import { ActionKeys, collectionAdapter } from "../src/index.js"

const Authors = BaseCollection.define("authors", {
  name: Field.text(),
})

const Posts = BaseCollection.define("posts", {
  title: Field.text(),
  body: Field.text(),
  secret: Field.text({ hidden: true }),
  author: Field.relation(Authors),
})

type PostFields = typeof Posts.fields

const Mira = createMiraClient("http://localhost:8989", { type: "browser" }).withCollections(
  { posts: Posts },
  { adapter: collectionAdapter }
)

describe("adapted select narrowing", () => {
  it("getOne with select narrows the data and keeps query metadata", () => {
    const handler = Mira.posts.getOne("abc", { select: ["title"] })
    type Data = Awaited<ReturnType<typeof handler.raw>>
    expectTypeOf<Data>().toEqualTypeOf<
      Pick<InferRecord<PostFields>, "id" | "created" | "updated" | "title">
    >()
    expectTypeOf<Data["title"]>().toEqualTypeOf<string>()
    // @ts-expect-error body was not selected
    expectTypeOf<Data["body"]>().toEqualTypeOf<never>()
    expect(handler.queryKey[0]).toBe("posts")
    expect(handler.queryKey[1]).toBe(ActionKeys.GetOne)
    expect(typeof handler.queryOptions.queryFn).toBe("function")
  })

  it("getList with select + expand narrows items and keeps query metadata", () => {
    const handler = Mira.posts.getList({ select: ["title"], expand: ["author"] })
    type Data = Awaited<ReturnType<typeof handler.queryOptions.queryFn>>
    expectTypeOf<Data["items"][number]["title"]>().toEqualTypeOf<string>()
    expectTypeOf<Data["items"][number]["author"]>().toEqualTypeOf<string>()
    expectTypeOf<Data["items"][number]["expand"]["author"]["name"]>().toEqualTypeOf<string>()
    // @ts-expect-error body was not selected
    expectTypeOf<Data["items"][number]["body"]>().toEqualTypeOf<never>()
    expect(handler.queryKey[1]).toBe(ActionKeys.GetList)
  })

  it("getFirstOrNone / getFullList with select narrow through the adapter", () => {
    const first = Mira.posts.getFirstOrNone((f) => f.field("title").eq("hi"), { select: ["title"] })
    type First = Awaited<ReturnType<typeof first.raw>>
    expectTypeOf<First>().not.toBeNever()
    const full = Mira.posts.getFullList({ select: ["title"] })
    type Full = Awaited<ReturnType<typeof full.raw>>
    expectTypeOf<Full[number]>().toEqualTypeOf<
      Pick<InferRecord<PostFields>, "id" | "created" | "updated" | "title">
    >()
  })

  it("hidden field in select is a type error through the adapter", () => {
    // @ts-expect-error secret is hidden and not selectable
    Mira.posts.getOne("abc", { select: ["secret"] })
    expect(true).toBe(true)
  })

  it("without select the adapted result is unchanged", () => {
    const handler = Mira.posts.getOne("abc")
    type Data = Awaited<ReturnType<typeof handler.raw>>
    expectTypeOf<Data["body"]>().toEqualTypeOf<string>()
    expect(true).toBe(true)
  })
})
