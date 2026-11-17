import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"

import { describe, expect, it } from "vitest"

const OLD_NAMES = [
  "makeSqliteTelemetryLayer",
  "makeSqliteTelemetryLayerForClient",
  "SqliteLoggerConfig",
  "TelemetrySqlClient"
]

const ROOT = resolve(import.meta.dirname, "../../../..")

const ROOTS = [
  "packages/mira/src",
  "packages/mira/EGM.md",
  "packages/dashboard/README.md",
  "apps",
  "scripts",
  "README.md"
]

const EXCLUDED = ["node_modules", "dist", ".egm", ".handovers", "CHANGELOG.md"]

function walk(path: string, out: Array<string>) {
  const stats = statSync(path)
  if (stats.isDirectory()) {
    for (const entry of readdirSync(path)) {
      if (EXCLUDED.some((excluded) => entry === excluded)) continue
      walk(join(path, entry), out)
    }
    return
  }
  if (stats.isFile() && /\.(ts|tsx|js|mjs|md|svelte)$/.test(path)) out.push(path)
}

describe("telemetry API rename gate", () => {
  it("has no old telemetry names outside the changelog and historical artifacts", () => {
    const files: Array<string> = []
    for (const root of ROOTS) walk(resolve(ROOT, root), files)

    const offenders: Array<string> = []
    for (const file of files) {
      const content = readFileSync(file, "utf8")
      for (const oldName of OLD_NAMES) {
        if (content.includes(oldName)) {
          offenders.push(`${relative(ROOT, file)}: ${oldName}`)
        }
      }
    }

    expect(offenders).toEqual([])
  })
})
