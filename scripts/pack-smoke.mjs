import { execFileSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
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
      `import('@gettersethya/mira').then((m) => { if (!m.NodePlatform) throw new Error('Node entry missing NodePlatform'); if (typeof m.LibsqlDatabase !== 'function') throw new Error('Node entry missing LibsqlDatabase'); if (m.TursoDatabase !== m.LibsqlDatabase) throw new Error('TursoDatabase is not the libSQL alias'); const leaked = ${JSON.stringify(bunOnlyExports)}.filter((name) => name in m); if (leaked.length > 0) throw new Error('Node entry leaked Bun exports: ' + leaked.join(', ')) })`
    ],
    temp,
    false
  )

  // The root entry must not load the libSQL driver. Rename the adapter, its
  // client, and the native package, then import the root. An eager import
  // fails here; the lazy preset still resolves after they are restored.
  const miraPackageJson = realpathSync(
    join(temp, "node_modules", "@gettersethya", "mira", "package.json")
  )
  const resolveFromMira = createRequire(miraPackageJson)
  const libsqlAdapter = dirname(resolveFromMira.resolve("@effect/sql-libsql/package.json"))
  const libsqlClient = dirname(
    dirname(
      createRequire(realpathSync(join(libsqlAdapter, "package.json"))).resolve(
        "@libsql/client"
      )
    )
  )
  const libsqlNative = dirname(
    createRequire(realpathSync(join(libsqlClient, "package.json"))).resolve("libsql")
  )
  const moved = [libsqlAdapter, libsqlClient, libsqlNative]
  for (const dir of moved) renameSync(dir, `${dir}.bak`)
  try {
    run(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "import('@gettersethya/mira').then((m) => { if (typeof m.LibsqlDatabase !== 'function') throw new Error('lazy root import lost LibsqlDatabase') })"
      ],
      temp,
      false
    )
  } finally {
    for (const dir of moved) renameSync(`${dir}.bak`, dir)
  }

  copyFileSync(
    join(repo, "scripts", "pack-smoke-libsql.mjs"),
    join(temp, "pack-smoke-libsql.mjs")
  )
  run(process.execPath, ["pack-smoke-libsql.mjs"], temp, false)

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
  run("bun", ["add", ...tarballs, "effect@4.0.0", "@effect/sql-sqlite-bun@4.0.0"], bunTemp, false)
  const bunExportCheck =
    "if (!m.BunPlatform) throw new Error('Bun entry missing BunPlatform'); if (!m.BunPortablePlatform) throw new Error('Bun entry missing BunPortablePlatform'); if (!m.BunCryptoLayer) throw new Error('Bun entry missing BunCryptoLayer'); if (!m.BunAuthServiceLayer) throw new Error('Bun entry missing BunAuthServiceLayer'); if (!m.ThumbnailServiceBunLive) throw new Error('Bun entry missing ThumbnailServiceBunLive'); if (typeof m.makeTelemetryLayer !== 'function') throw new Error('Bun entry missing makeTelemetryLayer'); if (!m.TelemetryStore) throw new Error('Bun entry missing TelemetryStore'); if (!m.TelemetryStoreError) throw new Error('Bun entry missing TelemetryStoreError'); if (!m.TelemetryDuplicateEntryError) throw new Error('Bun entry missing TelemetryDuplicateEntryError'); if (typeof m.makeSqlTelemetryStoreLayer !== 'function') throw new Error('Bun entry missing makeSqlTelemetryStoreLayer'); if (!m.logCleanupCronDef) throw new Error('Bun entry missing logCleanupCronDef'); if (typeof m.LibsqlDatabase !== 'function') throw new Error('Bun entry missing LibsqlDatabase'); if (m.TursoDatabase !== m.LibsqlDatabase) throw new Error('Bun entry TursoDatabase alias is wrong')"
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

  // Run the packed Bun telemetry write/read script from inside the temp install.
  copyFileSync(
    join(repo, "scripts", "pack-smoke-bun-telemetry.ts"),
    join(bunTemp, "pack-smoke-bun-telemetry.ts")
  )
  run(bunExecutable(), ["run", "pack-smoke-bun-telemetry.ts"], bunTemp, false)

  copyFileSync(
    join(repo, "scripts", "pack-smoke-bun-libsql.ts"),
    join(bunTemp, "pack-smoke-bun-libsql.ts")
  )
  run(bunExecutable(), ["run", "pack-smoke-bun-libsql.ts"], bunTemp, false)

  // Bundle only the telemetry surface and assert the Node SQLite driver stays out.
  writeFileSync(
    join(bunTemp, "telemetry-chunk-entry.ts"),
    [
      'import { makeTelemetryLayer, TelemetryStore } from "@gettersethya/mira/bun"',
      'import { SqliteClient } from "@effect/sql-sqlite-bun"',
      "console.log(makeTelemetryLayer, TelemetryStore, SqliteClient)",
      ""
    ].join("\n")
  )
  run(
    bunExecutable(),
    ["build", "telemetry-chunk-entry.ts", "--target=bun", "--outfile=telemetry-chunk.js"],
    bunTemp,
    false
  )
  const telemetryChunk = readFileSync(join(bunTemp, "telemetry-chunk.js"), "utf8")
  for (const forbidden of [
    "@effect/sql-sqlite-node",
    "node:sqlite",
    "@effect/sql-libsql",
    "@libsql/client",
    "libsql/"
  ]) {
    if (telemetryChunk.includes(forbidden)) {
      throw new Error(`Bun telemetry chunk references ${forbidden}`)
    }
  }

  console.log("pack smoke ok - Node and Bun entries resolve from packed tarballs")
} finally {
  rmSync(temp, { recursive: true, force: true })
}

function bunExecutable() {
  return "bun"
}
