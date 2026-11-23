import { describe, expect, it } from "vitest"

import type { ViewShape } from "@/dialect/dialect.js"
import {
  affectedViews,
  fromJoinReferences,
  normalizeIdentifier,
  topologicalViewOrder,
  viewDeclaresColumnList,
  viewDependencies
} from "@/dialect/view-dependencies.js"

const refs = (query: string) => [...fromJoinReferences(query)].sort()

describe("normalizeIdentifier", () => {
  it("lowercases names for dependency lookups", () => {
    expect(normalizeIdentifier("Posts")).toBe("posts")
  })
})

describe("viewDeclaresColumnList", () => {
  it("detects a plain column list", () => {
    expect(viewDeclaresColumnList("CREATE VIEW v (a, b) AS SELECT 1, 2")).toBe(true)
    expect(viewDeclaresColumnList("CREATE VIEW v AS SELECT 1")).toBe(false)
  })

  it("detects double-quoted, backtick, and bracket names", () => {
    expect(viewDeclaresColumnList('CREATE VIEW "v" ("a", "b") AS SELECT 1, 2')).toBe(true)
    expect(viewDeclaresColumnList("CREATE VIEW `v` (`a`) AS SELECT 1")).toBe(true)
    expect(viewDeclaresColumnList("CREATE VIEW [v] ([a], [b]) AS SELECT 1, 2")).toBe(true)
  })

  it("detects a schema-qualified name", () => {
    expect(viewDeclaresColumnList("CREATE VIEW main.v (a) AS SELECT 1")).toBe(true)
    expect(viewDeclaresColumnList('CREATE VIEW "main"."v" AS SELECT 1')).toBe(false)
  })

  it("skips IF NOT EXISTS and TEMP front matter", () => {
    expect(viewDeclaresColumnList("CREATE VIEW IF NOT EXISTS v (a) AS SELECT 1")).toBe(true)
    expect(viewDeclaresColumnList("CREATE TEMP VIEW v (a) AS SELECT 1")).toBe(true)
    expect(viewDeclaresColumnList("CREATE TEMPORARY VIEW IF NOT EXISTS v AS SELECT 1")).toBe(false)
  })

  it("does not treat a parenthesized query expression as a column list", () => {
    expect(viewDeclaresColumnList("CREATE VIEW v AS SELECT * FROM t WHERE (a = 1)")).toBe(false)
  })

  it("returns false for unparsable front matter", () => {
    expect(viewDeclaresColumnList("SELECT 1")).toBe(false)
    expect(viewDeclaresColumnList("CREATE TABLE v (a)")).toBe(false)
    expect(viewDeclaresColumnList("CREATE VIEW")).toBe(false)
    expect(viewDeclaresColumnList("CREATE OR REPLACE VIEW v (a) AS SELECT 1")).toBe(false)
  })
})

