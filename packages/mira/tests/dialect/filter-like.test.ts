import { describe, it } from "@effect/vitest"
import type { CollectionSchema, FilterNode } from "@gettersethya/mira-client"
import { filterNodeToWhereClause } from "@gettersethya/mira-client"
import { Effect } from "effect"
import { expect } from "vitest"

import { postgresFilterSql, postgresRuleSql } from "@/dialect/dialect-postgres.js"
import { sqliteDialect } from "@/dialect/dialect-sqlite.js"

const SQLITE_ESCAPE = "ESCAPE '\\'"
const POSTGRES_ESCAPE = String.raw`ESCAPE E'\\'`

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
  it.effect("SQLite renders LIKE and PostgreSQL renders ILIKE with the escape clause", () =>
    Effect.sync(() => {
      expect(sqliteDialect.caseInsensitivePattern('t."title"', "?")).toBe(
        `t."title" LIKE ? ${SQLITE_ESCAPE}`
      )
      expect(postgresFilterSql.caseInsensitivePattern('t."title"', "?")).toBe(
        `t."title" ILIKE ? ${POSTGRES_ESCAPE}`
      )
    })
  )

  it.effect("caseInsensitiveLike keeps the prefix and contains output", () =>
    Effect.sync(() => {
      expect(sqliteDialect.caseInsensitiveLike('t."title"', "?", "prefix")).toBe(
        `t."title" LIKE (? || '%') ${SQLITE_ESCAPE}`
      )
      expect(sqliteDialect.caseInsensitiveLike('t."title"', "?", "contains")).toBe(
        `t."title" LIKE ('%' || ? || '%') ${SQLITE_ESCAPE}`
      )
      expect(postgresRuleSql.caseInsensitiveLike('t."title"', "?", "prefix")).toBe(
        `t."title" ILIKE (? || '%') ${POSTGRES_ESCAPE}`
      )
      expect(postgresRuleSql.caseInsensitiveLike('t."title"', "?", "contains")).toBe(
        `t."title" ILIKE ('%' || ? || '%') ${POSTGRES_ESCAPE}`
      )
    })
  )

  it.effect("a like node emits LIKE for SQLite and ILIKE for PostgreSQL", () =>
    Effect.gen(function* () {
      const node: FilterNode = { op: "like", field: "title", value: "%a%" }

      const sqlite = yield* filterNodeToWhereClause(node, schema, "posts", sqliteOptions)
      const postgres = yield* filterNodeToWhereClause(node, schema, "posts", postgresOptions)

      expect(sqlite.sql).toBe(`t."title" LIKE ? ${SQLITE_ESCAPE}`)
      expect(postgres.sql).toBe(`t."title" ILIKE ? ${POSTGRES_ESCAPE}`)
      expect(sqlite.params).toEqual(["%a%"])
      expect(postgres.params).toEqual(sqlite.params)
    })
  )

  it.effect("a backslash pattern stays one parameter with the engine escape clause", () =>
    Effect.gen(function* () {
      const node: FilterNode = { op: "like", field: "title", value: "100\\%_" }

      const sqlite = yield* filterNodeToWhereClause(node, schema, "posts", sqliteOptions)
      const postgres = yield* filterNodeToWhereClause(node, schema, "posts", postgresOptions)

      expect(sqlite.params).toEqual(["100\\%_"])
      expect(postgres.params).toEqual(["100\\%_"])
      expect(sqlite.params).toHaveLength(1)
      expect(postgres.params).toHaveLength(1)
      expect(sqlite.sql).toBe(`t."title" LIKE ? ${SQLITE_ESCAPE}`)
      expect(postgres.sql).toBe(`t."title" ILIKE ? ${POSTGRES_ESCAPE}`)
    })
  )
})
