import { describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { expect } from "vitest"

import type { ViewShape } from "@/dialect/dialect.js"
import { postgresDdlSql } from "@/dialect/dialect-postgres.js"
import type { MigrationStep } from "@/migrator/types.js"

const live = (query: string | null): ViewShape => ({
  stored: { query },
  desired: { query }
})

const storedOnly = (query: string | null): ViewShape => ({
  stored: { query },
  desired: null
})

const desiredOnly = (query: string | null): ViewShape => ({
  stored: null,
  desired: { query }
})

const views = (...entries: ReadonlyArray<readonly [string, ViewShape]>) =>
  new Map<string, ViewShape>(entries)

const plan = (
  steps: ReadonlyArray<MigrationStep>,
  viewMap: ReadonlyMap<string, ViewShape> = new Map()
) =>
  postgresDdlSql.translatePlan(steps, {
    tables: new Map(),
    views: viewMap,
    readonlyQuery: () => Effect.succeed([])
  })

const failureDetail = (
  steps: ReadonlyArray<MigrationStep>,
  viewMap: ReadonlyMap<string, ViewShape> = new Map()
) =>
  plan(steps, viewMap).pipe(
    Effect.catchTag("UnsupportedMigrationStepError", (error) => Effect.succeed(error.detail)),
    Effect.orDie
  )

const dropColumn: MigrationStep = {
  kind: "dropColumn",
  table: "posts",
  column: "draft_notes"
}

describe("postgresDdlSql.translatePlan views", () => {
  it.effect("does nothing view-related when there are no views", () =>
    Effect.gen(function* () {
      const result = yield* plan([dropColumn])
      expect(result.statements).toEqual([
        'ALTER TABLE "posts" DROP COLUMN "draft_notes"'
      ])
      expect(result.notes).toEqual([])
    }))

  it.effect("renders an explicit createView when the view map is empty", () =>
    Effect.gen(function* () {
      const result = yield* plan([
        { kind: "createView", view: "v", query: "SELECT 1" }
      ])
      expect(result.statements).toEqual(['CREATE VIEW "v" AS SELECT 1'])
      expect(result.notes).toEqual(["create view v"])
    }))

  it.effect("renders an explicit dropView when the view map is empty", () =>
    Effect.gen(function* () {
      const result = yield* plan([{ kind: "dropView", view: "v" }])
      expect(result.statements).toEqual(['DROP VIEW IF EXISTS "v"'])
      expect(result.notes).toEqual(["drop view v"])
    }))

  it.effect("drops and recreates a dependent view around a column drop", () =>
    Effect.gen(function* () {
      const result = yield* plan(
        [dropColumn],
        views(["published", live("SELECT id FROM posts")])
      )
      expect(result.statements).toEqual([
        'DROP VIEW IF EXISTS "published"',
        'ALTER TABLE "posts" DROP COLUMN "draft_notes"',
        'CREATE VIEW "published" AS SELECT id FROM posts'
      ])
      expect(result.notes).toEqual(["drop view published", "create view published"])
    }))

  it.effect("drops a transitive chain in one statement and recreates it in order", () =>
    Effect.gen(function* () {
      const result = yield* plan(
        [dropColumn],
        views(
          ["v1", live("SELECT id FROM posts")],
          ["v2", live("SELECT id FROM v1")]
        )
      )
      expect(result.statements[0]).toBe('DROP VIEW IF EXISTS "v1", "v2"')
      expect(result.statements.filter((s) => s.startsWith("CREATE VIEW"))).toEqual([
        'CREATE VIEW "v1" AS SELECT id FROM posts',
        'CREATE VIEW "v2" AS SELECT id FROM v1'
      ])
    }))

  it.effect("orders a changed view's new dependency before the changed view", () =>
    Effect.gen(function* () {
      const result = yield* plan(
        [
          dropColumn,
          { kind: "dropView", view: "v1" },
          { kind: "createView", view: "v1", query: "SELECT id FROM v2" }
        ],
        views(
          ["v1", { stored: { query: "SELECT id FROM posts" }, desired: { query: "SELECT id FROM v2" } }],
          ["v2", live("SELECT id FROM posts")]
        )
      )
      expect(result.statements.filter((s) => s.startsWith("CREATE VIEW"))).toEqual([
        'CREATE VIEW "v2" AS SELECT id FROM posts',
        'CREATE VIEW "v1" AS SELECT id FROM v2'
      ])
    }))

  it.effect("does not duplicate a changed view and its dependent", () =>
    Effect.gen(function* () {
      const result = yield* plan(
        [
          dropColumn,
          { kind: "dropView", view: "v1" },
          { kind: "createView", view: "v1", query: "SELECT id FROM posts WHERE id IS NOT NULL" }
        ],
        views(
          ["v1", { stored: { query: "SELECT id FROM posts" }, desired: { query: "SELECT id FROM posts WHERE id IS NOT NULL" } }],
          ["v2", live("SELECT id FROM v1")]
        )
      )
      expect(result.statements.filter((s) => s.includes('"v1"'))).toHaveLength(2)
      expect(result.statements.filter((s) => s.includes('"v2"'))).toHaveLength(2)
    }))

  it.effect("drops an orphaned view and does not recreate it", () =>
    Effect.gen(function* () {
      const result = yield* plan(
        [dropColumn, { kind: "dropView", view: "old" }],
        views(["old", storedOnly("SELECT id FROM posts")])
      )
      expect(result.statements[0]).toBe('DROP VIEW IF EXISTS "old"')
      expect(result.statements.some((s) => s.startsWith("CREATE VIEW"))).toBe(false)
    }))

  it.effect("creates a new view after the table change", () =>
    Effect.gen(function* () {
      const result = yield* plan(
        [dropColumn, { kind: "createView", view: "new", query: "SELECT id FROM posts" }],
        views(["new", desiredOnly("SELECT id FROM posts")])
      )
      expect(result.statements).toEqual([
        'ALTER TABLE "posts" DROP COLUMN "draft_notes"',
        'CREATE VIEW "new" AS SELECT id FROM posts'
      ])
    }))

  it.effect("leaves an unrelated view untouched", () =>
    Effect.gen(function* () {
      const result = yield* plan(
        [dropColumn],
        views(["other", live("SELECT id FROM elsewhere")])
      )
      expect(result.statements).toEqual([
        'ALTER TABLE "posts" DROP COLUMN "draft_notes"'
      ])
    }))

  it.effect("drops a view before a table drop and recreates it afterward", () =>
    Effect.gen(function* () {
      const result = yield* plan(
        [{ kind: "dropTable", table: "posts" }],
        views(["published", live("SELECT id FROM posts")])
      )
      expect(result.statements).toEqual([
        'DROP VIEW IF EXISTS "published"',
        'DROP TABLE IF EXISTS "posts"',
        'CREATE VIEW "published" AS SELECT id FROM posts'
      ])
    }))

  it.effect("normalizes a mixed-case table and view", () =>
    Effect.gen(function* () {
      const result = yield* plan(
        [{ kind: "dropColumn", table: "Posts", column: "draft_notes" }],
        views(["Published", live('SELECT id FROM "Posts"')])
      )
      expect(result.statements).toEqual([
        'DROP VIEW IF EXISTS "Published"',
        'ALTER TABLE "Posts" DROP COLUMN "draft_notes"',
        'CREATE VIEW "Published" AS SELECT id FROM "Posts"'
      ])
    }))

  it.effect("rejects a desired view with a null query", () =>
    Effect.gen(function* () {
      const detail = yield* failureDetail(
        [],
        views(["v1", desiredOnly(null)])
      )
      expect(detail).toBe('desired view "v1" has no x-view-query')
    }))

  it.effect("rejects an explicit createView with a blank query", () =>
    Effect.gen(function* () {
      const detail = yield* failureDetail([
        { kind: "createView", view: "v", query: "   " }
      ])
      expect(detail).toBe('createView "v" has no query')
    }))

  it.effect("rejects a stored view with a null query when a destructive change is present", () =>
    Effect.gen(function* () {
      const detail = yield* failureDetail(
        [dropColumn],
        views([
          "v1",
          { stored: { query: null }, desired: { query: "SELECT id FROM posts" } }
        ])
      )
      expect(detail).toBe('stored view "v1" has no x-view-query')
    }))

  it.effect("allows an explicitly dropped stored view with a null query", () =>
    Effect.gen(function* () {
      const result = yield* plan(
        [dropColumn, { kind: "dropView", view: "v1" }],
        views([
          "v1",
          { stored: { query: null }, desired: { query: "SELECT id FROM posts" } }
        ])
      )
      expect(result.statements).toEqual([
        'DROP VIEW IF EXISTS "v1"',
        'ALTER TABLE "posts" DROP COLUMN "draft_notes"',
        'CREATE VIEW "v1" AS SELECT id FROM posts'
      ])
    }))

  it.effect("rejects an overlong synthesized dependent view name", () =>
    Effect.gen(function* () {
      const name = "v".repeat(64)
      const detail = yield* failureDetail(
        [dropColumn],
        views([name, live("SELECT id FROM posts")])
      )
      expect(detail).toContain("PostgreSQL identifiers must be at most 63 bytes")
    }))
})
