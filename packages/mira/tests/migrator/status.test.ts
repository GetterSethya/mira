import { describe, it } from "@effect/vitest"
import { expect } from "vitest"

import { classifyStatus } from "@/migrator/migrator.js"
import type { ColumnDef, MigrationStep } from "@/migrator/types.js"

const column = (
  name: string,
  maxLength: number | undefined
): ColumnDef => ({
  name,
  type: "text",
  nullable: false,
  ...(maxLength === undefined ? {} : { maxLength })
})

const alter = (from: ColumnDef, to: ColumnDef): MigrationStep => ({
  kind: "alterColumn",
  table: "t",
  from,
  to
})

describe("classifyStatus", () => {
  it("reports current for no steps", () => {
    expect(classifyStatus([], true, new Set(), new Set())).toBe("current")
  })

  it("reports behind for a keyed text length increase", () => {
    expect(
      classifyStatus(
        [alter(column("title", 100), column("title", 200))],
        true,
        new Set(["title"]),
        new Set(["title"])
      )
    ).toBe("behind")
  })

  it("resolves an undefined stored length to the provisional 255", () => {
    expect(
      classifyStatus(
        [alter(column("title", undefined), column("title", 500))],
        true,
        new Set(["title"]),
        new Set(["title"])
      )
    ).toBe("behind")
    expect(
      classifyStatus(
        [alter(column("title", undefined), column("title", 200))],
        true,
        new Set(["title"]),
        new Set(["title"])
      )
    ).toBe("ahead")
  })

  it("reports ahead for a keyed text decrease", () => {
    expect(
      classifyStatus(
        [alter(column("title", 200), column("title", 100))],
        true,
        new Set(["title"]),
        new Set(["title"])
      )
    ).toBe("ahead")
  })

  it("keeps unindexed length changes out of the text rule", () => {
    expect(
      classifyStatus(
        [alter(column("body", 100), column("body", 200))],
        true,
        new Set(),
        new Set()
      )
    ).toBe("ahead")
  })

  it("lets a behind condition win over an ahead condition", () => {
    const steps: Array<MigrationStep> = [
      { kind: "addColumn", table: "t", column: column("extra", 100) },
      alter(column("title", 200), column("title", 100))
    ]
    expect(
      classifyStatus(steps, true, new Set(["title"]), new Set(["title"]))
    ).toBe("behind")
  })

  it("reports behind for an index addition and ahead for a removal", () => {
    expect(
      classifyStatus(
        [{ kind: "createIndex", table: "t", fields: ["title"], unique: false }],
        true,
        new Set(),
        new Set(["title"])
      )
    ).toBe("behind")
    expect(
      classifyStatus(
        [{ kind: "dropIndex", table: "t", fields: ["title"], unique: false }],
        true,
        new Set(["title"]),
        new Set()
      )
    ).toBe("ahead")
  })
})
