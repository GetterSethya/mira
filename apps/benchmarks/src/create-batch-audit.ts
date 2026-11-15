/**
 * Create-batch evidence run (transparent server-side create batching spike).
 *
 * Answers one question: does merging concurrent single creates into one commit
 * reduce fsync cost without breaking per-request behavior? It compares
 * `BENCH_CREATE_BATCH=off` (baseline) with `on` (batched) across SQLite
 * `synchronous=FULL` and `NORMAL`, at concurrency 1/10/50/100, with a read arm,
 * an open-loop arm, and window/batch-size sweeps.
 *
 * Deliberately NOT part of the published platform benchmark
 * (`apps/landing/src/lib/benchmarks.json`). Run it directly:
 *
 *   pnpm --filter mira-benchmarks create-batch:audit
 *   AUDIT_FAST=1 pnpm --filter mira-benchmarks create-batch:audit   # smoke run
 *
 * Every cell gets a fresh temporary directory and database, and the server is
 * always stopped before the script exits.
 *
 * Environment:
 * - `AUDIT_OUT`            output directory (default `.egm/create-batch-spike-2026-11-15/audit`)
 * - `AUDIT_FAST=1`         reduced smoke matrix (1 repeat, c1/c50, no sweeps/open loop)
 * - `AUDIT_SKIP_SWEEPS=1`  matrix + read/open-loop arms only (skips window/batch-size sweeps)
 * - `AUDIT_REPEATS`        repeats per matrix cell (default 3)
 * - `AUDIT_PLATFORM`       node | bun (default node)
 * - `AUDIT_PRE_SPIKE`      path to the pre-spike control JSON
 */
import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { cpus, tmpdir } from "node:os"
import { join } from "node:path"
import { performance } from "node:perf_hooks"

type PlatformName = "node" | "bun"
type Durability = "FULL" | "NORMAL"
type BatchMode = "off" | "on"

interface CellSpec {
  readonly family: "matrix" | "window-sweep" | "batch-sweep" | "cache-on"
  readonly label: string
  readonly synchronous: Durability
  readonly batch: BatchMode
  readonly cache: boolean
  readonly windowMs: number
  readonly maxBatchSize: number
  readonly concurrency: number
  readonly requests: number
  readonly repeat: number
  readonly readArm: boolean
  readonly collectReadAtRest: boolean
}

interface ReadArmResult {
  readonly samples: number
  readonly failures: number
  readonly throughput: number
  readonly p50: number
  readonly p95: number
  readonly p99: number
  readonly targetMet: boolean
}

interface BatchStats {
  readonly batches: number
  readonly commits: number
  readonly applied: number
  readonly maxBatchSize: number
  readonly lastBatchSizes: ReadonlyArray<number>
  readonly rejected: number
  readonly consecutiveDefects: number
  readonly timedOut: number
  readonly admitted: number
}

interface CellResult extends CellSpec {
  readonly platform: PlatformName
  readonly throughput: number
  readonly offeredRps: number
  readonly p50: number
  readonly p95: number
  readonly p99: number
  readonly durationMs: number
  readonly successes: number
  readonly failures: number
  readonly successRate: number
  readonly statuses: Readonly<Record<string, number>>
  readonly titleMismatches: number
  readonly medianFlushSizeLast50: number
  readonly stats: BatchStats | null
  readonly rows: number
  readonly expectedRows: number
  readonly reads: ReadArmResult | null
  readonly readAtRest: ReadArmResult | null
}

interface OpenLoopResult {
  readonly synchronous: Durability
  readonly batch: BatchMode
  readonly rate: number
  readonly durationMs: number
  readonly repeat: number
  readonly scheduled: number
  readonly successes: number
  readonly failures: number
  readonly successRate: number
  readonly statuses: Readonly<Record<string, number>>
  readonly clientCapEvents: number
  /** True when the generator stopped at the in-flight cap; excluded from check 9. */
  readonly capped: boolean
  /** 503 responses whose body said `batch_unavailable`. */
  readonly batchUnavailable: number
  /** Every other non-2xx response. */
  readonly otherErrors: number
  readonly stats: BatchStats | null
  readonly p50: number
  readonly p95: number
  readonly p99: number
  readonly rows: number
  readonly expectedRows: number
}

interface SweepPoint {
  readonly windowMs: number
  readonly maxBatchSize: number
  readonly throughput: number
  readonly p99: number
  readonly medianFlushSizeLast50: number
  readonly commitsRatio: number
}

const packageRoot = process.cwd()
const repoRoot = join(packageRoot, "../..")
const platform = (process.env.AUDIT_PLATFORM ?? "node") as PlatformName
const fast = process.env.AUDIT_FAST === "1"
const skipSweeps = process.env.AUDIT_SKIP_SWEEPS === "1"
const MATRIX_WINDOW_MS = 0
const repeatsEnv = fast ? 1 : Number(process.env.AUDIT_REPEATS ?? "3")
if (!Number.isInteger(repeatsEnv) || repeatsEnv < 1) {
  throw new Error(`AUDIT_REPEATS must be an integer >= 1 (received ${String(process.env.AUDIT_REPEATS)})`)
}
const repeats = repeatsEnv
const outDir =
  process.env.AUDIT_OUT ?? join(repoRoot, ".egm", "create-batch-spike-2026-11-15", "audit")
const preSpikePath =
  process.env.AUDIT_PRE_SPIKE ??
  join(repoRoot, ".egm", "create-batch-spike-2026-11-15", "pre-spike", "audit-load.json")

const BODY = "x".repeat(180)
const WARMUPS = fast ? 10 : 50
const READ_TARGET = fast ? 200 : 500
const READ_WARMUPS = fast ? 20 : 100
const WRITE_BATCH = 10
const OPEN_LOOP_IN_FLIGHT_CAP = 1_000

const matrixConcurrencies = fast ? [1, 50] : [1, 10, 50, 100]
const samplesFor = (concurrency: number): number => {
  if (fast) return concurrency === 1 ? 30 : 200
  if (concurrency === 1) return 200
  if (concurrency === 10) return 1_000
  return 5_000
}

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

const percentile = (sorted: ReadonlyArray<number>, p: number) => {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return sorted[index] ?? 0
}

const median = (values: ReadonlyArray<number>) => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : sorted[middle] ?? 0
}

