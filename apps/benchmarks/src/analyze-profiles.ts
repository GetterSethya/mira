import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"

import { Schema } from "effect"

type CallFrame = {
  readonly functionName: string
  readonly url: string
  readonly lineNumber: number
}

type ProfileNode = {
  readonly id: number
  readonly callFrame: CallFrame
  readonly children?: ReadonlyArray<number>
}

type Profile = {
  readonly nodes: ReadonlyArray<ProfileNode>
  readonly samples: ReadonlyArray<number>
  readonly timeDeltas: ReadonlyArray<number>
  readonly startTime: number
  readonly endTime: number
}

const CallFrameSchema = Schema.Struct({
  functionName: Schema.String,
  url: Schema.String,
  lineNumber: Schema.Finite
})

const ProfileSchema = Schema.Struct({
  nodes: Schema.Array(
    Schema.Struct({
      id: Schema.Finite,
      callFrame: CallFrameSchema,
      children: Schema.optional(Schema.Array(Schema.Finite))
    })
  ),
  samples: Schema.Array(Schema.Finite),
  timeDeltas: Schema.Array(Schema.Finite),
  startTime: Schema.Finite,
  endTime: Schema.Finite
})

const profileDir = process.argv[2] ?? ".egm/perf-audit-2026-11-15"
const outputPath = process.argv[3] ?? join(profileDir, "hotspots.md")

const readProfile = (path: string): Profile =>
  Schema.decodeSync(Schema.fromJsonString(ProfileSchema))(readFileSync(path, "utf8"))

const shortUrl = (url: string) => {
  if (url.startsWith("file:///C:/ProjectCode/mira/")) {
    return url.slice("file:///C:/ProjectCode/mira/".length)
  }
  if (url.startsWith("file:///")) return url.slice("file:///".length)
  if (url.startsWith("node:internal/")) return url
  if (url.startsWith("node:")) return url
  if (url.startsWith("bun:")) return url
  return url
}

const categoryOf = (url: string) => {
  const short = shortUrl(url)
  if (short.startsWith("packages/mira/")) return "mira"
  if (short.startsWith("packages/collection/")) return "mira-collection"
  if (short.startsWith("packages/client/")) return "mira-client"
  if (short.startsWith("apps/benchmarks/")) return "benchmark"
  if (short.includes("node_modules/.pnpm/effect@")) return "effect"
  if (short.startsWith("node:") || short.startsWith("internal/")) return "node/internal"
  if (short.startsWith("bun:")) return "bun"
  if (short.length === 0) return "vm/unknown"
  return "other"
}

const fmt = (value: number, digits = 1) => value.toLocaleString("en-US", { maximumFractionDigits: digits })

const nodeKey = (node: ProfileNode) =>
  `${node.callFrame.functionName}|${node.callFrame.url}|${node.callFrame.lineNumber}`

const selfByKey = (profile: Profile) => {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]))
  const self = new Map<string, number>()
  const count = Math.min(profile.samples.length, profile.timeDeltas.length)
  for (let i = 0; i < count; i += 1) {
    const id = profile.samples[i]
    if (id === undefined) continue
    const node = nodes.get(id)
    if (node === undefined) continue
    const key = nodeKey(node)
    self.set(key, (self.get(key) ?? 0) + (profile.timeDeltas[i] ?? 0))
  }
  return self
}

