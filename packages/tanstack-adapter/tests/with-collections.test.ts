import { AuthCollection, BaseCollection, createMiraClient,Field } from "@gettersethya/mira-client"
import { describe, expect, it } from "vitest"

import type { QueryKey } from "../src/index.js"
import { ActionKeys, collectionAdapter } from "../src/index.js"

const Todo = BaseCollection.define("todos", {
  title: Field.text(),
  done: Field.boolean({ default: false }),
})
const User = AuthCollection.define("users", {
  name: Field.text(),
})

// Type-level: the adapter must be accepted by `withCollections(map, { adapter })`
// and the returned accessors must expose query/mutation metadata.
const Mira = createMiraClient("http://localhost:8989", { type: "browser" }).withCollections(
  { Todo, User },
  { adapter: collectionAdapter }
)

describe("withCollections({ adapter })", () => {
  it("adapts every accessor — query key uses def.name and carries queryOptions", () => {
    const handler = Mira.Todo.getList({ limit: 5 })
    expect(handler.queryKey).toEqual(["todos", ActionKeys.GetList, { limit: 5 }])
    expect(handler.queryOptions.queryKey).toEqual(handler.queryKey)
    expect(typeof handler.queryOptions.queryFn).toBe("function")
  })

  it("enriches mutations with mutationOptions", () => {
    const opts = Mira.Todo.create().mutationOptions
    expect(typeof opts.mutationFn).toBe("function")
  })

  it("preserves auth accessors on auth collections", () => {
    expect(typeof Mira.User.authWithPassword().raw).toBe("function")
    expect(typeof Mira.User.register().mutationOptions.mutationFn).toBe("function")
  })

  it("getOne query key uses def.name and the record id", () => {
    expect(Mira.Todo.getOne("abc").queryKey).toEqual(["todos", ActionKeys.GetOne, "abc", {}])
  })

  it("invalidateAll targets the collection name prefix", () => {
    const calls: Array<{ queryKey: QueryKey }> = []
    Mira.Todo.invalidateAll({ invalidateQueries: (opts) => { calls.push(opts) } })
    expect(calls[0]).toEqual({ queryKey: ["todos"] })
  })

  it("the adapted handler retains the original raw() method", () => {
    expect(typeof Mira.Todo.getList().raw).toBe("function")
  })
})
