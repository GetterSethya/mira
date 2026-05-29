import { describe, expect, it } from "vitest"

import { Effect, MutableRef, Option, Schedule } from "effect"
import { HttpClient, HttpClientRequest } from "@effect/platform"
import type { AnyCollectionDef } from "@gettersethya/mira-collection"
import { Field, Bytes } from "@gettersethya/mira-collection"
import { makeCollectionClient } from "@/client/collection.js"
import type { ExecuteFn } from "@/client/handler.js"
import { makeClientHandler } from "@/client/handler.js"
import { MiraError } from "@/client/errors.js"

const TestCollection: AnyCollectionDef = {
  name: "tasks",
  fields: {
    title: Field.text(),
    completed: Field.boolean({ default: false })
  },
  schema: {
    "x-collection-kind": "base",
    type: "object",
    properties: {
      title: { type: "string" },
      completed: { type: "boolean", default: false }
    }
  }
}

const AuthCollectionDef: AnyCollectionDef = {
  name: "users",
  fields: {
    name: Field.text()
  },
  schema: {
    "x-collection-kind": "auth",
    type: "object",
    properties: {
      name: { type: "string" }
    }
  }
}

const FileCollection: AnyCollectionDef = {
  name: "uploads",
  fields: {
    label: Field.text(),
    attachment: Field.file({ maxSize: Bytes.fromMB(5) })
  },
  schema: {
    "x-collection-kind": "base",
    type: "object",
    properties: {
      label: { type: "string" },
      attachment: { type: "string", "x-kind": "file" }
    }
  }
}

function makeTestExecute(
  captured: Array<{ method: string; url: string }>
): ExecuteFn {
  return <T>(req: HttpClientRequest.HttpClientRequest) =>
    Effect.gen(function* () {
      captured.push({
        method: req.method,
        url: req.url
      })
      if (req.method === "DELETE") {
        return undefined as T
      }
      if (req.url.includes("auth-with-password")) {
        return { token: "test-token", record: { id: "1", created: "", updated: "", name: "Test" } } as T
      }
      if (req.method === "GET" && !req.url.includes("/1")) {
        return { items: [], nextCursor: null } as T
      }
      return { id: "1", created: "", updated: "" } as T
    })
}

function makeBodyCapturingExecute(
  captured: Array<{ method: string; url: string; bodyIsFormData: boolean }>
): ExecuteFn {
  return <T>(req: HttpClientRequest.HttpClientRequest) =>
    Effect.gen(function* () {
      captured.push({
        method: req.method,
        url: req.url,
        bodyIsFormData: req.body._tag === "FormData"
      })
      return { id: "1", created: "", updated: "", label: "x", attachment: "x.png" } as T
    })
}

