import { describe, it } from "@effect/vitest"
import { Data, Effect } from "effect"
import { SqlError } from "effect/sql"
import { expect } from "vitest"

import type { TranslatePlanContext, ViewShape } from "@/dialect/dialect.js"
import { sqliteDialect } from "@/dialect/dialect-sqlite.js"
import type {
  ColumnDef,
  MigrationStep,
  TableShape,
  TableShapes
} from "@/migrator/types.js"

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

const shape = (columns: Array<ColumnDef>, indexes: TableShape["indexes"] = []): TableShape => ({
  columns,
  indexes
})

const context = (
  stored: TableShape | null,
  desired: TableShape,
  rows: ReadonlyArray<Record<string, unknown>> = []
): TranslatePlanContext => ({
  tables: new Map([["todos", { stored, desired }]]),
  views: new Map(),
  readonlyQuery: () => Effect.succeed(rows)
})

const planContext = (
  tables: ReadonlyMap<string, TableShapes>,
  views: ReadonlyMap<string, ViewShape> = new Map(),
  rows: ReadonlyArray<Record<string, unknown>> = []
): TranslatePlanContext => ({
  tables,
  views,
  readonlyQuery: () => Effect.succeed(rows)
})

const viewsOf = (
  entries: ReadonlyArray<readonly [string, ViewShape]>
): ReadonlyMap<string, ViewShape> => new Map(entries)

const catalogRow = (
  name: string,
  sql: string | null,
  tblName: string,
  type: string
): Record<string, unknown> => ({ name, sql, tbl_name: tblName, type })

/** A render that was expected to fail preflight but succeeded. */
class PreflightSucceededError extends Data.TaggedError("PreflightSucceededError")<{
  readonly statements: number
}> {}

const failureOf = (steps: ReadonlyArray<MigrationStep>, ctx: TranslatePlanContext) =>
  sqliteDialect.translatePlan(steps, ctx).pipe(
    Effect.flatMap((plan) => new PreflightSucceededError({ statements: plan.statements.length })),
    Effect.catchTag("UnsupportedMigrationStepError", (error) =>
      Effect.succeed({ step: error.step, detail: error.detail })
    ),
    Effect.orDie
  )

const relaxCategory: MigrationStep = {
  kind: "alterColumn",
  table: "todos",
  from: category,
  to: categoryNullable
}

