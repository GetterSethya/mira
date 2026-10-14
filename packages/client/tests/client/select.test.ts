import { AuthCollection, BaseCollection, Field, ViewCollection } from "@gettersethya/mira-collection"
import { describe, expect, expectTypeOf, it } from "vitest"

import { createMiraClient } from "@/client/factory.js"
import type { GetListOptions, GetOneOptions } from "@/client/collection.js"
import type { InferRecord, RelationKeys, SelectableKeys, WithExpand, WithSelect } from "@/client/types.js"
import type { Option } from "effect"

const Authors = BaseCollection.define("authors", {
  name: Field.text(),
})

const Posts = BaseCollection.define("posts", {
  title: Field.text(),
  body: Field.text({ required: false }),
  views: Field.integer({ default: 0 }),
  secret: Field.text({ hidden: true }),
  author: Field.relation(Authors),
})

const Users = AuthCollection.define("users", {
  displayName: Field.text({ required: false }),
  ssn: Field.text({ hidden: true }),
})

const PostSummaries = ViewCollection.define(
  "post_summaries",
  "SELECT id, seqId, title, body, created, updated FROM posts",
  {
    id: Field.text().view(),
    seqId: Field.integer().view(),
    title: Field.text().view(),
    body: Field.text().view(),
  }
)

type PostFields = typeof Posts.fields
type UserFields = typeof Users.fields
type SummaryFields = typeof PostSummaries.fields

const mira = createMiraClient("http://localhost:8585").withCollections({
  posts: Posts,
  users: Users,
  summaries: PostSummaries,
})

// Module-scope handlers for select-narrowing assertions. Handlers build no
// network traffic until `.raw()` is called; only their types are queried
// below, so nothing here executes requests.
const selectedPostHandler = mira.posts.getOne("abc", { select: ["title"] })
type SelectedPost = Awaited<ReturnType<typeof selectedPostHandler.raw>>
const selectedExpandedPostHandler = mira.posts.getOne("abc", { select: ["title"], expand: ["author"] })
type SelectedExpandedPost = Awaited<ReturnType<typeof selectedExpandedPostHandler.raw>>
const emptySelectedPostHandler = mira.posts.getOne("abc", { select: [] })
type EmptySelectedPost = Awaited<ReturnType<typeof emptySelectedPostHandler.raw>>
const selectedSummaryHandler = mira.summaries.getOne("abc", { select: ["title"] })
type SelectedSummary = Awaited<ReturnType<typeof selectedSummaryHandler.raw>>

describe("option property types", () => {
  it("select/expand expose their constraints, not bare type params", () => {
    // Regression: the option properties used to be typed as the method's type
    // parameters (`select?: S`, `expand?: E`), so editors showed their defaults
    // (`select?: undefined`, `expand?: []`) on hover instead of the usable keys.
    expectTypeOf<GetListOptions<PostFields>["select"]>().toEqualTypeOf<
      ReadonlyArray<SelectableKeys<PostFields>> | undefined
    >()
    expectTypeOf<GetOneOptions<PostFields>["select"]>().toEqualTypeOf<
      ReadonlyArray<SelectableKeys<PostFields>> | undefined
    >()
    expectTypeOf<GetListOptions<PostFields>["expand"]>().toEqualTypeOf<
      ReadonlyArray<RelationKeys<PostFields>> | undefined
    >()
    expectTypeOf<GetOneOptions<PostFields>["expand"]>().toEqualTypeOf<
      ReadonlyArray<RelationKeys<PostFields>> | undefined
    >()
    expect(true).toBe(true)
  })
})

describe("SelectableKeys", () => {
  it("excludes hidden fields on base collections", () => {
    expectTypeOf<SelectableKeys<PostFields>>().toEqualTypeOf<"title" | "body" | "views" | "author">()
    expect(true).toBe(true)
  })

  it("excludes hidden extra fields on auth collections", () => {
    expectTypeOf<SelectableKeys<UserFields>>().toEqualTypeOf<"email" | "emailVerified" | "displayName">()
    expect(true).toBe(true)
  })

  it("covers view collection fields", () => {
    expectTypeOf<SelectableKeys<SummaryFields>>().toEqualTypeOf<"id" | "seqId" | "title" | "body">()
    expect(true).toBe(true)
  })
})

describe("WithSelect", () => {
  it("undefined select resolves to the full WithExpand type", () => {
    expectTypeOf<WithSelect<PostFields, undefined, []>>().toEqualTypeOf<WithExpand<PostFields, []>>()
    expect(true).toBe(true)
  })

  it("select narrows to selected + system fields", () => {
    expectTypeOf<WithSelect<PostFields, ["title"], []>>().toEqualTypeOf<
      Pick<InferRecord<PostFields>, "id" | "created" | "updated" | "title">
    >()
    expect(true).toBe(true)
  })

  it("empty select narrows to system fields only", () => {
    expectTypeOf<WithSelect<PostFields, [], []>>().toEqualTypeOf<
      Pick<InferRecord<PostFields>, "id" | "created" | "updated">
    >()
    expect(true).toBe(true)
  })

  it("select + expand keeps the local id column and the expand prop", () => {
    type Data = WithSelect<PostFields, ["title"], ["author"]>
    expectTypeOf<Data["title"]>().toEqualTypeOf<string>()
    expectTypeOf<Data["author"]>().toEqualTypeOf<string>()
    expectTypeOf<Data["expand"]["author"]["name"]>().toEqualTypeOf<string>()
    expectTypeOf<keyof Data>().toEqualTypeOf<"id" | "created" | "updated" | "title" | "author" | "expand">()
    expect(true).toBe(true)
  })
})