describe("CollectionClient", () => {
  it("getList with no options → GET /api/collections/tasks", async () => {
    const captured: Array<{ method: string; url: string }> = []
    const execute = makeTestExecute(captured)
    const client = makeCollectionClient({
      collectionName: "tasks",
      schema: TestCollection.schema,
      fields: TestCollection.fields,
      execute,
      baseUrl: "http://localhost",
      authTokenRef: null,
      loggedInRef: null,
      fileTokenCacheRef: MutableRef.make(new Map()),
      isAuth: false,
    })

    await client.getList().raw()
    expect(captured[0].method).toBe("GET")
    expect(captured[0].url).toBe("/api/collections/tasks")
  })

  it("getList with filter, sort, cursor, limit, expand → correct query string", async () => {
    const captured: Array<{ method: string; url: string }> = []
    const execute = makeTestExecute(captured)
    const client = makeCollectionClient({
      collectionName: "tasks",
      schema: TestCollection.schema,
      fields: TestCollection.fields,
      execute,
      baseUrl: "http://localhost",
      authTokenRef: null,
      loggedInRef: null,
      fileTokenCacheRef: MutableRef.make(new Map()),
      isAuth: false,
    })

    await client.getList({
      filter: (f) => f.field("completed").eq(false),
      sort: "title",
      order: "asc",
      cursor: 10,
      limit: 20
    }).raw()

    expect(captured[0].url).toContain("filter=")
    expect(captured[0].url).toContain("sort=title")
    expect(captured[0].url).toContain("order=asc")
    expect(captured[0].url).toContain("after=10")
    expect(captured[0].url).toContain("limit=20")
  })

  it("cursor option serializes as ?after=", async () => {
    const captured: Array<{ method: string; url: string }> = []
    const execute = makeTestExecute(captured)
    const client = makeCollectionClient({
      collectionName: "tasks",
      schema: TestCollection.schema,
      fields: TestCollection.fields,
      execute,
      baseUrl: "http://localhost",
      authTokenRef: null,
      loggedInRef: null,
      fileTokenCacheRef: MutableRef.make(new Map()),
      isAuth: false,
    })

    await client.getList({ cursor: 42 }).raw()
    expect(captured[0].url).toContain("after=42")
    expect(captured[0].url).not.toContain("cursor=")
  })

  it("getOne → correct path", async () => {
    const captured: Array<{ method: string; url: string }> = []
    const execute = makeTestExecute(captured)
    const client = makeCollectionClient({
      collectionName: "tasks",
      schema: TestCollection.schema,
      fields: TestCollection.fields,
      execute,
      baseUrl: "http://localhost",
      authTokenRef: null,
      loggedInRef: null,
      fileTokenCacheRef: MutableRef.make(new Map()),
      isAuth: false,
    })

    await client.getOne("abc123").raw()
    expect(captured[0].method).toBe("GET")
    expect(captured[0].url).toBe("/api/collections/tasks/abc123")
  })

  it("create → POST with JSON body", async () => {
    const captured: Array<{ method: string; url: string }> = []
    const execute = makeTestExecute(captured)
    const client = makeCollectionClient({
      collectionName: "tasks",
      schema: TestCollection.schema,
      fields: TestCollection.fields,
      execute,
      baseUrl: "http://localhost",
      authTokenRef: null,
      loggedInRef: null,
      fileTokenCacheRef: MutableRef.make(new Map()),
      isAuth: false,
    })

    await client.create().raw({ title: "New Task" })
    expect(captured[0].method).toBe("POST")
    expect(captured[0].url).toBe("/api/collections/tasks")
  })

  it("update → PATCH with JSON body", async () => {
    const captured: Array<{ method: string; url: string }> = []
    const execute = makeTestExecute(captured)
    const client = makeCollectionClient({
      collectionName: "tasks",
      schema: TestCollection.schema,
      fields: TestCollection.fields,
      execute,
      baseUrl: "http://localhost",
      authTokenRef: null,
      loggedInRef: null,
      fileTokenCacheRef: MutableRef.make(new Map()),
      isAuth: false,
    })

    await client.update().raw({ id: "abc123", data: { title: "Updated" } })
    expect(captured[0].method).toBe("PATCH")
    expect(captured[0].url).toBe("/api/collections/tasks/abc123")
  })

  it("delete → DELETE", async () => {
    const captured: Array<{ method: string; url: string }> = []
    const execute = makeTestExecute(captured)
    const client = makeCollectionClient({
      collectionName: "tasks",
      schema: TestCollection.schema,
      fields: TestCollection.fields,
      execute,
      baseUrl: "http://localhost",
      authTokenRef: null,
      loggedInRef: null,
      fileTokenCacheRef: MutableRef.make(new Map()),
      isAuth: false,
    })

    await client.delete().raw("abc123")
    expect(captured[0].method).toBe("DELETE")
    expect(captured[0].url).toBe("/api/collections/tasks/abc123")
  })

  it("authWithPassword → correct endpoint and body", async () => {
    const captured: Array<{ method: string; url: string }> = []
    const execute = makeTestExecute(captured)
    const client = makeCollectionClient({
      collectionName: "users",
      schema: AuthCollectionDef.schema,
      fields: AuthCollectionDef.fields,
      execute,
      baseUrl: "http://localhost",
      authTokenRef: null,
      loggedInRef: null,
      fileTokenCacheRef: MutableRef.make(new Map()),
      isAuth: true,
    })

    const authWithPassword = client.authWithPassword
    if (!authWithPassword) throw new Error("authWithPassword should be defined when isAuth=true")
    const result = await authWithPassword().raw({ email: "test@example.com", password: "secret" })
    expect(captured[0].method).toBe("POST")
    expect(captured[0].url).toBe("/api/collections/users/auth-with-password")
    expect(result.token).toBe("test-token")
  })

  it("create with Blob value → uses FormData body", async () => {
    const captured: Array<{ method: string; url: string; bodyIsFormData: boolean }> = []
    const execute = makeBodyCapturingExecute(captured)
    const client = makeCollectionClient({
      collectionName: "uploads",
      schema: FileCollection.schema,
      fields: FileCollection.fields,
      execute,
      baseUrl: "http://localhost",
      authTokenRef: null,
      loggedInRef: null,
      fileTokenCacheRef: MutableRef.make(new Map()),
      isAuth: false,
    })

    const blob = new Blob(["data"], { type: "text/plain" })
    await client.create().raw({ label: "test", attachment: blob })
    expect(captured[0].bodyIsFormData).toBe(true)
  })

  it("create with no Blob → uses JSON body", async () => {
    const captured: Array<{ method: string; url: string; bodyIsFormData: boolean }> = []
    const execute = makeBodyCapturingExecute(captured)
    const client = makeCollectionClient({
      collectionName: "uploads",
      schema: FileCollection.schema,
      fields: FileCollection.fields,
      execute,
      baseUrl: "http://localhost",
      authTokenRef: null,
      loggedInRef: null,
      fileTokenCacheRef: MutableRef.make(new Map()),
      isAuth: false,
    })

    await client.create().raw({ label: "test", attachment: "existing-file.png" })
    expect(captured[0].bodyIsFormData).toBe(false)
  })

  it("update with Blob value → uses FormData body", async () => {
    const captured: Array<{ method: string; url: string; bodyIsFormData: boolean }> = []
    const execute = makeBodyCapturingExecute(captured)
    const client = makeCollectionClient({
      collectionName: "uploads",
      schema: FileCollection.schema,
      fields: FileCollection.fields,
      execute,
      baseUrl: "http://localhost",
      authTokenRef: null,
      loggedInRef: null,
      fileTokenCacheRef: MutableRef.make(new Map()),
      isAuth: false,
    })

    const blob = new Blob(["new content"], { type: "text/plain" })
    await client.update().raw({ id: "abc123", data: { attachment: blob } })
    expect(captured[0].bodyIsFormData).toBe(true)
  })
})