const round = (value: number, digits = 2) => Number(value.toFixed(digits))

interface RunningServer {
  readonly child: ChildProcess
  readonly baseUrl: string
  readonly logs: () => string
}

const startServer = (
  spec: CellSpec,
  directory: string,
  port: number,
  databaseName: string
): RunningServer => {
  const args = platform === "node" ? ["src/server.ts"] : ["run", "src/server.ts"]
  const child = spawn(platform === "node" ? process.execPath : "bun", args, {
    cwd: packageRoot,
    env: {
      ...process.env,
      BENCH_PLATFORM: platform,
      BENCH_PORT: String(port),
      BENCH_DB: join(directory, databaseName),
      BENCH_UPLOADS: join(directory, "uploads"),
      BENCH_SYNCHRONOUS: spec.synchronous,
      BENCH_CACHE: spec.cache ? "on" : "off",
      BENCH_TRACING: "off",
      BENCH_STACK_TRACES: "off",
      BENCH_CREATE_BATCH: spec.batch,
      BENCH_CREATE_BATCH_WINDOW_MS: String(spec.windowMs),
      BENCH_CREATE_BATCH_MAX: String(spec.maxBatchSize)
    },
    stdio: ["ignore", "pipe", "pipe"]
  })

  let output = ""
  const append = (value: Buffer) => {
    output = `${output}${value.toString()}`.slice(-8_000)
  }
  child.stdout?.on("data", append)
  child.stderr?.on("data", append)

  return { child, baseUrl: `http://127.0.0.1:${port}`, logs: () => output }
}

const waitForReady = async (server: RunningServer) => {
  const deadline = performance.now() + 30_000
  while (performance.now() < deadline) {
    if (server.child.exitCode !== null) {
      throw new Error(`Server exited before readiness:\n${server.logs()}`)
    }
    try {
      const response = await fetch(`${server.baseUrl}/__bench/ping`, {
        signal: AbortSignal.timeout(500)
      })
      if (response.ok) {
        await response.arrayBuffer()
        return
      }
    } catch {
      // Still booting.
    }
    await sleep(5)
  }
  throw new Error(`Timed out waiting for ${server.baseUrl}:\n${server.logs()}`)
}

const stopServer = async (server: RunningServer) => {
  if (server.child.exitCode !== null) return
  try {
    await fetch(`${server.baseUrl}/__bench/exit`, { signal: AbortSignal.timeout(1_000) })
  } catch {
    // Server may already be gone.
  }
  const deadline = performance.now() + 5_000
  while (server.child.exitCode === null && performance.now() < deadline) await sleep(20)
  if (server.child.exitCode === null) server.child.kill("SIGKILL")
}

const getJson = async (url: string): Promise<unknown> => {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error(`GET ${url} failed with ${response.status}`)
  return response.json()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

const readBatchStats = async (server: RunningServer): Promise<BatchStats | null> => {
  const payload = await getJson(`${server.baseUrl}/__bench/batch-stats`)
  if (!isRecord(payload)) return null
  const batches = payload["batches"]
  if (typeof batches !== "number") return null
  return {
    batches,
    commits: Number(payload["commits"] ?? 0),
    applied: Number(payload["applied"] ?? 0),
    maxBatchSize: Number(payload["maxBatchSize"] ?? 0),
    lastBatchSizes: Array.isArray(payload["lastBatchSizes"])
      ? payload["lastBatchSizes"].filter((value): value is number => typeof value === "number")
      : [],
    rejected: Number(payload["rejected"] ?? 0),
    consecutiveDefects: Number(payload["consecutiveDefects"] ?? 0),
    timedOut: Number(payload["timedOut"] ?? 0),
    admitted: Number(payload["admitted"] ?? 0)
  }
}

const readRowCount = async (server: RunningServer): Promise<number> => {
  const payload = await getJson(`${server.baseUrl}/__bench/count`)
  if (!isRecord(payload)) return -1
  const count = payload["count"]
  return typeof count === "number" ? count : -1
}

interface CreateLoadResult {
  readonly throughput: number
  readonly offeredThroughput: number
  readonly p50: number
  readonly p95: number
  readonly p99: number
  readonly durationMs: number
  readonly successes: number
  readonly failures: number
  readonly statuses: Record<string, number>
  readonly titleMismatches: number
}

const runCreates = async (
  baseUrl: string,
  concurrency: number,
  requests: number,
  prefix: string
): Promise<CreateLoadResult> => {
  const latencies: Array<number> = []
  const statuses: Record<string, number> = {}
  let successes = 0
  let failures = 0
  let titleMismatches = 0
  let next = 0
  const started = performance.now()

  const worker = async () => {
    while (true) {
      const index = next
      next += 1
      if (index >= requests) return
      const title = `${prefix}-${index}`
      const startedAt = performance.now()
      try {
        const response = await fetch(`${baseUrl}/api/collections/posts`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title, body: BODY, published: false })
        })
        const payload: unknown = await response.json()
        latencies.push(performance.now() - startedAt)
        const status = String(response.status)
        statuses[status] = (statuses[status] ?? 0) + 1
        if (response.ok) {
          successes += 1
          const returned = isRecord(payload) ? payload["title"] : undefined
          if (returned !== title) titleMismatches += 1
        } else {
          failures += 1
        }
      } catch {
        latencies.push(performance.now() - startedAt)
        statuses["network_error"] = (statuses["network_error"] ?? 0) + 1
        failures += 1
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker))
  const durationMs = performance.now() - started
  const sorted = [...latencies].sort((left, right) => left - right)
  return {
    throughput: successes / (durationMs / 1000),
    offeredThroughput: requests / (durationMs / 1000),
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    durationMs,
    successes,
    failures,
    statuses,
    titleMismatches
  }
}

const readList = async (baseUrl: string, index: number) => {
  const response = await fetch(`${baseUrl}/api/collections/posts?limit=20`, {
    signal: AbortSignal.timeout(10_000)
  })
  await response.arrayBuffer()
  return response.status
}

