import { describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { expect } from "vitest"

import { NodeCryptoLayer } from "@/crypto/index.js"
import { makeTelemetryLayerForClient } from "@/telemetry/core.js"
import {
  type TelemetryLogEntry,
  type TelemetrySpanEntry,
  TelemetryStore,
  type TelemetryStoreShape
} from "@/telemetry/store.js"

const fakeDelay = (millis: number) =>
  Effect.promise(() => new Promise((resolve) => setTimeout(resolve, millis)))

const makeFakeStore = () => {
  const logs = new Map<string, TelemetryLogEntry>()
  const spans = new Map<string, TelemetrySpanEntry>()

  const store: TelemetryStoreShape = {
    appendLogs: (rows) =>
      Effect.sync(() => {
        for (const row of rows) logs.set(row.id, row)
      }),
    appendSpans: (rows) =>
      Effect.sync(() => {
        for (const row of rows) spans.set(row.id, row)
      }),
    deleteOlderThan: (cutoff) =>
      Effect.sync(() => {
        let deletedLogs = 0
        let deletedSpans = 0
        for (const [id, row] of logs) {
          if (row.created < cutoff) {
            logs.delete(id)
            deletedLogs += 1
          }
        }
        for (const [id, row] of spans) {
          if (row.created < cutoff) {
            spans.delete(id)
            deletedSpans += 1
          }
        }
        return { logs: deletedLogs, spans: deletedSpans }
      }),
    read: {
      listLogs: ({ limit, after }) =>
        Effect.sync(() => {
          const items = [...logs.values()]
            .sort((left, right) => (left.id < right.id ? 1 : -1))
            .map((row) => ({ ...row, seqId: 1 }))
            .filter((row) => (after === null ? true : row.seqId < after))
            .slice(0, limit)
          return { items, total: logs.size, nextCursor: null }
        }),
      listSpans: ({ limit }) =>
        Effect.sync(() => ({
          items: [...spans.values()].slice(0, limit),
          total: spans.size,
          nextCursor: null
        }))
    }
  }

  return { store, logs, spans }
}

const layerFor = (store: TelemetryStoreShape) =>
  makeTelemetryLayerForClient().pipe(
    Layer.provideMerge(Layer.succeed(TelemetryStore, store)),
    Layer.provide(NodeCryptoLayer)
  )

describe("TelemetryStore boundary", () => {
  it.effect("builds and closes without SQL", () => {
    const fake = makeFakeStore()
    return Effect.void.pipe(Effect.provide(layerFor(fake.store)))
  })

  it.effect("delivers logs and spans without SQL", () => {
    const fake = makeFakeStore()
    return Effect.gen(function* () {
      yield* Effect.logInfo("fake-store-log")
      yield* Effect.void.pipe(Effect.withSpan("fake-store-span"))
      yield* fakeDelay(50)

      expect([...fake.logs.values()].some((row) => row.message === "fake-store-log")).toBe(true)
      expect([...fake.spans.values()].some((row) => row.name === "fake-store-span")).toBe(true)
    }).pipe(Effect.provide(layerFor(fake.store)))
  })

  it("flushes a partial batch after flushInterval", async () => {
    const fake = makeFakeStore()
    const layer = makeTelemetryLayerForClient({
      flushBatchSize: 100,
      flushInterval: "40 millis"
    }).pipe(
      Layer.provideMerge(Layer.succeed(TelemetryStore, fake.store)),
      Layer.provide(NodeCryptoLayer)
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.logInfo("interval-log")
        yield* fakeDelay(120)
        expect(fake.logs.size).toBe(1)
      }).pipe(Effect.provide(layer), Effect.scoped)
    )
  })

  it.effect("deduplicates a re-flushed batch by id", () => {
    const fake = makeFakeStore()
    const entry: TelemetryLogEntry = {
      id: "same-id",
      level: "INFO",
      message: "same",
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      traceId: null,
      spanId: null
    }

    return Effect.gen(function* () {
      yield* fake.store.appendLogs([entry])
      yield* fake.store.appendLogs([entry])
      expect(fake.logs.size).toBe(1)
    })
  })
})