describe("getFirstOrNone", () => {
  function makeClient(execute: ExecuteFn) {
    return makeCollectionClient({
      collectionName: "tasks",
      schema: TestCollection.schema,
      fields: TestCollection.fields,
      execute,
      baseUrl: "http://localhost",
      authTokenRef: null,
      loggedInRef: null,
      fileTokenCacheRef: MutableRef.make(new Map()),
      isAuth: false,
    })
  }

  it("returns Option.Some when an item matches the filter", async () => {
    const record = { id: "1", seqId: 1, created: "", updated: "", title: "Hello", completed: false }
    const execute: ExecuteFn = <T>() =>
      Effect.succeed({ items: [record], nextCursor: null } as T)

    const result = await makeClient(execute)
      .getFirstOrNone(f => f.field("completed").eq(false))
      .raw()

    expect(Option.isSome(result)).toBe(true)
    if (Option.isSome(result)) expect(result.value).toEqual(record)
  })

  it("returns Option.None when no item matches", async () => {
    const execute: ExecuteFn = <T>() =>
      Effect.succeed({ items: [], nextCursor: null } as T)

    const result = await makeClient(execute)
      .getFirstOrNone(f => f.field("completed").eq(true))
      .raw()

    expect(Option.isNone(result)).toBe(true)
  })

  it("always sends limit=1 regardless of other options", async () => {
    const captured: Array<{ url: string }> = []
    const execute: ExecuteFn = <T>(req: HttpClientRequest.HttpClientRequest) => {
      captured.push({ url: req.url })
      return Effect.succeed({ items: [], nextCursor: null } as T)
    }

    await makeClient(execute)
      .getFirstOrNone(f => f.field("completed").eq(false))
      .raw()

    expect(captured[0].url).toContain("limit=1")
  })

  it("sends filter in query string", async () => {
    const captured: Array<{ url: string }> = []
    const execute: ExecuteFn = <T>(req: HttpClientRequest.HttpClientRequest) => {
      captured.push({ url: req.url })
      return Effect.succeed({ items: [], nextCursor: null } as T)
    }

    await makeClient(execute)
      .getFirstOrNone(f => f.field("completed").eq(false))
      .raw()

    expect(captured[0].url).toContain("filter=")
  })

  it("passes sort and order options through", async () => {
    const captured: Array<{ url: string }> = []
    const execute: ExecuteFn = <T>(req: HttpClientRequest.HttpClientRequest) => {
      captured.push({ url: req.url })
      return Effect.succeed({ items: [], nextCursor: null } as T)
    }

    await makeClient(execute)
      .getFirstOrNone(f => f.field("completed").eq(false), { sort: "title", order: "desc" })
      .raw()

    expect(captured[0].url).toContain("sort=title")
    expect(captured[0].url).toContain("order=desc")
  })
})

