import { describe, expect, it } from "vitest"

import { rewritePlaceholders } from "@/dialect/dialect.js"
import {
  buildJoins,
  buildSelect,
  renderDelete,
  renderDeleteReturning,
  renderExists,
  renderList,
  renderRuleCheck,
  renderView,
  renderViewWithAccess
} from "@/repository/sql.js"

const quote = (name: string) => `\`${name}\``
const dollar = { placeholder: (index: number) => `$${index}` }

describe("repository SQL rendering", () => {
  it("renders quoted select columns and expand aliases", () => {
    expect(
      buildSelect(quote, ["id", "ownerId"], [
        { localField: "authorId", targetTable: "users", targetColumns: ["name"] }
      ])
    ).toBe(
      "SELECT t.`id`, t.`ownerId`, `_e_authorId`.`name` AS `__e_authorId__name`"
    )
  })

  it("uses one quoted join alias in SELECT, JOIN, and ON", () => {
    const joins = buildJoins(quote, [
      {
        localField: "authorId",
        targetTable: "users",
        targetColumns: ["name"],
        onClause: { sql: 't."ownerId" = ?', params: ["u1"] }
      }
    ])
    expect(joins.sql).toContain("JOIN `users` `_e_authorId`")
    expect(joins.sql).toContain("`_e_authorId`.`id` = t.`authorId`")
    expect(joins.sql).toContain('`_e_authorId`."ownerId" = ?')
    expect(joins.params).toEqual(["u1"])
  })

  it("bounds list params in textual order", () => {
    const rendered = renderList(quote, "posts", 10, {
      where: { sql: 't."ownerId" = ?', params: ["u1"] },
      fields: ["id"]
    })
    expect(rendered.sql).toBe(
      "SELECT t.`id` FROM `posts` t WHERE t.\"ownerId\" = ? LIMIT ?"
    )
    expect(rendered.params).toEqual(["u1", 10])
  })

  it("renders view, exists, delete, and returning SQL", () => {
    expect(renderView(quote, "posts", "p1").sql).toBe(
      "SELECT * FROM `posts` t WHERE t.`id` = ? LIMIT 1"
    )
    expect(renderExists(quote, "posts", "p1").sql).toBe(
      "SELECT 1 FROM `posts` t WHERE t.`id` = ? LIMIT 1"
    )
    expect(renderDelete(quote, "posts", "p1").sql).toBe(
      "DELETE FROM `posts` WHERE `id` = ?"
    )
    expect(renderDeleteReturning(quote, "posts", "p1").sql).toBe(
      "DELETE FROM `posts` WHERE `id` = ? RETURNING `id`"
    )
  })

  it("puts access params before the id param", () => {
    const rendered = renderViewWithAccess(quote, "posts", "p1", [
      { name: "rule", where: { sql: 't."ownerId" = ?', params: ["u1"] } },
      { name: "manage", where: { sql: 't."role" = ?', params: ["admin"] } }
    ])
    expect(rendered.params).toEqual(["u1", "admin", "p1"])
    expect(rendered.sql).toContain('t."ownerId" = ?')
    expect(rendered.sql).toContain('t."role" = ?')
  })

  it("rewrites placeholders to $n outside quoted regions", () => {
    expect(
      rewritePlaceholders(
        't."a?b" = ? AND note = \'?\' AND t."ownerId" = ?',
        dollar
      )
    ).toBe('t."a?b" = $1 AND note = \'?\' AND t."ownerId" = $2')
  })

  it("renders a typed rule check without a repository", () => {
    const rendered = renderRuleCheck(
      { sql: 't."ownerId" = ? AND t."age" > ?', params: ["u1", 18] },
      dollar
    )
    expect(rendered.sql).toBe(
      'SELECT 1 AS ok WHERE t."ownerId" = $1 AND t."age" > $2'
    )
    expect(rendered.params).toEqual(["u1", 18])
  })
})
