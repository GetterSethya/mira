import { describe, it } from "@effect/vitest"
import { Cause, Effect, Exit, Layer, Redacted } from "effect"
import { expect } from "vitest"

import * as PostgresEntry from "@/index.postgres.js"

const badUrl = Redacted.make("postgres://mira:secret@127.0.0.1:not-a-port/mira")

describe("@gettersethya/mira/postgres entry", () => {
  it("exports the PostgreSQL server surface without a SQLite preset", () => {
    expect(PostgresEntry.Mira).toBeDefined()
    expect(PostgresEntry.NodePlatform).toBeDefined()
    expect(PostgresEntry.LocalFileStorage).toBeDefined()
    expect(PostgresEntry.PostgresDatabase).toBeTypeOf("function")
    expect(PostgresEntry.PostgresConfigError).toBeTypeOf("function")
    expect(PostgresEntry.Migrator).toBeDefined()
    expect(PostgresEntry.MigratorLive).toBeDefined()
    expect(PostgresEntry.postgresDialect).toBeDefined()
    expect("SqliteDatabase" in PostgresEntry).toBe(false)
  })

  it.effect("fails the readiness probe for a malformed URL", () =>
    Effect.gen(function* () {
      const database = PostgresEntry.PostgresDatabase({ url: badUrl })
      const exit = yield* Effect.exit(Effect.scoped(Layer.build(database.layer)))

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(exit.cause.reasons.some(Cause.isDieReason)).toBe(true)
      }
    })
  )
})
