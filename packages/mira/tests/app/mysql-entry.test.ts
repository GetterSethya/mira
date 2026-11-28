import { describe, it } from "@effect/vitest"
import { expect } from "vitest"

import * as MysqlEntry from "@/index.mysql.js"

describe("@gettersethya/mira/mysql entry", () => {
  it("exports the MySQL server surface without another database preset", () => {
    expect(MysqlEntry.Mira).toBeDefined()
    expect(MysqlEntry.NodePlatform).toBeDefined()
    expect(MysqlEntry.LocalFileStorage).toBeDefined()
    expect(MysqlEntry.MysqlDatabase).toBeTypeOf("function")
    expect(MysqlEntry.MysqlConfigError).toBeTypeOf("function")
    expect(MysqlEntry.Migrator).toBeDefined()
    expect(MysqlEntry.MigratorLive).toBeDefined()
    expect(MysqlEntry.mysqlDialect).toBeDefined()
    expect("SqliteDatabase" in MysqlEntry).toBe(false)
    expect("PostgresDatabase" in MysqlEntry).toBe(false)
  })
})