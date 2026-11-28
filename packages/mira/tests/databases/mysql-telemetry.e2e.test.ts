import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, it } from "@effect/vitest"
import { BaseCollection, Field } from "@gettersethya/mira-client"
import { Effect, Redacted } from "effect"
import mysql from "mysql2/promise"
import type { RowDataPacket } from "mysql2/promise"
import { expect } from "vitest"

import { applyRulesToCollections, defineRule, Mira } from "@/app/index.js"
import { MysqlDatabase } from "@/databases/mysql.js"
import { NodePlatform } from "@/platforms/node.js"
import { LocalFileStorage } from "@/storage/local-preset.js"
import { makeTelemetryLayer } from "@/telemetry/layer.js"
import { TelemetryStore } from "@/telemetry/store.js"

type EngineConfig = {
  readonly label: string
  readonly envUrl: string | undefined
  readonly fallbackUrl: string
}

const engines: ReadonlyArray<EngineConfig> = [
  {
    label: "MySQL",
    envUrl: process.env["MIRA_TEST_MYSQL_URL"],
    fallbackUrl: "mysql://root:mira@127.0.0.1:53307/mira_test"
  },
  {
    label: "MariaDB",
    envUrl: process.env["MIRA_TEST_MARIADB_URL"],
    fallbackUrl: "mysql://root:mira@127.0.0.1:53306/mira_test"
  }
]

const adminUrl = (url: string) => {
  const parsed = new URL(url)
  parsed.pathname = "/"
  return parsed.toString()
}

const databaseUrl = (url: string, name: string) => {
  const parsed = new URL(url)
  parsed.pathname = `/${name}`
  return parsed.toString()
}

const createDatabase = (url: string, name: string) =>
  Effect.promise(async () => {
    const connection = await mysql.createConnection(adminUrl(url))
    try {
      await connection.query(`DROP DATABASE IF EXISTS \`${name}\``)
      await connection.query(`CREATE DATABASE \`${name}\``)
    } finally {
      await connection.end()
    }
  })

const dropDatabase = (url: string, name: string) =>
  Effect.promise(async () => {
    const connection = await mysql.createConnection(adminUrl(url))
    try {
      await connection.query(`DROP DATABASE IF EXISTS \`${name}\``)
    } finally {
      await connection.end()
    }
  })

const PostsDef = BaseCollection.define("e2e_mysql_telemetry_posts", {
  title: Field.text({ required: true })
})
const postsRules = defineRule(PostsDef, (R) => ({
  list: R.public(),
  view: R.public(),
  create: R.public(),
  update: R.public(),
  delete: R.public()
}))
const [Posts] = applyRulesToCollections([PostsDef], [postsRules])

const app = (url: string, dedicatedUrl?: string) => {
  const builder = Mira.builder()
    .platform(NodePlatform)
    .database(MysqlDatabase({ url: Redacted.make(url) }))
    .storage(
      LocalFileStorage({
        directory: join(mkdtempSync(join(tmpdir(), "mira-mysql-telemetry-")), "uploads")
      })
    )
    .collections([Posts])

  return (
    dedicatedUrl === undefined
      ? builder.telemetry(
          makeTelemetryLayer({
            storage: { mode: "shared" },
            flushBatchSize: 100,
            flushInterval: "1 second"
          })
        )
      : builder.telemetry(
          makeTelemetryLayer({
            storage: {
              mode: "dedicated",
              database: MysqlDatabase({ url: Redacted.make(dedicatedUrl) })
            },
            flushBatchSize: 100,
            flushInterval: "1 second"
          })
        )
  ).build()
}