const runReads = async (baseUrl: string, workers: number, requests: number, prefix: number) => {
  const latencies: Array<number> = []
  let failures = 0
  let next = 0
  const started = performance.now()
  const worker = async () => {
    while (true) {
      const index = next
      next += 1
      if (index >= requests) return
      const startedAt = performance.now()
      try {
        const status = await readList(baseUrl, prefix + index)
        latencies.push(performance.now() - startedAt)
        if (status >= 400) failures += 1
      } catch {
        latencies.push(performance.now() - startedAt)
        failures += 1
      }
    }
  }
  await Promise.all(Array.from({ length: workers }, worker))
  const durationMs = performance.now() - started
  const sorted = [...latencies].sort((left, right) => left - right)
  return {
    samples: latencies.length,
    failures,
    throughput: latencies.length / (durationMs / 1000),
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99)
  }
}

/** Concurrent read load for the duration of a create cell. */
const startReadArm = (baseUrl: string) => {
  const latencies: Array<number> = []
  let failures = 0
  let stopped = false
  let index = 0
  const started = performance.now()

  const worker = async () => {
    while (!stopped) {
      const startedAt = performance.now()
      try {
        const status = await readList(baseUrl, index)
        index += 1
        latencies.push(performance.now() - startedAt)
        if (status >= 400) failures += 1
      } catch {
        latencies.push(performance.now() - startedAt)
        failures += 1
      }
    }
  }

  const workers = Array.from({ length: 5 }, worker)
  return {
    stop: async (): Promise<ReadArmResult> => {
      stopped = true
      await Promise.all(workers)
      const durationMs = performance.now() - started
      const sorted = [...latencies].sort((left, right) => left - right)
      return {
        samples: latencies.length,
        failures,
        throughput: latencies.length / (durationMs / 1000),
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
        p99: percentile(sorted, 0.99),
        targetMet: latencies.length >= READ_TARGET
      }
    }
  }
}

