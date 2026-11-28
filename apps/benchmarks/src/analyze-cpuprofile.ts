/**
 * Tiny CPU-profile summarizer. Prints self time by function and by module.
 *
 *   tsx src/analyze-cpuprofile.ts <file.cpuprofile>
 */
import { readFileSync } from "node:fs"

import { Schema } from "effect"

const CallFrameSchema = Schema.Struct({
  functionName: Schema.String,
  url: Schema.String,
  lineNumber: Schema.Finite,
  columnNumber: Schema.Finite
})

const ProfileNodeSchema = Schema.Struct({
  id: Schema.Finite,
  callFrame: CallFrameSchema,
  hitCount: Schema.optional(Schema.Finite)
})

const ProfileSchema = Schema.Struct({
  nodes: Schema.Array(ProfileNodeSchema),
  samples: Schema.Array(Schema.Finite),
  timeDeltas: Schema.Array(Schema.Finite)
})

type ProfileNode = typeof ProfileNodeSchema.Type
type Profile = typeof ProfileSchema.Type

const decodeProfile = Schema.decodeUnknownSync(Schema.fromJsonString(ProfileSchema))

const path = process.argv[2]
if (path === undefined) throw new Error("Usage: analyze-cpuprofile.ts <file.cpuprofile>")
const profile: Profile = decodeProfile(readFileSync(path, "utf8"))
const nodes = new Map<number, ProfileNode>(profile.nodes.map((node) => [node.id, node]))
const selfMicros = new Map<number, number>()
for (let index = 0; index < profile.samples.length; index += 1) {
  const id = profile.samples[index]
  if (id === undefined) continue
  const delta = profile.timeDeltas[index] ?? 0
  selfMicros.set(id, (selfMicros.get(id) ?? 0) + delta)
}
const total = [...selfMicros.values()].reduce((sum, value) => sum + value, 0)
const byFunction = new Map<string, { micros: number; url: string; line: number }>()
for (const [id, micros] of selfMicros) {
  const node = nodes.get(id)
  if (node === undefined) continue
  const key = `${node.callFrame.functionName || "(anonymous)"} @ ${node.callFrame.url || "(native)"}:${node.callFrame.lineNumber + 1}`
  const current = byFunction.get(key)
  byFunction.set(key, {
    micros: (current?.micros ?? 0) + micros,
    url: node.callFrame.url,
    line: node.callFrame.lineNumber + 1
  })
}
const top = [...byFunction.entries()].sort((left, right) => right[1].micros - left[1].micros).slice(0, 40)
process.stdout.write(`total sampled: ${(total / 1000).toFixed(1)} ms\n\n`)
process.stdout.write("self time by function:\n")
for (const [key, value] of top) {
  const pct = total === 0 ? 0 : (value.micros / total) * 100
  process.stdout.write(`${(value.micros / 1000).toFixed(1).padStart(8)} ms ${pct.toFixed(1).padStart(5)}%  ${key}\n`)
}
const byUrl = new Map<string, number>()
for (const [, value] of byFunction) {
  byUrl.set(value.url, (byUrl.get(value.url) ?? 0) + value.micros)
}
process.stdout.write("\nself time by module:\n")
for (const [url, micros] of [...byUrl.entries()].sort((left, right) => right[1] - left[1]).slice(0, 20)) {
  const pct = total === 0 ? 0 : (micros / total) * 100
  process.stdout.write(
    `${(micros / 1000).toFixed(1).padStart(8)} ms ${pct.toFixed(1).padStart(5)}%  ${url || "(native)"}\n`
  )
}