const withEngine = <A, E, R>(
  url: string,
  body: (url: string, dedicatedUrl: string) => Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> =>
  Effect.scoped(
    Effect.acquireRelease(
      Effect.sync(() => `mira_e2e_telemetry_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
      (name) => Effect.all([dropDatabase(url, name), dropDatabase(url, `${name}_dedicated`)])
    ).pipe(
      Effect.flatMap((name) =>
        Effect.gen(function* () {
          yield* createDatabase(url, name)
          yield* createDatabase(url, `${name}_dedicated`)
          return yield* body(databaseUrl(url, name), databaseUrl(url, `${name}_dedicated`))
        })
      )
    )
  )

for (const engine of engines) {
  const enabled = engine.envUrl !== undefined
  const describeEngine = enabled ? describe : describe.skip
  const url = engine.envUrl ?? engine.fallbackUrl

  describeEngine(`${engine.label} telemetry`, () => {
    it.live(
      "persists logs and spans in shared mode and ignores duplicates",
      () =>
        withEngine(url, (databaseUrlValue) =>
          Effect.gen(function* () {
            const appInstance = app(databaseUrlValue)
            yield* Effect.gen(function* () {
              const store = yield* TelemetryStore
              yield* Effect.logInfo("e2e-mysql-telemetry-log")
              yield* Effect.void.pipe(Effect.withSpan("e2e-mysql-telemetry-span"))
              yield* Effect.sleep(2_000)

              const read = store.read
              if (read === null) return yield* Effect.die("expected telemetry read store")
              const logs = yield* read.listLogs({
                limit: 100,
                after: null,
                filter: null,
                traceId: null
              })
              const spans = yield* read.listSpans({
                limit: 100,
                after: null,
                filter: null,
                traceId: null
              })
              expect(logs.items.some((row) => row.message === "e2e-mysql-telemetry-log")).toBe(true)
              expect(spans.items.some((row) => row.name === "e2e-mysql-telemetry-span")).toBe(true)

              const now = new Date().toISOString()
              yield* store.appendLogs([
                {
                  id: "e2e-mysql-dup",
                  level: "INFO",
                  message: "dup",
                  created: now,
                  updated: now,
                  traceId: null,
                  spanId: null
                }
              ])
              yield* store.appendLogs([
                {
                  id: "e2e-mysql-dup",
                  level: "INFO",
                  message: "dup",
                  created: now,
                  updated: now,
                  traceId: null,
                  spanId: null
                }
              ])

              const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
              const recent = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString()
              yield* store.appendLogs([
                {
                  id: "e2e-mysql-old",
                  level: "INFO",
                  message: "old",
                  created: old,
                  updated: old,
                  traceId: null,
                  spanId: null
                },
                {
                  id: "e2e-mysql-recent",
                  level: "INFO",
                  message: "recent",
                  created: recent,
                  updated: recent,
                  traceId: null,
                  spanId: null
                }
              ])
              const deleted = yield* store.deleteOlderThan(recent)
              expect(deleted.logs).toBe(1)

              const afterDelete = yield* read.listLogs({
                limit: 100,
                after: null,
                filter: null,
                traceId: null
              })
              expect(afterDelete.items.filter((row) => row.id === "e2e-mysql-dup")).toHaveLength(1)
              expect(afterDelete.items.filter((row) => row.id === "e2e-mysql-old")).toHaveLength(0)
              expect(afterDelete.items.filter((row) => row.id === "e2e-mysql-recent")).toHaveLength(1)

              const firstPage = yield* read.listLogs({
                limit: 1,
                after: null,
                filter: null,
                traceId: null
              })
              expect(firstPage.items).toHaveLength(1)
              if (firstPage.nextCursor === null) {
                return yield* Effect.die("expected a telemetry next cursor")
              }
              const secondPage = yield* read.listLogs({
                limit: 1,
                after: firstPage.nextCursor,
                filter: null,
                traceId: null
              })
              expect(secondPage.items).toHaveLength(1)
              expect(secondPage.items[0]?.id).not.toBe(firstPage.items[0]?.id)
            }).pipe(Effect.provide(appInstance.buildServiceLayer()))
          })
        ),
      120_000
    )

    it.effect(
      "persists logs in dedicated mode on a separate database",
      () =>
        withEngine(url, (databaseUrlValue, dedicatedUrl) =>
          Effect.gen(function* () {
            const appInstance = app(databaseUrlValue, dedicatedUrl)
            yield* Effect.gen(function* () {
              const store = yield* TelemetryStore
              const now = new Date().toISOString()
              yield* store.appendLogs([
                {
                  id: "e2e-mysql-dedicated",
                  level: "INFO",
                  message: "dedicated",
                  created: now,
                  updated: now,
                  traceId: null,
                  spanId: null
                }
              ])
              const read = store.read
              if (read === null) return yield* Effect.die("expected telemetry read store")
              const logs = yield* read.listLogs({
                limit: 10,
                after: null,
                filter: null,
                traceId: null
              })
              expect(logs.items.some((row) => row.id === "e2e-mysql-dedicated")).toBe(true)
            }).pipe(Effect.provide(appInstance.buildServiceLayer()))

            const appTables = yield* Effect.promise(async () => {
              const connection = await mysql.createConnection(databaseUrlValue)
              try {
                const [rows] = await connection.query<Array<RowDataPacket>>(
                  "SELECT TABLE_NAME AS name FROM information_schema.tables WHERE TABLE_SCHEMA = DATABASE()"
                )
                return rows.map((row) => String(row["name"]))
              } finally {
                await connection.end()
              }
            })
            expect(appTables).not.toContain("logs")
            expect(appTables).not.toContain("spans")
          })
        ),
      120_000
    )
  })
}
