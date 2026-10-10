import type { AnyCollectionDef } from "@gettersethya/mira-collection"
import { Field } from "@gettersethya/mira-collection"
import { afterAll, beforeEach, describe, expect, it } from "vitest"

import { createMiraClient } from "@/client/factory.js"

const Tasks: AnyCollectionDef = {
  name: "tasks",
  fields: { title: Field.text() },
  schema: {
    "x-collection-kind": "base",
    type: "object",
    properties: { title: { type: "string" } }
  }
}

// Effect resolves the `Fetch` reference default once (memoized), so install a
// single stub for the whole file and reset the capture buffer per test.
const originalFetch = globalThis.fetch
const captured: Array<RequestInit | undefined> = []

globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  captured.push(init)
  return new Response(JSON.stringify({ items: [], nextCursor: null }), {
    status: 200,
    headers: { "content-type": "application/json" }
  })
}) as typeof globalThis.fetch

afterAll(() => {
  globalThis.fetch = originalFetch
})

beforeEach(() => {
  captured.length = 0
})

describe("createMiraClient credentials", () => {
  it("browser mode sends credentials: 'include' on every request", async () => {
    const client = createMiraClient("http://localhost:8989", { type: "browser" }).withCollections({
      tasks: Tasks
    })

    await client.tasks.getList().raw()

    expect(captured.length).toBe(1)
    expect(captured[0]?.credentials).toBe("include")
  })

  it("server mode does not force credentials (uses default)", async () => {
    const client = createMiraClient("http://localhost:8989", { type: "server" }).withCollections({
      tasks: Tasks
    })

    await client.tasks.getList().raw()

    expect(captured.length).toBe(1)
    expect(captured[0]?.credentials).toBeUndefined()
  })
})