const analyze = (path: string, baseline?: Profile) => {
  const profile: Profile = readProfile(path)
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]))
  const parent = new Map<number, number>()
  for (const node of profile.nodes) {
    for (const child of node.children ?? []) parent.set(child, node.id)
  }

  const self = new Map<number, number>()
  const count = Math.min(profile.samples.length, profile.timeDeltas.length)
  for (let i = 0; i < count; i += 1) {
    const id = profile.samples[i]
    if (id === undefined) continue
    const delta = profile.timeDeltas[i] ?? 0
    self.set(id, (self.get(id) ?? 0) + delta)
  }

  const rawTotal = [...self.values()].reduce((sum, value) => sum + value, 0)
  const baselineByKey = baseline === undefined ? null : selfByKey(baseline)
  const rows = [...self.entries()]
    .flatMap(([id, microseconds]) => {
      const node = nodes.get(id)
      if (node === undefined) return []
      const baselineMicroseconds = baselineByKey?.get(nodeKey(node)) ?? 0
      return [
        {
          node,
          microseconds,
          attributed: Math.max(0, microseconds - baselineMicroseconds)
        }
      ]
    })
    .sort((a, b) => b.attributed - a.attributed)

  const isNoise = (name: string) =>
    name === "(idle)" || name === "(program)" || name === "(garbage collector)" || name === "(root)"

  const total = rows.reduce((sum, row) => sum + row.attributed, 0)
  const idle = rows
    .filter((row) => isNoise(row.node.callFrame.functionName))
    .reduce((sum, row) => sum + row.attributed, 0)

  const byCategory = new Map<string, number>()
  for (const row of rows) {
    const category = categoryOf(row.node.callFrame.url)
    byCategory.set(category, (byCategory.get(category) ?? 0) + row.attributed)
  }

  const top = rows.filter((row) => !isNoise(row.node.callFrame.functionName) && row.attributed > 0).slice(0, 30)

  const callPath = (id: number) => {
    const frames: Array<string> = []
    let current: number | undefined = id
    for (let depth = 0; depth < 5 && current !== undefined; depth += 1) {
      const node = nodes.get(current)
      if (node === undefined) break
      const name = node.callFrame.functionName || "(anonymous)"
      frames.push(name)
      current = parent.get(current)
    }
    return frames.reverse().join(" → ")
  }

  return {
    name: relative(profileDir, path).replaceAll("\\", "/"),
    rawTotalMs: rawTotal / 1000,
    totalMs: total / 1000,
    idleMs: idle / 1000,
    idlePct: total === 0 ? 0 : (idle / total) * 100,
    baseline: baseline !== undefined,
    rows,
    top,
    byCategory,
    callPath
  }
}

const files = readdirSync(profileDir)
  .filter((name) => name.endsWith(".cpuprofile"))
  .sort()

if (files.length === 0) {
  throw new Error(`No .cpuprofile files in ${profileDir}`)
}

const baselineCache = new Map<string, Profile | null>()
const baselineFor = (file: string) => {
  if (file.includes("-startup.")) return undefined
  const platformName = file.split("-")[0]
  if (platformName === undefined) return undefined
  const cached = baselineCache.get(platformName)
  if (cached !== undefined) return cached ?? undefined
  const path = join(profileDir, `${platformName}-startup.cpuprofile`)
  if (!existsSync(path)) {
    baselineCache.set(platformName, null)
    return undefined
  }
  const profile = readProfile(path)
  baselineCache.set(platformName, profile)
  return profile
}

const sections = files.map((file) => {
  const result = analyze(join(profileDir, file), baselineFor(file))
  const categories = [...result.byCategory.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(
      ([category, microseconds]) =>
        `| ${category} | ${fmt(microseconds / 1000)} ms | ${fmt(
          result.totalMs === 0 ? 0 : (microseconds / (result.totalMs * 1000)) * 100
        )}% |`
    )
  const rows = result.top
    .map(
      (row, index) =>
        `| ${index + 1} | ${row.node.callFrame.functionName || "(anonymous)"} | ${shortUrl(
          row.node.callFrame.url
        )}:${row.node.callFrame.lineNumber + 1} | ${fmt(row.attributed / 1000)} ms | ${fmt(
          result.totalMs === 0 ? 0 : (row.attributed / (result.totalMs * 1000)) * 100
        )}% |`
    )
    .join("\n")

  return `## ${result.name}

- Raw sampled time: ${fmt(result.rawTotalMs)} ms
- Load-attributed time: ${fmt(result.totalMs)} ms${result.baseline ? " (startup profile subtracted)" : ""}
- Idle/program/GC: ${fmt(result.idleMs)} ms (${fmt(result.idlePct)}%)

### Categories (load-attributed)

| Category | Self time | Share of loaded |
|---|---:|---:|
${categories.join("\n")}

### Top load-attributed self-time frames

| # | Function | Location | Self time | Share |
|---:|---|---|---:|---:|
${rows}

Top call path: ${result.callPath(result.top[0]?.node.id ?? 0)}
`
})

const markdown = `# CPU hotspot report

Profiles: ${files.length} file(s) in \`${profileDir}\`.

Self time is the sampled time attributed to the top frame. It excludes time in callees.
For every non-startup profile, the matching \`<platform>-startup\` profile is subtracted by
function and location, so the table approximates the measured load phase. “Share” is relative
to load-attributed time, including idle/program/GC.

${sections.join("\n")}`

writeFileSync(outputPath, markdown)
console.log(`Wrote ${outputPath}`)
for (const section of sections) {
  const name = section.split("\n")[0]?.replace("## ", "") ?? "profile"
  console.log(name)
}
