import { describe, expect, it } from "vitest"
import { sqliteDialect } from "@/migrator/dialect-sqlite.js"
import type { MigrationStep } from "@/migrator/types.js"

const dialect = sqliteDialect

describe("sqliteDialect", () => {
  it("CREATE TABLE with columns", () => {
    const step: MigrationStep = {
      kind: "createTable", table: "posts",
      columns: [
        { name: "seqId", type: "integer", nullable: false },
        { name: "title", type: "text", nullable: false },
        { name: "published", type: "boolean", nullable: true, default: false }
      ]
    }
    const sql = dialect.translate(step)
    expect(sql).toHaveLength(1)
    expect(sql[0]).toBe(
      `CREATE TABLE "posts" (\n  "seqId" INTEGER NOT NULL,\n  "title" TEXT NOT NULL,\n  "published" INTEGER DEFAULT 0\n)`
    )
  })

  it("DROP TABLE", () => {
    const sql = dialect.translate({ kind: "dropTable", table: "old_posts" })
    expect(sql).toEqual(['DROP TABLE IF EXISTS "old_posts"'])
  })

  it("RENAME TABLE", () => {
    const sql = dialect.translate({ kind: "renameTable", from: "posts", to: "posts_old" })
    expect(sql).toEqual(['ALTER TABLE "posts" RENAME TO "posts_old"'])
  })

  it("ADD COLUMN", () => {
    const step: MigrationStep = { kind: "addColumn", table: "posts", column: { name: "score", type: "integer", nullable: true, default: 0 } }
    const sql = dialect.translate(step)
    expect(sql).toEqual(['ALTER TABLE "posts" ADD COLUMN "score" INTEGER DEFAULT 0'])
  })

  it("CREATE INDEX non-unique", () => {
    const step: MigrationStep = { kind: "createIndex", table: "posts", fields: ["status"], unique: false }
    const sql = dialect.translate(step)
    expect(sql).toEqual(['CREATE INDEX "idx_posts_status" ON "posts" ("status")'])
  })

  it("CREATE UNIQUE INDEX", () => {
    const step: MigrationStep = { kind: "createIndex", table: "users", fields: ["email"], unique: true }
    const sql = dialect.translate(step)
    expect(sql).toEqual(['CREATE UNIQUE INDEX "idx_users_email" ON "users" ("email")'])
  })

  it("CREATE VIEW", () => {
    const step: MigrationStep = {
      kind: "createView",
      view: "active_posts",
      query: "SELECT id, seqId, title FROM posts WHERE published = 1"
    }
    const sql = dialect.translate(step)
    expect(sql).toEqual([
      `CREATE VIEW IF NOT EXISTS "active_posts" AS SELECT id, seqId, title FROM posts WHERE published = 1`
    ])
  })

  it("DROP VIEW", () => {
    const sql = dialect.translate({ kind: "dropView", view: "active_posts" })
    expect(sql).toEqual([`DROP VIEW IF EXISTS "active_posts"`])
  })

  it("DROP INDEX", () => {
    const step: MigrationStep = { kind: "dropIndex", table: "posts", indexName: "idx_posts_status" }
    const sql = dialect.translate(step)
    expect(sql).toEqual(['DROP INDEX IF EXISTS "idx_posts_status"'])
  })

  it("CREATE TABLE with PRIMARY KEY", () => {
    const step: MigrationStep = {
      kind: "createSystemTable", table: "_collections",
      columns: [
        { name: "name", type: "text", nullable: false, primaryKey: true },
        { name: "schema", type: "text", nullable: false },
        { name: "updated_at", type: "text", nullable: false }
      ]
    }
    const sql = dialect.translate(step)
    expect(sql).toHaveLength(1)
    expect(sql[0]).toContain("CREATE TABLE IF NOT EXISTS")
    expect(sql[0]).toContain('"name" TEXT NOT NULL PRIMARY KEY')
  })

  it("nativeType maps correctly", () => {
    expect(dialect.nativeType({ name: "x", type: "text", nullable: true })).toBe("TEXT")
    expect(dialect.nativeType({ name: "x", type: "integer", nullable: true })).toBe("INTEGER")
    expect(dialect.nativeType({ name: "x", type: "real", nullable: true })).toBe("REAL")
    expect(dialect.nativeType({ name: "x", type: "boolean", nullable: true })).toBe("INTEGER")
  })

  it("quoteLiteral formats correctly", () => {
    expect(dialect.quoteLiteral("hello")).toBe("'hello'")
    expect(dialect.quoteLiteral(42)).toBe("42")
    expect(dialect.quoteLiteral(true)).toBe("1")
    expect(dialect.quoteLiteral(false)).toBe("0")
    expect(dialect.quoteLiteral(null)).toBe("NULL")
    expect(dialect.quoteLiteral("it's")).toBe("'it''s'")
  })
})
