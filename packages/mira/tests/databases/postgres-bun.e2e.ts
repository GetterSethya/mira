import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  BaseCollection,
  Field,
  Migrator,
  MigratorLive,
  PostgresDatabase
} from "@gettersethya/mira/bun"
import { Effect, Layer, Redacted } from "effect"
import { SqlClient } from "effect/sql"

const url = process.env["MIRA_TEST_POSTGRES_URL"]
if (url === undefined || url.length === 0) {
  throw new Error("MIRA_TEST_POSTGRES_URL is required for the Bun PostgreSQL smoke")
}

const Posts = BaseCollection.define("bun_pg_smoke", {
  title: Field.text({ required: true }),
  published: Field.boolean({ default: false })
})

const directory = mkdtempSync(join(tmpdir(), "mira-bun-postgres-"))
const database = PostgresDatabase({
  url: Redacted.make(url),
  maxConnections: 2
})

const options = {
  schemaTable: "bun_pg_collections",
  migrationsTable: "bun_pg_migrations",
  logLevel: 0
}

const reset = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  for (const name of [
    "bun_pg_smoke",
    "bun_pg_collections",
    "bun_pg_migrations"
  ]) {
    yield* sql.unsafe(`DROP TABLE IF EXISTS "${name}" CASCADE`).pipe(Effect.ignore)
  }
})

const layer = Layer.mergeAll(
  database.layer,
  MigratorLive.pipe(Layer.provideMerge(database.layer))
)

const program = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const migrator = yield* Migrator

  yield* migrator.migrate([{ name: Posts.name, schema: Posts.schema }], options)
  yield* sql.unsafe(
    `ALTER TABLE "bun_pg_smoke" ALTER COLUMN "seqId" RESTART WITH 9007199254740993`
  )
  const now = new Date().toISOString()
  yield* sql`INSERT INTO ${sql("bun_pg_smoke")} ${sql.insert({
    id: "bun-1",
    title: "first",
    published: true,
    created: now,
    updated: now
  })}`
  yield* sql`INSERT INTO ${sql("bun_pg_smoke")} ${sql.insert({
    id: "bun-2",
    title: "second",
    published: false,
    created: now,
    updated: now
  })}`

  return yield* sql<{ seqId: bigint; title: string; published: boolean }>`
    SELECT "seqId", "title", "published" FROM ${sql("bun_pg_smoke")} ORDER BY "seqId"
  `
})

try {
  await Effect.runPromise(reset.pipe(Effect.provide(database.layer)))
  const rows = await Effect.runPromise(program.pipe(Effect.provide(layer)))

  const first = rows[0]
  const second = rows[1]
  if (first === undefined || second === undefined) {
    throw new Error("PostgreSQL Bun smoke returned fewer than two rows")
  }
  if (first.published !== true || second.published !== false) {
    throw new Error(
      `expected native booleans, got ${String(first.published)} and ${String(second.published)}`
    )
  }
  if (typeof first.seqId !== "bigint") {
    throw new Error(`expected a bigint seqId, got ${typeof first.seqId}`)
  }
  if (String(first.seqId) !== "9007199254740993") {
    throw new Error(`expected the restarted seqId, got ${String(first.seqId)}`)
  }

  console.log("bun pg smoke ok", {
    ok: true,
    rows: rows.length,
    boolean: first.published,
    seqId: String(first.seqId)
  })
} finally {
  rmSync(directory, { recursive: true, force: true })
}
