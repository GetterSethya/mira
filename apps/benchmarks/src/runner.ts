import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { execSync } from "node:child_process"
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { arch, cpus, platform, totalmem } from "node:os"
import { join } from "node:path"
import { performance } from "node:perf_hooks"

import { Schema } from "effect"

type PlatformName = "node" | "bun"

type LoadResult = {
  readonly throughput: number
  readonly p50: number
  readonly p95: number
  readonly p99: number
  readonly durationMs: number
}

type PlatformRun = {
  readonly startupMs: number
  readonly create: LoadResult
  readonly list: LoadResult
  readonly listCached: LoadResult
}

type PlatformSummary = {
  readonly startupMs: number
  readonly create: LoadResult
  readonly list: LoadResult
  readonly listCached: LoadResult
  readonly runs: ReadonlyArray<PlatformRun>
}

const packageRoot = process.cwd()
const repoRoot = join(packageRoot, "../..")
const RUNS = Number(process.env.BENCH_RUNS ?? "5")
const NODE_LOADER = process.env.BENCH_NODE_LOADER === "tsx" ? "tsx" : "native"
const RECORDS = Number(process.env.BENCH_RECORDS ?? "500")
const SEED_RECORDS = Number(process.env.BENCH_SEED_RECORDS ?? "50")
const LIST_REQUESTS = Number(process.env.BENCH_LIST_REQUESTS ?? "2000")
const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY ?? "50")
const BODY = "x".repeat(180)
const BATCH_MUTATION_ENABLED = process.env.BENCH_CREATE_BATCH !== "off"
const BATCH_MUTATION_WINDOW_MS = Number(process.env.BENCH_CREATE_BATCH_WINDOW_MS ?? "0")
const BATCH_MUTATION_MAX = Number(process.env.BENCH_CREATE_BATCH_MAX ?? "100")
const ListBodySchema = Schema.Struct({ items: Schema.Array(Schema.Unknown) })
const PostWriteSchema = Schema.Struct({ title: Schema.String, body: Schema.String })
const ListFilterSchema = Schema.Struct({
  op: Schema.Literals(["neq", "eq"]),
  field: Schema.String,
  value: Schema.String
})

const encodePostWrite = Schema.encodeSync(Schema.fromJsonString(PostWriteSchema))
const encodeListFilter = Schema.encodeSync(Schema.fromJsonString(ListFilterSchema))
const encodeBenchmarkOutput = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown, { space: 2 }))

if (!Number.isInteger(RUNS) || RUNS < 1) {
  throw new Error("BENCH_RUNS must be a positive integer")
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
        reject(new Error("Could not allocate a benchmark port"))
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
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
}

