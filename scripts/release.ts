import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"

/**
 * Release helper for the Mira workspace.
 *
 *   node scripts/release.ts alpha           bump the alpha counter, commit, tag
 *   node scripts/release.ts stable          strip the prerelease, commit, tag
 *   node scripts/release.ts info <tag>      validate a tag against the manifests
 *
 * `info` is also what the publish workflow runs before building anything: it
 * fails unless every publishable manifest version is identical and the tag is
 * `v<version>`. It writes `version`, `channel`, `dist_tag` and `prerelease` to
 * `$GITHUB_OUTPUT` when that variable is present.
 */

const MANIFEST_PATHS = [
  "packages/collection/package.json",
  "packages/client/package.json",
  "packages/mira/package.json",
  "packages/tanstack-adapter/package.json",
  "packages/dashboard/package.json"
] as const

const ALPHA_VERSION = /^(\d+)\.(\d+)\.(\d+)-alpha\.(\d+)$/
const STABLE_VERSION = /^(\d+)\.(\d+)\.(\d+)$/

type Channel = "alpha" | "stable"

type Manifest = {
  readonly path: string
  readonly name: string
  readonly version: string
}

function fail(message: string): never {
  console.error(`release: ${message}`)
  process.exit(1)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readManifests(): ReadonlyArray<Manifest> {
  return MANIFEST_PATHS.map((path) => {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
    if (!isRecord(parsed)) fail(`${path} is not a JSON object`)

    const name = parsed["name"]
    const version = parsed["version"]
    if (typeof name !== "string" || typeof version !== "string") {
      fail(`${path} is missing a string "name" or "version"`)
    }

    return { path, name, version }
  })
}

function synchronizedVersion(manifests: ReadonlyArray<Manifest>): string {
  const first = manifests.at(0) ?? fail("no package manifests configured")
  for (const manifest of manifests) {
    if (manifest.version !== first.version) {
      fail(
        `versions are out of sync: ${first.name}@${first.version} vs ${manifest.name}@${manifest.version}`
      )
    }
  }
  return first.version
}

function detectChannel(version: string): Channel {
  if (ALPHA_VERSION.test(version)) return "alpha"
  if (STABLE_VERSION.test(version)) return "stable"
  return fail(`unsupported version "${version}" (expected X.Y.Z or X.Y.Z-alpha.N)`)
}

function nextVersion(current: string, channel: Channel): string {
  const alpha = ALPHA_VERSION.exec(current)
  const stable = STABLE_VERSION.exec(current)

  if (channel === "alpha") {
    if (alpha !== null) {
      return `${alpha[1]}.${alpha[2]}.${alpha[3]}-alpha.${Number(alpha[4]) + 1}`
    }
    if (stable !== null) {
      return `${stable[1]}.${stable[2]}.${Number(stable[3]) + 1}-alpha.0`
    }
    return fail(`cannot derive an alpha version from "${current}"`)
  }

  if (alpha !== null) return `${alpha[1]}.${alpha[2]}.${alpha[3]}`
  return fail(`"${current}" is already a stable version`)
}

function assertCleanTree(): void {
  const status = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()
  if (status.length > 0) {
    fail(`uncommitted changes detected, commit or stash them first:\n\n${status}`)
  }
}

function writeGithubOutput(values: Record<string, string>): void {
  const file = process.env["GITHUB_OUTPUT"]
  if (file === undefined) {
    for (const [key, value] of Object.entries(values)) console.log(`${key}=${value}`)
    return
  }
  const lines = Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")
  appendFileSync(file, `${lines}\n`)
}

function printInfo(tag: string): void {
  if (!tag.startsWith("v")) fail(`tag "${tag}" must start with "v" (e.g. v0.1.0-alpha.33)`)

  const tagVersion = tag.slice(1)
  const version = synchronizedVersion(readManifests())
  if (tagVersion !== version) {
    fail(`tag "${tag}" does not match the package versions (${version})`)
  }

  const channel = detectChannel(version)
  const distTag = channel === "alpha" ? "alpha" : "latest"

  writeGithubOutput({
    version,
    channel,
    dist_tag: distTag,
    prerelease: String(channel === "alpha")
  })

  console.log(`release: ${version} -> npm dist-tag "${distTag}" (${channel})`)
}

function bumpAndTag(channel: Channel, dryRun: boolean): void {
  const manifests = readManifests()
  const current = synchronizedVersion(manifests)
  const next = nextVersion(current, channel)

  if (dryRun) {
    console.log(`release: would bump ${current} -> ${next} and tag v${next}`)
    return
  }

  assertCleanTree()

  for (const manifest of manifests) {
    const parsed: unknown = JSON.parse(readFileSync(manifest.path, "utf8"))
    if (!isRecord(parsed)) fail(`${manifest.path} is not a JSON object`)
    parsed["version"] = next
    writeFileSync(manifest.path, `${JSON.stringify(parsed, null, 2)}\n`)
    console.log(`  ${manifest.name} -> ${next}`)
  }

  const paths = MANIFEST_PATHS.map((path) => path)
  execFileSync("git", ["add", ...paths], { stdio: "inherit" })
  execFileSync("git", ["commit", "-m", `chore: release v${next}`], { stdio: "inherit" })
  execFileSync("git", ["tag", "-a", `v${next}`, "-m", `v${next}`], { stdio: "inherit" })

  console.log(`\nrelease: tagged v${next}`)
  console.log("push it with: git push origin HEAD --follow-tags")
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2)

  if (command === "info") {
    const tag = rest[0] ?? process.env["RELEASE_TAG"]
    if (tag === undefined) fail("usage: node scripts/release.ts info <tag>")
    printInfo(tag)
    return
  }

  if (command === "alpha" || command === "stable") {
    bumpAndTag(command, rest.includes("--dry-run"))
    return
  }

  fail("usage: node scripts/release.ts <alpha|stable|info> [tag] [--dry-run]")
}

main()
