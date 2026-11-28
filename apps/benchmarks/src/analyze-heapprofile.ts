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

import { Schema } from "effect"

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

const HeapCallFrameSchema = Schema.Struct({
  functionName: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  lineNumber: Schema.optional(Schema.Finite)
})

const HeapProfileNodeSchema: Schema.Codec<HeapProfileNode> = Schema.Struct({
  callFrame: Schema.optional(HeapCallFrameSchema),
  selfSize: Schema.optional(Schema.Finite),
  children: Schema.optional(Schema.Array(Schema.suspend((): Schema.Codec<HeapProfileNode> => HeapProfileNodeSchema)))
})

const HeapProfileSchema: Schema.Codec<HeapProfile> = Schema.Struct({
  head: Schema.optional(HeapProfileNodeSchema)
})

const decodeHeapProfile = Schema.decodeSync(Schema.fromJsonString(HeapProfileSchema))

const keyOf = (frame: HeapCallFrame | undefined): string => {
  const name = frame?.functionName !== undefined && frame.functionName.length > 0 ? frame.functionName : "(anonymous)"
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
  let profile: HeapProfile
  try {
    profile = decodeHeapProfile(readFileSync(path, "utf8"))
  } catch {
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
