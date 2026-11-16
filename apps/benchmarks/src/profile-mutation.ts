/**
 * CPU-profile a batched mutation workload.
 *
 * Starts the benchmark server with the CPU profiler, seeds rows, runs the
 * requested operation with batching enabled, then stops the server. Use
 * `pnpm --filter mira-benchmarks analyze:cpu <file.cpuprofile>` to summarize.
 *
 *   PROFILE_OP=update PROFILE_REQUESTS=5000 pnpm --filter mira-benchmarks profile:mutation
 *   PROFILE_OP=create PROFILE_REQUESTS=5000 pnpm --filter mira-benchmarks profile:mutation
 *   PROFILE_OP=mixed  PROFILE_REQUESTS=3000 pnpm --filter mira-benchmarks profile:mutation
 */
import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { performance } from "node:perf_hooks"

type Operation = "create" | "update" | "delete" | "mixed" | "list"

const packageRoot = process.cwd()
const repoRoot = join(packageRoot, "../..")
const operation = (process.env.PROFILE_OP ?? "update") as Operation
const requests = Number(process.env.PROFILE_REQUESTS ?? "5000")
const concurrency = Number(process.env.PROFILE_CONCURRENCY ?? "50")
const seedRows = Number(process.env.PROFILE_SEED ?? "3000")
const synchronous = process.env.PROFILE_SYNC === "NORMAL" ? "NORMAL" : "FULL"
const tracing = process.env.PROFILE_TRACING === "on"
const profileDir =
  process.env.PROFILE_DIR ?? join(repoRoot, ".egm", "create-batch-polish-2026-11-15", "profile", operation)
mkdirSync(profileDir, { recursive: true })

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
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

const directory = mkdtempSync(join(tmpdir(), "mira-profile-mutation-"))
const port = await freePort()
const child: ChildProcess = spawn(
  process.execPath,
  ["src/server.ts"],
  {
    cwd: packageRoot,
    env: {
      ...process.env,
      BENCH_PLATFORM: "node",
      BENCH_PORT: String(port),
      BENCH_DB: join(directory, "bench.sqlite"),
      BENCH_UPLOADS: join(directory, "uploads"),
      BENCH_SYNCHRONOUS: synchronous,
      BENCH_CACHE: "off",
      BENCH_TRACING: tracing ? "on" : "off",
      BENCH_STACK_TRACES: "off",
      BENCH_CREATE_BATCH: "on",
      BENCH_UPDATE_BATCH: "on",
      BENCH_DELETE_BATCH: "on",
      BENCH_CREATE_BATCH_WINDOW_MS: "0",
      BENCH_CREATE_BATCH_MAX: "100"
    },
    stdio: ["ignore", "pipe", "pipe"]
  }
)
let logs = ""
child.stdout?.on("data", (value: Buffer) => (logs += value.toString()))
child.stderr?.on("data", (value: Buffer) => (logs += value.toString()))
const baseUrl = `http://127.0.0.1:${port}`

const waitForReady = async () => {
  const deadline = performance.now() + 30_000
  while (performance.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited:\n${logs}`)
    try {
      const response = await fetch(`${baseUrl}/__bench/ping`, { signal: AbortSignal.timeout(500) })
      if (response.ok) {
        await response.arrayBuffer()
        return
      }
    } catch {
      // booting
    }
    await sleep(10)
  }
  throw new Error(`Server not ready:\n${logs}`)
}

const stopServer = async () => {
  if (child.exitCode !== null) return
  try {
    await fetch(`${baseUrl}/__bench/exit`, { signal: AbortSignal.timeout(1_000) })
  } catch {
    // gone
  }
  const deadline = performance.now() + 5_000
  while (child.exitCode === null && performance.now() < deadline) await sleep(20)
  if (child.exitCode === null) child.kill("SIGKILL")
}

const seed = async () => {
  const ids: Array<string> = []
  for (let start = 0; start < seedRows; start += 1_000) {
    const records = Array.from({ length: Math.min(1_000, seedRows - start) }, (_, index) => ({
      title: `seed-${start + index}`,
      body: "seed",
      published: false
    }))
    const response = await fetch(`${baseUrl}/api/collections/posts/bulk`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ records })
    })
    if (!response.ok) throw new Error(`Seed failed: ${response.status} ${await response.text()}`)
    const payload: unknown = await response.json()
    if (typeof payload !== "object" || payload === null || !("records" in payload)) {
      throw new Error("Seed response has no records")
    }
    const recordsOut = payload.records
    if (!Array.isArray(recordsOut)) throw new Error("Seed records is not an array")
    for (const record of recordsOut) {
      if (typeof record === "object" && record !== null && "id" in record && typeof record.id === "string") {
        ids.push(record.id)
      }
    }
  }
  return ids
}

const create = async (index: number) => {
  const response = await fetch(`${baseUrl}/api/collections/posts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: `create-${index}`, body: "x", published: false })
  })
  await response.arrayBuffer()
  return response.ok
}

