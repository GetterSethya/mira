import { describe, it } from "@effect/vitest"
import type { CollectionSchema, FilterNode } from "@gettersethya/mira-client"
import { filterNodeToWhereClause } from "@gettersethya/mira-client"
import { Effect } from "effect"
import { expect } from "vitest"

import { postgresFilterSql, postgresRuleSql } from "@/dialect/dialect-postgres.js"
import { sqliteDialect } from "@/dialect/dialect-sqlite.js"

const schema: CollectionSchema = {
  "x-collection-kind": "base",
  type: "object",
  properties: {
    title: { type: "string" }
  },
  required: ["title"]
}

const sqliteOptions = {
  quoteIdentifier: sqliteDialect.quoteIdentifier,
  caseInsensitivePattern: (left: string, right: string) =>
    sqliteDialect.caseInsensitivePattern(left, right)
}

const postgresOptions = {
  quoteIdentifier: postgresRuleSql.quoteIdentifier,
  caseInsensitivePattern: (left: string, right: string) =>
    postgresFilterSql.caseInsensitivePattern(left, right)
}

describe("dialect case-insensitive pattern", () => {
  it.effect("SQLite renders LIKE and PostgreSQL renders ILIKE", () =>
    Effect.sync(() => {
      expect(sqliteDialect.caseInsensitivePattern('t."title"', "?")).toBe('t."title" LIKE ?')
      expect(postgresFilterSql.caseInsensitivePattern('t."title"', "?")).toBe(
        't."title" ILIKE ?'
      )
    })
  )

  it.effect("caseInsensitiveLike keeps the prefix and contains output", () =>
    Effect.sync(() => {
      expect(sqliteDialect.caseInsensitiveLike('t."title"', "?", "prefix")).toBe(
        `t."title" LIKE (? || '%')`
      )
      expect(sqliteDialect.caseInsensitiveLike('t."title"', "?", "contains")).toBe(
        `t."title" LIKE ('%' || ? || '%')`
      )
      expect(postgresRuleSql.caseInsensitiveLike('t."title"', "?", "prefix")).toBe(
        `t."title" ILIKE (? || '%')`
      )
      expect(postgresRuleSql.caseInsensitiveLike('t."title"', "?", "contains")).toBe(
        `t."title" ILIKE ('%' || ? || '%')`
      )
    })
  )

  it.effect("a like node emits LIKE for SQLite and ILIKE for PostgreSQL", () =>
    Effect.gen(function* () {
      const node: FilterNode = { op: "like", field: "title", value: "%a%" }

      const sqlite = yield* filterNodeToWhereClause(node, schema, "posts", sqliteOptions)
      const postgres = yield* filterNodeToWhereClause(node, schema, "posts", postgresOptions)

      expect(sqlite.sql).toBe('t."title" LIKE ?')
      expect(postgres.sql).toBe('t."title" ILIKE ?')
      expect(sqlite.params).toEqual(["%a%"])
      expect(postgres.params).toEqual(sqlite.params)
    })
  )

  it.effect("a backslash pattern stays one parameter with no ESCAPE clause", () =>
    Effect.gen(function* () {
      const node: FilterNode = { op: "like", field: "title", value: "100\\%_" }

      const sqlite = yield* filterNodeToWhereClause(node, schema, "posts", sqliteOptions)
      const postgres = yield* filterNodeToWhereClause(node, schema, "posts", postgresOptions)

      expect(sqlite.params).toEqual(["100\\%_"])
      expect(postgres.params).toEqual(["100\\%_"])
      expect(sqlite.params).toHaveLength(1)
      expect(postgres.params).toHaveLength(1)
      expect(sqlite.sql).not.toContain("ESCAPE")
      expect(postgres.sql).not.toContain("ESCAPE")
    })
  )
})
