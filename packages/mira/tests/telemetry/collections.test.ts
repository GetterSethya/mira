import { describe, it, expect } from "vitest"
import { LogsCollection, SpansCollection } from "@/telemetry/collections.js"

describe("telemetry collection definitions", () => {
  it("LogsCollection.name is 'logs'", () => {
    expect(LogsCollection.name).toBe("logs")
  })

  it("SpansCollection.name is 'spans'", () => {
    expect(SpansCollection.name).toBe("spans")
  })

  it("LogsCollection.schema has x-collection-kind 'base'", () => {
    expect(LogsCollection.schema["x-collection-kind"]).toBe("base")
  })

  it("SpansCollection.schema has x-collection-kind 'base'", () => {
    expect(SpansCollection.schema["x-collection-kind"]).toBe("base")
  })

  it("LogsCollection.schema.properties contains all expected fields", () => {
    const props = Object.keys(LogsCollection.schema.properties)
    expect(props).toContain("level")
    expect(props).toContain("message")
    expect(props).toContain("traceId")
    expect(props).toContain("spanId")
    expect(props).toContain("id")
    expect(props).toContain("seqId")
    expect(props).toContain("created")
    expect(props).toContain("updated")
  })

  it("SpansCollection.schema.properties contains all expected fields", () => {
    const props = Object.keys(SpansCollection.schema.properties)
    expect(props).toContain("name")
    expect(props).toContain("traceId")
    expect(props).toContain("spanId")
    expect(props).toContain("parentSpanId")
    expect(props).toContain("kind")
    expect(props).toContain("durationMs")
    expect(props).toContain("status")
    expect(props).toContain("error")
    expect(props).toContain("attributes")
    expect(props).toContain("id")
    expect(props).toContain("seqId")
    expect(props).toContain("created")
    expect(props).toContain("updated")
  })

  it("traceId and spanId are optional in LogsCollection", () => {
    const required = LogsCollection.schema.required ?? []
    expect(required).not.toContain("traceId")
    expect(required).not.toContain("spanId")
  })

  it("parentSpanId and error are optional in SpansCollection", () => {
    const required = SpansCollection.schema.required ?? []
    expect(required).not.toContain("parentSpanId")
    expect(required).not.toContain("error")
  })

  it("level and message are required in LogsCollection", () => {
    const required = LogsCollection.schema.required ?? []
    expect(required).toContain("level")
    expect(required).toContain("message")
  })

  it("name, traceId, kind, status, attributes are required in SpansCollection", () => {
    const required = SpansCollection.schema.required ?? []
    expect(required).toContain("name")
    expect(required).toContain("traceId")
    expect(required).toContain("kind")
    expect(required).toContain("status")
    expect(required).toContain("attributes")
  })
})
