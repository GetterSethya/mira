import { execFileSync, execSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Publishes the tarballs produced by the build job, in dependency order.
 *
 *   node scripts/publish-tarballs.ts <tarball-dir> <version> <dist-tag>
 *
 * Each tarball is unpacked into a scratch directory and published from there as
 * a normal directory publish, so npm can attach provenance attestations. The
 * tarball was already produced by `pnpm pack`, which rewrites `workspace:*`
 * specifiers to exact versions — npm never sees the workspace protocol.
 *
 * Publishing is idempotent: a version that already exists on the registry is
 * skipped, so re-running a failed release does not abort on the packages that
 * made it out the first time.
 */

const PACKAGE_ORDER = [
  "gettersethya-mira-collection",
  "gettersethya-mira-client",
  "gettersethya-mira",
  "gettersethya-mira-tanstack-adapter",
  "gettersethya-mira-dashboard"
] as const

type PackageManifest = {
  readonly name: string
  readonly version: string
}

/** `npm` is `npm.cmd` on Windows, which must be invoked through a shell. */
function quoteWindowsArg(arg: string): string {
  return /[\s"]/.test(arg) ? `"${arg.replaceAll('"', '\\"')}"` : arg
}

function runNpm(args: ReadonlyArray<string>, stdio: "inherit" | "pipe"): void {
  if (process.platform === "win32") {
    execSync(["npm", ...args].map(quoteWindowsArg).join(" "), { stdio })
    return
  }
  execFileSync("npm", [...args], { stdio })
}

function fail(message: string): never {
  console.error(`publish: ${message}`)
  process.exit(1)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readManifest(path: string): PackageManifest {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
  if (!isRecord(parsed)) fail(`${path} is not a JSON object`)

  const name = parsed["name"]
  const version = parsed["version"]
  if (typeof name !== "string" || typeof version !== "string") {
    fail(`${path} is missing a string "name" or "version"`)
  }

  return { name, version }
}

function isPublished(name: string, version: string): boolean {
  try {
    runNpm(["view", `${name}@${version}`, "version"], "pipe")
    return true
  } catch {
    return false
  }
}

function main(): void {
  const [tarballDir, version, distTag] = process.argv.slice(2)

  if (tarballDir === undefined || version === undefined || distTag === undefined) {
    fail("usage: node scripts/publish-tarballs.ts <tarball-dir> <version> <dist-tag>")
  }

  console.log(`publish: ${version} with npm dist-tag "${distTag}"`)

  for (const slug of PACKAGE_ORDER) {
    const tarball = join(tarballDir, `${slug}-${version}.tgz`)
    if (!existsSync(tarball)) fail(`missing tarball ${tarball}`)

    const workDir = mkdtempSync(join(tmpdir(), `${slug}-`))
    try {
      execFileSync("tar", ["-xzf", tarball, "-C", workDir], { stdio: "inherit" })

      const packageDir = join(workDir, "package")
      const manifest = readManifest(join(packageDir, "package.json"))

      if (manifest.version !== version) {
        fail(`${manifest.name} tarball has version ${manifest.version}, expected ${version}`)
      }

      if (isPublished(manifest.name, manifest.version)) {
        console.log(`  skip ${manifest.name}@${manifest.version} (already published)`)
        continue
      }

      console.log(`  publish ${manifest.name}@${manifest.version}`)
      const args = ["publish", packageDir, "--tag", distTag, "--access", "public"]
      if (process.env["DRY_RUN"] === "1") args.push("--dry-run")
      runNpm(args, "inherit")
    } finally {
      rmSync(workDir, { recursive: true, force: true })
    }
  }

  console.log("publish: done")
}

main()
