import { readFileSync } from "node:fs"

/**
 * Prints the changelog section for a release tag so the Publish workflow can
 * use it as the GitHub release body.
 *
 *   node scripts/release-notes.ts v0.1.0-alpha.38
 *
 * The section must exist and contain at least one entry. The release helper
 * enforces the same rule before tagging, so a missing section cannot reach CI.
 */

function fail(message: string): never {
  console.error(`release-notes: ${message}`)
  process.exit(1)
}

function main(): void {
  const tag = process.argv[2]
  if (tag === undefined) fail("usage: node scripts/release-notes.ts <tag>")
  if (!tag.startsWith("v")) fail(`tag "${tag}" must start with "v"`)

  const version = tag.slice(1)
  const changelog = readFileSync("CHANGELOG.md", "utf8")
  const marker = `## [${version}]`
  const start = changelog.indexOf(marker)
  if (start === -1) fail(`CHANGELOG.md has no "${marker}" section`)

  const bodyStart = changelog.indexOf("\n", start)
  if (bodyStart === -1) fail(`"${marker}" has no content`)

  const next = changelog.indexOf("\n## [", bodyStart)
  const body = changelog.slice(bodyStart, next === -1 ? undefined : next).trim()
  if (body.length === 0) fail(`"${marker}" is empty`)

  process.stdout.write(`${body}\n`)
}

main()
