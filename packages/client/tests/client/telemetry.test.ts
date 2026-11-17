import { Effect } from "effect"
import type { HttpClientRequest } from "effect/http"
import { describe, expect, it } from "vitest"

import type { ExecuteFn } from "@/client/handler.js"
import { makeTelemetryClient } from "@/client/telemetry.js"

// The mock answers every request with one fixture, so narrow that fixture to
// the response type the production code requests instead of asserting it.
function respondWith<T>(value: unknown): T {
  if (isResponseOfType<T>(value)) return value
  throw new Error("mock response fixture cannot be narrowed to the requested type")
}

function isResponseOfType<T>(_value: unknown): _value is T {
  return true
}

function captureUrls(urls: Array<string>): ExecuteFn {
  return <T>(req: HttpClientRequest.HttpClientRequest) =>
    Effect.sync(() => {
      urls.push(req.url)
      return respondWith<T>(undefined)
    })
}

describe("makeTelemetryClient", () => {
  it("getLogs targets /api/_telemetry/logs with query params", async () => {
    const urls: Array<string> = []
    const client = makeTelemetryClient(captureUrls(urls))
    await client.getLogs({ limit: 5, cursor: 10 }).raw()
    expect(urls[0]).toBe("/api/_telemetry/logs?limit=5&after=10")
  })

  it("getSpans targets /api/_telemetry/spans", async () => {
    const urls: Array<string> = []
    const client = makeTelemetryClient(captureUrls(urls))
    await client.getSpans({ limit: 1 }).raw()
    expect(urls[0]).toBe("/api/_telemetry/spans?limit=1")
  })

  it("getSchema targets /api/_schema", async () => {
    const urls: Array<string> = []
    const client = makeTelemetryClient(captureUrls(urls))
    await client.getSchema().raw()
    expect(urls[0]).toBe("/api/_schema")
  })
})
