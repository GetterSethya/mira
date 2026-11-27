import { describe, it } from "@effect/vitest"
import { expect } from "vitest"

import {
  isMysqlTransactionFatal,
  MYSQL_DEADLOCK_CODES,
  mysqlTransactionProbe
} from "@/dialect/dialect-mysql-transactions.js"

describe("isMysqlTransactionFatal", () => {
  it("matches an Effect SQL DeadlockError reason", () => {
    expect(isMysqlTransactionFatal({ reason: { _tag: "DeadlockError" } })).toBe(true)
  })

  it("walks nested cause and error fields for the reason tag", () => {
    expect(
      isMysqlTransactionFatal({ cause: { reason: { _tag: "DeadlockError" } } })
    ).toBe(true)
    expect(
      isMysqlTransactionFatal({ error: { reason: { _tag: "DeadlockError" } } })
    ).toBe(true)
    expect(
      isMysqlTransactionFatal({
        reason: { _tag: "UnknownError" },
        cause: { reason: { _tag: "DeadlockError" } }
      })
    ).toBe(true)
  })

  it("falls back to the numeric and symbolic deadlock codes", () => {
    expect(isMysqlTransactionFatal({ errno: 1213 })).toBe(true)
    expect(isMysqlTransactionFatal({ code: "ER_LOCK_DEADLOCK" })).toBe(true)
    expect(
      isMysqlTransactionFatal({ reason: { cause: { errno: 1213, code: "ER_LOCK_DEADLOCK" } } })
    ).toBe(true)
  })

  it("does not match statement-level errors", () => {
    const statementLevel = [
      { errno: 1062, code: "ER_DUP_ENTRY" },
      { errno: 1205, code: "ER_LOCK_WAIT_TIMEOUT" },
      { errno: 1452 },
      { errno: 3819 },
      { message: "Can't add new command when connection is in closed state", fatal: true },
      { reason: { _tag: "UniqueViolation" } },
      { reason: { _tag: "LockTimeoutError" } },
      null,
      undefined,
      "deadlock",
      1213,
      [],
      {}
    ]

    for (const error of statementLevel) {
      expect(isMysqlTransactionFatal(error)).toBe(false)
    }
  })

  it("does not treat the savepoint 1305 defect as a deadlock", () => {
    expect(
      isMysqlTransactionFatal({
        reason: { _tag: "UnknownError" },
        cause: { errno: 1305, code: "ER_SP_DO_NOT_EXIST" }
      })
    ).toBe(false)
  })
})

describe("mysqlTransactionProbe", () => {
  it("is a complete error-classified strategy", () => {
    expect(mysqlTransactionProbe._tag).toBe("error-classified")
    expect(mysqlTransactionProbe.isTransactionFatal).toBe(isMysqlTransactionFatal)
  })

  it("exports the exact deadlock code set", () => {
    expect(MYSQL_DEADLOCK_CODES).toEqual([1213, "ER_LOCK_DEADLOCK"])
  })
})