const update = async (id: string, index: number) => {
  const response = await fetch(`${baseUrl}/api/collections/posts/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: `update-${index}` })
  })
  await response.arrayBuffer()
  return response.ok
}

const remove = async (id: string) => {
  const response = await fetch(`${baseUrl}/api/collections/posts/${id}`, { method: "DELETE" })
  await response.arrayBuffer()
  return response.ok
}

const list = async (index: number) => {
  const filter = encodeURIComponent(
    JSON.stringify({ op: "neq", field: "title", value: `read-${index}` })
  )
  const response = await fetch(`${baseUrl}/api/collections/posts?limit=20&filter=${filter}`)
  await response.arrayBuffer()
  return response.ok
}

const percentile = (sorted: ReadonlyArray<number>, fraction: number) => {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * fraction)))
  return sorted[index] ?? 0
}

const run = async (ids: ReadonlyArray<string>) => {
  let next = 0
  let successes = 0
  let failures = 0
  const latencies: Array<number> = []
  const started = performance.now()
  const worker = async () => {
    while (true) {
      const index = next
      next += 1
      if (index >= requests) return
      const requestStarted = performance.now()
      let ok = false
      if (operation === "list") {
        ok = await list(index)
      } else if (operation === "create") {
        ok = await create(index)
      } else if (operation === "update") {
        const id = ids[index % ids.length]
        if (id !== undefined) ok = await update(id, index)
      } else if (operation === "delete") {
        const id = ids[index % ids.length]
        if (id !== undefined) ok = await remove(id)
      } else {
        const lane = index % 3
        if (lane === 0) ok = await create(index)
        else if (lane === 1) {
          const id = ids[index % ids.length]
          if (id !== undefined) ok = await update(id, index)
        } else {
          const id = ids[(index + 1) % ids.length]
          if (id !== undefined) ok = await remove(id)
        }
      }
      latencies.push(performance.now() - requestStarted)
      if (ok) successes += 1
      else failures += 1
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  const durationMs = performance.now() - started
  const sorted = [...latencies].sort((left, right) => left - right)
  return {
    successes,
    failures,
    durationMs,
    rps: successes / (durationMs / 1000),
    p50: percentile(sorted, 0.5),
    p99: percentile(sorted, 0.99)
  }
}

try {
  await waitForReady()
  const ids = await seed()
  const warmupIds = operation === "delete" ? ids.slice(-200) : ids.slice(0, Math.min(200, ids.length))
  await run(warmupIds)
  const measuredIds = operation === "delete" ? ids.slice(0, requests) : ids
  const profileFile = join(
    profileDir,
    `${operation}-${synchronous}-${Date.now()}.cpuprofile`
  )
  const startResponse = await fetch(`${baseUrl}/__bench/profile/start`)
  if (!startResponse.ok) {
    throw new Error(`Profile start failed: ${startResponse.status} ${await startResponse.text()}`)
  }
  const result = await run(measuredIds)
  const stopResponse = await fetch(
    `${baseUrl}/__bench/profile/stop?file=${encodeURIComponent(profileFile)}`
  )
  if (!stopResponse.ok) {
    throw new Error(`Profile stop failed: ${stopResponse.status} ${await stopResponse.text()}`)
  }
  process.stdout.write(
    `${operation} ${synchronous} tracing=${tracing ? "on" : "off"}: ${result.successes}/${requests} ok, ${result.failures} failed, ${result.rps.toFixed(0)} rps, p50 ${result.p50.toFixed(1)}ms, p99 ${result.p99.toFixed(1)}ms\n`
  )
  process.stdout.write(`profile=${profileFile}\n`)
} finally {
  await stopServer()
  rmSync(directory, { recursive: true, force: true })
}
