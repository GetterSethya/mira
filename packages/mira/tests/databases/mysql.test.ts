import { describe, it } from "@effect/vitest"
import { Cause, Effect, Exit, Layer, Redacted } from "effect"
import { expect } from "vitest"

import { mysqlDialect } from "@/dialect/dialect-mysql.js"
import {
  MysqlConfigError,
  MysqlDatabase,
  mysqlPoolOptions
} from "@/databases/mysql.js"

const goodUrl = Redacted.make("mysql://mira:secret@127.0.0.1:3306/mira")

describe("MysqlDatabase", () => {
  it("parses the URL into the non-URL driver options", () => {
    const options = mysqlPoolOptions({
      url: goodUrl,
      maxConnections: 7,
      connectionTTL: "30 seconds",
      ssl: true,
      connectTimeout: "5 seconds",
      disablePreparedStatements: true
    })
    expect(options.host).toBe("127.0.0.1")
    expect(options.port).toBe(3306)
    expect(options.database).toBe("mira")
    expect(options.username).toBe("mira")
    expect(Redacted.value(options.password)).toBe("secret")
    expect(options.maxConnections).toBe(7)
    expect(options.disablePreparedStatements).toBe(true)
    expect(options.poolConfig).toMatchObject({
      ssl: {},
      connectTimeout: 5_000
    })
  })

  it("maps ssl false to no ssl option", () => {
    const options = mysqlPoolOptions({ url: goodUrl, ssl: false })
    expect(options.poolConfig).toBeUndefined()
  })

  it("rejects bad configuration synchronously", () => {
    expect(() =>
      mysqlPoolOptions({ url: Redacted.make("postgres://x:y@h/db") })
    ).toThrow(MysqlConfigError)
    expect(() =>
      mysqlPoolOptions({ url: Redacted.make("mysql:///db") })
    ).toThrow(MysqlConfigError)
    expect(() =>
      mysqlPoolOptions({ url: Redacted.make("mysql://h:3306") })
    ).toThrow(MysqlConfigError)
    expect(() =>
      mysqlPoolOptions({ url: goodUrl, maxConnections: 0 })
    ).toThrow(MysqlConfigError)
  })

  it("propagates migrateAtStartup false", () => {
    const database = MysqlDatabase({ url: goodUrl, migrateAtStartup: false })
    expect(database.migrateAtStartup).toBe(false)
    expect(database.layer).toBeDefined()
  })

  it.effect("fails the readiness probe for a closed port", () =>
    Effect.gen(function* () {
      const database = MysqlDatabase({
        url: Redacted.make("mysql://root:mira@127.0.0.1:1/mira")
      })
      const exit = yield* Effect.exit(Effect.scoped(Layer.build(database.layer)))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(exit.cause.reasons.some(Cause.isDieReason)).toBe(true)
      }
    })
  )

  it("exports the mysql dialect from the preset module", () => {
    expect(mysqlDialect.store.mutationResult._tag).toBe("affectedRows")
  })
})