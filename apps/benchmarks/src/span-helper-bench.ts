/**
 * A/B the tracing-off span helper against `Effect.withSpan`.
 *
 *   pnpm --filter mira-benchmarks exec tsx src/span-helper-bench.ts
 *
 * The benchmark measures both wall time and sampled heap bytes for 100k
 * sequential no-op spans with tracing disabled. A go requires the helper to be
 * faster and allocate less.
 */
import { Session } from "node:inspector"
import { performance } from "node:perf_hooks"

import { Effect } from "effect"

import { summarizeHeapProfile } from "./analyze-heapprofile.js"
import { withSpanWhenEnabled } from "../../../packages/mira/src/telemetry/span.js"

const iterations = 100_000

function sessionPost(session: Session, method: string, params?: object): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const callback = (error: Error | null, result: unknown) => {
      if (error !== null) reject(error)
      else resolve(result)
    }
    if (params === undefined) session.post(method, callback)
    else session.post(method, params, callback)
  })
}

async function allocatedBytes(program: Effect.Effect<void>): Promise<number> {
  const session = new Session()
  session.connect()
  await sessionPost(session, "HeapProfiler.enable")
  await sessionPost(session, "HeapProfiler.startSampling", {
    samplingInterval: 16_384,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true
  })
  await Effect.runPromise(program)
  const result = await sessionPost(session, "HeapProfiler.stopSampling")
  session.disconnect()
  if (typeof result !== "object" || result === null || !("profile" in result)) return 0
  const profile = result.profile
  if (typeof profile !== "object" || profile === null) return 0
  return summarizeHeapProfile(profile).totalBytes
}

const loop = (span: Effect.Effect<void>) =>
  Effect.forEach(
    Array.from({ length: iterations }, (_, index) => index),
    () => span,
    { discard: true }
  )

const oldSpan = Effect.withSpan("bench.span", { kind: "internal" }, { captureStackTrace: false })(
  Effect.void
)
const newSpan = withSpanWhenEnabled(
  "bench.span",
  { kind: "internal" },
  { captureStackTrace: false }
)(Effect.void)

async function time(program: Effect.Effect<void>): Promise<number> {
  const start = performance.now()
  await Effect.runPromise(program.pipe(Effect.withTracerEnabled(false)))
  return performance.now() - start
}

const oldTimes: Array<number> = []
const newTimes: Array<number> = []
const oldBytes: Array<number> = []
const newBytes: Array<number> = []

for (let round = 0; round < 3; round += 1) {
  if (round % 2 === 0) {
    oldTimes.push(await time(loop(oldSpan)))
    newTimes.push(await time(loop(newSpan)))
    oldBytes.push(await allocatedBytes(loop(oldSpan).pipe(Effect.withTracerEnabled(false))))
    newBytes.push(await allocatedBytes(loop(newSpan).pipe(Effect.withTracerEnabled(false))))
  } else {
    newTimes.push(await time(loop(newSpan)))
    oldTimes.push(await time(loop(oldSpan)))
    newBytes.push(await allocatedBytes(loop(newSpan).pipe(Effect.withTracerEnabled(false))))
    oldBytes.push(await allocatedBytes(loop(oldSpan).pipe(Effect.withTracerEnabled(false))))
  }
}

const median = (values: ReadonlyArray<number>) => {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}
const mib = (bytes: number) => (bytes / 1024 / 1024).toFixed(2)

process.stdout.write(
  `Effect.withSpan: ${(median(oldTimes) * 1_000_000 / iterations).toFixed(0)} ns/op, ${mib(median(oldBytes))} MiB sampled\n` +
    `withSpanWhenEnabled: ${(median(newTimes) * 1_000_000 / iterations).toFixed(0)} ns/op, ${mib(median(newBytes))} MiB sampled\n`
)
