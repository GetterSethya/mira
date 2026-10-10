import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { MutableRef } from "effect"
import { BaseCollection } from "@gettersethya/mira-client"
import { Field } from "@gettersethya/mira-client"
import { makeCollectionClient } from "@gettersethya/mira-client"
import type { ExecuteFn } from "@gettersethya/mira-client"
import { ActionKeys } from "../src/_core.js"
import type { MutationOptionsShape, QueryOptionsShape } from "../src/_core.js"
import { createSvelteCollectionAdapter } from "../src/svelte.js"

const Posts = BaseCollection.define("posts", { title: Field.text() })

function makeTestClient() {
  // These tests only assert query-key shapes and option passthrough — they never
  // invoke `execute`. A generic fake cannot produce `T` without a type assertion
  // (forbidden), so stub it as a defect, matching the hook-service test idiom.
  const execute: ExecuteFn = () => Effect.die("test stub: execute must not be called")

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

const identityQueryOptions = <T>(opts: QueryOptionsShape<T>): QueryOptionsShape<T> => opts
const identityMutationOptions = <TData, TInput>(
  opts: MutationOptionsShape<TData, TInput>
): MutationOptionsShape<TData, TInput> => opts
const adapter = createSvelteCollectionAdapter(identityQueryOptions, identityMutationOptions)

describe("createSvelteCollectionAdapter", () => {
  const adapted = adapter(makeTestClient(), "posts")

  it("getList — query key shape [name, GetList, options]", () => {
    const handler = adapted.getList({ limit: 5 })
    expect(handler.queryKey).toEqual(["posts", ActionKeys.GetList, { limit: 5 }])
  })

  it("getList — queryOptions carry the same queryKey and a queryFn", () => {
    const handler = adapted.getList()
    expect(handler.queryOptions.queryKey).toEqual(handler.queryKey)
    expect(typeof handler.queryOptions.queryFn).toBe("function")
  })

  it("create — mutationOptions carry a mutationFn", () => {
    expect(typeof adapted.create().mutationOptions.mutationFn).toBe("function")
  })
})