describe("fromJoinReferences", () => {
  it("collects FROM and JOIN targets", () => {
    expect(refs("SELECT id FROM posts p JOIN users u ON p.user_id = u.id")).toEqual([
      "posts",
      "users"
    ])
  })

  it("handles ONLY, schema qualification, and quoted names", () => {
    expect(refs('SELECT id FROM ONLY public."Posts"')).toEqual(["posts"])
  })

  it("collects comma-separated FROM targets", () => {
    expect(refs("SELECT id FROM posts p, users u")).toEqual(["posts", "users"])
  })

  it("collects a direct TABLE body", () => {
    expect(refs("TABLE posts")).toEqual(["posts"])
  })

  it("collects nested subquery targets", () => {
    expect(refs("SELECT id FROM (SELECT id FROM posts) x")).toEqual(["posts"])
    expect(refs("SELECT id FROM a WHERE x IN (SELECT y FROM b)")).toEqual(["a", "b"])
  })

  it("collects a CTE name as a documented false positive", () => {
    expect(refs("WITH ranked AS (SELECT id FROM posts) SELECT * FROM ranked")).toEqual([
      "posts",
      "ranked"
    ])
  })

  it("does not collect ORDER BY or GROUP BY expressions as tables", () => {
    expect(refs("SELECT id FROM posts ORDER BY a, b")).toEqual(["posts"])
    expect(refs("SELECT id FROM posts GROUP BY a, b")).toEqual(["posts"])
  })

  it("ignores comments and strings", () => {
    expect(refs("SELECT id FROM posts -- FROM fake\n WHERE x = 1")).toEqual(["posts"])
    expect(refs("SELECT id FROM posts /* FROM fake */")).toEqual(["posts"])
    expect(refs("SELECT id FROM posts WHERE x = 'FROM fake'")).toEqual(["posts"])
    expect(refs("SELECT id FROM posts WHERE x = E'FROM fake'")).toEqual(["posts"])
    expect(refs("SELECT id FROM posts WHERE x = $$ FROM fake $$")).toEqual(["posts"])
  })

  it("does not collect a parenthesized ONLY target (documented miss)", () => {
    expect(refs("SELECT id FROM ONLY (posts)")).toEqual([])
  })

  it("handles JOIN variants", () => {
    expect(refs("SELECT id FROM a NATURAL JOIN b")).toEqual(["a", "b"])
    expect(refs("SELECT id FROM a CROSS JOIN b")).toEqual(["a", "b"])
    expect(refs("SELECT id FROM a JOIN LATERAL (SELECT id FROM b) x ON true")).toEqual([
      "a",
      "b"
    ])
  })

  it("handles UNION and multiple statements", () => {
    expect(refs("SELECT id FROM a UNION SELECT id FROM b")).toEqual(["a", "b"])
    expect(refs("SELECT id FROM a; SELECT id FROM b")).toEqual(["a", "b"])
  })

  it("ignores aliases and function arguments", () => {
    expect(refs("SELECT id FROM posts AS p")).toEqual(["posts"])
    expect(refs("SELECT id FROM generate_series(1, 2) x")).toEqual(["generate_series"])
  })
})

const view = (stored: string | null, desired: string | null): ViewShape => ({
  stored: stored === null ? null : { query: stored },
  desired: desired === null ? null : { query: desired }
})

describe("viewDependencies", () => {
  it("builds the stored and desired graphs from their own queries", () => {
    const views = new Map<string, ViewShape>([
      ["v1", view("SELECT id FROM posts", "SELECT id FROM v2")],
      ["v2", view("SELECT id FROM posts", "SELECT id FROM posts")]
    ])

    expect([...(viewDependencies(views, "stored").get("v1") ?? [])]).toEqual([])
    expect([...(viewDependencies(views, "desired").get("v1") ?? [])]).toEqual(["v2"])
  })

  it("treats names case-insensitively", () => {
    const views = new Map<string, ViewShape>([
      ["v1", view('SELECT id FROM "Posts"', 'SELECT id FROM "Posts"')]
    ])
    expect([...(viewDependencies(views, "stored").get("v1") ?? [])]).toEqual([])
  })
})

describe("affectedViews", () => {
  it("includes direct and transitive dependents", () => {
    const views = new Map<string, ViewShape>([
      ["v1", view("SELECT id FROM posts", "SELECT id FROM posts")],
      ["v2", view("SELECT id FROM v1", "SELECT id FROM v1")],
      ["v3", view("SELECT id FROM other", "SELECT id FROM other")]
    ])

    expect([...affectedViews(views, new Set(), new Set(["posts"]))].sort()).toEqual([
      "v1",
      "v2"
    ])
  })

  it("normalizes a mixed-case table and view reference", () => {
    const views = new Map<string, ViewShape>([
      ["Published", view('SELECT id FROM "Posts"', 'SELECT id FROM "Posts"')]
    ])

    expect([...affectedViews(views, new Set(), new Set(["Posts"]))]).toEqual([
      "published"
    ])
  })

  it("includes explicitly dropped views even when they have no stored query", () => {
    const views = new Map<string, ViewShape>([
      ["old", { stored: null, desired: null }]
    ])

    expect([...affectedViews(views, new Set(["old"]), new Set())]).toEqual(["old"])
  })
})

describe("topologicalViewOrder", () => {
  it("creates dependencies before dependents", () => {
    const order = topologicalViewOrder(
      new Set(["v1", "v2"]),
      new Map([
        ["v1", new Set(["v2"])],
        ["v2", new Set<string>()]
      ])
    )
    expect(order).toEqual(["v2", "v1"])
  })

  it("does not loop on a back edge", () => {
    const order = topologicalViewOrder(
      new Set(["v1", "v2"]),
      new Map([
        ["v1", new Set(["v2"])],
        ["v2", new Set(["v1"])]
      ])
    )
    expect(order.sort()).toEqual(["v1", "v2"])
  })
})
