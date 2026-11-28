import { describe, it } from "@effect/vitest"
import { Cause, Effect, Exit, Layer, Redacted } from "effect"
import { expect } from "vitest"

import { mysqlDialect } from "@/dialect/dialect-mysql.js"
import {
  checkMysqlVersion,
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
      mysqlPoolOptions({ url: Redacted.make("not a url") })
    ).toThrow(MysqlConfigError)
    expect(() =>
      mysqlPoolOptions({ url: Redacted.make("mysql://user:%zz@host/db") })
    ).toThrow(MysqlConfigError)
    expect(() =>
      mysqlPoolOptions({ url: goodUrl, maxConnections: 0 })
    ).toThrow(MysqlConfigError)
  })

  it("parses an IPv6 host", () => {
    const options = mysqlPoolOptions({
      url: Redacted.make("mysql://mira:secret@[::1]:3306/mira")
    })
    expect(options.host).toBe("::1")
    expect(options.port).toBe(3306)
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

  it("checks the documented engine version floor", () => {
    expect(checkMysqlVersion("8.4.13")).toBe("supported")
    expect(checkMysqlVersion("8.4.0")).toBe("supported")
    expect(checkMysqlVersion("9.1.0")).toBe("supported")
    expect(checkMysqlVersion("8.0.36")).toBe("unsupported")
    expect(checkMysqlVersion("11.4.13-MariaDB-ubu2404")).toBe("supported")
    expect(checkMysqlVersion("11.4.6-MariaDB")).toBe("supported")
    expect(checkMysqlVersion("11.4.5-MariaDB")).toBe("unsupported")
    expect(checkMysqlVersion("12.0.1-MariaDB")).toBe("supported")
    expect(checkMysqlVersion("10.11.6-MariaDB")).toBe("unsupported")
    expect(checkMysqlVersion("not-a-version")).toBe("unparseable")
  })
})