describe("sqliteDialect.translatePlan", () => {
  it.effect("rebuilds a table when a column changes", () =>
    Effect.gen(function* () {
      const stored = shape([seqId, id, title, category], [{ fields: ["category"], unique: false }])
      const desired = shape([seqId, id, title, categoryNullable], [{ fields: ["category"], unique: false }])

      const { statements, cleanup } = yield* sqliteDialect.translatePlan(
        [relaxCategory],
        context(stored, desired)
      )

      expect(statements[0]).toContain('CREATE TABLE "_mira_rebuild_todos"')
      expect(statements[0]).toContain('"category" TEXT')
      expect(statements[0]).not.toContain('"category" TEXT NOT NULL')
      expect(statements[0]).toContain('"seqId" INTEGER PRIMARY KEY AUTOINCREMENT')
      expect(statements[1]).toBe(
        'INSERT INTO "_mira_rebuild_todos" ("seqId", "id", "title", "category") SELECT "seqId", "id", "title", "category" FROM "todos"'
      )
      expect(statements[2]).toBe('DELETE FROM "sqlite_sequence" WHERE "name" = \'_mira_rebuild_todos\'')
      expect(statements[3]).toBe(
        'UPDATE "sqlite_sequence" SET "name" = \'_mira_rebuild_todos\' WHERE "name" = \'todos\''
      )
      expect(statements[4]).toBe('DROP TABLE "todos"')
      expect(statements[5]).toContain('CREATE TABLE "todos"')
      expect(statements[5]).toContain('"category" TEXT')
      expect(statements[6]).toBe(
        'INSERT INTO "todos" ("seqId", "id", "title", "category") SELECT "seqId", "id", "title", "category" FROM "_mira_rebuild_todos"'
      )
      expect(statements[7]).toBe('DELETE FROM "sqlite_sequence" WHERE "name" = \'todos\'')
      expect(statements[8]).toBe(
        'UPDATE "sqlite_sequence" SET "name" = \'todos\' WHERE "name" = \'_mira_rebuild_todos\''
      )
      expect(statements[9]).toBe('DROP TABLE "_mira_rebuild_todos"')
      expect(statements[10]).toBe('CREATE INDEX "idx_todos_category" ON "todos" ("category")')
      expect(cleanup).toEqual([])

      // Every rendered statement must contain SQL: a comment-only one cannot be prepared.
      for (const statement of statements) {
        expect(statement.trim().startsWith("--")).toBe(false)
      }
    }))

  it.effect("coalesces every column and index step of a rebuilt table into one rebuild", () =>
    Effect.gen(function* () {
      const note: ColumnDef = { name: "note", type: "text", nullable: true }
      const extra: ColumnDef = { name: "extra", type: "text", nullable: true }
      const stored = shape([seqId, id, title, category, note], [{ fields: ["note"], unique: false }])
      const desired = shape([seqId, id, title, categoryNullable, extra], [
        { fields: ["extra"], unique: false }
      ])
      const steps: Array<MigrationStep> = [
        { kind: "addColumn", table: "todos", column: extra },
        relaxCategory,
        { kind: "dropColumn", table: "todos", column: "note" },
        { kind: "dropIndex", table: "todos", fields: ["note"], unique: false },
        { kind: "createIndex", table: "todos", fields: ["extra"], unique: false }
      ]

      const { statements } = yield* sqliteDialect.translatePlan(steps, context(stored, desired))

      expect(statements.filter((s) => s.startsWith('CREATE TABLE "_mira_rebuild_todos"'))).toHaveLength(1)
      expect(statements.some((s) => s.includes("ADD COLUMN"))).toBe(false)
      expect(statements.some((s) => s.includes("DROP COLUMN"))).toBe(false)
      expect(statements.some((s) => s.includes("DROP INDEX"))).toBe(false)
      expect(statements.filter((s) => s.startsWith("CREATE INDEX"))).toEqual([
        'CREATE INDEX "idx_todos_extra" ON "todos" ("extra")'
      ])
      expect(statements).toContain(
        'INSERT INTO "_mira_rebuild_todos" ("seqId", "id", "title", "category") SELECT "seqId", "id", "title", "category" FROM "todos"'
      )
    }))

  it.effect("folds a default into the copy when a column becomes NOT NULL", () =>
    Effect.gen(function* () {
      const required: ColumnDef = {
        name: "category",
        type: "text",
        nullable: false,
        default: "fallback"
      }
      const stored = shape([seqId, id, title, categoryNullable])
      const desired = shape([seqId, id, title, required])

      const { statements } = yield* sqliteDialect.translatePlan(
        [{ kind: "alterColumn", table: "todos", from: categoryNullable, to: required }],
        context(stored, desired)
      )

      expect(statements.find((s) => s.startsWith("INSERT INTO"))).toContain(
        `COALESCE("category", 'fallback')`
      )
    }))

  it.effect("maps additive steps one-to-one and needs no cleanup", () =>
    Effect.gen(function* () {
      const extra: ColumnDef = { name: "extra", type: "text", nullable: true }
      const steps: Array<MigrationStep> = [
        { kind: "addColumn", table: "todos", column: extra },
        { kind: "createIndex", table: "todos", fields: ["extra"], unique: false }
      ]

      const { statements, cleanup } = yield* sqliteDialect.translatePlan(
        steps,
        context(null, shape([]))
      )

      expect(statements).toEqual([
        'ALTER TABLE "todos" ADD COLUMN "extra" TEXT',
        'CREATE INDEX "idx_todos_extra" ON "todos" ("extra")'
      ])
      expect(cleanup).toEqual([])
    }))

  it.effect("fails when a column change carries no stored shape", () =>
    Effect.gen(function* () {
      const detail = yield* sqliteDialect.translatePlan([relaxCategory], {
        tables: new Map(),
        views: new Map(),
        readonlyQuery: () => Effect.succeed([])
      }).pipe(
        Effect.catchTag("UnsupportedMigrationStepError", (error) => Effect.succeed(error.detail)),
        Effect.orDie
      )
      expect(detail).toContain("no stored shape")
    }))

  it("has no standalone rendering for alterColumn — the rebuild owns it", () => {
    expect(sqliteDialect.translate(relaxCategory)).toEqual([])
  })

  it.effect("adds the same synthetic default as ADD COLUMN for a new NOT NULL column", () =>
    Effect.gen(function* () {
      const extra: ColumnDef = { name: "extra", type: "text", nullable: false }
      const stored = shape([seqId, id, title, category])
      const desired = shape([seqId, id, title, category, extra])
      const steps: Array<MigrationStep> = [
        { kind: "addColumn", table: "todos", column: extra },
        relaxCategory
      ]

      const { statements } = yield* sqliteDialect.translatePlan(steps, context(stored, desired))
      const creates = statements.filter((statement) => statement.startsWith('CREATE TABLE "'))

      expect(creates).toHaveLength(2)
      for (const statement of creates) {
        expect(statement).toContain('"extra" TEXT NOT NULL DEFAULT \'\'')
      }
      expect(statements.some((statement) => statement.includes("DROP TABLE IF EXISTS"))).toBe(false)
    }))

  it.effect("rejects a new column that is the only field of a unique index", () =>
    Effect.gen(function* () {
      const extra: ColumnDef = { name: "code", type: "text", nullable: false }
      const stored = shape([seqId, id, title, category])
      const desired = shape([seqId, id, title, category, extra], [
        { fields: ["code"], unique: true }
      ])
      const steps: Array<MigrationStep> = [
        { kind: "addColumn", table: "todos", column: extra },
        { kind: "createIndex", table: "todos", fields: ["code"], unique: true }
      ]

      const error = yield* failureOf(steps, context(stored, desired))
      expect(error.step).toBe("addColumn")
      expect(error.detail).toContain("unique index")
    }))

  it.effect("allows a new column in a composite unique index", () =>
    Effect.gen(function* () {
      const extra: ColumnDef = { name: "code", type: "text", nullable: false }
      const stored = shape([seqId, id, title, category])
      const desired = shape([seqId, id, title, category, extra], [
        { fields: ["code", "title"], unique: true }
      ])
      const steps: Array<MigrationStep> = [
        { kind: "addColumn", table: "todos", column: extra },
        { kind: "createIndex", table: "todos", fields: ["code", "title"], unique: true }
      ]

      const { statements } = yield* sqliteDialect.translatePlan(steps, context(stored, desired))
      expect(statements.some((statement) => statement.includes("CREATE UNIQUE INDEX"))).toBe(true)
    }))

  it.effect("rejects a type change on a single-field unique column", () =>
    Effect.gen(function* () {
      const storedCode: ColumnDef = { name: "title", type: "text", nullable: false }
      const desiredCode: ColumnDef = { name: "title", type: "integer", nullable: false }
      const stored = shape([seqId, id, storedCode, category], [{ fields: ["title"], unique: true }])
      const desired = shape([seqId, id, desiredCode, category], [{ fields: ["title"], unique: true }])
      const steps: Array<MigrationStep> = [
        { kind: "alterColumn", table: "todos", from: storedCode, to: desiredCode }
      ]

      const error = yield* failureOf(steps, context(stored, desired))
      expect(error.step).toBe("alterColumn")
      expect(error.detail).toContain("unique index")
    }))

  describe("catalog scan", () => {
    const dropTitle: MigrationStep = { kind: "dropColumn", table: "todos", column: "title" }
    const storedWithTitle = shape([seqId, id, title, category])
    const desiredWithoutTitle = shape([seqId, id, categoryNullable])

    it.effect("fails when a rebuild-subsumed drop would break an untracked view", () =>
      Effect.gen(function* () {
        const rows = [
          catalogRow(
            "untracked_view",
            'CREATE VIEW "untracked_view" AS SELECT id FROM todos',
            "untracked_view",
            "view"
          )
        ]
        const error = yield* failureOf(
          [relaxCategory, dropTitle],
          context(storedWithTitle, desiredWithoutTitle, rows)
        )
        expect(error.step).toBe("dropColumn")
        expect(error.detail).toBe(
          'untracked views: "untracked_view" depends on rebuilt table "todos"; they would be left broken. Track each view in Mira, or remove or rename it before migrating.'
        )
      }))

    it.effect("notes an untracked view that may fail a native drop", () =>
      Effect.gen(function* () {
        const rows = [
          catalogRow(
            "untracked_view",
            'CREATE VIEW "untracked_view" AS SELECT id FROM todos',
            "untracked_view",
            "view"
          )
        ]
        const result = yield* sqliteDialect.translatePlan(
          [dropTitle],
          context(storedWithTitle, shape([seqId, id, category]), rows)
        )
        expect(result.statements).toEqual(['ALTER TABLE "todos" DROP COLUMN "title"'])
        expect(result.notes).toEqual([
          'untracked view "untracked_view" may fail this native drop at execution if it reads the dropped column'
        ])
        expect(result.validations).toEqual(['SELECT 1 FROM "untracked_view" LIMIT 0'])
      }))

    it.effect("notes an untracked dependent of a synthesized recreation", () =>
      Effect.gen(function* () {
        const views = viewsOf([
          [
            "todos_view",
            {
              stored: { query: "SELECT id FROM todos" },
              desired: {
                query: "SELECT id FROM todos WHERE id IS NOT NULL",
                properties: ["id"]
              }
            }
          ]
        ])
        const rows = [
          catalogRow(
            "dependent_view",
            'CREATE VIEW "dependent_view" AS SELECT id FROM todos_view',
            "dependent_view",
            "view"
          )
        ]
        const result = yield* sqliteDialect.translatePlan(
          [dropTitle],
          planContext(
            new Map([["todos", { stored: storedWithTitle, desired: desiredWithoutTitle }]]),
            views,
            rows
          )
        )
        expect(result.notes).toContain(
          'untracked view "dependent_view" depends on recreated view "todos_view"; a probe verifies it inside the migration'
        )
        expect(result.validations).toContain('SELECT 1 FROM "dependent_view" LIMIT 0')
      }))

    it.effect("notes an untracked dependent of an explicit view edit", () =>
      Effect.gen(function* () {
        const views = viewsOf([
          [
            "edited_view",
            {
              stored: { query: "SELECT id FROM todos" },
              desired: {
                query: "SELECT id FROM todos WHERE id IS NOT NULL",
                properties: ["id"]
              }
            }
          ]
        ])
        const rows = [
          catalogRow(
            "dependent_view",
            'CREATE VIEW "dependent_view" AS SELECT id FROM edited_view',
            "dependent_view",
            "view"
          )
        ]
        const result = yield* sqliteDialect.translatePlan(
          [
            { kind: "dropView", view: "edited_view" },
            {
              kind: "createView",
              view: "edited_view",
              query: "SELECT id FROM todos WHERE id IS NOT NULL"
            }
          ],
          planContext(new Map(), views, rows)
        )
        expect(result.statements).toEqual([
          'DROP VIEW IF EXISTS "edited_view"',
          'CREATE VIEW IF NOT EXISTS "edited_view" AS SELECT id FROM todos WHERE id IS NOT NULL'
        ])
        expect(result.notes).toEqual([
          'untracked view "dependent_view" depends on recreated view "edited_view"; a probe verifies it inside the migration'
        ])
        expect(result.validations).toEqual(['SELECT 1 FROM "dependent_view" LIMIT 0'])
      }))

    it.effect("notes a trigger removed with a dropped table", () =>
      Effect.gen(function* () {
        const rows = [
          catalogRow(
            "todos_trigger",
            "CREATE TRIGGER todos_trigger BEFORE INSERT ON todos FOR EACH ROW BEGIN SELECT 1; END",
            "todos",
            "trigger"
          )
        ]
        const result = yield* sqliteDialect.translatePlan(
          [{ kind: "dropTable", table: "todos" }],
          planContext(new Map(), new Map(), rows)
        )
        expect(result.notes).toEqual(['dropping table "todos" also removes trigger "todos_trigger"'])
      }))

    it.effect("notes a trigger removed with a removed view", () =>
      Effect.gen(function* () {
        const rows = [
          catalogRow(
            "view_trigger",
            "CREATE TRIGGER view_trigger INSTEAD OF INSERT ON removed_view FOR EACH ROW BEGIN SELECT 1; END",
            "removed_view",
            "trigger"
          )
        ]
        const result = yield* sqliteDialect.translatePlan(
          [{ kind: "dropView", view: "removed_view" }],
          planContext(new Map(), new Map(), rows)
        )
        expect(result.notes).toEqual([
          'dropping view "removed_view" also removes trigger "view_trigger"'
        ])
      }))

    it.effect("ignores a table name that appears only inside a string literal", () =>
      Effect.gen(function* () {
        const rows = [
          catalogRow(
            "literal_view",
            'CREATE VIEW "literal_view" AS SELECT id FROM other WHERE note = \'todos\'',
            "literal_view",
            "view"
          )
        ]
        const result = yield* sqliteDialect.translatePlan(
          [relaxCategory, dropTitle],
          context(storedWithTitle, desiredWithoutTitle, rows)
        )
        expect(result.notes).toBeUndefined()
        expect(result.validations).toBeUndefined()
      }))

    it.effect("fails when a dropped table would break an untracked view", () =>
      Effect.gen(function* () {
        const rows = [
          catalogRow(
            "dependent_view",
            'CREATE VIEW "dependent_view" AS SELECT id FROM todos',
            "dependent_view",
            "view"
          )
        ]
        const error = yield* failureOf(
          [{ kind: "dropTable", table: "todos" }],
          planContext(new Map(), new Map(), rows)
        )
        expect(error.step).toBe("dropTable")
        expect(error.detail).toBe(
          'untracked views: "dependent_view" depends on dropped table "todos"; they would be left broken. Track each view in Mira, or remove or rename it before migrating.'
        )
      }))

    it.effect("fails when a removed view would break an untracked view", () =>
      Effect.gen(function* () {
        const rows = [
          catalogRow(
            "old_view",
            'CREATE VIEW "old_view" AS SELECT id FROM elsewhere',
            "old_view",
            "view"
          ),
          catalogRow(
            "dependent_view",
            'CREATE VIEW "dependent_view" AS SELECT id FROM old_view',
            "dependent_view",
            "view"
          )
        ]
        const error = yield* failureOf(
          [{ kind: "dropView", view: "old_view" }],
          planContext(new Map(), new Map(), rows)
        )
        expect(error.step).toBe("dropView")
        expect(error.detail).toBe(
          'untracked views: "dependent_view" depends on dropped view "old_view"; they would be left broken. Track each view in Mira, or remove or rename it before migrating.'
        )
      }))

    it.effect("fails for a tracked dependent of a dropped table", () =>
      Effect.gen(function* () {
        const views = viewsOf([
          [
            "todos_view",
            {
              stored: { query: "SELECT id FROM todos" },
              desired: { query: "SELECT id FROM todos" }
            }
          ]
        ])
        const error = yield* failureOf(
          [{ kind: "dropTable", table: "todos" }],
          planContext(new Map(), views)
        )
        expect(error.step).toBe("dropTable")
        expect(error.detail).toBe(
          'tracked view "todos_view" depends on dropped table "todos" and is neither recreated nor dropped; Mira would leave it broken. Remove the view collection, or recreate or drop it in this plan.'
        )
      }))

    it.effect("fails for a trigger on a recreated view", () =>
      Effect.gen(function* () {
        const views = viewsOf([
          [
            "todos_view",
            {
              stored: { query: "SELECT id FROM todos" },
              desired: {
                query: "SELECT id FROM todos WHERE id IS NOT NULL",
                properties: ["id"]
              }
            }
          ]
        ])
        const rows = [
          catalogRow(
            "todos_trigger",
            "CREATE TRIGGER todos_trigger INSTEAD OF UPDATE ON todos_view FOR EACH ROW BEGIN SELECT 1; END",
            "todos_view",
            "trigger"
          )
        ]
        const error = yield* failureOf(
          [
            { kind: "dropView", view: "todos_view" },
            {
              kind: "createView",
              view: "todos_view",
              query: "SELECT id FROM todos WHERE id IS NOT NULL"
            }
          ],
          planContext(new Map(), views, rows)
        )
        expect(error.step).toBe("dropView")
        expect(error.detail).toBe(
          'view "todos_view" has trigger "todos_trigger"; SQLite allows only INSTEAD OF triggers on views and Mira cannot recreate them. Remove the trigger or migrate the view by hand.'
        )
      }))

    it.effect("fails for a trigger on a rebuilt table with a mixed-case tbl_name", () =>
      Effect.gen(function* () {
        const rows = [
          catalogRow(
            "case_trigger",
            "CREATE TRIGGER case_trigger BEFORE INSERT ON TODOS FOR EACH ROW BEGIN SELECT 1; END",
            "TODOS",
            "trigger"
          )
        ]
        const error = yield* failureOf(
          [relaxCategory],
          context(storedWithTitle, shape([seqId, id, title, categoryNullable]), rows)
        )
        expect(error.step).toBe("alterColumn")
        expect(error.detail.toLowerCase()).toContain(
          'table "todos" has trigger "case_trigger"'
        )
        expect(error.detail).toContain("the rebuild would drop it")
      }))

    it.effect("fails for a recreated view with an explicit column list", () =>
      Effect.gen(function* () {
        const views = viewsOf([
          [
            "v",
            {
              stored: { query: "SELECT id, title FROM todos" },
              desired: { query: "SELECT id, title FROM todos" }
            }
          ]
        ])
        const rows = [
          catalogRow(
            "v",
            'CREATE VIEW "v" ("a", "b") AS SELECT id, title FROM todos',
            "v",
            "view"
          )
        ]
        const error = yield* failureOf(
          [
            { kind: "dropView", view: "v" },
            { kind: "createView", view: "v", query: "SELECT id, title FROM todos" }
          ],
          planContext(new Map(), views, rows)
        )
        expect(error.step).toBe("dropView")
        expect(error.detail).toBe(
          'stored view "v" declares an explicit column list; Mira recreates views from x-view-query only. Remove the column list or migrate the view by hand.'
        )
      }))

    it.effect("allows a recreated view without an explicit column list", () =>
      Effect.gen(function* () {
        const views = viewsOf([
          [
            "v",
            {
              stored: { query: "SELECT id, title FROM todos" },
              desired: { query: "SELECT id, title FROM todos" }
            }
          ]
        ])
        const rows = [
          catalogRow(
            "v",
            'CREATE VIEW "v" AS SELECT id, title FROM todos',
            "v",
            "view"
          )
        ]
        const result = yield* sqliteDialect.translatePlan(
          [
            { kind: "dropView", view: "v" },
            { kind: "createView", view: "v", query: "SELECT id, title FROM todos" }
          ],
          planContext(new Map(), views, rows)
        )
        expect(result.statements).toEqual([
          'DROP VIEW IF EXISTS "v"',
          'CREATE VIEW IF NOT EXISTS "v" AS SELECT id, title FROM todos'
        ])
        expect(result.notes).toBeUndefined()
      }))

    it.effect("fails when a createView name already exists as another object type", () =>
      Effect.gen(function* () {
        const rows = [
          catalogRow(
            "todos_view",
            'CREATE TABLE "todos_view" ("id" TEXT)',
            "todos_view",
            "table"
          )
        ]
        const error = yield* failureOf(
          [{ kind: "createView", view: "todos_view", query: "SELECT id FROM todos" }],
          planContext(new Map(), new Map(), rows)
        )
        expect(error.step).toBe("createView")
        expect(error.detail).toBe(
          'an object named "todos_view" already exists and is not tracked; CREATE VIEW IF NOT EXISTS would not apply the desired query. Remove or rename the object, or track it in Mira.'
        )
      }))

    it.effect("fails when a createView collides after case folding", () =>
      Effect.gen(function* () {
        const rows = [
          catalogRow("V", 'CREATE TABLE "V" ("id" TEXT)', "V", "table")
        ]
        const error = yield* failureOf(
          [{ kind: "createView", view: "v", query: "SELECT 1" }],
          planContext(new Map(), new Map(), rows)
        )
        expect(error.step).toBe("createView")
        expect(error.detail.toLowerCase()).toContain('an object named "v" already exists')
      }))

    it.effect("does not flag an untracked view the plan explicitly drops", () =>
      Effect.gen(function* () {
        const rows = [
          catalogRow(
            "old_view",
            'CREATE VIEW "old_view" AS SELECT id FROM todos',
            "old_view",
            "view"
          )
        ]
        const result = yield* sqliteDialect.translatePlan(
          [{ kind: "dropView", view: "old_view" }],
          planContext(new Map(), new Map(), rows)
        )
        expect(result.statements).toEqual(['DROP VIEW IF EXISTS "old_view"'])
        expect(result.notes).toBeUndefined()
        expect(result.validations).toBeUndefined()
      }))

    it.effect("surfaces a failed catalog read as an SqlError", () =>
      Effect.gen(function* () {
        const catalogFailure = new SqlError.SqlError({
          reason: new SqlError.UnknownError({
            cause: undefined,
            message: "catalog unavailable"
          })
        })
        const ctx: TranslatePlanContext = {
          tables: new Map(),
          views: new Map(),
          readonlyQuery: () => Effect.fail(catalogFailure)
        }
        const error = yield* sqliteDialect
          .translatePlan([{ kind: "dropTable", table: "todos" }], ctx)
          .pipe(Effect.flip)
        expect(error._tag).toBe("SqlError")
      }))

    it.effect("never calls readonlyQuery for a plan without a gated step", () =>
      Effect.gen(function* () {
        let calls = 0
        const extra: ColumnDef = { name: "category", type: "text", nullable: true }
        const ctx: TranslatePlanContext = {
          tables: new Map([
            ["todos", { stored: shape([seqId, id, title]), desired: shape([seqId, id, title, extra]) }]
          ]),
          views: new Map(),
          readonlyQuery: () => {
            calls += 1
            return Effect.succeed([])
          }
        }
        const result = yield* sqliteDialect.translatePlan(
          [
            { kind: "addColumn", table: "todos", column: extra },
            { kind: "createIndex", table: "todos", fields: ["category"], unique: false }
          ],
          ctx
        )
        expect(result.statements).toHaveLength(2)
        expect(calls).toBe(0)
      }))

    it.effect("classifies each untracked view by its matched object in a mixed plan", () =>
      Effect.gen(function* () {
        const views = viewsOf([
          [
            "todos_view",
            {
              stored: { query: "SELECT id FROM todos" },
              desired: {
                query: "SELECT id FROM todos WHERE id IS NOT NULL",
                properties: ["id"]
              }
            }
          ]
        ])
        const rows = [
          catalogRow(
            "a_rebuild_view",
            'CREATE VIEW "a_rebuild_view" AS SELECT id FROM todos',
            "a_rebuild_view",
            "view"
          ),
          catalogRow(
            "b_dropped_view",
            'CREATE VIEW "b_dropped_view" AS SELECT id FROM archived',
            "b_dropped_view",
            "view"
          ),
          catalogRow(
            "c_removed_view",
            'CREATE VIEW "c_removed_view" AS SELECT id FROM old_view',
            "c_removed_view",
            "view"
          ),
          catalogRow(
            "d_native_view",
            'CREATE VIEW "d_native_view" AS SELECT id FROM posts',
            "d_native_view",
            "view"
          ),
          catalogRow(
            "e_recreated_view",
            'CREATE VIEW "e_recreated_view" AS SELECT id FROM todos_view',
            "e_recreated_view",
            "view"
          ),
          catalogRow(
            "old_view",
            'CREATE VIEW "old_view" AS SELECT id FROM elsewhere',
            "old_view",
            "view"
          )
        ]
        const error = yield* failureOf(
          [
            relaxCategory,
            dropTitle,
            { kind: "dropColumn", table: "posts", column: "draft_notes" },
            { kind: "dropTable", table: "archived" },
            { kind: "dropView", view: "old_view" }
          ],
          planContext(
            new Map([["todos", { stored: storedWithTitle, desired: desiredWithoutTitle }]]),
            views,
            rows
          )
        )
        expect(error.step).toBe("dropColumn")
        expect(error.detail).toBe(
          'untracked views: "a_rebuild_view" depends on rebuilt table "todos"; "b_dropped_view" depends on dropped table "archived"; "c_removed_view" depends on dropped view "old_view"; they would be left broken. Track each view in Mira, or remove or rename it before migrating.'
        )
        expect(error.detail).not.toContain("d_native_view")
        expect(error.detail).not.toContain("e_recreated_view")
      }))

    it.effect("notes the native and recreated classes in a mixed plan", () =>
      Effect.gen(function* () {
        const views = viewsOf([
          [
            "edited_view",
            {
              stored: { query: "SELECT id FROM elsewhere" },
              desired: {
                query: "SELECT id FROM elsewhere WHERE id IS NOT NULL",
                properties: ["id"]
              }
            }
          ]
        ])
        const rows = [
          catalogRow(
            "native_view",
            'CREATE VIEW "native_view" AS SELECT id FROM posts',
            "native_view",
            "view"
          ),
          catalogRow(
            "recreated_dependent",
            'CREATE VIEW "recreated_dependent" AS SELECT id FROM edited_view',
            "recreated_dependent",
            "view"
          )
        ]
        const result = yield* sqliteDialect.translatePlan(
          [
            { kind: "dropColumn", table: "posts", column: "draft_notes" },
            { kind: "dropView", view: "edited_view" },
            {
              kind: "createView",
              view: "edited_view",
              query: "SELECT id FROM elsewhere WHERE id IS NOT NULL"
            }
          ],
          planContext(new Map(), views, rows)
        )
        expect(result.notes).toContain(
          'untracked view "native_view" may fail this native drop at execution if it reads the dropped column'
        )
        expect(result.notes).toContain(
          'untracked view "recreated_dependent" depends on recreated view "edited_view"; a probe verifies it inside the migration'
        )
        expect(result.validations).toContain('SELECT 1 FROM "native_view" LIMIT 0')
        expect(result.validations).toContain('SELECT 1 FROM "recreated_dependent" LIMIT 0')
      }))

    it.effect("returns the untracked detail before a trigger failure", () =>
      Effect.gen(function* () {
        const views = viewsOf([
          [
            "edited_view",
            {
              stored: { query: "SELECT id FROM elsewhere" },
              desired: {
                query: "SELECT id FROM elsewhere WHERE id IS NOT NULL",
                properties: ["id"]
              }
            }
          ]
        ])
        const rows = [
          catalogRow(
            "untracked_view",
            'CREATE VIEW "untracked_view" AS SELECT id FROM todos',
            "untracked_view",
            "view"
          ),
          catalogRow(
            "edited_trigger",
            "CREATE TRIGGER edited_trigger INSTEAD OF UPDATE ON edited_view FOR EACH ROW BEGIN SELECT 1; END",
            "edited_view",
            "trigger"
          )
        ]
        const error = yield* failureOf(
          [
            relaxCategory,
            dropTitle,
            { kind: "dropView", view: "edited_view" },
            {
              kind: "createView",
              view: "edited_view",
              query: "SELECT id FROM elsewhere WHERE id IS NOT NULL"
            }
          ],
          planContext(
            new Map([["todos", { stored: storedWithTitle, desired: desiredWithoutTitle }]]),
            views,
            rows
          )
        )
        expect(error.step).toBe("dropColumn")
        expect(error.detail).toBe(
          'untracked views: "untracked_view" depends on rebuilt table "todos"; they would be left broken. Track each view in Mira, or remove or rename it before migrating.'
        )
        expect(error.detail).not.toContain("edited_trigger")
      }))
  })
})
