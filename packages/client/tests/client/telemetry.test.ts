import { Effect } from "effect"
import type { HttpClientRequest } from "effect/http"
import { describe, expect, it } from "vitest"

import type { ExecuteFn } from "@/client/handler.js"
import { makeTelemetryClient } from "@/client/telemetry.js"

function captureUrls(urls: Array<string>): ExecuteFn {
  return <T>(req: HttpClientRequest.HttpClientRequest) =>
    Effect.sync(() => {
      urls.push(req.url)
      return undefined as T
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
