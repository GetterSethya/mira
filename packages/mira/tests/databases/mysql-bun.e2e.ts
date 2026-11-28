import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  BaseCollection,
  Field,
  Migrator,
  MigratorLive,
  MysqlDatabase
} from "@gettersethya/mira/bun"
import { Effect, Layer, Redacted } from "effect"
import { SqlClient } from "effect/sql"

const url = process.env["MIRA_TEST_MYSQL_URL"]
if (url === undefined || url.length === 0) {
  throw new Error("MIRA_TEST_MYSQL_URL is required for the Bun MySQL smoke")
}

const Posts = BaseCollection.define("bun_mysql_smoke", {
  title: Field.text({ required: true }),
  published: Field.boolean({ default: false })
})

const directory = mkdtempSync(join(tmpdir(), "mira-bun-mysql-"))
const database = MysqlDatabase({
  url: Redacted.make(url),
  maxConnections: 2
})

const options = {
  schemaTable: "bun_mysql_collections",
  migrationsTable: "bun_mysql_migrations",
  logLevel: 0
}

const reset = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  for (const name of [
    "bun_mysql_smoke",
    "bun_mysql_collections",
    "bun_mysql_migrations"
  ]) {
    yield* sql.unsafe(`DROP TABLE IF EXISTS \`${name}\``).pipe(Effect.ignore)
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
    "ALTER TABLE `bun_mysql_smoke` AUTO_INCREMENT = 9007199254740993"
  )
  const now = new Date().toISOString()
  yield* sql`INSERT INTO ${sql("bun_mysql_smoke")} ${sql.insert({
    id: "bun-1",
    title: "first",
    published: 1,
    created: now,
    updated: now
  })}`
  yield* sql`INSERT INTO ${sql("bun_mysql_smoke")} ${sql.insert({
    id: "bun-2",
    title: "second",
    published: 0,
    created: now,
    updated: now
  })}`

  return yield* sql<{ seqId: string | number; title: string; published: number }>`
    SELECT \`seqId\`, \`title\`, \`published\` FROM ${sql("bun_mysql_smoke")} ORDER BY \`seqId\`
  `
})

try {
  await Effect.runPromise(reset.pipe(Effect.provide(database.layer)))
  const rows = await Effect.runPromise(program.pipe(Effect.provide(layer)))

  const first = rows[0]
  const second = rows[1]
  if (first === undefined || second === undefined) {
    throw new Error("MySQL Bun smoke returned fewer than two rows")
  }
  if (first.published !== 1 || second.published !== 0) {
    throw new Error(
      `expected 0/1 booleans, got ${String(first.published)} and ${String(second.published)}`
    )
  }
  if (typeof first.seqId !== "string") {
    throw new Error(`expected a string seqId above 2^53, got ${typeof first.seqId}`)
  }
  if (first.seqId !== "9007199254740993") {
    throw new Error(`expected the restarted seqId, got ${first.seqId}`)
  }

  console.log("bun mysql smoke ok", {
    ok: true,
    rows: rows.length,
    boolean: first.published,
    seqId: first.seqId
  })
} finally {
  rmSync(directory, { recursive: true, force: true })
}