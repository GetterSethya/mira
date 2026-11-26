import { describe, expect, it } from "vitest"

import {
  boundLockName,
  classifyAcquire,
  databaseNameFromRows,
  isHeldByThisSession,
  isSessionLoss,
  resolveLockTimeoutSeconds
} from "@/migrator/lock.js"

const mysqlLockConfig = { namePrefix: "mira.migrations", maxNameLength: 64 }

describe("boundLockName", () => {
  it("pins the FNV-1a output for known database names", () => {
    expect(boundLockName(mysqlLockConfig, "mira_test")).toBe(
      "mira.migrations:e2a1fe5c08edcb0f"
    )
    expect(boundLockName(mysqlLockConfig, "app")).toBe("mira.migrations:e74fa719056a838c")
    expect(boundLockName(mysqlLockConfig, "test-db")).toBe(
      "mira.migrations:76cc3eb62dfba422"
    )
  })

  it("lowercases before hashing so case-only names share a lock", () => {
    expect(boundLockName(mysqlLockConfig, "Mira_Test")).toBe(
      boundLockName(mysqlLockConfig, "mira_test")
    )
    expect(boundLockName(mysqlLockConfig, "APP")).toBe(boundLockName(mysqlLockConfig, "app"))
  })

  it("trims surrounding whitespace", () => {
    expect(boundLockName(mysqlLockConfig, "  app  ")).toBe(boundLockName(mysqlLockConfig, "app"))
  })

  it("always emits ASCII within the maximum for non-ASCII names", () => {
    for (const name of ["é", "😀", "データベース", "aé😀z"]) {
      const lock = boundLockName(mysqlLockConfig, name)
      expect(lock).toMatch(/^[\x20-\x7e]+$/)
      expect(lock.length).toBeLessThanOrEqual(64)
      expect(lock.startsWith("mira.migrations:")).toBe(true)
    }
    expect(boundLockName(mysqlLockConfig, "😀")).toBe(boundLockName(mysqlLockConfig, "😀"))
  })

  it("truncates the digest when the dialect maximum is smaller than the prefix", () => {
    const name = boundLockName({ namePrefix: "mira.migrations", maxNameLength: 20 }, "mira_test")
    expect(name).toHaveLength(20)
    expect(name).toBe("mira.migrations:e2a1")
  })

  it("falls back to a pure digest when the prefix leaves no room", () => {
    const name = boundLockName({ namePrefix: "x".repeat(70), maxNameLength: 64 }, "app")
    expect(name).toHaveLength(16)
    expect(name).toMatch(/^[0-9a-f]{16}$/)
  })

  it("is deterministic across calls", () => {
    expect(boundLockName(mysqlLockConfig, "stable")).toBe(
      boundLockName(mysqlLockConfig, "stable")
    )
  })
})

describe("databaseNameFromRows", () => {
  it("returns a trimmed string name", () => {
    expect(databaseNameFromRows([{ database_name: " mira_test " }])).toBe("mira_test")
  })

  it("returns null for missing, empty, non-string, or no rows", () => {
    expect(databaseNameFromRows([])).toBeNull()
    expect(databaseNameFromRows([{}])).toBeNull()
    expect(databaseNameFromRows([{ database_name: null }])).toBeNull()
    expect(databaseNameFromRows([{ database_name: undefined }])).toBeNull()
    expect(databaseNameFromRows([{ database_name: "" }])).toBeNull()
    expect(databaseNameFromRows([{ database_name: "   " }])).toBeNull()
    expect(databaseNameFromRows([{ database_name: 42 }])).toBeNull()
    expect(databaseNameFromRows([{ database_name: 42n }])).toBeNull()
  })
})

describe("resolveLockTimeoutSeconds", () => {
  it("uses the dialect default silently when the value is undefined", () => {
    expect(resolveLockTimeoutSeconds(undefined, 60)).toEqual({ seconds: 60 })
  })

  it("accepts finite non-negative values including fractions", () => {
    expect(resolveLockTimeoutSeconds(0, 60)).toEqual({ seconds: 0 })
    expect(resolveLockTimeoutSeconds(0.5, 60)).toEqual({ seconds: 0.5 })
    expect(resolveLockTimeoutSeconds(30, 60)).toEqual({ seconds: 30 })
  })

  it("rejects negative, infinite, and NaN values with an exact detail", () => {
    expect(resolveLockTimeoutSeconds(-1, 60)).toEqual({
      detail: "migrationLockTimeoutSeconds must be a finite number >= 0; received -1"
    })
    expect(resolveLockTimeoutSeconds(Number.NaN, 60)).toEqual({
      detail: "migrationLockTimeoutSeconds must be a finite number >= 0; received NaN"
    })
    expect(resolveLockTimeoutSeconds(Number.POSITIVE_INFINITY, 60)).toEqual({
      detail: "migrationLockTimeoutSeconds must be a finite number >= 0; received Infinity"
    })
  })
})

describe("classifyAcquire", () => {
  it.each([true, 1, 1n, "1"])("classifies %p as acquired", (value) => {
    expect(classifyAcquire(value)).toBe("acquired")
  })

  it.each([false, 0, 0n, "0"])("classifies %p as busy", (value) => {
    expect(classifyAcquire(value)).toBe("busy")
  })

  it.each([null, undefined, "", "true", 2, -1])("classifies %p as unexpected", (value) => {
    expect(classifyAcquire(value)).toBe("unexpected")
  })
})

describe("isHeldByThisSession", () => {
  it.each([true, 1, 1n, "1"])("treats %p as held by this session", (value) => {
    expect(isHeldByThisSession(value)).toBe(true)
  })

  it.each([false, 0, 0n, "0", null, undefined])("treats %p as not held", (value) => {
    expect(isHeldByThisSession(value)).toBe(false)
  })
})

describe("isSessionLoss", () => {
  it("recognizes connection-loss markers", () => {
    expect(isSessionLoss({ code: "PROTOCOL_CONNECTION_LOST" })).toBe(true)
    expect(isSessionLoss(new Error("Connection lost: server closed the connection"))).toBe(true)
    expect(isSessionLoss({ message: "connect ECONNRESET 127.0.0.1:3306" })).toBe(true)
  })

  it("does not treat a permission or syntax error as session loss", () => {
    expect(isSessionLoss({ message: "Access denied for user" })).toBe(false)
    expect(isSessionLoss({ message: "You have an error in your SQL syntax" })).toBe(false)
  })
})
