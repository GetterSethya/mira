import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import { DatabaseSync } from "node:sqlite"

import { Schema } from "effect"

type PlatformName = "node" | "bun"
type Scenario =
  | "list"
  | "list-nocache"
  | "list-nofilter-nocache"
  | "list-scan"
  | "repo-list"
  | "repo-list-scan"
  | "create"
  | "ping"
  | "startup"

type LoadResult = {
  readonly throughput: number
  readonly p50: number
  readonly p95: number
  readonly p99: number
  readonly durationMs: number
}

type Memory = {
  readonly rss: number
  readonly heapTotal: number
  readonly heapUsed: number
  readonly external: number
  readonly arrayBuffers: number
}

type AuditCase = {
  readonly name: string
  readonly platform: PlatformName
  readonly scenario: Scenario
  readonly rows: number
  readonly concurrency: number
  readonly requests: number
  readonly profile: boolean
}

type CaseResult = AuditCase & {
  readonly startupMs: number
  readonly load: LoadResult | null
  readonly memory: Memory | null
  readonly profilePath: string | null
  readonly profileBytes: number | null
}

const packageRoot = process.cwd()
const root = join(packageRoot, "../..")
const outDir = process.env.AUDIT_OUT ?? join(root, ".egm", "perf-audit-2026-11-15")
const mode = process.env.AUDIT_MODE ?? "all"
const only = (process.env.AUDIT_ONLY ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter((value) => value.length > 0)
const platforms = (process.env.AUDIT_PLATFORMS ?? "node,bun")
  .split(",")
  .map((value) => value.trim())
  .filter((value): value is PlatformName => value === "node" || value === "bun")
const BODY = "x".repeat(180)

const MemorySchema = Schema.Struct({
  rss: Schema.Number,
  heapTotal: Schema.Number,
  heapUsed: Schema.Number,
  external: Schema.Number,
  arrayBuffers: Schema.Number
})

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
      const startedAt = performance.now()
      const response = await makeRequest(index)
      await response.arrayBuffer()
      latencies.push(performance.now() - startedAt)
      if (!response.ok) {
        throw new Error(`Audit request ${index} failed with ${response.status}`)
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

const startServer = (
  platform: PlatformName,
  options: {
    readonly port: string
    readonly dbPath: string
    readonly uploads: string
    readonly profile: boolean
    readonly profileName: string
  }
) => {
  const profileArgs = options.profile
    ? ["--cpu-prof", `--cpu-prof-dir=${outDir}`, `--cpu-prof-name=${options.profileName}`]
    : []
  const args =
    platform === "node"
      ? [...profileArgs, "src/server.ts"]
      : [...profileArgs, "run", "src/server.ts"]
  const child = spawn(platform === "node" ? process.execPath : "bun", args, {
    cwd: packageRoot,
    env: {
      ...process.env,
      BENCH_PLATFORM: platform,
      BENCH_PORT: options.port,
      BENCH_DB: options.dbPath,
      BENCH_UPLOADS: options.uploads,
      BENCH_STACK_TRACES: "off"
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

const waitForExit = (child: ChildProcess, timeoutMs: number) =>
  new Promise<boolean>((resolve) => {
    if (child.exitCode !== null) {
      resolve(true)
      return
    }
    const timer = setTimeout(() => resolve(false), timeoutMs)
    child.once("exit", () => {
      clearTimeout(timer)
      resolve(true)
    })
  })

const waitForReady = async (baseUrl: string, child: ChildProcess, logs: () => string) => {
  const deadline = performance.now() + 30_000
  while (performance.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited before readiness:\n${logs()}`)
    }
    try {
      const response = await fetch(`${baseUrl}/__bench/ping`, {
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

const stopServer = async (baseUrl: string, child: ChildProcess) => {
  if (child.exitCode !== null) return
  try {
    await fetch(`${baseUrl}/__bench/exit`, { signal: AbortSignal.timeout(1_000) })
  } catch {
    // The server may already be gone.
  }
  const exited = await waitForExit(child, 5_000)
  if (!exited && child.exitCode === null) {
    child.kill("SIGKILL")
    await waitForExit(child, 2_000)
  }
}

const seedRows = (dbPath: string, rows: number) => {
  if (rows === 0) return
  const db = new DatabaseSync(dbPath)
  const insert = db.prepare(
    "INSERT INTO posts (id, title, body, published, created, updated) VALUES (?, ?, ?, ?, ?, ?)"
  )
  const now = new Date().toISOString()
  db.exec("BEGIN")
  for (let i = 0; i < rows; i += 1) {
    insert.run(randomUUID(), `Post ${i}`, BODY, 0, now, now)
  }
  db.exec("COMMIT")
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
  db.close()
}

const prepareDatabase = async (platform: PlatformName, rows: number, dir: string) => {
  const dbPath = join(dir, "bench.sqlite")
  const uploads = join(dir, "uploads")
  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const server = startServer(platform, {
    port: String(port),
    dbPath,
    uploads,
    profile: false,
    profileName: "unused"
  })
  try {
    await waitForReady(baseUrl, server.child, server.logs)
  } finally {
    await stopServer(baseUrl, server.child)
  }
  seedRows(dbPath, rows)
  return { dbPath, uploads }
}

const listUrl = (baseUrl: string, prefix: string, index: number) => {
  const filter = encodeURIComponent(
    JSON.stringify({ op: "neq", field: "title", value: `${prefix}-${index}` })
  )
  return `${baseUrl}/api/collections/posts?limit=30&filter=${filter}`
}

const scanUrl = (baseUrl: string, prefix: string, index: number) => {
  const filter = encodeURIComponent(
    JSON.stringify({ op: "eq", field: "title", value: `${prefix}-${index}` })
  )
  return `${baseUrl}/api/collections/posts?limit=30&filter=${filter}`
}

// A non-empty `expand` makes the cached service bypass the cache without
// adding a join, because `__none__` is not a relation field.
const listNoCacheUrl = (baseUrl: string, prefix: string, index: number) => {
  const filter = encodeURIComponent(
    JSON.stringify({ op: "neq", field: "title", value: `${prefix}-${index}` })
  )
  return `${baseUrl}/api/collections/posts?limit=30&filter=${filter}&expand=__none__`
}

const listNoFilterNoCacheUrl = (baseUrl: string) =>
  `${baseUrl}/api/collections/posts?limit=30&expand=__none__`

const repoListUrl = (baseUrl: string, prefix: string, index: number) =>
  `${baseUrl}/__bench/repo-list?value=${encodeURIComponent(`${prefix}-${index}`)}`

const repoScanUrl = (baseUrl: string, prefix: string, index: number) =>
  `${baseUrl}/__bench/repo-list?op=eq&value=${encodeURIComponent(`${prefix}-${index}`)}`

const requestFor = (
  scenario: Scenario,
  baseUrl: string,
  prefix: string,
  index: number
): Promise<Response> => {
  switch (scenario) {
    case "list":
      return fetch(listUrl(baseUrl, prefix, index))
    case "list-nocache":
      return fetch(listNoCacheUrl(baseUrl, prefix, index))
    case "list-nofilter-nocache":
      return fetch(listNoFilterNoCacheUrl(baseUrl))
    case "list-scan":
      return fetch(scanUrl(baseUrl, prefix, index))
    case "repo-list":
      return fetch(repoListUrl(baseUrl, prefix, index))
    case "repo-list-scan":
      return fetch(repoScanUrl(baseUrl, prefix, index))
    case "ping":
    case "startup":
      return fetch(`${baseUrl}/__bench/ping`)
    case "create":
      return fetch(`${baseUrl}/api/collections/posts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: `Post ${index}`, body: BODY })
      })
  }
}

const runCase = async (testCase: AuditCase): Promise<CaseResult> => {
  mkdirSync(outDir, { recursive: true })
  const dir = mkdtempSync(join(tmpdir(), `mira-audit-${testCase.platform}-`))
  const { dbPath, uploads } = await prepareDatabase(testCase.platform, testCase.rows, dir)
  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const profileName = `${testCase.platform}-${testCase.name}.cpuprofile`
  const profilePath = join(outDir, profileName)
  if (existsSync(profilePath)) rmSync(profilePath, { force: true })

  const started = performance.now()
  const server = startServer(testCase.platform, {
    port: String(port),
    dbPath,
    uploads,
    profile: testCase.profile,
    profileName
  })

  try {
    await waitForReady(baseUrl, server.child, server.logs)
    const startupMs = performance.now() - started

    let load: LoadResult | null = null
    if (testCase.requests > 0) {
      if (testCase.scenario !== "create") {
        const warmup = testCase.scenario === "ping" ? 1_000 : 100
        await runLoad(warmup, 10, (index) =>
          requestFor(testCase.scenario, baseUrl, "warm", index)
        )
      }
      load = await runLoad(testCase.requests, testCase.concurrency, (index) =>
        requestFor(testCase.scenario, baseUrl, "measured", index)
      )
    }

    const memoryResponse = await fetch(`${baseUrl}/__bench/memory`)
    const memory = Schema.decodeUnknownSync(MemorySchema)(await memoryResponse.json())

    await stopServer(baseUrl, server.child)
    await sleep(250)

    const profileBytes = existsSync(profilePath) ? statSync(profilePath).size : null
    return {
      ...testCase,
      startupMs,
      load,
      memory,
      profilePath: profileBytes === null ? null : profilePath,
      profileBytes
    }
  } finally {
    await stopServer(baseUrl, server.child)
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch {
      // Windows may keep a handle briefly after the child exits.
    }
  }
}

const profileCases = (platform: PlatformName): ReadonlyArray<AuditCase> => [
  { name: "startup", platform, scenario: "startup", rows: 0, concurrency: 1, requests: 0, profile: true },
  { name: "ping", platform, scenario: "ping", rows: 0, concurrency: 50, requests: 30_000, profile: true },
  { name: "list-small", platform, scenario: "list", rows: 550, concurrency: 50, requests: 4_000, profile: true },
  { name: "list-nocache-small", platform, scenario: "list-nocache", rows: 550, concurrency: 50, requests: 4_000, profile: true },
  { name: "list-nofilter-nocache-small", platform, scenario: "list-nofilter-nocache", rows: 550, concurrency: 50, requests: 4_000, profile: true },
  { name: "list-large", platform, scenario: "list", rows: 50_000, concurrency: 50, requests: 4_000, profile: true },
  { name: "list-scan-large", platform, scenario: "list-scan", rows: 50_000, concurrency: 50, requests: 2_000, profile: true },
  { name: "repo-list-small", platform, scenario: "repo-list", rows: 550, concurrency: 50, requests: 4_000, profile: true },
  { name: "repo-list-large", platform, scenario: "repo-list", rows: 50_000, concurrency: 50, requests: 4_000, profile: true },
  { name: "create", platform, scenario: "create", rows: 0, concurrency: 50, requests: 4_000, profile: true }
]

const loadCases = (platform: PlatformName): ReadonlyArray<AuditCase> => {
  const cases: Array<AuditCase> = []
  for (const rows of [550, 50_000]) {
    for (const concurrency of [1, 10, 50, 100]) {
      cases.push({
        name: `list-${rows}-c${concurrency}`,
        platform,
        scenario: "list",
        rows,
        concurrency,
        requests: concurrency === 1 ? 300 : 2_000,
        profile: false
      })
    }
  }
  for (const rows of [550, 50_000]) {
    cases.push({
      name: `list-nocache-${rows}-c50`,
      platform,
      scenario: "list-nocache",
      rows,
      concurrency: 50,
      requests: 2_000,
      profile: false
    })
    cases.push({
      name: `list-nofilter-nocache-${rows}-c50`,
      platform,
      scenario: "list-nofilter-nocache",
      rows,
      concurrency: 50,
      requests: 2_000,
      profile: false
    })
  }
  for (const concurrency of [1, 10, 50, 100]) {
    cases.push({
      name: `create-c${concurrency}`,
      platform,
      scenario: "create",
      rows: 0,
      concurrency,
      requests: 500,
      profile: false
    })
  }
  for (const rows of [550, 50_000]) {
    cases.push({
      name: `repo-list-${rows}-c50`,
      platform,
      scenario: "repo-list",
      rows,
      concurrency: 50,
      requests: 2_000,
      profile: false
    })
    cases.push({
      name: `repo-scan-${rows}-c50`,
      platform,
      scenario: "repo-list-scan",
      rows,
      concurrency: 50,
      requests: rows === 50_000 ? 500 : 2_000,
      profile: false
    })
  }
  return cases
}

const allCases =
  mode === "profiles"
    ? platforms.flatMap(profileCases)
    : mode === "load"
      ? platforms.flatMap(loadCases)
      : platforms.flatMap((platform) => [...profileCases(platform), ...loadCases(platform)])
const cases = only.length === 0 ? allCases : allCases.filter((testCase) => only.includes(testCase.name))

const results: Array<CaseResult> = []
for (const testCase of cases) {
  console.log(`[${testCase.platform}] ${testCase.name}`)
  const result = await runCase(testCase)
  results.push(result)
  const load = result.load
  console.log(
    `  startup=${result.startupMs.toFixed(0)}ms ` +
      `rps=${load === null ? "-" : load.throughput.toFixed(0)} ` +
      `p50=${load === null ? "-" : load.p50.toFixed(1)} ` +
      `p95=${load === null ? "-" : load.p95.toFixed(1)} ` +
      `rss=${((result.memory?.rss ?? 0) / 1024 / 1024).toFixed(0)}MB ` +
      `profile=${result.profileBytes ?? "-"}`
  )
}

const outputPath = join(outDir, `audit-${mode}.json`)
mkdirSync(outDir, { recursive: true })
const tempPath = `${outputPath}.tmp`
writeFileSync(tempPath, `${JSON.stringify({ mode, results }, null, 2)}\n`)
renameSync(tempPath, outputPath)
console.log(`Wrote ${outputPath}`)