describe("getOne select narrowing", () => {
  it("without select returns the full record", () => {
    const handler = mira.posts.getOne("abc")
    type Data = Awaited<ReturnType<typeof handler.raw>>
    expectTypeOf<Data>().toEqualTypeOf<WithExpand<PostFields, []>>()
    expect(true).toBe(true)
  })

  it("with select returns only selected + system fields", () => {
    expectTypeOf<SelectedPost>().toEqualTypeOf<
      Pick<InferRecord<PostFields>, "id" | "created" | "updated" | "title">
    >()
    expectTypeOf<SelectedPost["title"]>().toEqualTypeOf<string>()
    // @ts-expect-error body was not selected
    expectTypeOf<SelectedPost["body"]>().toEqualTypeOf<never>()
    // @ts-expect-error views were not selected
    expectTypeOf<SelectedPost["views"]>().toEqualTypeOf<never>()
    expect(true).toBe(true)
  })

  it("with select + expand keeps the local id column and expand", () => {
    expectTypeOf<SelectedExpandedPost["title"]>().toEqualTypeOf<string>()
    expectTypeOf<SelectedExpandedPost["author"]>().toEqualTypeOf<string>()
    expectTypeOf<SelectedExpandedPost["expand"]["author"]["name"]>().toEqualTypeOf<string>()
    // @ts-expect-error body was not selected
    expectTypeOf<SelectedExpandedPost["body"]>().toEqualTypeOf<never>()
    expect(true).toBe(true)
  })

  it("with empty select returns system fields only", () => {
    expectTypeOf<EmptySelectedPost>().toEqualTypeOf<
      Pick<InferRecord<PostFields>, "id" | "created" | "updated">
    >()
    expectTypeOf<EmptySelectedPost["id"]>().toEqualTypeOf<string>()
    // @ts-expect-error title was not selected
    expectTypeOf<EmptySelectedPost["title"]>().toEqualTypeOf<never>()
    expect(true).toBe(true)
  })

  it("hidden field in select is a type error", () => {
    // @ts-expect-error secret is hidden and not selectable
    mira.posts.getOne("abc", { select: ["secret"] })
    expect(true).toBe(true)
  })
})

describe("getList select narrowing", () => {
  it("with select narrows each item", () => {
    const handler = mira.posts.getList({ select: ["title", "views"] })
    type Data = Awaited<ReturnType<typeof handler.raw>>
    expectTypeOf<Data["items"][number]>().toEqualTypeOf<
      Pick<InferRecord<PostFields>, "id" | "created" | "updated" | "title" | "views">
    >()
    expectTypeOf<Data["nextCursor"]>().toEqualTypeOf<number | null>()
    expect(true).toBe(true)
  })

  it("without select returns full items", () => {
    const handler = mira.posts.getList()
    type Data = Awaited<ReturnType<typeof handler.raw>>
    expectTypeOf<Data["items"][number]>().toEqualTypeOf<WithExpand<PostFields, []>>()
    expect(true).toBe(true)
  })
})

describe("getFirstOrNone / getFullList select narrowing", () => {
  it("getFirstOrNone with select + expand narrows the Option value", () => {
    const handler = mira.posts.getFirstOrNone((f) => f.field("title").eq("hi"), {
      select: ["title"],
      expand: ["author"],
    })
    type Data = Awaited<ReturnType<typeof handler.raw>>
    expectTypeOf<Data>().toEqualTypeOf<Option.Option<WithSelect<PostFields, ["title"], ["author"]>>>()
    expect(true).toBe(true)
  })

  it("getFullList with select narrows each element", () => {
    const handler = mira.posts.getFullList({ select: ["title"] })
    type Data = Awaited<ReturnType<typeof handler.raw>>
    expectTypeOf<Data[number]>().toEqualTypeOf<
      Pick<InferRecord<PostFields>, "id" | "created" | "updated" | "title">
    >()
    expect(true).toBe(true)
  })
})

describe("auth + view collection shapes", () => {
  it("auth getOne with select narrows extra fields", () => {
    const handler = mira.users.getOne("abc", { select: ["displayName"] })
    type Data = Awaited<ReturnType<typeof handler.raw>>
    expectTypeOf<Data>().toEqualTypeOf<
      Pick<InferRecord<UserFields>, "id" | "created" | "updated" | "displayName">
    >()
    expect(true).toBe(true)
  })

  it("auth hidden extra field in select is a type error", () => {
    // @ts-expect-error ssn is hidden and not selectable
    mira.users.getOne("abc", { select: ["ssn"] })
    expect(true).toBe(true)
  })

  it("auth create / me keep the full record type", () => {
    const creator = mira.users.create()
    type Created = Awaited<ReturnType<typeof creator.raw>>
    expectTypeOf<Created>().toEqualTypeOf<InferRecord<UserFields>>()
    const meHandler = mira.users.me()
    type Me = Awaited<ReturnType<typeof meHandler.raw>>
    expectTypeOf<Me>().toEqualTypeOf<InferRecord<UserFields>>()
    expect(true).toBe(true)
  })

  it("view getOne with select narrows view fields", () => {
    expectTypeOf<SelectedSummary>().toEqualTypeOf<
      Pick<InferRecord<SummaryFields>, "id" | "created" | "updated" | "title">
    >()
    // @ts-expect-error body was not selected
    expectTypeOf<SelectedSummary["body"]>().toEqualTypeOf<never>()
    expect(true).toBe(true)
  })

  it("view getList without select returns the full record", () => {
    const handler = mira.summaries.getList()
    type Data = Awaited<ReturnType<typeof handler.raw>>
    expectTypeOf<Data["items"][number]>().toEqualTypeOf<WithExpand<SummaryFields, []>>()
    expect(true).toBe(true)
  })
})