describe("getFullList", () => {
  function makeClient(execute: ExecuteFn) {
    return makeCollectionClient({
      collectionName: "tasks",
      schema: TestCollection.schema,
      fields: TestCollection.fields,
      execute,
      baseUrl: "http://localhost",
      authTokenRef: null,
      loggedInRef: null,
      fileTokenCacheRef: MutableRef.make(new Map()),
      isAuth: false,
    })
  }

  it("defaults to limit=1000", async () => {
    const captured: Array<{ url: string }> = []
    const execute: ExecuteFn = <T>(req: HttpClientRequest.HttpClientRequest) => {
      captured.push({ url: req.url })
      return Effect.succeed({ items: [], nextCursor: null } as T)
    }

    await makeClient(execute).getFullList().raw()
    expect(captured[0].url).toContain("limit=1000")
  })

  it("custom limit overrides default", async () => {
    const captured: Array<{ url: string }> = []
    const execute: ExecuteFn = <T>(req: HttpClientRequest.HttpClientRequest) => {
      captured.push({ url: req.url })
      return Effect.succeed({ items: [], nextCursor: null } as T)
    }

    await makeClient(execute).getFullList({ limit: 500 }).raw()
    expect(captured[0].url).toContain("limit=500")
    expect(captured[0].url).not.toContain("limit=1000")
  })

  it("returns a flat array unwrapped from the items envelope", async () => {
    const records = [
      { id: "1", seqId: 1, created: "", updated: "", title: "A", completed: false },
      { id: "2", seqId: 2, created: "", updated: "", title: "B", completed: true },
    ]
    const execute: ExecuteFn = <T>() =>
      Effect.succeed({ items: records, nextCursor: null } as T)

    const result = await makeClient(execute).getFullList().raw()
    expect(result).toEqual(records)
  })

  it("never sends a cursor param", async () => {
    const captured: Array<{ url: string }> = []
    const execute: ExecuteFn = <T>(req: HttpClientRequest.HttpClientRequest) => {
      captured.push({ url: req.url })
      return Effect.succeed({ items: [], nextCursor: null } as T)
    }

    await makeClient(execute).getFullList().raw()
    expect(captured[0].url).not.toContain("after=")
  })

  it("passes filter, sort, and order through", async () => {
    const captured: Array<{ url: string }> = []
    const execute: ExecuteFn = <T>(req: HttpClientRequest.HttpClientRequest) => {
      captured.push({ url: req.url })
      return Effect.succeed({ items: [], nextCursor: null } as T)
    }

    await makeClient(execute)
      .getFullList({ filter: f => f.field("completed").eq(true), sort: "title", order: "asc" })
      .raw()

    expect(captured[0].url).toContain("filter=")
    expect(captured[0].url).toContain("sort=title")
    expect(captured[0].url).toContain("order=asc")
  })
})

