import { describe, expect, it } from "vitest"

import { forEachSqlCode, sqlCodeMatches, transformSqlCode } from "@/sql-text.js"

describe("sql-text", () => {
  it("transforms only code segments", () => {
    const sql = `t."ownerId" = ? AND note = '@auth_id' AND tag = \`a?b\``
    expect(transformSqlCode(sql, (code) => code.replace(/\?/g, "$1"))).toBe(
      `t."ownerId" = $1 AND note = '@auth_id' AND tag = \`a?b\``
    )
  })

  it("leaves tokens inside double-quoted identifiers", () => {
    const sql = `SELECT t."a?b", t."note@auth_id", t."t.field", t."@field_x@" FROM "t" t`
    expect(transformSqlCode(sql, (code) => code.replace(/@auth_/g, "X"))).toBe(sql)
    expect(sqlCodeMatches(sql, /@auth_/)).toBe(false)
  })

  it("handles doubled quotes and backticks", () => {
    const sql = `SELECT "a""?b", \`c\`\`@auth_id\`, 'it''s ? fine'`
    expect(transformSqlCode(sql, (code) => code.replace(/\?/g, "$1"))).toBe(sql)
  })

  it("visits each code segment in order", () => {
    const seen: Array<string> = []
    forEachSqlCode(`a ? "b ?" c ?`, (code) => seen.push(code))
    expect(seen).toEqual(["a ? ", " c ?"])
  })
})
