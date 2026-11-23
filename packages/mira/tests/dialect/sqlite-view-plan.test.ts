import { describe, it } from "@effect/vitest"
import { Data, Effect } from "effect"
import { expect } from "vitest"

import type { TranslatePlanContext, ViewShape } from "@/dialect/dialect.js"
import { sqliteDialect } from "@/dialect/dialect-sqlite.js"
import type { ColumnDef, MigrationStep, TableShape, TableShapes } from "@/migrator/types.js"

const live = (query: string, properties: ReadonlyArray<string> = []): ViewShape => ({
  stored: { query },
  desired: { query, properties }
})

const storedOnly = (query: string): ViewShape => ({
  stored: { query },
  desired: null
})

const desiredOnly = (query: string | null, properties: ReadonlyArray<string> = []): ViewShape => ({
  stored: null,
  desired: { query, properties }
})

const views = (...entries: ReadonlyArray<readonly [string, ViewShape]>) =>
  new Map<string, ViewShape>(entries)

const context = (
  viewMap: ReadonlyMap<string, ViewShape>,
  tables: ReadonlyMap<string, TableShapes> = new Map()
): TranslatePlanContext => ({
  tables,
  views: viewMap,
  readonlyQuery: () => Effect.succeed([])
})

const plan = (
  steps: ReadonlyArray<MigrationStep>,
  viewMap: ReadonlyMap<string, ViewShape> = new Map(),
  tables: ReadonlyMap<string, TableShapes> = new Map()
) => sqliteDialect.translatePlan(steps, context(viewMap, tables))

const failure = (
  steps: ReadonlyArray<MigrationStep>,
  viewMap: ReadonlyMap<string, ViewShape> = new Map(),
  tables: ReadonlyMap<string, TableShapes> = new Map()
) =>
  plan(steps, viewMap, tables).pipe(
    Effect.flatMap((translated) => new PreflightSucceededError({ statements: translated.statements.length })),
    Effect.catchTag("UnsupportedMigrationStepError", (error) =>
      Effect.succeed({ step: error.step, detail: error.detail })
    ),
    Effect.orDie
  )

/** A render that was expected to fail preflight but succeeded. */
class PreflightSucceededError extends Data.TaggedError("PreflightSucceededError")<{
  readonly statements: number
}> {}

const dropColumn: MigrationStep = {
  kind: "dropColumn",
  table: "posts",
  column: "draft_notes"
}

const seqId: ColumnDef = {
  name: "seqId",
  type: "integer",
  nullable: false,
  primaryKey: true,
  autoIncrement: true,
  xSystem: true
}
const id: ColumnDef = { name: "id", type: "text", nullable: false, unique: true, xSystem: true }
const title: ColumnDef = { name: "title", type: "text", nullable: false }
const category: ColumnDef = { name: "category", type: "text", nullable: false }
const categoryNullable: ColumnDef = { name: "category", type: "text", nullable: true }

const shape = (columns: Array<ColumnDef>): TableShape => ({ columns, indexes: [] })
const tableShapes = (stored: TableShape, desired: TableShape): TableShapes => ({ stored, desired })

