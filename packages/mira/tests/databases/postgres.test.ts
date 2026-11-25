import { describe, it } from "@effect/vitest"
import { Cause, Effect, Exit, Layer, Redacted } from "effect"
import { expect } from "vitest"

import * as Databases from "@/databases/index.js"
import { PostgresConfigError, PostgresDatabase } from "@/databases/postgres.js"

const url = Redacted.make("postgres://mira:secret@127.0.0.1:5432/mira")
const badUrl = Redacted.make("postgres://mira:secret@127.0.0.1:not-a-port/mira")

describe("PostgresDatabase preset", () => {
  it("rejects a non-positive maxConnections before building a layer", () => {
    expect(() => PostgresDatabase({ url, maxConnections: 0 })).toThrow(PostgresConfigError)
    expect(() => PostgresDatabase({ url, maxConnections: -1 })).toThrow(PostgresConfigError)
    expect(() => PostgresDatabase({ url, maxConnections: 1.5 })).toThrow(PostgresConfigError)
    expect(() => PostgresDatabase({ url, maxConnections: 0 })).toThrow(
      "maxConnections must be a positive integer"
    )
  })

  it("accepts a positive integer maxConnections", () => {
    expect(() => PostgresDatabase({ url, maxConnections: 20 })).not.toThrow()
  })

  it("omits migrateAtStartup by default and returns false only when configured", () => {
    expect(PostgresDatabase({ url }).migrateAtStartup).toBeUndefined()
    expect(PostgresDatabase({ url, migrateAtStartup: true }).migrateAtStartup).toBeUndefined()
    expect(PostgresDatabase({ url, migrateAtStartup: false }).migrateAtStartup).toBe(false)
  })

  it("is exported from the database barrel", () => {
    expect(Databases.PostgresDatabase).toBe(PostgresDatabase)
    expect(Databases.PostgresConfigError).toBe(PostgresConfigError)
  })

  it.effect("fails the readiness probe for a bad URL", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Effect.scoped(Layer.build(PostgresDatabase({ url: badUrl }).layer))
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(exit.cause.reasons.some(Cause.isDieReason)).toBe(true)
      }
    })
  )
})
