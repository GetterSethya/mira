import { describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { expect } from "vitest"

import type { TranslatePlanContext } from "@/dialect/dialect.js"
import { sqliteDialect } from "@/dialect/dialect-sqlite.js"
import type { ColumnDef, MigrationStep, TableShape } from "@/migrator/types.js"

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

const context = (stored: TableShape | null, desired: TableShape): TranslatePlanContext => ({
  tables: new Map([["todos", { stored, desired }]])
})

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

      expect(statements[0]).toBe("PRAGMA legacy_alter_table = ON")
      expect(statements[1]).toBe('DROP TABLE IF EXISTS "_mira_rebuild_todos"')
      expect(statements[2]).toContain('CREATE TABLE "_mira_rebuild_todos"')
      expect(statements[2]).toContain('"category" TEXT')
      expect(statements[2]).not.toContain('"category" TEXT NOT NULL')
      expect(statements[2]).toContain('"seqId" INTEGER PRIMARY KEY AUTOINCREMENT')
      expect(statements[3]).toBe(
        'INSERT INTO "_mira_rebuild_todos" ("seqId", "id", "title", "category") SELECT "seqId", "id", "title", "category" FROM "todos"'
      )
      expect(statements[4]).toBe('DELETE FROM "sqlite_sequence" WHERE "name" = \'_mira_rebuild_todos\'')
      expect(statements[5]).toBe(
        'UPDATE "sqlite_sequence" SET "name" = \'_mira_rebuild_todos\' WHERE "name" = \'todos\''
      )
      expect(statements[6]).toBe('DROP TABLE "todos"')
      expect(statements[7]).toBe('ALTER TABLE "_mira_rebuild_todos" RENAME TO "todos"')
      expect(statements[8]).toBe('CREATE INDEX "idx_todos_category" ON "todos" ("category")')
      expect(cleanup).toEqual(["PRAGMA legacy_alter_table = OFF"])

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
      const detail = yield* sqliteDialect.translatePlan([relaxCategory], { tables: new Map() }).pipe(
        Effect.catchTag("UnsupportedMigrationStepError", (error) => Effect.succeed(error.detail)),
        Effect.orDie
      )
      expect(detail).toContain("no stored shape")
    }))

  it("has no standalone rendering for alterColumn — the rebuild owns it", () => {
    expect(sqliteDialect.translate(relaxCategory)).toEqual([])
  })
})
