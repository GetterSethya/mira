/**
 * Summarize a V8 sampling heap profile.
 *
 *   tsx src/analyze-heapprofile.ts <file.heapprofile> [requests]
 *
 * The profile is produced by `/__bench/profile/stop?heapFile=...` from the
 * inspector `HeapProfiler.startSampling` window, so it covers only the measured
 * requests, not boot/seed/warmup.
 */
import { readFileSync } from "node:fs"

export interface HeapCallFrame {
  readonly functionName?: string
  readonly url?: string
  readonly lineNumber?: number
}

export interface HeapProfileNode {
  readonly callFrame?: HeapCallFrame
  readonly selfSize?: number
  readonly children?: ReadonlyArray<HeapProfileNode>
}

export interface HeapProfile {
  readonly head?: HeapProfileNode
}

export interface HeapFunctionSummary {
  readonly key: string
  readonly bytes: number
}

export interface HeapSummary {
  readonly totalBytes: number
  readonly byFunction: ReadonlyArray<HeapFunctionSummary>
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isCallFrame(value: unknown): value is HeapCallFrame {
  if (!isRecord(value)) return false
  if ("functionName" in value && typeof value.functionName !== "string") return false
  if ("url" in value && typeof value.url !== "string") return false
  if ("lineNumber" in value && typeof value.lineNumber !== "number") return false
  return true
}

function isNode(value: unknown): value is HeapProfileNode {
  if (!isRecord(value)) return false
  if ("callFrame" in value && !isCallFrame(value.callFrame)) return false
  if ("selfSize" in value && typeof value.selfSize !== "number") return false
  if ("children" in value) {
    if (!Array.isArray(value.children)) return false
    if (!value.children.every(isNode)) return false
  }
  return true
}

function isHeapProfile(value: unknown): value is HeapProfile {
  if (!isRecord(value)) return false
  if ("head" in value && !isNode(value.head)) return false
  return true
}

const keyOf = (frame: HeapCallFrame | undefined): string => {
  const name =
    frame?.functionName !== undefined && frame.functionName.length > 0
      ? frame.functionName
      : "(anonymous)"
  const url = frame?.url !== undefined && frame.url.length > 0 ? frame.url : "(unknown)"
  const line = frame?.lineNumber ?? 0
  return `${name} @ ${url}:${line}`
}

export function summarizeHeapProfile(profile: HeapProfile): HeapSummary {
  const byFunction = new Map<string, number>()
  let totalBytes = 0

  const visit = (node: HeapProfileNode): void => {
    const self = node.selfSize ?? 0
    if (self > 0) {
      totalBytes += self
      const key = keyOf(node.callFrame)
      byFunction.set(key, (byFunction.get(key) ?? 0) + self)
    }
    for (const child of node.children ?? []) visit(child)
  }

  if (profile.head !== undefined) visit(profile.head)
  return {
    totalBytes,
    byFunction: [...byFunction.entries()]
      .map(([key, bytes]) => ({ key, bytes }))
      .sort((left, right) => right.bytes - left.bytes)
  }
}

const path = process.argv[2]
if (path !== undefined) {
  const requests = Number(process.argv[3] ?? process.env.PROFILE_REQUESTS ?? "0")
  const profile: unknown = JSON.parse(readFileSync(path, "utf8"))
  if (!isHeapProfile(profile)) {
    throw new Error("heap profile has an unexpected shape")
  }
  const summary = summarizeHeapProfile(profile)
  const perRequest = requests > 0 ? summary.totalBytes / requests : null
  process.stdout.write(
    `total sampled: ${(summary.totalBytes / 1024 / 1024).toFixed(2)} MiB` +
      (perRequest === null ? "" : ` (${(perRequest / 1024).toFixed(2)} KiB/request)`) +
      "\n\nallocations by function:\n"
  )
  for (const entry of summary.byFunction.slice(0, 20)) {
    const pct = summary.totalBytes === 0 ? 0 : (entry.bytes / summary.totalBytes) * 100
    process.stdout.write(
      `${(entry.bytes / 1024).toFixed(1).padStart(10)} KiB ${pct.toFixed(1).padStart(5)}%  ${entry.key}\n`
    )
  }
}
