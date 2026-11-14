import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const temp = mkdtempSync(join(tmpdir(), "mira-pack-smoke-"))
const packs = join(temp, "packs")
mkdirSync(packs, { recursive: true })

const run = (command, args, cwd = repo, shell = process.platform === "win32") => {
  execFileSync(command, args, {
    cwd,
    stdio: "inherit",
    shell
  })
}

try {
  for (const dir of ["packages/collection", "packages/client", "packages/mira"]) {
    run("pnpm", ["pack", "--pack-destination", packs], join(repo, dir))
  }

  const tarballs = readdirSync(packs)
    .filter((file) => file.endsWith(".tgz"))
    .map((file) => join(packs, file))
  if (tarballs.length !== 3) {
    throw new Error(`expected 3 tarballs, found ${tarballs.length}`)
  }

  writeFileSync(
    join(temp, "package.json"),
    JSON.stringify({ name: "mira-pack-smoke", private: true, type: "module" }, null, 2)
  )
  run("pnpm", ["add", ...tarballs, "effect@4.0.0"], temp)

  run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import('@gettersethya/mira').then((m) => { if (!m.NodePlatform) throw new Error('Node entry missing NodePlatform'); if ('BunPlatform' in m) throw new Error('Node entry leaked BunPlatform') })"
    ],
    temp,
    false
  )

  const bunTemp = join(temp, "bun-install")
  mkdirSync(bunTemp, { recursive: true })
  writeFileSync(
    join(bunTemp, "package.json"),
    JSON.stringify({ name: "mira-pack-smoke-bun", private: true, type: "module" }, null, 2)
  )
  run("bun", ["add", ...tarballs, "effect@4.0.0"], bunTemp, false)
  run(
    bunExecutable(),
    [
      "-e",
      "import('@gettersethya/mira').then((m) => { if (!m.BunPlatform) throw new Error('Bun root condition missing BunPlatform'); if ('makeSqliteTelemetryLayer' in m) throw new Error('Bun entry leaked Node SQLite telemetry') })"
    ],
    bunTemp,
    false
  )
  run(
    bunExecutable(),
    [
      "-e",
      "import('@gettersethya/mira/bun').then((m) => { if (!m.BunSqliteDatabase) throw new Error('Bun subpath missing BunSqliteDatabase'); if ('makeSqliteTelemetryLayer' in m) throw new Error('Bun subpath leaked Node SQLite telemetry') })"
    ],
    bunTemp,
    false
  )

  console.log("pack smoke ok - Node and Bun entries resolve from packed tarballs")
} finally {
  rmSync(temp, { recursive: true, force: true })
}

function bunExecutable() {
  return "bun"
}
