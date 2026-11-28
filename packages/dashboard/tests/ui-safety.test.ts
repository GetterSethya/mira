import { readdirSync, readFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

/**
 * The dashboard runs on the superadmin origin. Operator-authored email template
 * HTML must never be injected into that document, so the UI source is scanned
 * for raw-HTML injection and inline document frames.
 */

const PACKAGE_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..")
const UI_SRC = join(PACKAGE_ROOT, "ui", "src")
const SOURCE_EXTENSIONS = [".svelte", ".ts", ".tsx", ".js"]

function sourceFiles(dir: string): Array<string> {
  const files: Array<string> = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...sourceFiles(full))
    } else if (entry.isFile() && SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
      files.push(full)
    }
  }
  return files
}

function filesMatching(pattern: RegExp): Array<string> {
  return sourceFiles(UI_SRC)
    .filter((file) => pattern.test(readFileSync(file, "utf8")))
    .map((file) => relative(UI_SRC, file))
}

describe("dashboard UI source safety", () => {
  it("has source files to scan", () => {
    expect(sourceFiles(UI_SRC).length).toBeGreaterThan(0)
  })

  it("never injects raw HTML", () => {
    expect(filesMatching(/\{@html\}/)).toEqual([])
  })

  it("never inlines a document frame", () => {
    expect(filesMatching(/srcdoc/i)).toEqual([])
  })
})
