/**
 * Bulk-create evidence run (P2: transactional bulk create).
 *
 * Compares 500 individual `POST /api/collections/posts` requests against one
 * `POST /api/collections/posts/bulk` carrying the same 500 records, against the
 * real benchmark server with `BENCH_SYNCHRONOUS=FULL` (the production SQLite
 * setting, where every commit fsyncs).
 *
 * This is deliberately NOT part of the published platform benchmark
 * (`apps/landing/src/lib/benchmarks.json`) — it measures one feature, not the
 * Node-vs-Bun comparison. Run it directly:
 *
 *   pnpm --filter mira-benchmarks bulk-create:audit
 *
 * The script spawns the benchmark server itself, uses a throwaway temp
 * database, and always stops the server before exiting.
 */
import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { performance } from "node:perf_hooks"

import { Schema } from "effect"

const BenchRecordSchema = Schema.Struct({
  title: Schema.String,
  body: Schema.String,
  published: Schema.Boolean
})

const BulkCreateRequestSchema = Schema.Struct({ records: Schema.Array(BenchRecordSchema) })

const RequestBodySchema = Schema.Union([BenchRecordSchema, BulkCreateRequestSchema])
type RequestBody = typeof RequestBodySchema.Type

const StatsSchema = Schema.Struct({
  batch: Schema.Finite,
  runs: Schema.Finite,
  synchronous: Schema.Literal("FULL"),
  recordsPerRun: Schema.Array(Schema.Struct({ individual: Schema.Finite, bulk: Schema.Finite })),
  individualMs: Schema.Array(Schema.Finite),
  bulkMs: Schema.Array(Schema.Finite),
  individualMeanMs: Schema.Finite,
  bulkMeanMs: Schema.Finite,
  speedup: Schema.Finite
})

const encodeRequestBody = Schema.encodeSync(Schema.fromJsonString(RequestBodySchema))
const encodeStats = Schema.encodeSync(Schema.fromJsonString(StatsSchema, { space: 2 }))

const BATCH = 500
const RUNS = 3

const packageRoot = process.cwd()

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address === null || typeof address === "string") {
        server.close()
        reject(new Error("Could not allocate a port"))
        return
      }
      server.close(() => resolve(address.port))
    })
  })

const waitForReady = async (baseUrl: string, child: ChildProcess, logs: () => string) => {
  const deadline = performance.now() + 30_000
  while (performance.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited before readiness:\n${logs()}`)
    try {
      const response = await fetch(`${baseUrl}/__bench/ping`, { signal: AbortSignal.timeout(500) })
      if (response.ok) {
        await response.arrayBuffer()
        return
      }
    } catch {
      // Still booting.
    }
    await sleep(5)
  }
  throw new Error(`Timed out waiting for ${baseUrl}:\n${logs()}`)
}

const stopServer = async (baseUrl: string, child: ChildProcess) => {
  if (child.exitCode !== null) return
  try {
    await fetch(`${baseUrl}/__bench/exit`, { signal: AbortSignal.timeout(1_000) })
  } catch {
    // Server may already be gone.
  }
  const deadline = performance.now() + 5_000
  while (child.exitCode === null && performance.now() < deadline) await sleep(20)
  if (child.exitCode === null) child.kill("SIGKILL")
}

const makeRecords = (prefix: string) =>
  Array.from({ length: BATCH }, (_, i) => ({
    title: `${prefix}-${i}`,
    body: "x".repeat(180),
    published: false
  }))

const postJson = async (url: string, body: RequestBody) => {
  const started = performance.now()
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: encodeRequestBody(body)
  })
  await response.arrayBuffer()
  if (!response.ok) throw new Error(`POST ${url} failed with ${response.status}`)
  return performance.now() - started
}

const mean = (values: ReadonlyArray<number>) => values.reduce((sum, value) => sum + value, 0) / values.length

const main = async () => {
  const dir = mkdtempSync(join(tmpdir(), "mira-bulk-create-"))
  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`

  const child = spawn(process.execPath, ["src/server.ts"], {
    cwd: packageRoot,
    env: {
      ...process.env,
      BENCH_PLATFORM: "node",
      BENCH_PORT: String(port),
      BENCH_DB: join(dir, "bench.sqlite"),
      BENCH_UPLOADS: join(dir, "uploads"),
      BENCH_SYNCHRONOUS: "FULL"
    },
    stdio: ["ignore", "pipe", "pipe"]
  })

  let output = ""
  const append = (value: Buffer) => {
    output = `${output}${value.toString()}`.slice(-8_000)
  }
  child.stdout?.on("data", append)
  child.stderr?.on("data", append)

  try {
    await waitForReady(baseUrl, child, () => output)

    // Warm up both paths so the first-request JIT/statement cache is not measured.
    await postJson(`${baseUrl}/api/collections/posts`, { title: "warmup", body: "x", published: false })
    await postJson(`${baseUrl}/api/collections/posts/bulk`, {
      records: [{ title: "warmup-bulk", body: "x", published: false }]
    })

    const individual: Array<number> = []
    const bulk: Array<number> = []
    const recordsPerRun: Array<{ individual: number; bulk: number }> = []

    for (let run = 0; run < RUNS; run += 1) {
      const individualRecords = makeRecords(`single-${run}`)
      const individualStart = performance.now()
      for (const record of individualRecords) {
        await postJson(`${baseUrl}/api/collections/posts`, record)
      }
      const individualMs = performance.now() - individualStart
      individual.push(individualMs)

      const bulkMs = await postJson(`${baseUrl}/api/collections/posts/bulk`, {
        records: makeRecords(`bulk-${run}`)
      })
      bulk.push(bulkMs)
      recordsPerRun.push({ individual: individualRecords.length, bulk: BATCH })
    }

    const individualMean = mean(individual)
    const bulkMean = mean(bulk)

    console.log(
      encodeStats({
        batch: BATCH,
        runs: RUNS,
        synchronous: "FULL",
        recordsPerRun,
        individualMs: individual,
        bulkMs: bulk,
        individualMeanMs: Number(individualMean.toFixed(1)),
        bulkMeanMs: Number(bulkMean.toFixed(1)),
        speedup: Number((individualMean / bulkMean).toFixed(1))
      })
    )
  } finally {
    await stopServer(baseUrl, child)
    rmSync(dir, { recursive: true, force: true })
  }
}

await main()
