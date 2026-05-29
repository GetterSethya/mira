import { describe, expect, it } from "vitest"

import { Effect } from "effect"
import { FetchHttpClient } from "@effect/platform"
import { makeClientHandler } from "@/client/handler.js"
import { MiraError } from "@/client/errors.js"

describe("ClientHandler", () => {
  it("raw() resolves the Effect and returns the value", async () => {
    const effect = Effect.succeed({ ok: true })
    const handler = makeClientHandler(effect)
    const result = await handler.raw()
    expect(result).toEqual({ ok: true })
  })

  it("raw() rejects with MiraError on failure", async () => {
    const effect = Effect.fail(new MiraError({ status: 404, body: { error: "not_found" } }))
    const handler = makeClientHandler(effect)
    await expect(handler.raw()).rejects.toThrow()
  })

  it("toEffect() returns an Effect (does not run it)", () => {
    const effect = Effect.succeed(42)
    const handler = makeClientHandler(effect)
    const returned = handler.toEffect()
    expect(returned).toBe(effect)
  })

})
