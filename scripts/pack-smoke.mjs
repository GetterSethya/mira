import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
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

  const tarballRank = (file) => {
    if (file.startsWith("gettersethya-mira-collection-")) return 0
    if (file.startsWith("gettersethya-mira-client-")) return 1
    return 2
  }
  const tarballs = readdirSync(packs)
    .filter((file) => file.endsWith(".tgz"))
    .sort((a, b) => tarballRank(a) - tarballRank(b))
    .map((file) => join(packs, file))
  if (tarballs.length !== 3) {
    throw new Error(`expected 3 tarballs, found ${tarballs.length}`)
  }

  const fileSpec = (from, file) => `file:${relative(from, file).replaceAll("\\", "/")}`
  const findTarball = (prefix) => {
    const tarball = tarballs.find((file) => file.split(/[\\/]/).at(-1)?.startsWith(prefix))
    if (!tarball) throw new Error(`missing ${prefix} tarball`)
    return tarball
  }
  const overrides = {
    "@gettersethya/mira-client": fileSpec(temp, findTarball("gettersethya-mira-client-")),
    "@gettersethya/mira-collection": fileSpec(temp, findTarball("gettersethya-mira-collection-"))
  }

  writeFileSync(
    join(temp, "package.json"),
    JSON.stringify(
      {
        name: "mira-pack-smoke",
        private: true,
        type: "module",
        pnpm: { overrides }
      },
      null,
      2
    )
  )
  run("pnpm", ["add", ...tarballs, "effect@4.0.0"], temp)

  const bunOnlyExports = [
    "BunPlatform",
    "BunPlatformLayer",
    "BunPortablePlatform",
    "BunCryptoLayer",
    "BunAuthServiceLayer",
    "ThumbnailServiceBunLive",
    "makeThumbnailServiceBunLive",
    "BunRuntime"
  ]
  run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import('@gettersethya/mira').then((m) => { if (!m.NodePlatform) throw new Error('Node entry missing NodePlatform'); const leaked = ${JSON.stringify(bunOnlyExports)}.filter((name) => name in m); if (leaked.length > 0) throw new Error('Node entry leaked Bun exports: ' + leaked.join(', ')) })`
    ],
    temp,
    false
  )

  const bunTemp = join(temp, "bun-install")
  mkdirSync(bunTemp, { recursive: true })
  writeFileSync(
    join(bunTemp, "package.json"),
    JSON.stringify(
      {
        name: "mira-pack-smoke-bun",
        private: true,
        type: "module",
        overrides: {
          "@gettersethya/mira-client": fileSpec(bunTemp, findTarball("gettersethya-mira-client-")),
          "@gettersethya/mira-collection": fileSpec(
            bunTemp,
            findTarball("gettersethya-mira-collection-")
          )
        }
      },
      null,
      2
    )
  )
  run("bun", ["add", ...tarballs, "effect@4.0.0"], bunTemp, false)
  const bunExportCheck =
    "if (!m.BunPlatform) throw new Error('Bun entry missing BunPlatform'); if (!m.BunPortablePlatform) throw new Error('Bun entry missing BunPortablePlatform'); if (!m.BunCryptoLayer) throw new Error('Bun entry missing BunCryptoLayer'); if (!m.BunAuthServiceLayer) throw new Error('Bun entry missing BunAuthServiceLayer'); if (!m.ThumbnailServiceBunLive) throw new Error('Bun entry missing ThumbnailServiceBunLive'); if ('makeSqliteTelemetryLayer' in m) throw new Error('Bun entry leaked Node SQLite telemetry')"
  run(
    bunExecutable(),
    ["-e", `import('@gettersethya/mira').then((m) => { ${bunExportCheck} })`],
    bunTemp,
    false
  )
  run(
    bunExecutable(),
    [
      "-e",
      `import('@gettersethya/mira/bun').then((m) => { if (!m.BunSqliteDatabase) throw new Error('Bun subpath missing BunSqliteDatabase'); ${bunExportCheck} })`
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
