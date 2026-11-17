import { SqliteClient } from "@effect/sql-sqlite-node"
import { BaseCollection, Field } from "@gettersethya/mira-client"
import { describe, it } from "@effect/vitest"
import { Context, Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { expect } from "vitest"

import { Dialect } from "@/dialect/dialect.js"
import { sqliteDialect } from "@/dialect/dialect-sqlite.js"
import { Migrator, MigratorLive } from "@/migrator/migrator.js"
import { LogsCollection, SpansCollection } from "@/telemetry/collections.js"

const Posts = BaseCollection.define("posts", {
  title: Field.text({ required: true })
})

const layer = MigratorLive.pipe(
  Layer.provideMerge(
    Layer.merge(
      SqliteClient.layer({ filename: ":memory:" }),
      Layer.succeed(Dialect, sqliteDialect)
    )
  )
)

describe("telemetry migration metadata", () => {
  it.effect("isolates app and telemetry schema rows", () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(layer)
      const migrator = Context.get(context, Migrator)
      const sql = Context.get(context, SqlClient.SqlClient)

      yield* migrator.migrate([{ name: "posts", schema: Posts.schema }])
      yield* migrator.migrate(
        [
          { name: "logs", schema: LogsCollection.schema },
          { name: "spans", schema: SpansCollection.schema }
        ],
        {
          schemaTable: "_telemetry_collections",
          migrationsTable: "_telemetry_migrations"
        }
      )

      const appRows = yield* sql<{ name: string }>`SELECT name FROM _collections ORDER BY name`
      const telemetryRows = yield* sql<{ name: string }>`
        SELECT name FROM _telemetry_collections ORDER BY name
      `

      expect(appRows.map((row) => row.name)).toEqual(["posts"])
      expect(telemetryRows.map((row) => row.name)).toEqual(["logs", "spans"])
    })
  )
})
