import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const pkgDir = resolve(here, "..")
const pkg: {
  name?: unknown
  exports?: Record<string, Record<string, unknown>>
} = JSON.parse(readFileSync(resolve(pkgDir, "package.json"), "utf8"))

const missing: Array<string> = []
for (const [subpath, conditions] of Object.entries(pkg.exports ?? {})) {
  for (const [condition, rel] of Object.entries(conditions)) {
    if (typeof rel !== "string" || !rel.startsWith("./dist/")) continue
    const abs = resolve(pkgDir, rel)
    if (!existsSync(abs)) missing.push(`${subpath} [${condition}]: ${rel}`)
  }
}

// Fail on stale layouts from previous configs (nested src/, leaked tests/).
// tsc never deletes, so without a clean step these would ship in the tarball.
const stale = ["dist/src", "dist/tests"].filter((rel) => existsSync(resolve(pkgDir, rel)))

if (missing.length > 0 || stale.length > 0) {
  if (missing.length > 0) {
    console.error("pack-exports guard failed — missing built files:")
    for (const m of missing) console.error(`  - ${m}`)
  }
  if (stale.length > 0) {
    console.error("pack-exports guard failed — stale build output present:")
    for (const s of stale) console.error(`  - ${s}`)
    console.error(`hint: dist/ was not cleaned before build (expected flat dist/*.js layout)`)
  }
  const label = typeof pkg.name === "string" ? pkg.name : "this package"
  console.error(`hint: run "pnpm --filter ${label} build" first`)
  process.exit(1)
}

console.log(`pack-exports guard ok — ${Object.keys(pkg.exports ?? {}).length} subpaths resolve to dist files`)