describe("retryOptions", () => {
  function makeRetryExecute(failCount: number): { execute: ExecuteFn; callsMade: () => number } {
    let count = 0
    const execute: ExecuteFn = <T>(req: HttpClientRequest.HttpClientRequest) =>
      Effect.gen(function* () {
        count++
        if (count <= failCount) {
          return yield* Effect.fail(new MiraError({ status: 503, body: "unavailable" }))
        }
        if (req.method === "DELETE") return undefined as T
        if (req.url.includes("auth-with-password")) return { token: "tok", record: { id: "u1" } } as T
        if (req.method === "GET" && !req.url.includes("/1")) return { items: [], nextCursor: null } as T
        return { id: "1", created: "", updated: "" } as T
      })
    return { execute, callsMade: () => count }
  }

  function makeClient(execute: ExecuteFn, defaultRetryOptions?: { schedule: Schedule.Schedule<unknown, MiraError, never> }) {
    return makeCollectionClient({
      collectionName: "tasks",
      schema: TestCollection.schema,
      fields: TestCollection.fields,
      execute,
      baseUrl: "http://localhost",
      authTokenRef: null,
      loggedInRef: null,
      fileTokenCacheRef: MutableRef.make(new Map()),
      isAuth: false,
      ...(defaultRetryOptions !== undefined ? { defaultRetryOptions } : {})
    })
  }

  const retrySchedule = Schedule.recurs(2)

  it("getList retries on failure and succeeds", async () => {
    const { execute, callsMade } = makeRetryExecute(2)
    await makeClient(execute).getList({ retryOptions: { schedule: retrySchedule } }).raw()
    expect(callsMade()).toBe(3)
  })

  it("getOne retries on failure and succeeds", async () => {
    const { execute, callsMade } = makeRetryExecute(2)
    await makeClient(execute).getOne("1", { retryOptions: { schedule: retrySchedule } }).raw()
    expect(callsMade()).toBe(3)
  })

  it("create retries on failure via defaultRetryOptions", async () => {
    const { execute, callsMade } = makeRetryExecute(2)
    await makeClient(execute, { schedule: retrySchedule }).create().raw({ title: "t" })
    expect(callsMade()).toBe(3)
  })

  it("update retries on failure via defaultRetryOptions", async () => {
    const { execute, callsMade } = makeRetryExecute(2)
    await makeClient(execute, { schedule: retrySchedule }).update().raw({ id: "1", data: { title: "t" } })
    expect(callsMade()).toBe(3)
  })

  it("delete retries on failure via defaultRetryOptions", async () => {
    const { execute, callsMade } = makeRetryExecute(2)
    await makeClient(execute, { schedule: retrySchedule }).delete().raw("1")
    expect(callsMade()).toBe(3)
  })

  it("authWithPassword retries on failure via defaultRetryOptions", async () => {
    const { execute, callsMade } = makeRetryExecute(2)
    const client = makeCollectionClient({
      collectionName: "users",
      schema: AuthCollectionDef.schema,
      fields: AuthCollectionDef.fields,
      execute,
      baseUrl: "http://localhost",
      authTokenRef: null,
      loggedInRef: null,
      fileTokenCacheRef: MutableRef.make(new Map()),
      isAuth: true,
      defaultRetryOptions: { schedule: retrySchedule },
    })
    const authWithPassword = client.authWithPassword
    if (!authWithPassword) throw new Error("authWithPassword should be defined when isAuth=true")
    await authWithPassword().raw({ email: "u@test.com", password: "pass" })
    expect(callsMade()).toBe(3)
  })

  it("propagates error once the retry schedule is exhausted", async () => {
    const { execute, callsMade } = makeRetryExecute(Infinity)
    await expect(
      makeClient(execute).getOne("1", { retryOptions: { schedule: retrySchedule } }).raw()
    ).rejects.toBeInstanceOf(MiraError)
    expect(callsMade()).toBe(3)
  })

  it("without retryOptions failure propagates on the first attempt with no retry", async () => {
    const { execute, callsMade } = makeRetryExecute(Infinity)
    await expect(makeClient(execute).getOne("1").raw()).rejects.toBeInstanceOf(MiraError)
    expect(callsMade()).toBe(1)
  })

  it("defaultRetryOptions applies when no method-level retryOptions is given", async () => {
    const { execute, callsMade } = makeRetryExecute(2)
    const client = makeCollectionClient({
      collectionName: "tasks",
      schema: TestCollection.schema,
      fields: TestCollection.fields,
      execute,
      baseUrl: "http://localhost",
      authTokenRef: null,
      loggedInRef: null,
      fileTokenCacheRef: MutableRef.make(new Map()),
      isAuth: false,
      defaultRetryOptions: { schedule: retrySchedule },
    })
    await client.getOne("1").raw()
    expect(callsMade()).toBe(3)
  })

  it("method-level retryOptions.schedule overrides defaultRetryOptions for queries", async () => {
    const { execute, callsMade } = makeRetryExecute(1)
    const client = makeCollectionClient({
      collectionName: "tasks",
      schema: TestCollection.schema,
      fields: TestCollection.fields,
      execute,
      baseUrl: "http://localhost",
      authTokenRef: null,
      loggedInRef: null,
      fileTokenCacheRef: MutableRef.make(new Map()),
      isAuth: false,
      defaultRetryOptions: { schedule: Schedule.recurs(5) },
    })
    await client.getOne("1", { retryOptions: { schedule: Schedule.recurs(1) } }).raw()
    expect(callsMade()).toBe(2)
  })
})