describe("sqliteDialect.translatePlan view synthesis", () => {
  it.effect("leaves a plan without dropColumn unchanged", () =>
    Effect.gen(function* () {
      const result = yield* plan([
        { kind: "createView", view: "v", query: "SELECT 1" },
        { kind: "dropView", view: "v" }
      ])
      expect(result.statements).toEqual([
        'CREATE VIEW IF NOT EXISTS "v" AS SELECT 1',
        'DROP VIEW IF EXISTS "v"'
      ])
      expect(result.validations).toBeUndefined()
      expect(result.notes).toBeUndefined()
    }))

  it.effect("leaves a dropColumn plan without views unchanged", () =>
    Effect.gen(function* () {
      const result = yield* plan([dropColumn])
      expect(result.statements).toEqual([
        'ALTER TABLE "posts" DROP COLUMN "draft_notes"'
      ])
      expect(result.validations).toBeUndefined()
      expect(result.notes).toBeUndefined()
    }))

  it.effect("drops and recreates a view whose desired query and properties remove the column", () =>
    Effect.gen(function* () {
      const result = yield* plan(
        [dropColumn],
        views([
          "published",
          {
            stored: { query: "SELECT id, draft_notes FROM posts" },
            desired: { query: "SELECT id FROM posts", properties: ["id"] }
          }
        ])
      )
      expect(result.statements).toEqual([
        'DROP VIEW IF EXISTS "published"',
        'ALTER TABLE "posts" DROP COLUMN "draft_notes"',
        'CREATE VIEW IF NOT EXISTS "published" AS SELECT id FROM posts'
      ])
      expect(result.validations).toEqual([
        'SELECT "id", "seqId" FROM "published" LIMIT 0'
      ])
      expect(result.notes).toEqual([
        "drop view published",
        "create view published",
        "validate view published"
      ])
    }))

  it.effect("drops dependents before dependencies and creates dependencies first", () =>
    Effect.gen(function* () {
      const result = yield* plan(
        [dropColumn],
        views(
          ["v1", live("SELECT id FROM posts", ["id"])],
          ["v2", live("SELECT id FROM v1", ["id"])]
        )
      )
      expect(result.statements.filter((s) => s.startsWith("DROP VIEW"))).toEqual([
        'DROP VIEW IF EXISTS "v2"',
        'DROP VIEW IF EXISTS "v1"'
      ])
      expect(result.statements.filter((s) => s.startsWith("CREATE VIEW"))).toEqual([
        'CREATE VIEW IF NOT EXISTS "v1" AS SELECT id FROM posts',
        'CREATE VIEW IF NOT EXISTS "v2" AS SELECT id FROM v1'
      ])
      expect(result.validations).toEqual([
        'SELECT "id", "seqId" FROM "v1" LIMIT 0',
        'SELECT "id", "seqId" FROM "v2" LIMIT 0'
      ])
      expect(result.notes).toEqual([
        "drop view v2",
        "drop view v1",
        "create view v1",
        "create view v2",
        "validate view v1",
        "validate view v2"
      ])
    }))

  it.effect("reverses unrelated drop order but preserves unrelated create order", () =>
    Effect.gen(function* () {
      const result = yield* plan(
        [dropColumn],
        views(
          ["v1", live("SELECT id FROM posts", ["id"])],
          ["v2", live("SELECT id FROM posts", ["id"])]
        )
      )
      expect(result.statements.filter((s) => s.startsWith("DROP VIEW"))).toEqual([
        'DROP VIEW IF EXISTS "v2"',
        'DROP VIEW IF EXISTS "v1"'
      ])
      expect(result.statements.filter((s) => s.startsWith("CREATE VIEW"))).toEqual([
        'CREATE VIEW IF NOT EXISTS "v1" AS SELECT id FROM posts',
        'CREATE VIEW IF NOT EXISTS "v2" AS SELECT id FROM posts'
      ])
    }))

  it.effect("creates a recreated dependency before a new explicit view that reads it", () =>
    Effect.gen(function* () {
      const result = yield* plan(
        [
          dropColumn,
          { kind: "createView", view: "v2", query: "SELECT id FROM v1" }
        ],
        views(["v1", live("SELECT id FROM posts", ["id"])])
      )
      expect(result.statements.filter((s) => s.startsWith("CREATE VIEW"))).toEqual([
        'CREATE VIEW IF NOT EXISTS "v1" AS SELECT id FROM posts',
        'CREATE VIEW IF NOT EXISTS "v2" AS SELECT id FROM v1'
      ])
      expect(result.validations).toEqual([
        'SELECT "id", "seqId" FROM "v1" LIMIT 0',
        'SELECT "seqId" FROM "v2" LIMIT 0'
      ])
    }))

  it.effect("validates declared properties and adds seqId when absent", () =>
    Effect.gen(function* () {
      const result = yield* plan(
        [dropColumn],
        views(["published", live("SELECT id FROM posts", ["id", "title"])])
      )
      expect(result.validations).toEqual([
        'SELECT "id", "title", "seqId" FROM "published" LIMIT 0'
      ])
    }))

  it.effect("uses the seqId probe when the view declares no properties", () =>
    Effect.gen(function* () {
      const result = yield* plan(
        [dropColumn],
        views(["published", live("SELECT id FROM posts")])
      )
      expect(result.validations).toEqual(['SELECT "seqId" FROM "published" LIMIT 0'])
    }))

  it.effect("returns probes in validations, not statements", () =>
    Effect.gen(function* () {
      const result = yield* plan(
        [dropColumn],
        views(["published", live("SELECT id FROM posts", ["id"])])
      )
      expect(result.statements.some((s) => s.includes("LIMIT 0"))).toBe(false)
      expect(result.validations).toHaveLength(1)
    }))

  it.effect("validates hidden declared properties against the admin read", () =>
    Effect.gen(function* () {
      const result = yield* plan(
        [dropColumn],
        views(["published", live("SELECT id FROM posts", ["id", "secret"])])
      )
      expect(result.validations).toEqual([
        'SELECT "id", "secret", "seqId" FROM "published" LIMIT 0'
      ])
    }))

  it.effect("validates an explicit create that directly references the changed table", () =>
    Effect.gen(function* () {
      const result = yield* plan([
        dropColumn,
        { kind: "createView", view: "v2", query: "SELECT draft_notes FROM posts" }
      ])
      expect(result.validations).toEqual(['SELECT "seqId" FROM "v2" LIMIT 0'])
    }))

  it.effect("does not validate an unrelated explicit create", () =>
    Effect.gen(function* () {
      const result = yield* plan([
        dropColumn,
        { kind: "createView", view: "v2", query: "SELECT id FROM elsewhere" }
      ])
      expect(result.validations).toBeUndefined()
    }))

  it.effect("recreates a SELECT * view with updated properties", () =>
    Effect.gen(function* () {
      const result = yield* plan(
        [dropColumn],
        views(["published", live("SELECT * FROM posts", ["id"])])
      )
      expect(result.statements).toContain(
        'CREATE VIEW IF NOT EXISTS "published" AS SELECT * FROM posts'
      )
      expect(result.validations).toEqual([
        'SELECT "id", "seqId" FROM "published" LIMIT 0'
      ])
    }))

  it.effect("leaves an unaffected view untouched", () =>
    Effect.gen(function* () {
      const result = yield* plan(
        [dropColumn],
        views(["other", live("SELECT id FROM elsewhere", ["id"])])
      )
      expect(result.statements).toEqual([
        'ALTER TABLE "posts" DROP COLUMN "draft_notes"'
      ])
      expect(result.validations).toBeUndefined()
      expect(result.notes).toBeUndefined()
    }))

  it.effect("deduplicates an explicit changed view and its dependent", () =>
    Effect.gen(function* () {
      const result = yield* plan(
        [
          dropColumn,
          { kind: "dropView", view: "v1" },
          { kind: "createView", view: "v1", query: "SELECT id FROM posts WHERE id IS NOT NULL" }
        ],
        views(
          [
            "v1",
            {
              stored: { query: "SELECT id FROM posts" },
              desired: { query: "SELECT id FROM posts WHERE id IS NOT NULL", properties: ["id"] }
            }
          ],
          ["v2", live("SELECT id FROM v1", ["id"])]
        )
      )
      expect(result.statements.filter((s) => s.includes('"v1"'))).toHaveLength(2)
      expect(result.statements.filter((s) => s.includes('"v2"'))).toHaveLength(2)
      expect(result.statements.filter((s) => s.startsWith("CREATE VIEW"))).toEqual([
        'CREATE VIEW IF NOT EXISTS "v1" AS SELECT id FROM posts WHERE id IS NOT NULL',
        'CREATE VIEW IF NOT EXISTS "v2" AS SELECT id FROM v1'
      ])
    }))

  it.effect("prefers the desired query over an explicit create query", () =>
    Effect.gen(function* () {
      const result = yield* plan(
        [
          dropColumn,
          { kind: "dropView", view: "v1" },
          { kind: "createView", view: "v1", query: "SELECT id FROM posts" }
        ],
        views([
          "v1",
          {
            stored: { query: "SELECT id FROM posts" },
            desired: { query: "SELECT id FROM posts WHERE id IS NOT NULL", properties: ["id"] }
          }
        ])
      )
      expect(result.statements).toContain(
        'CREATE VIEW IF NOT EXISTS "v1" AS SELECT id FROM posts WHERE id IS NOT NULL'
      )
    }))

  it.effect("drops an explicitly dropped view without recreating it", () =>
    Effect.gen(function* () {
      const result = yield* plan(
        [dropColumn, { kind: "dropView", view: "old" }],
        views(["old", storedOnly("SELECT id FROM posts")])
      )
      expect(result.statements).toContain('DROP VIEW IF EXISTS "old"')
      expect(result.statements.some((s) => s.includes('CREATE VIEW IF NOT EXISTS "old"'))).toBe(
        false
      )
    }))

  it.effect("drops a tracked dependent of an explicitly dropped untracked view", () =>
    Effect.gen(function* () {
      const result = yield* plan(
        [dropColumn, { kind: "dropView", view: "v1" }],
        views(["v2", live("SELECT id FROM v1", ["id"])])
      )
      expect(result.statements.filter((s) => s.startsWith("DROP VIEW"))).toEqual([
        'DROP VIEW IF EXISTS "v2"',
        'DROP VIEW IF EXISTS "v1"'
      ])
      expect(result.statements).toContain(
        'CREATE VIEW IF NOT EXISTS "v2" AS SELECT id FROM v1'
      )
    }))

  it.effect("drops a tracked dependent of an explicitly dropped untracked view with mixed-case names", () =>
    Effect.gen(function* () {
      const result = yield* plan(
        [dropColumn, { kind: "dropView", view: "V1" }],
        views(["V2", live("SELECT id FROM V1", ["id"])])
      )
      expect(result.statements).toContain('DROP VIEW IF EXISTS "V2"')
      expect(result.statements).toContain('DROP VIEW IF EXISTS "V1"')
      expect(result.statements).toContain(
        'CREATE VIEW IF NOT EXISTS "V2" AS SELECT id FROM V1'
      )
    }))

  it.effect("preserves every explicit view step when synthesis is active", () =>
    Effect.gen(function* () {
      const result = yield* plan([
        dropColumn,
        { kind: "dropView", view: "old" },
        { kind: "createView", view: "new", query: "SELECT id FROM elsewhere" }
      ])
      expect(result.statements).toContain('DROP VIEW IF EXISTS "old"')
      expect(result.statements).toContain(
        'CREATE VIEW IF NOT EXISTS "new" AS SELECT id FROM elsewhere'
      )
      expect(result.notes).toEqual(["drop view old", "create view new"])
    }))

  it.effect("drops a view that references the table but not the dropped column", () =>
    Effect.gen(function* () {
      const result = yield* plan(
        [dropColumn],
        views(["published", live("SELECT id FROM posts", ["id"])])
      )
      expect(result.statements).toContain('DROP VIEW IF EXISTS "published"')
      expect(result.statements).toContain(
        'CREATE VIEW IF NOT EXISTS "published" AS SELECT id FROM posts'
      )
      expect(result.validations).toEqual([
        'SELECT "id", "seqId" FROM "published" LIMIT 0'
      ])
    }))

  it.effect("creates and validates a new view after the column drop", () =>
    Effect.gen(function* () {
      const result = yield* plan([
        dropColumn,
        { kind: "createView", view: "v2", query: "SELECT id FROM posts" }
      ])
      expect(result.statements).toContain(
        'CREATE VIEW IF NOT EXISTS "v2" AS SELECT id FROM posts'
      )
      expect(result.validations).toEqual(['SELECT "seqId" FROM "v2" LIMIT 0'])
    }))

  it.effect("fails when an affected desired view has no query", () =>
    Effect.gen(function* () {
      const error = yield* failure(
        [dropColumn],
        views(["v", { stored: { query: "SELECT id FROM posts" }, desired: desiredOnly(null).desired }])
      )
      expect(error.step).toBe("createView")
      expect(error.detail).toBe('desired view "v" has no x-view-query')
    }))

  it.effect("does not fail for an unrelated desired view with no query", () =>
    Effect.gen(function* () {
      const result = yield* plan(
        [dropColumn],
        views(["bad", desiredOnly(null)])
      )
      expect(result.statements).toEqual([
        'ALTER TABLE "posts" DROP COLUMN "draft_notes"'
      ])
    }))

  it.effect("fails when a rebuild-subsumed plan has an unanalyzable stored-side view", () =>
    Effect.gen(function* () {
      const tables = new Map([
        [
          "todos",
          tableShapes(
            shape([seqId, id, title, category]),
            shape([seqId, id, categoryNullable])
          )
        ]
      ])
      const error = yield* failure(
        [
          { kind: "alterColumn", table: "todos", from: category, to: categoryNullable },
          { kind: "dropColumn", table: "todos", column: "title" }
        ],
        views(["v", { stored: { query: null }, desired: { query: "SELECT id FROM todos", properties: ["id"] } }]),
        tables
      )
      expect(error.step).toBe("dropView")
      expect(error.detail).toBe('stored view "v" has no x-view-query')
    }))

  it.effect("fails when a rebuild-subsumed plan has a blank stored-side view query", () =>
    Effect.gen(function* () {
      const tables = new Map([
        [
          "todos",
          tableShapes(
            shape([seqId, id, title, category]),
            shape([seqId, id, categoryNullable])
          )
        ]
      ])
      const error = yield* failure(
        [
          { kind: "alterColumn", table: "todos", from: category, to: categoryNullable },
          { kind: "dropColumn", table: "todos", column: "title" }
        ],
        views(["v", { stored: { query: "   " }, desired: { query: "SELECT id FROM todos", properties: ["id"] } }]),
        tables
      )
      expect(error.step).toBe("dropView")
      expect(error.detail).toBe('stored view "v" has no x-view-query')
    }))

  it.effect("does not fail for an unanalyzable stored-side view in a native-drop plan", () =>
    Effect.gen(function* () {
      const result = yield* plan(
        [dropColumn],
        views(["v", { stored: { query: null }, desired: { query: "SELECT id FROM posts", properties: ["id"] } }])
      )
      expect(result.statements).toEqual([
        'ALTER TABLE "posts" DROP COLUMN "draft_notes"'
      ])
    }))

  it.effect("allows an explicitly dropped stored-side view with no query", () =>
    Effect.gen(function* () {
      const result = yield* plan(
        [dropColumn, { kind: "dropView", view: "v" }],
        views(["v", { stored: { query: null }, desired: null }])
      )
      expect(result.statements).toContain('DROP VIEW IF EXISTS "v"')
    }))

  it.effect("fails when an affected orphan has no explicit dropView", () =>
    Effect.gen(function* () {
      const error = yield* failure(
        [dropColumn],
        views(["v", storedOnly("SELECT id FROM posts")])
      )
      expect(error.step).toBe("dropView")
      expect(error.detail).toBe(
        'removed view "v" has no dropView step; pass allowDestructive: true or add an explicit dropView'
      )
    }))

  it.effect("fails when an explicit createView has a blank query", () =>
    Effect.gen(function* () {
      const error = yield* failure([
        dropColumn,
        { kind: "createView", view: "v", query: "   " }
      ])
      expect(error.step).toBe("createView")
      expect(error.detail).toBe('createView "v" has no query')
    }))

  it.effect("fails when two view names collide after case folding", () =>
    Effect.gen(function* () {
      const error = yield* failure(
        [dropColumn],
        views(
          ["todos_view", live("SELECT id FROM posts", ["id"])],
          ["Todos_View", live("SELECT id FROM posts", ["id"])]
        )
      )
      expect(error.step).toBe("createView")
      expect(error.detail).toContain("collide after case folding")
    }))

  it.effect("fails when duplicate explicit createView steps have different queries", () =>
    Effect.gen(function* () {
      const error = yield* failure([
        dropColumn,
        { kind: "createView", view: "v", query: "SELECT 1" },
        { kind: "createView", view: "v", query: "SELECT 2" }
      ])
      expect(error.step).toBe("createView")
      expect(error.detail).toBe('duplicate createView steps for "v" have different queries')
    }))

  it.effect("drops and recreates views when a dropColumn is subsumed by a rebuild", () =>
    Effect.gen(function* () {
      const tables = new Map([
        [
          "todos",
          tableShapes(
            shape([seqId, id, title, category]),
            shape([seqId, id, categoryNullable])
          )
        ]
      ])
      const result = yield* plan(
        [
          { kind: "alterColumn", table: "todos", from: category, to: categoryNullable },
          { kind: "dropColumn", table: "todos", column: "title" }
        ],
        views(["v", live("SELECT id, title FROM todos", ["id"])]),
        tables
      )
      expect(result.statements[0]).toBe('DROP VIEW IF EXISTS "v"')
      expect(result.statements.some((s) => s.includes('CREATE TABLE "_mira_rebuild_todos"'))).toBe(
        true
      )
      expect(result.statements).toContain(
        'CREATE VIEW IF NOT EXISTS "v" AS SELECT id, title FROM todos'
      )
      expect(result.validations).toEqual(['SELECT "id", "seqId" FROM "v" LIMIT 0'])
    }))

  it.effect("preserves mixed-case raw names and normalizes the validation flag", () =>
    Effect.gen(function* () {
      const result = yield* plan(
        [{ kind: "dropColumn", table: "Posts", column: "draft_notes" }],
        views(["Posts_View", live("SELECT id FROM Posts", ["id"])])
      )
      expect(result.statements).toContain('DROP VIEW IF EXISTS "Posts_View"')
      expect(result.statements).toContain(
        'CREATE VIEW IF NOT EXISTS "Posts_View" AS SELECT id FROM Posts'
      )
      expect(result.validations).toEqual([
        'SELECT "id", "seqId" FROM "Posts_View" LIMIT 0'
      ])
    }))

  it.effect("quotes identifiers with embedded double quotes", () =>
    Effect.gen(function* () {
      const result = yield* plan(
        [dropColumn],
        views(['weird"name', live("SELECT id FROM posts", ['a"b'])])
      )
      expect(result.statements).toContain(
        'DROP VIEW IF EXISTS "weird""name"'
      )
      expect(result.validations).toEqual([
        'SELECT "a""b", "seqId" FROM "weird""name" LIMIT 0'
      ])
    }))

  it.effect("emits notes in execution order", () =>
    Effect.gen(function* () {
      const result = yield* plan(
        [dropColumn],
        views(
          ["v1", live("SELECT id FROM posts", ["id"])],
          ["v2", live("SELECT id FROM v1", ["id"])]
        )
      )
      expect(result.notes).toEqual([
        "drop view v2",
        "drop view v1",
        "create view v1",
        "create view v2",
        "validate view v1",
        "validate view v2"
      ])
    }))
})