const runOpenLoop = async (
  spec: CellSpec,
  baseUrl: string,
  rate: number,
  durationMs: number
): Promise<Omit<OpenLoopResult, "rows" | "expectedRows" | "stats">> => {
  const interval = 1_000 / rate
  const latencies: Array<number> = []
  const statuses: Record<string, number> = {}
  let successes = 0
  let failures = 0
  let batchUnavailable = 0
  let otherErrors = 0
  let clientCapEvents = 0
  let inFlight = 0
  let scheduled = 0
  const pending: Array<Promise<void>> = []
  const started = performance.now()

  while (performance.now() - started < durationMs) {
    const scheduledAt = started + scheduled * interval
    const wait = scheduledAt - performance.now()
    if (wait > 0) await sleep(wait)
    if (inFlight >= OPEN_LOOP_IN_FLIGHT_CAP) {
      clientCapEvents += 1
      break
    }
    const index = scheduled
    scheduled += 1
    inFlight += 1
    const title = `open-${String(spec.synchronous)}-${String(spec.batch)}-${rate}-${index}`
    pending.push(
      fetch(`${baseUrl}/api/collections/posts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, body: BODY, published: false })
      })
        .then(async (response) => {
          // Read the body so a 503 can be attributed to `batch_unavailable`
          // (queue full / closed) rather than another failure mode.
          const text = await response.text()
          latencies.push(performance.now() - scheduledAt)
          const status = String(response.status)
          statuses[status] = (statuses[status] ?? 0) + 1
          if (response.ok) {
            successes += 1
          } else {
            failures += 1
            if (response.status === 503 && text.includes("batch_unavailable")) {
              batchUnavailable += 1
            } else {
              otherErrors += 1
            }
          }
        })
        .catch(() => {
          latencies.push(performance.now() - scheduledAt)
          statuses["network_error"] = (statuses["network_error"] ?? 0) + 1
          failures += 1
          otherErrors += 1
        })
        .finally(() => {
          inFlight -= 1
        })
    )
  }

  await Promise.all(pending)
  const sorted = [...latencies].sort((left, right) => left - right)
  return {
    synchronous: spec.synchronous,
    batch: spec.batch,
    rate,
    durationMs,
    repeat: spec.repeat,
    scheduled,
    successes,
    failures,
    successRate: scheduled === 0 ? 0 : successes / scheduled,
    statuses,
    clientCapEvents,
    capped: clientCapEvents > 0,
    batchUnavailable,
    otherErrors,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99)
  }
}

interface CellOutcome {
  readonly result: CellResult
}

const runCell = async (spec: CellSpec): Promise<CellOutcome> => {
  const directory = mkdtempSync(join(tmpdir(), `mira-create-batch-${spec.label}-`))
  const port = await freePort()
  const server = startServer(spec, directory, port, "bench.sqlite")

  try {
    await waitForReady(server)

    // Warm-up: excluded from every statistic and from the row-count check.
    await runCreates(server.baseUrl, spec.concurrency, WARMUPS, "warm")
    await fetch(`${server.baseUrl}/__bench/batch-stats/reset`, { method: "POST" })

    const readArm = spec.readArm ? startReadArm(server.baseUrl) : null
    const load = await runCreates(server.baseUrl, spec.concurrency, spec.requests, "measured")
    const reads = readArm === null ? null : await readArm.stop()

    const stats = await readBatchStats(server)
    const rows = await readRowCount(server)
    await stopServer(server)

    let readAtRest: ReadArmResult | null = null
    if (spec.collectReadAtRest) {
      const restPort = await freePort()
      const restServer = startServer(spec, directory, restPort, "bench.sqlite")
      try {
        await waitForReady(restServer)
        await runReads(restServer.baseUrl, 5, READ_WARMUPS, 0)
        const rest = await runReads(restServer.baseUrl, 5, READ_TARGET, READ_WARMUPS)
        readAtRest = { ...rest, targetMet: rest.samples >= READ_TARGET }
      } finally {
        await stopServer(restServer)
      }
    }

    return {
      result: {
        ...spec,
        platform,
        throughput: round(load.throughput),
        offeredRps: round(load.offeredThroughput),
        p50: round(load.p50),
        p95: round(load.p95),
        p99: round(load.p99),
        durationMs: round(load.durationMs),
        successes: load.successes,
        failures: load.failures,
        successRate: round((load.successes / spec.requests) * 100, 3),
        statuses: load.statuses,
        titleMismatches: load.titleMismatches,
        medianFlushSizeLast50:
          stats === null || stats.lastBatchSizes.length === 0 ? 0 : round(median(stats.lastBatchSizes)),
        stats,
        rows,
        expectedRows: spec.requests + WARMUPS,
        reads,
        readAtRest
      }
    }
  } finally {
    await stopServer(server)
    try {
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch {
      // Windows may hold a handle briefly after the child exits.
    }
  }
}

const matrixSpecs = (): ReadonlyArray<CellSpec> => {
  const specs: Array<CellSpec> = []
  const modes: ReadonlyArray<{ synchronous: Durability; batch: BatchMode }> = [
    { synchronous: "FULL", batch: "off" },
    { synchronous: "FULL", batch: "on" },
    { synchronous: "NORMAL", batch: "off" },
    { synchronous: "NORMAL", batch: "on" }
  ]
  for (const mode of modes) {
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      for (const concurrency of matrixConcurrencies) {
        specs.push({
          family: "matrix",
          label: `${mode.synchronous.toLowerCase()}-${mode.batch}-c${concurrency}-r${repeat}`,
          synchronous: mode.synchronous,
          batch: mode.batch,
          cache: false,
          windowMs: MATRIX_WINDOW_MS,
          maxBatchSize: 100,
          concurrency,
          requests: samplesFor(concurrency),
          repeat,
          readArm: concurrency >= (fast ? 50 : 10),
          collectReadAtRest: concurrency === 50
        })
      }
    }
  }
  return specs
}

const sweepSpecs = (): ReadonlyArray<CellSpec> => {
  if (fast || skipSweeps) return []
  const specs: Array<CellSpec> = []
  for (let repeat = 0; repeat < repeats; repeat += 1) {
    for (const windowMs of [0, 1, 2, 5, 10]) {
      specs.push({
        family: "window-sweep",
        label: `window-${windowMs}-r${repeat}`,
        synchronous: "FULL",
        batch: "on",
        cache: false,
        windowMs,
        maxBatchSize: 100,
        concurrency: 50,
        requests: 5_000,
        repeat,
        readArm: false,
        collectReadAtRest: false
      })
    }
    for (const maxBatchSize of [25, 50, 100, 200]) {
      specs.push({
        family: "batch-sweep",
        label: `batch-${maxBatchSize}-r${repeat}`,
        synchronous: "FULL",
        batch: "on",
        cache: false,
        windowMs: MATRIX_WINDOW_MS,
        maxBatchSize,
        concurrency: 50,
        requests: 5_000,
        repeat,
        readArm: false,
        collectReadAtRest: false
      })
    }
  }
  return specs
}

const cacheOnSpecs = (): ReadonlyArray<CellSpec> =>
  fast
    ? []
    : Array.from({ length: repeats }, (_, repeat) => ({
        family: "cache-on" as const,
        label: `cache-on-c50-r${repeat}`,
        synchronous: "FULL" as const,
        batch: "on" as const,
        cache: true,
        windowMs: MATRIX_WINDOW_MS,
        maxBatchSize: 100,
        concurrency: 50,
        requests: 5_000,
        repeat,
        readArm: false,
        collectReadAtRest: false
      }))

const readPreSpikeControl = (): Record<string, unknown> | null => {
  if (!existsSync(preSpikePath)) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(preSpikePath, "utf8"))
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

const preSpikeCreateThroughput = (control: Record<string, unknown> | null): number | null => {
  if (control === null) return null
  const results = control["results"]
  if (!Array.isArray(results)) return null
  const cell = results.find((entry) => isRecord(entry) && entry["name"] === "create-c50")
  if (!isRecord(cell)) return null
  const load = cell["load"]
  if (!isRecord(load)) return null
  const throughput = load["throughput"]
  return typeof throughput === "number" ? throughput : null
}

// ---------------------------------------------------------------------------
// Aggregation + acceptance
// ---------------------------------------------------------------------------

interface Aggregate {
  readonly synchronous: Durability
  readonly batch: BatchMode
  readonly concurrency: number
  readonly throughputMedian: number
  readonly p50Median: number
  readonly p99Median: number
  readonly successRateMedian: number
  readonly runs: number
}

const aggregate = (results: ReadonlyArray<CellResult>, family: CellSpec["family"]): ReadonlyArray<Aggregate> => {
  const groups = new Map<string, Array<CellResult>>()
  for (const result of results) {
    if (result.family !== family) continue
    const key = `${result.synchronous}|${result.batch}|${result.concurrency}`
    const list = groups.get(key) ?? []
    list.push(result)
    groups.set(key, list)
  }
  return [...groups.values()].map((cells) => {
    const first = cells[0]
    return {
      synchronous: first.synchronous,
      batch: first.batch,
      concurrency: first.concurrency,
      throughputMedian: round(median(cells.map((cell) => cell.throughput))),
      p50Median: round(median(cells.map((cell) => cell.p50))),
      p99Median: round(median(cells.map((cell) => cell.p99))),
      successRateMedian: round(median(cells.map((cell) => cell.successRate)), 3),
      runs: cells.length
    }
  })
}

const findAggregate = (
  aggregates: ReadonlyArray<Aggregate>,
  synchronous: Durability,
  batch: BatchMode,
  concurrency: number
): Aggregate | undefined =>
  aggregates.find(
    (entry) =>
      entry.synchronous === synchronous && entry.batch === batch && entry.concurrency === concurrency
  )

interface Check {
  readonly name: string
  readonly status: "pass" | "fail" | "insufficient-data"
  readonly detail: string
  /** Defaults to true. Non-blocking checks are reported but do not fail the run. */
  readonly blocking?: boolean
}

const evaluate = (
  matrix: ReadonlyArray<CellResult>,
  openLoop: ReadonlyArray<OpenLoopResult>,
  preSpikeC50: number | null
): ReadonlyArray<Check> => {
  const aggregates = aggregate(matrix, "matrix")
  const checks: Array<Check> = []

  const allCells = matrix
  const correctnessOk = allCells.every((cell) => cell.titleMismatches === 0)
  checks.push({
    name: "1. correctness: every response matches its request payload",
    status: correctnessOk ? "pass" : "fail",
    detail: `${allCells.filter((cell) => cell.titleMismatches > 0).length} cells had payload/response mismatches`
  })

  const fullOnC50 = matrix.filter(
    (cell) => cell.family === "matrix" && cell.synchronous === "FULL" && cell.batch === "on" && cell.concurrency === 50
  )
  const statsOk = fullOnC50.length > 0 && fullOnC50.every((cell) => cell.stats !== null)
  const batchesOk = fullOnC50.every((cell) => (cell.stats?.batches ?? 0) > 0 && (cell.stats?.batches ?? 0) < cell.requests)
  const flushOk = fullOnC50.every((cell) => cell.medianFlushSizeLast50 >= 4)
  const commitRatio = fullOnC50.map((cell) => (cell.stats?.commits ?? 0) / cell.requests)
  const commitOk = commitRatio.length > 0 && commitRatio.every((ratio) => ratio <= 0.25)
  const recordsOk = fullOnC50.every((cell) => cell.stats?.applied === cell.requests)
  checks.push({
    name: "2. batching evidence at FULL c50",
    status: !statsOk ? "fail" : batchesOk && flushOk && commitOk && recordsOk ? "pass" : "fail",
    detail: `stats=${statsOk ? "present" : "MISSING"}; batches<requests=${batchesOk}; medianFlush>=4=${flushOk}; commits/requests=${commitRatio.map((ratio) => round(ratio, 3)).join(",")}; records===requests=${recordsOk}`
  })

  const successOk = fullOnC50.length > 0 && fullOnC50.every((cell) => cell.successRate >= 99.5)
  checks.push({
    name: "3. success rate at FULL c50",
    status: fullOnC50.length === 0 ? "insufficient-data" : successOk ? "pass" : "fail",
    detail: fullOnC50.map((cell) => `${cell.successRate}%`).join(", ") || "no cells"
  })

  const fullOffC50 = findAggregate(aggregates, "FULL", "off", 50)
  // Sanity check only: the pre-spike control is a different shape (500
  // requests, no warm-up, produced by `audit.ts`), so it cannot be a
  // like-for-like acceptance gate. It is reported for drift, not blocking.
  const controlDelta =
    preSpikeC50 !== null && fullOffC50 !== undefined
      ? ((fullOffC50.throughputMedian - preSpikeC50) / preSpikeC50) * 100
      : null
  checks.push({
    name: "4. sanity: post-change baseline vs pre-spike control (different shape, not a gate)",
    status:
      controlDelta === null
        ? "insufficient-data"
        : Math.abs(controlDelta) <= 10
          ? "pass"
          : "fail",
    blocking: false,
    detail:
      controlDelta === null || fullOffC50 === undefined
        ? "pre-spike control or c50 baseline missing"
        : `pre-spike ${round(preSpikeC50 ?? 0)} rps (500 req, no warm-up) vs baseline ${fullOffC50.throughputMedian} rps (5,000 req, 50 warm-ups): ${round(controlDelta, 1)}%`
  })

  const fullOn = findAggregate(aggregates, "FULL", "on", 50)
  if (fullOffC50 !== undefined && fullOn !== undefined) {
    const batchedCells = matrix.filter(
      (cell) => cell.family === "matrix" && cell.synchronous === "FULL" && cell.batch === "on" && cell.concurrency === 50
    )
    const medianRatio = fullOn.throughputMedian / fullOffC50.throughputMedian
    const worstRatio =
      Math.min(...batchedCells.map((cell) => cell.throughput)) / fullOffC50.throughputMedian
    checks.push({
      name: "5. FULL c50: median batched >= 2x baseline, all runs >= 1.8x",
      status: medianRatio >= 2 && worstRatio >= 1.8 ? "pass" : "fail",
      detail: `median ratio ${round(medianRatio, 2)}x, worst run ${round(worstRatio, 2)}x`
    })
  } else {
    checks.push({
      name: "5. FULL c50: median batched >= 2x baseline, all runs >= 1.8x",
      status: "insufficient-data",
      detail: "missing c50 cells"
    })
  }

  const normalOff = findAggregate(aggregates, "NORMAL", "off", 50)
  const normalOn = findAggregate(aggregates, "NORMAL", "on", 50)
  if (normalOff !== undefined && normalOn !== undefined) {
    const normalCells = matrix.filter(
      (cell) => cell.family === "matrix" && cell.synchronous === "NORMAL" && cell.batch === "on" && cell.concurrency === 50
    )
    const ratio = normalOn.throughputMedian / normalOff.throughputMedian
    const worst = Math.min(...normalCells.map((cell) => cell.throughput)) / normalOff.throughputMedian
    checks.push({
      name: "6. NORMAL c50: median batched >= 1.3x baseline, all runs >= 1.2x",
      status: ratio >= 1.3 && worst >= 1.2 ? "pass" : "fail",
      detail: `median ratio ${round(ratio, 2)}x, worst run ${round(worst, 2)}x`
    })
  } else {
    checks.push({
      name: "6. NORMAL c50: median batched >= 1.3x baseline, all runs >= 1.2x",
      status: "insufficient-data",
      detail: "missing c50 cells"
    })
  }

  const offC1 = findAggregate(aggregates, "FULL", "off", 1)
  const onC1 = findAggregate(aggregates, "FULL", "on", 1)
  if (offC1 !== undefined && onC1 !== undefined) {
    const latencyIncrease = onC1.p50Median - offC1.p50Median
    const throughputRatio = onC1.throughputMedian / offC1.throughputMedian
    checks.push({
      name: "7. c1: median latency increase <= windowMs+1ms, throughput >= 85%",
      status: latencyIncrease <= MATRIX_WINDOW_MS + 1 && throughputRatio >= 0.85 ? "pass" : "fail",
      detail: `+${round(latencyIncrease)} ms p50, throughput ${round(throughputRatio * 100, 1)}%`
    })
  } else {
    checks.push({
      name: "7. c1: median latency increase <= windowMs+1ms, throughput >= 85%",
      status: "insufficient-data",
      detail: "missing c1 cells"
    })
  }

  if (fullOffC50 !== undefined && fullOn !== undefined) {
    const p99Ok = fullOn.p99Median <= fullOffC50.p99Median * 2
    const readOfOn = matrix.filter(
      (cell) => cell.family === "matrix" && cell.synchronous === "FULL" && cell.batch === "on" && cell.concurrency === 50
    )
    const readsUsable = readOfOn.every(
      (cell) => cell.reads !== null && cell.reads.targetMet && cell.reads.failures === 0 && cell.readAtRest !== null
    )
    const burstRead = median(readOfOn.flatMap((cell) => (cell.reads === null ? [] : [cell.reads.p99])))
    const restRead = median(readOfOn.flatMap((cell) => (cell.readAtRest === null ? [] : [cell.readAtRest.p99])))
    const readOk = readsUsable && burstRead <= restRead * 2
    const readSamples = readOfOn
      .map((cell) => `${cell.reads?.samples ?? 0}/${cell.reads?.failures ?? 0}`)
      .join(",")
    checks.push({
      name: "8. c50 tail: p99 <= 2x baseline, read p99 during burst <= 2x at rest",
      status: !readsUsable ? "insufficient-data" : p99Ok && readOk ? "pass" : "fail",
      detail: `create p99 ${fullOn.p99Median} vs ${fullOffC50.p99Median} ms; read p99 ${round(burstRead)} vs ${round(restRead)} ms at rest; samples/failures ${readSamples}; readAtRest ${readOfOn.every((cell) => cell.readAtRest !== null) ? "present" : "MISSING"}`
    })
  } else {
    checks.push({
      name: "8. c50 tail: p99 <= 2x baseline, read p99 during burst <= 2x at rest",
      status: "insufficient-data",
      detail: "missing c50 cells"
    })
  }

  const open600 = openLoop.filter((cell) => cell.rate === 600)
  const uncapped600 = open600.filter((cell) => !cell.capped)
  if (uncapped600.length === 0) {
    checks.push({
      name: "9. open loop at 600 req/s",
      status: "insufficient-data",
      detail:
        open600.length === 0
          ? "open-loop arm not executed"
          : `${open600.length} run(s), all hit the in-flight cap (excluded)`
    })
  } else {
    const on = uncapped600.filter((cell) => cell.batch === "on")
    const off = uncapped600.filter((cell) => cell.batch === "off")
    if (on.length === 0 || off.length === 0) {
      checks.push({
        name: "9. open loop at 600 req/s",
        status: "insufficient-data",
        detail: `uncapped runs: on=${on.length} off=${off.length} (capped runs excluded)`
      })
    } else {
      const onP99 = median(on.map((cell) => cell.p99))
      const offP99 = median(off.map((cell) => cell.p99))
      const success = Math.min(...on.map((cell) => cell.successRate))
      const unavailable = on.reduce((total, cell) => total + cell.batchUnavailable, 0)
      const other = on.reduce((total, cell) => total + cell.otherErrors, 0)
      checks.push({
        name: "9. open loop at 600 req/s",
        status: onP99 <= offP99 * 2 && success >= 0.995 ? "pass" : "fail",
        detail: `p99 ${round(onP99)} vs ${round(offP99)} ms, success ${round(success * 100, 2)}%; batch_unavailable=${unavailable}, otherErrors=${other}; capped runs excluded`
      })
    }
  }

  const selfCheckFailures: Array<string> = []
  for (const cell of matrix) {
    if (cell.family !== "matrix") continue
    if (cell.stats === null) {
      selfCheckFailures.push(`${cell.label}: stats missing`)
      continue
    }
    if (cell.batch === "off" && cell.stats.batches !== 0) {
      selfCheckFailures.push(`${cell.label}: baseline reported ${cell.stats.batches} batches`)
    }
    if (cell.batch === "on" && cell.concurrency > 1) {
      if (cell.stats.maxBatchSize <= 1) selfCheckFailures.push(`${cell.label}: maxBatchSize <= 1`)
      if (cell.stats.applied !== cell.requests) {
        selfCheckFailures.push(`${cell.label}: records ${cell.stats.applied} != requests ${cell.requests}`)
      }
    }
    if (cell.rows !== cell.expectedRows) {
      selfCheckFailures.push(`${cell.label}: rows ${cell.rows} != expected ${cell.expectedRows}`)
    }
  }
  checks.push({
    name: "self-checks: stats active, baseline idle, records/rows exact",
    status: selfCheckFailures.length === 0 ? "pass" : "fail",
    detail: selfCheckFailures.slice(0, 8).join("; ") || "all cells consistent"
  })

  return checks
}

const sweepSummary = (
  results: ReadonlyArray<CellResult>,
  family: CellSpec["family"]
): ReadonlyArray<SweepPoint> => {
  const cells = results.filter((cell) => cell.family === family)
  const groups = new Map<string, Array<CellResult>>()
  for (const cell of cells) {
    const key = `${cell.windowMs}|${cell.maxBatchSize}`
    const list = groups.get(key) ?? []
    list.push(cell)
    groups.set(key, list)
  }
  return [...groups.values()]
    .map((group) => {
      const first = group[0]
      return {
        windowMs: first.windowMs,
        maxBatchSize: first.maxBatchSize,
        throughput: round(median(group.map((cell) => cell.throughput))),
        p99: round(median(group.map((cell) => cell.p99))),
        medianFlushSizeLast50: round(median(group.map((cell) => cell.medianFlushSizeLast50))),
        commitsRatio: round(
          median(group.map((cell) => (cell.stats === null ? 0 : cell.stats.commits / cell.requests))),
          3
        )
      }
    })
    .sort((left, right) => left.windowMs - right.windowMs || left.maxBatchSize - right.maxBatchSize)
}

const formatMatrixTable = (aggregates: ReadonlyArray<Aggregate>) => {
  const rows = aggregates
    .slice()
    .sort(
      (left, right) =>
        left.synchronous.localeCompare(right.synchronous) ||
        left.concurrency - right.concurrency ||
        left.batch.localeCompare(right.batch)
    )
    .map(
      (entry) =>
        `| ${entry.synchronous} | ${entry.batch} | ${entry.concurrency} | ${entry.throughputMedian} | ${entry.p50Median} | ${entry.p99Median} | ${entry.successRateMedian}% | ${entry.runs} |`
    )
  return ["| Sync | Batch | c | rps (2xx/median) | p50 ms | p99 ms | success | runs |", "|---|---|---:|---:|---:|---:|---:|---:|", ...rows].join("\n")
}

const renderSummary = (
  results: ReadonlyArray<CellResult>,
  openLoop: ReadonlyArray<OpenLoopResult>,
  checks: ReadonlyArray<Check>,
  preSpikeC50: number | null,
  machine: Record<string, string>
): string => {
  const aggregates = aggregate(results, "matrix")
  const windowSweep = sweepSummary(results, "window-sweep")
  const batchSweep = sweepSummary(results, "batch-sweep")
  const cacheOn = aggregate(results, "cache-on")
  const matrixOff50 = findAggregate(aggregates, "FULL", "off", 50)

  const lines: string[] = []
  lines.push("# Create-batch audit summary")
  lines.push("")
  lines.push(`- Platform: ${platform}`)
  lines.push(`- Node: ${machine.node}`)
  lines.push(`- OS: ${machine.os}`)
  lines.push(`- CPU: ${machine.cpu}`)
  lines.push(`- Mode: ${fast ? "AUDIT_FAST (smoke)" : "full matrix"}; repeats: ${repeats}`)
  lines.push(`- Cache: off for the primary matrix; one cache-on cell when enabled`)
  lines.push(`- Pre-spike control c50 throughput: ${preSpikeC50 === null ? "not found" : `${round(preSpikeC50)} rps`}`)
  lines.push("")
  lines.push("## Acceptance")
  lines.push("")
  for (const check of checks) {
    lines.push(
      `- **${check.status.toUpperCase()}**${check.blocking === false ? " (sanity, non-blocking)" : ""} — ${check.name}: ${check.detail}`
    )
  }
  lines.push("")
  lines.push("## Matrix (baseline vs batched)")
  lines.push("")
  lines.push(formatMatrixTable(aggregates))
  lines.push("")
  if (cacheOn.length > 0) {
    lines.push("## Cache-on informational cell (FULL, c50, batched)")
    lines.push("")
    lines.push(formatMatrixTable(cacheOn))
    const cacheRow = cacheOn[0]
    if (matrixOff50 !== undefined) {
      lines.push(
        ""
      )
      lines.push(
        `Cache-on batched throughput is ${round((cacheRow.throughputMedian / matrixOff50.throughputMedian) * 100, 1)}% of the no-cache baseline median.`
      )
    }
    lines.push("")
  }
  if (windowSweep.length > 0) {
    lines.push("## Window sweep (FULL, c50, maxBatchSize 100)")
    lines.push("")
    lines.push("| windowMs | maxBatchSize | rps | p99 ms | median flush (last 50) | commits/requests |")
    lines.push("|---:|---:|---:|---:|---:|---:|")
    for (const point of windowSweep) {
      lines.push(
        `| ${point.windowMs} | ${point.maxBatchSize} | ${point.throughput} | ${point.p99} | ${point.medianFlushSizeLast50} | ${point.commitsRatio} |`
      )
    }
    lines.push("")
  }
  if (batchSweep.length > 0) {
    lines.push("## Batch-size sweep (FULL, c50, windowMs 0)")
    lines.push("")
    lines.push("| windowMs | maxBatchSize | rps | p99 ms | median flush (last 50) | commits/requests |")
    lines.push("|---:|---:|---:|---:|---:|---:|")
    for (const point of batchSweep) {
      lines.push(
        `| ${point.windowMs} | ${point.maxBatchSize} | ${point.throughput} | ${point.p99} | ${point.medianFlushSizeLast50} | ${point.commitsRatio} |`
      )
    }
    lines.push("")
  }
  if (openLoop.length > 0) {
    lines.push("## Open loop (timer-driven, in-flight cap 1,000)")
    lines.push("")
    lines.push("| Sync | Batch | rate | scheduled | success | p50 ms | p99 ms | capped | batch_unavailable | rejected | timedOut |")
    lines.push("|---|---|---:|---:|---:|---:|---:|---:|")
    for (const cell of openLoop) {
      lines.push(
        `| ${cell.synchronous} | ${cell.batch} | ${cell.rate} | ${cell.scheduled} | ${round(cell.successRate * 100, 2)}% | ${round(cell.p50)} | ${round(cell.p99)} | ${cell.capped ? "yes" : "no"} | ${cell.batchUnavailable} | ${cell.stats?.rejected ?? "-"} | ${cell.stats?.timedOut ?? "-"} |`
      )
    }
    lines.push("")
  }
  const readCells = results.filter(
    (cell) => cell.family === "matrix" && cell.reads !== null && cell.synchronous === "FULL"
  )
  if (readCells.length > 0) {
    lines.push("## Read arm (FULL cells with concurrent reads)")
    lines.push("")
    lines.push("| Batch | c | read p50 | read p95 | read p99 | reads | target met | read p99 at rest |")
    lines.push("|---|---:|---:|---:|---:|---:|---|---:|")
    for (const cell of readCells) {
      const reads = cell.reads
      const rest = cell.readAtRest
      if (reads === null) continue
      lines.push(
        `| ${cell.batch} | ${cell.concurrency} | ${round(reads.p50)} | ${round(reads.p95)} | ${round(reads.p99)} | ${reads.samples} | ${reads.targetMet ? "yes" : "no"} | ${rest === null ? "-" : round(rest.p99)} |`
      )
    }
    lines.push("")
  }
  lines.push("## Notes")
  lines.push("")
  lines.push("- `rps` is successful throughput (2xx only); failed attempts are excluded. Each cell reports its success rate next to it.")
  lines.push("- `commits` comes from `BatchMutationStats`, recorded after `COMMIT` returns; `batches` is the flush count; `median flush` is over the last 50 flushes, not the whole run.")
  lines.push("- A create that times out may still have committed. There is no idempotency key: do not blindly retry creates.")
  lines.push("- The batch holds the single SQLite connection for its duration, so reads in other fibers wait for the commit.")
  lines.push(`- The read arm targets ${READ_TARGET} completed reads per cell; check 8 is \`insufficient-data\` when a cell misses that target or has no read-at-rest sample.`)
  lines.push("- The pre-spike control is a different shape (500 requests, no warm-up, cache disabled). Check 4 is a non-blocking sanity comparison, not an acceptance gate.")
  lines.push("- Open-loop row counts can exceed acknowledged successes when a client timeout hides a commit; such runs report `batch_unavailable` separately and capped runs are excluded from check 9.")
  lines.push("")
  return lines.join("\n")
}

const checkStatusExitCode = (checks: ReadonlyArray<Check>) =>
  checks.some((check) => check.blocking !== false && check.status !== "pass") ? 1 : 0

const results: Array<CellResult> = []
const openLoop: Array<OpenLoopResult> = []

const main = async () => {
  mkdirSync(outDir, { recursive: true })

  const preSpike = readPreSpikeControl()
  const preSpikeC50 = preSpikeCreateThroughput(preSpike)
  let runError: string | null = null

  const specs = [...matrixSpecs(), ...cacheOnSpecs(), ...sweepSpecs()]

  try {
    for (const spec of specs) {
      process.stdout.write(
        `[${platform}] ${spec.label} (c${spec.concurrency}, n=${spec.requests}, window=${spec.windowMs}, batch=${spec.maxBatchSize})\n`
      )
      const outcome = await runCell(spec)
      results.push(outcome.result)
      const result = outcome.result
      process.stdout.write(
        `  rps=${result.throughput} p50=${result.p50} p99=${result.p99} success=${result.successRate}% commits=${result.stats?.commits ?? "-"} flush=${result.medianFlushSizeLast50} rows=${result.rows}/${result.expectedRows}\n`
      )

      // Hard self-checks: abort rather than report a meaningless comparison.
      if (result.stats === null) {
        throw new Error(`${spec.label}: BatchMutationStats is missing or unreadable — aborting`)
      }
      if (result.batch === "on" && result.concurrency > 1 && result.stats.applied !== result.requests) {
        throw new Error(
          `${spec.label}: stats.applied (${result.stats.applied}) !== requests (${result.requests}) — aborting`
        )
      }
      if (result.batch === "off" && result.stats.batches !== 0) {
        throw new Error(`${spec.label}: baseline recorded ${result.stats.batches} batches — aborting`)
      }
      if (result.rows !== result.expectedRows) {
        throw new Error(`${spec.label}: row count ${result.rows} !== expected ${result.expectedRows} — aborting`)
      }
    }
  } catch (error) {
    runError = error instanceof Error ? error.message : String(error)
    process.stderr.write(`Audit aborted during the cell loop: ${runError}\n`)
  }

  if (!fast && runError === null) {
    const rates = [600, 1_200]
    const durationMs = 5_000
    try {
      for (const synchronous of ["FULL", "NORMAL"] as const) {
        for (const batch of ["off", "on"] as const) {
          for (let repeat = 0; repeat < repeats; repeat += 1) {
            for (const rate of rates) {
              const spec: CellSpec = {
                family: "matrix",
                label: `open-${synchronous}-${batch}-${rate}-r${repeat}`,
                synchronous,
                batch,
                cache: false,
                windowMs: MATRIX_WINDOW_MS,
                maxBatchSize: 100,
                concurrency: 0,
                requests: 0,
                repeat,
                readArm: false,
                collectReadAtRest: false
              }
              const directory = mkdtempSync(join(tmpdir(), `mira-open-loop-${synchronous}-${batch}-`))
              const port = await freePort()
              const server = startServer(spec, directory, port, "bench.sqlite")
              try {
                await waitForReady(server)
                await runCreates(server.baseUrl, 10, WARMUPS, "warm")
                await fetch(`${server.baseUrl}/__bench/batch-stats/reset`, { method: "POST" })
                process.stdout.write(
                  `[${platform}] open-loop ${synchronous} ${batch} ${rate} req/s r${repeat}\n`
                )
                const outcome = await runOpenLoop(spec, server.baseUrl, rate, durationMs)
                const [rows, stats] = await Promise.all([
                  readRowCount(server),
                  readBatchStats(server)
                ])
                const expectedRows = outcome.successes + WARMUPS
                openLoop.push({ ...outcome, rows, expectedRows, stats })
                process.stdout.write(
                  `  scheduled=${outcome.scheduled} success=${round(outcome.successRate * 100, 2)}% p99=${round(outcome.p99)} cap=${outcome.clientCapEvents} rows=${rows}/${expectedRows} batchUnavailable=${outcome.batchUnavailable}\n`
                )
                if (rows < expectedRows) {
                  throw new Error(
                    `open-loop ${spec.label}: rows ${rows} < acknowledged successes+warmups ${expectedRows} — aborting`
                  )
                }
                if (rows > expectedRows) {
                  process.stdout.write(
                    `  note: ${rows - expectedRows} rows committed without an acknowledged response (client timeout; do not blind-retry)\n`
                  )
                }
              } finally {
                await stopServer(server)
                try {
                  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
                } catch {
                  // Windows may hold a handle briefly.
                }
              }
            }
          }
        }
      }
    } catch (error) {
      runError = error instanceof Error ? error.message : String(error)
      process.stderr.write(`Audit aborted during the open-loop arm: ${runError}\n`)
    }
  }

  const checks = evaluate(results, openLoop, preSpikeC50)
  const machine = {
    node: process.version,
    os: `${process.platform} ${process.arch}`,
    cpu: cpus()[0]?.model ?? "unknown"
  }

  const rawPath = join(outDir, fast ? "create-batch-audit-fast.json" : "create-batch-audit.json")
  const summaryPath = join(outDir, "create-batch-audit-summary.md")
  const payload = {
    mode: fast ? "fast" : "full",
    platform,
    repeats,
    warmups: WARMUPS,
    readTarget: READ_TARGET,
    matrixConcurrencies,
    matrixWindowMs: MATRIX_WINDOW_MS,
    skipSweeps,
    runError,
    preSpikeControl: preSpike,
    preSpikeC50,
    machine,
    checks,
    aggregates: aggregate(results, "matrix"),
    sweep: { window: sweepSummary(results, "window-sweep"), batch: sweepSummary(results, "batch-sweep") },
    cacheOn: aggregate(results, "cache-on"),
    results,
    openLoop
  }
  const summary = `${renderSummary(results, openLoop, checks, preSpikeC50, machine)}${
    runError === null ? "" : `\n> **ABORTED**: ${runError}\n`
  }`
  writeFileSync(rawPath, `${JSON.stringify(payload, null, 2)}\n`)
  writeFileSync(summaryPath, `${summary}\n`)

  process.stdout.write(`\n${summary}\n`)
  process.stdout.write(`Wrote ${rawPath}\nWrote ${summaryPath}\n`)

  return runError === null ? checkStatusExitCode(checks) : 1
}

const exitCode = await main()
process.exit(exitCode)