const runLoad = async (
  total: number,
  concurrency: number,
  makeRequest: (index: number) => Promise<Response>
): Promise<LoadResult> => {
  const latencies: Array<number> = []
  let next = 0
  const started = performance.now()

  const worker = async () => {
    while (true) {
      const index = next
      next += 1
      if (index >= total) return

      const requestStarted = performance.now()
      const response = await makeRequest(index)
      await response.arrayBuffer()
      latencies.push(performance.now() - requestStarted)
      if (!response.ok) {
        throw new Error(`Benchmark request ${index} failed with ${response.status}`)
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker))
  const durationMs = performance.now() - started
  const sorted = [...latencies].sort((a, b) => a - b)

  return {
    throughput: total / (durationMs / 1000),
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    durationMs
  }
}

const waitForReady = async (baseUrl: string, child: ChildProcess, logs: () => string) => {
  const deadline = performance.now() + 30_000
  while (performance.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Benchmark server exited before readiness:\n${logs()}`)
    }
    try {
      const response = await fetch(`${baseUrl}/api/collections/posts?limit=1`, {
        signal: AbortSignal.timeout(500)
      })
      if (response.ok) {
        await response.arrayBuffer()
        return
      }
    } catch {
      // Server is still booting.
    }
    await sleep(5)
  }
  throw new Error(`Timed out waiting for ${baseUrl}:\n${logs()}`)
}

const stopServer = async (child: ChildProcess) => {
  if (child.exitCode !== null) return
  child.kill("SIGTERM")
  const exited = await Promise.race([
    new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
    sleep(5_000).then(() => false)
  ])
  if (!exited && child.exitCode === null) {
    child.kill("SIGKILL")
  }
}

const startServer = (platform: PlatformName, port: number, dbPath: string, uploads: string) => {
  const command =
    platform === "node"
      ? {
          executable: process.execPath,
          args: NODE_LOADER === "native" ? ["src/server.ts"] : ["--import", "tsx", "src/server.ts"]
        }
      : { executable: "bun", args: ["run", "src/server.ts"] }

  const child = spawn(command.executable, command.args, {
    cwd: packageRoot,
    env: {
      ...process.env,
      BENCH_PLATFORM: platform,
      BENCH_PORT: String(port),
      BENCH_DB: dbPath,
      BENCH_UPLOADS: uploads
    },
    stdio: ["ignore", "pipe", "pipe"]
  })

  let output = ""
  const append = (value: Buffer) => {
    output = `${output}${value.toString()}`.slice(-8_000)
  }
  child.stdout?.on("data", append)
  child.stderr?.on("data", append)

  return { child, logs: () => output }
}

const runOnce = async (platform: PlatformName): Promise<PlatformRun> => {
  const dir = mkdtempSync(join(tmpdir(), `mira-bench-${platform}-`))
  const dbPath = join(dir, "bench.sqlite")
  const uploads = join(dir, "uploads")
  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const started = performance.now()
  const { child, logs } = startServer(platform, port, dbPath, uploads)

  try {
    await waitForReady(baseUrl, child, logs)
    const startupMs = performance.now() - started

    await runLoad(SEED_RECORDS, 10, (index) =>
      fetch(`${baseUrl}/api/collections/posts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: encodePostWrite({ title: `Seed ${index}`, body: BODY })
      })
    )

    const create = await runLoad(RECORDS, CONCURRENCY, (index) =>
      fetch(`${baseUrl}/api/collections/posts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: encodePostWrite({ title: `Post ${index}`, body: BODY })
      })
    )

    const listUrl = (prefix: string, index: number) => {
      const filter = encodeURIComponent(encodeListFilter({ op: "neq", field: "title", value: `${prefix}-${index}` }))
      return `${baseUrl}/api/collections/posts?limit=30&filter=${filter}`
    }

    const validation = await fetch(listUrl("validate", 0))
    const validationBody = Schema.decodeUnknownSync(ListBodySchema)(await validation.json())
    if (!validation.ok || validationBody.items.length !== 30) {
      throw new Error("Filtered list validation failed: expected 30 items")
    }

    const positive = await fetch(
      `${baseUrl}/api/collections/posts?limit=30&filter=${encodeURIComponent(
        encodeListFilter({ op: "eq", field: "title", value: "Post 0" })
      )}`
    )
    const positiveBody = Schema.decodeUnknownSync(ListBodySchema)(await positive.json())
    if (!positive.ok || positiveBody.items.length !== 1) {
      throw new Error("Filter positive control failed: expected one Post 0")
    }

    const negative = await fetch(
      `${baseUrl}/api/collections/posts?limit=30&filter=${encodeURIComponent(
        encodeListFilter({ op: "eq", field: "title", value: "__absent__" })
      )}`
    )
    const negativeBody = Schema.decodeUnknownSync(ListBodySchema)(await negative.json())
    if (!negative.ok || negativeBody.items.length !== 0) {
      throw new Error("Filter negative control failed: expected no rows")
    }

    await runLoad(100, 10, (index) => fetch(listUrl("warm", index)))

    const list = await runLoad(LIST_REQUESTS, CONCURRENCY, (index) => fetch(listUrl("cache-miss", index)))

    // Cache-hit path: one stable URL, warmed after the write phase so the
    // create invalidation cannot hide the cache metric.
    const cachedListUrl = `${baseUrl}/api/collections/posts?limit=30`
    const cachedValidation = await fetch(cachedListUrl)
    const cachedValidationBody = Schema.decodeUnknownSync(ListBodySchema)(await cachedValidation.json())
    if (!cachedValidation.ok || cachedValidationBody.items.length !== 30) {
      throw new Error("Cached list validation failed: expected 30 items")
    }
    await runLoad(100, 10, () => fetch(cachedListUrl))
    const listCached = await runLoad(LIST_REQUESTS, CONCURRENCY, () => fetch(cachedListUrl))

    return { startupMs, create, list, listCached }
  } finally {
    await stopServer(child)
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch {
      // Windows can keep a handle briefly after the child exits. The next run
      // uses a fresh temp directory, so a leftover directory is harmless.
    }
  }
}

const summarize = (runs: ReadonlyArray<PlatformRun>): PlatformSummary => ({
  startupMs: median(runs.map((run) => run.startupMs)),
  create: {
    throughput: median(runs.map((run) => run.create.throughput)),
    p50: median(runs.map((run) => run.create.p50)),
    p95: median(runs.map((run) => run.create.p95)),
    p99: median(runs.map((run) => run.create.p99)),
    durationMs: median(runs.map((run) => run.create.durationMs))
  },
  list: {
    throughput: median(runs.map((run) => run.list.throughput)),
    p50: median(runs.map((run) => run.list.p50)),
    p95: median(runs.map((run) => run.list.p95)),
    p99: median(runs.map((run) => run.list.p99)),
    durationMs: median(runs.map((run) => run.list.durationMs))
  },
  listCached: {
    throughput: median(runs.map((run) => run.listCached.throughput)),
    p50: median(runs.map((run) => run.listCached.p50)),
    p95: median(runs.map((run) => run.listCached.p95)),
    p99: median(runs.map((run) => run.listCached.p99)),
    durationMs: median(runs.map((run) => run.listCached.durationMs))
  },
  runs
})

const nodeRuns: Array<PlatformRun> = []
const bunRuns: Array<PlatformRun> = []

for (let run = 0; run < RUNS; run += 1) {
  const nodeFirst = run % 2 === 0
  const order: ReadonlyArray<PlatformName> = nodeFirst ? ["node", "bun"] : ["bun", "node"]
  for (const platformName of order) {
    console.log(`run ${run + 1}/${RUNS}: ${platformName}`)
    const result = await runOnce(platformName)
    if (platformName === "node") nodeRuns.push(result)
    else bunRuns.push(result)
  }
}

const bunVersion = execSync("bun --version", { encoding: "utf8" }).trim()
const gitCommit = execSync("git rev-parse --short HEAD", {
  cwd: repoRoot,
  encoding: "utf8"
}).trim()

const data = {
  generatedAt: new Date().toISOString(),
  environment: {
    os: `${platform()} ${arch()}`,
    cpu: cpus()[0]?.model ?? "unknown",
    cores: cpus().length,
    memoryGb: Math.round(totalmem() / 1024 ** 3),
    node: process.version,
    bun: bunVersion,
    harnessCommit: gitCommit
  },
  method: {
    runs: RUNS,
    nodeLoader: NODE_LOADER,
    runOrder: "alternating node-first / bun-first",
    seedRecords: SEED_RECORDS,
    seedConcurrency: 10,
    records: SEED_RECORDS + RECORDS,
    createRequests: RECORDS,
    listRequests: LIST_REQUESTS,
    warmupRequests: 100,
    warmupConcurrency: 10,
    concurrency: CONCURRENCY,
    responseLimit: 30,
    payloadBytes: BODY.length,
    listFilter: "unique title neq value per request (cache bypass)",
    listCached: "same URL repeated after warm-up (cache hit)",
    batchMutation: {
      create: {
        enabled: BATCH_MUTATION_ENABLED,
        windowMs: BATCH_MUTATION_WINDOW_MS,
        maxBatchSize: BATCH_MUTATION_MAX
      }
    },
    cache: {
      enabled: process.env.BENCH_CACHE !== "off",
      listTtlMs: 10_000,
      maxLists: 5_000
    },
    telemetry: "off",
    schemaCompiler: process.env.BENCH_SCHEMA_JIT === "on" ? "jit" : "off",
    validation: {
      filteredItems: 30,
      positiveItems: 1,
      negativeItems: 0
    }
  },
  results: {
    node: summarize(nodeRuns),
    bun: summarize(bunRuns)
  }
}

const outputPath = process.env.BENCH_OUTPUT ?? join(repoRoot, "apps/landing/src/lib/benchmarks.json")
const tempPath = `${outputPath}.tmp`
writeFileSync(tempPath, `${encodeBenchmarkOutput(data)}\n`)
renameSync(tempPath, outputPath)

console.log(`Wrote ${outputPath}`)
