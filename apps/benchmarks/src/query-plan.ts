/**
 * Query-plan probe for the list filter shapes Mira supports.
 *
 *   pnpm --filter mira-benchmarks query-plan
 *
 * Creates a temporary 100k-row SQLite table with single-column indexes and
 * prints `EXPLAIN QUERY PLAN` plus a short median latency for representative
 * filters. This is a diagnostic, not a benchmark gate; it answers whether the
 * `WHERE ... ORDER BY seqId LIMIT` shape can use an index.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { performance } from "node:perf_hooks"

const rows = Number(process.env.QUERY_PLAN_ROWS ?? "100000")
const directory = mkdtempSync(join(tmpdir(), "mira-query-plan-"))
const db = new DatabaseSync(join(directory, "plan.sqlite"))

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = OFF;
  CREATE TABLE posts (
    seqId INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    category TEXT NOT NULL,
    views INTEGER NOT NULL,
    published INTEGER NOT NULL,
    created TEXT NOT NULL,
    updated TEXT NOT NULL
  );
  CREATE INDEX idx_posts_category ON posts(category);
  CREATE INDEX idx_posts_title ON posts(title);
  CREATE INDEX idx_posts_views ON posts(views);
`)

const insert = db.prepare(
  `INSERT INTO posts (id, title, category, views, published, created, updated)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
)
const categories = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"]
const now = new Date().toISOString()
db.exec("BEGIN")
for (let index = 0; index < rows; index += 1) {
  insert.run(
    `id-${index}`,
    `title-${index}`,
    categories[index % categories.length],
    index % 1000,
    index % 2,
    now,
    now
  )
}
db.exec("COMMIT")
db.exec("ANALYZE")

const shapes: ReadonlyArray<{ name: string; sql: string; params: ReadonlyArray<string | number> }> = [
  {
    name: "default (seqId order)",
    sql: `SELECT t."id", t."title", t."category", t."views", t."seqId" FROM "posts" t ORDER BY t."seqId" ASC LIMIT 30`,
    params: []
  },
  {
    name: "eq indexed category",
    sql: `SELECT t."id", t."title", t."category", t."views", t."seqId" FROM "posts" t WHERE t."category" = ? ORDER BY t."seqId" ASC LIMIT 30`,
    params: ["alpha"]
  },
  {
    name: "eq unique title",
    sql: `SELECT t."id", t."title", t."category", t."views", t."seqId" FROM "posts" t WHERE t."title" = ? ORDER BY t."seqId" ASC LIMIT 30`,
    params: ["title-50000"]
  },
  {
    name: "range indexed views",
    sql: `SELECT t."id", t."title", t."category", t."views", t."seqId" FROM "posts" t WHERE t."views" > ? ORDER BY t."seqId" ASC LIMIT 30`,
    params: [900]
  },
  {
    name: "eq non-indexed published",
    sql: `SELECT t."id", t."title", t."category", t."views", t."seqId" FROM "posts" t WHERE t."published" = ? ORDER BY t."seqId" ASC LIMIT 30`,
    params: [1]
  },
  {
    name: "in indexed category",
    sql: `SELECT t."id", t."title", t."category", t."views", t."seqId" FROM "posts" t WHERE t."category" IN (?, ?) ORDER BY t."seqId" ASC LIMIT 30`,
    params: ["alpha", "beta"]
  },
  {
    name: "like prefix title",
    sql: `SELECT t."id", t."title", t."category", t."views", t."seqId" FROM "posts" t WHERE t."title" LIKE ? ORDER BY t."seqId" ASC LIMIT 30`,
    params: ["title-500%"]
  },
  {
    name: "neq title (benchmark shape)",
    sql: `SELECT t."id", t."title", t."category", t."views", t."seqId" FROM "posts" t WHERE t."title" != ? ORDER BY t."seqId" ASC LIMIT 30`,
    params: ["read-0"]
  },
  {
    name: "sort title",
    sql: `SELECT t."id", t."title", t."category", t."views", t."seqId" FROM "posts" t ORDER BY t."title" ASC LIMIT 30`,
    params: []
  },
  {
    name: "filter indexed + sort title",
    sql: `SELECT t."id", t."title", t."category", t."views", t."seqId" FROM "posts" t WHERE t."category" = ? ORDER BY t."title" ASC LIMIT 30`,
    params: ["alpha"]
  },
  {
    name: "cursor + indexed category",
    sql: `SELECT t."id", t."title", t."category", t."views", t."seqId" FROM "posts" t WHERE t."category" = ? AND t."seqId" > ? ORDER BY t."seqId" ASC LIMIT 30`,
    params: ["alpha", 1000]
  }
]

function median(values: ReadonlyArray<number>) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

for (const shape of shapes) {
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${shape.sql}`).all(...shape.params)
  const statement = db.prepare(shape.sql)
  for (let index = 0; index < 20; index += 1) statement.all(...shape.params)
  const samples: Array<number> = []
  for (let index = 0; index < 100; index += 1) {
    const started = performance.now()
    statement.all(...shape.params)
    samples.push(performance.now() - started)
  }
  process.stdout.write(`\n${shape.name}\n`)
  for (const row of plan) {
    const detail =
      typeof row === "object" && row !== null && "detail" in row && typeof row.detail === "string"
        ? row.detail
        : String(row)
    process.stdout.write(`  ${detail}\n`)
  }
  process.stdout.write(`  median ${median(samples).toFixed(3)} ms\n`)
}

db.close()
rmSync(directory, { recursive: true, force: true })
