import { describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { expect } from "vitest"

import type { TranslatePlanContext, ViewShape } from "@/dialect/dialect.js"
import { mysqlMigrationDialect } from "@/dialect/dialect-mysql-migrations.js"
import { UnsupportedMigrationStepError } from "@/migrator/errors.js"
import type { ColumnDef, IndexShape, MigrationStep, TableShapes } from "@/migrator/types.js"

const column = (name: string, type: ColumnDef["type"], overrides: Partial<ColumnDef> = {}): ColumnDef => ({
  name,
  type,
  nullable: false,
  ...overrides
})

const seqId = column("seqId", "integer", {
  primaryKey: true,
  autoIncrement: true,
  xSystem: true
})
const id = column("id", "text", { unique: true, xSystem: true, maxLength: 255 })
const title = column("title", "text")

const tableShapes = (columns: Array<ColumnDef>, indexes: Array<IndexShape> = []): TableShapes => ({
  stored: null,
  desired: { columns, indexes }
})

type CatalogColumnSpec = {
  readonly name: string
  readonly type: string
  readonly nullable?: boolean
  readonly defaultValue?: string | number | null
  readonly autoIncrement?: boolean
  readonly collationName?: string | null
  readonly characterSetName?: string | null
  readonly columnComment?: string | null
  readonly extra?: string
  readonly generationExpression?: string | null
}

type CatalogIndexFieldSpec = string | { readonly name: string; readonly subPart?: boolean }

type CatalogIndexSpec = {
  readonly name: string
  readonly unique?: boolean
  readonly fields: ReadonlyArray<CatalogIndexFieldSpec>
}

type CatalogTableSpec = {
  readonly name: string
  readonly kind?: "base" | "view"
  readonly columns?: ReadonlyArray<CatalogColumnSpec>
  readonly indexes?: ReadonlyArray<CatalogIndexSpec>
}

type CatalogViewSpec = {
  readonly name: string
  readonly definition: string
}

type ContextOptions = {
  readonly catalogTables?: ReadonlyArray<CatalogTableSpec>
  readonly catalogViews?: ReadonlyArray<CatalogViewSpec>
  readonly shapes?: ReadonlyMap<string, TableShapes>
  readonly viewShapes?: ReadonlyMap<string, ViewShape>
  /** Maximum character length returned by a narrowing probe. */
  readonly maxLength?: number
  /** Whether a duplicate probe should return one hit row. */
  readonly duplicate?: boolean
  /** Number of rows returned by an existence probe. */
  readonly rows?: number
  /** Drift strings returned by an audit. */
  readonly audit?: ReadonlyArray<string>
}

/**
 * Builds a `TranslatePlanContext` whose `readonlyQuery` answers the module's
 * four information_schema statements from in-memory rows.
 */
const makeContext = (
  options: ContextOptions = {}
): { readonly ctx: TranslatePlanContext; readonly queries: Array<string> } => {
  const tableRows: Array<Record<string, unknown>> = []
  const columnRows: Array<Record<string, unknown>> = []
  const indexRows: Array<Record<string, unknown>> = []
  const viewRows: Array<Record<string, unknown>> = []

  for (const table of options.catalogTables ?? []) {
    tableRows.push({
      table_name: table.name,
      table_type: table.kind === "view" ? "VIEW" : "BASE TABLE",
      data_length: 0,
      index_length: 0
    })
    for (const columnSpec of table.columns ?? []) {
      columnRows.push({
        table_name: table.name,
        column_name: columnSpec.name,
        column_type: columnSpec.type,
        is_nullable: columnSpec.nullable === true ? "YES" : "NO",
        column_default: columnSpec.defaultValue === undefined ? null : columnSpec.defaultValue,
        extra: columnSpec.extra ?? (columnSpec.autoIncrement === true ? "auto_increment" : ""),
        character_set_name:
          columnSpec.characterSetName === undefined
            ? columnSpec.type.includes("text") || columnSpec.type.startsWith("varchar")
              ? "utf8mb4"
              : null
            : columnSpec.characterSetName,
        collation_name:
          columnSpec.collationName === undefined
            ? columnSpec.type.includes("text") || columnSpec.type.startsWith("varchar")
              ? "utf8mb4_0900_bin"
              : null
            : columnSpec.collationName,
        column_comment: columnSpec.columnComment ?? "",
        generation_expression: columnSpec.generationExpression ?? ""
      })
    }
    for (const index of table.indexes ?? []) {
      for (const [position, field] of index.fields.entries()) {
        const fieldName = typeof field === "string" ? field : field.name
        const subPart = typeof field === "string" ? false : field.subPart === true
        indexRows.push({
          table_name: table.name,
          index_name: index.name,
          non_unique: index.unique === true ? 0 : 1,
          seq_in_index: position + 1,
          column_name: fieldName,
          sub_part: subPart ? 1 : null
        })
      }
    }
  }

  for (const view of options.catalogViews ?? []) {
    viewRows.push({ table_name: view.name, view_definition: view.definition })
  }

  const queries: Array<string> = []
  const readonlyQuery: TranslatePlanContext["readonlyQuery"] = (statement) => {
    queries.push(statement)
    if (statement.includes("information_schema.columns")) {
      return Effect.succeed(columnRows)
    }
    if (statement.includes("information_schema.statistics")) {
      return Effect.succeed(indexRows)
    }
    if (statement.includes("information_schema.views")) {
      return Effect.succeed(viewRows)
    }
    if (statement.includes("information_schema.tables")) {
      return Effect.succeed(tableRows)
    }
    if (statement.includes("MAX(CHAR_LENGTH")) {
      return Effect.succeed([{ c0: options.maxLength ?? 0 }])
    }
    if (statement.includes("GROUP BY")) {
      return Effect.succeed(options.duplicate === true ? [{ hit: 1 }] : [])
    }
    if (statement.includes("LIMIT 2")) {
      return Effect.succeed(Array.from({ length: options.rows ?? 0 }, () => ({ hit: 1 })))
    }
    if (statement.includes("bin_padded")) {
      return Effect.succeed([{ bin_padded: 0, email_padded: 0, email_case_equal: 1 }])
    }
    return Effect.succeed([])
  }

  return {
    ctx: {
      tables: options.shapes ?? new Map<string, TableShapes>(),
      views: options.viewShapes ?? new Map<string, ViewShape>(),
      readonlyQuery
    },
    queries
  }
}

const plan = (steps: ReadonlyArray<MigrationStep>, ctx: TranslatePlanContext) =>
  mysqlMigrationDialect.translatePlan(steps, ctx)

const failureDetail = (steps: ReadonlyArray<MigrationStep>, ctx: TranslatePlanContext) =>
  plan(steps, ctx).pipe(
    Effect.catchTag("UnsupportedMigrationStepError", (error) => Effect.succeed(error.detail)),
    Effect.orDie
  )

const verifyDetail = (steps: ReadonlyArray<MigrationStep>, ctx: TranslatePlanContext) =>
  mysqlMigrationDialect.verifyPlan(steps, ctx).pipe(
    Effect.catchTag("UnsupportedMigrationStepError", (error) => Effect.succeed(error.detail)),
    Effect.orDie
  )

const indexNameFromSql = (statement: string) => {
  const match = /INDEX `((?:``|[^`])+)`/.exec(statement)
  if (match === null) throw new Error(`no index name in: ${statement}`)
  return match[1] ?? ""
}

const catalogTypeOf = (type: ColumnDef["type"], keyed = false, maxLength = 255) => {
  switch (type) {
    case "boolean":
      return "tinyint(1)"
    case "integer":
      return "int"
    case "real":
      return "double"
    case "text":
      return keyed ? `varchar(${maxLength})` : "longtext"
  }
}

const createTableWithCatalogDefault = (desired: ColumnDef, catalogDefault: string | number | null) => {
  const { ctx } = makeContext({
    catalogTables: [
      {
        name: "t",
        columns: [
          {
            name: desired.name,
            type: catalogTypeOf(desired.type, desired.unique === true, desired.maxLength ?? 255),
            nullable: desired.nullable,
            defaultValue: catalogDefault
          }
        ]
      }
    ]
  })
  return plan([{ kind: "createTable", table: "t", columns: [desired] }], ctx)
}

const dependentViewContext = () =>
  makeContext({
    catalogTables: [
      {
        name: "t",
        columns: [
          { name: "a", type: "int" },
          { name: "b", type: "int" }
        ]
      },
      { name: "v", kind: "view" }
    ],
    catalogViews: [{ name: "v", definition: "SELECT a FROM t" }]
  })

const transitiveViewContext = () =>
  makeContext({
    catalogTables: [
      { name: "t", columns: [{ name: "a", type: "int" }] },
      { name: "v1", kind: "view" },
      { name: "v2", kind: "view" }
    ],
    catalogViews: [
      { name: "v1", definition: "SELECT a FROM t" },
      { name: "v2", definition: "SELECT a FROM v1" }
    ]
  })

describe("mysqlMigrationDialect identifiers", () => {
  it("quotes identifiers with backticks and escapes an embedded backtick", () => {
    expect(mysqlMigrationDialect.quoteIdentifier("todos")).toBe("`todos`")
    expect(mysqlMigrationDialect.quoteIdentifier("odd`name")).toBe("`odd``name`")
  })
})

describe("mysqlMigrationDialect createTable", () => {
  it("renders MySQL types, inline keys, and ENGINE=InnoDB", () => {
    const statements = mysqlMigrationDialect.translate({
      kind: "createTable",
      table: "todos",
      columns: [seqId, id, title, column("score", "real"), column("done", "boolean"), column("count", "integer")]
    })

    expect(statements).toHaveLength(1)
    const statement = statements[0]
    expect(statement).toContain("CREATE TABLE `todos` (")
    expect(statement).toContain("`seqId` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY")
    expect(statement).toContain("`id` VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL UNIQUE")
    expect(statement).toContain("`title` LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL")
    expect(statement).toContain("`score` DOUBLE NOT NULL")
    expect(statement).toContain("`done` BOOLEAN NOT NULL")
    expect(statement).toContain("`count` INT NOT NULL")
    expect(statement).toContain(") ENGINE=InnoDB")
  })

  it("renders CREATE TABLE IF NOT EXISTS for a system table", () => {
    const statements = mysqlMigrationDialect.translate({
      kind: "createSystemTable",
      table: "_collections",
      columns: [column("name", "text", { primaryKey: true, maxLength: 255 })]
    })

    expect(statements[0]).toContain("CREATE TABLE IF NOT EXISTS `_collections`")
    expect(statements[0]).toContain(
      "`name` VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL PRIMARY KEY"
    )
  })
})

describe("mysqlMigrationDialect addColumn", () => {
  it("renders a nullable column in one statement", () => {
    const statements = mysqlMigrationDialect.translate({
      kind: "addColumn",
      table: "t",
      column: column("note", "text", { nullable: true })
    })

    expect(statements).toEqual([
      "ALTER TABLE `t` ADD COLUMN `note` LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin"
    ])
  })

  it("renders a non-null column with a declared default in one statement", () => {
    const statements = mysqlMigrationDialect.translate({
      kind: "addColumn",
      table: "t",
      column: column("count", "integer", { default: 7 })
    })

    expect(statements).toEqual(["ALTER TABLE `t` ADD COLUMN `count` INT NOT NULL DEFAULT 7"])
  })

  it("renders the add, backfill, and MODIFY sequence for a non-null column without a default", () => {
    const statements = mysqlMigrationDialect.translate({
      kind: "addColumn",
      table: "t",
      column: column("code", "text")
    })

    expect(statements).toEqual([
      "ALTER TABLE `t` ADD COLUMN `code` LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin",
      "UPDATE `t` SET `code` = ('') WHERE `code` IS NULL",
      "ALTER TABLE `t` MODIFY COLUMN `code` LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL"
    ])
  })

  it("uses 0 for integer and FALSE for boolean backfills", () => {
    const integerStatements = mysqlMigrationDialect.translate({
      kind: "addColumn",
      table: "t",
      column: column("n", "integer")
    })
    const booleanStatements = mysqlMigrationDialect.translate({
      kind: "addColumn",
      table: "t",
      column: column("flag", "boolean")
    })

    expect(integerStatements[1]).toBe("UPDATE `t` SET `n` = 0 WHERE `n` IS NULL")
    expect(booleanStatements[1]).toBe("UPDATE `t` SET `flag` = FALSE WHERE `flag` IS NULL")
  })
})

describe("mysqlMigrationDialect alterColumn", () => {
  it("renders MODIFY COLUMN and the nullable-to-NOT NULL backfill", () => {
    const statements = mysqlMigrationDialect.translate({
      kind: "alterColumn",
      table: "t",
      from: column("score", "integer", { nullable: true }),
      to: column("score", "integer", { default: 0 })
    })

    expect(statements).toEqual([
      "UPDATE `t` SET `score` = 0 WHERE `score` IS NULL",
      "ALTER TABLE `t` MODIFY COLUMN `score` INT NOT NULL DEFAULT 0"
    ])
  })
})

describe("mysqlMigrationDialect createIndex", () => {
  it("renders a deterministic, quoted, non-unique index name", () => {
    const statements = mysqlMigrationDialect.translate({
      kind: "createIndex",
      table: "todos",
      fields: ["category"],
      unique: false
    })

    expect(statements).toEqual(["CREATE INDEX `idx_todos_category` ON `todos` (`category`)"])
  })

  it("renders UNIQUE for a unique index and quotes every field", () => {
    const statements = mysqlMigrationDialect.translate({
      kind: "createIndex",
      table: "todos",
      fields: ["category", "priority"],
      unique: true
    })

    expect(statements).toEqual([
      "CREATE UNIQUE INDEX `idx_todos_category_priority` ON `todos` (`category`, `priority`)"
    ])
  })

  it("truncates a long name to 64 code points with a stable FNV-1a suffix", () => {
    const table = "t".repeat(40)
    const field = "f".repeat(40)

    const first = mysqlMigrationDialect.translate({
      kind: "createIndex",
      table,
      fields: [field],
      unique: false
    })[0]
    const second = mysqlMigrationDialect.translate({
      kind: "createIndex",
      table,
      fields: [field],
      unique: false
    })[0]
    const other = mysqlMigrationDialect.translate({
      kind: "createIndex",
      table,
      fields: [`${field}g`],
      unique: false
    })[0]

    const name = indexNameFromSql(first)
    expect(name).toHaveLength(64)
    expect(name.startsWith("idx_")).toBe(true)
    expect(name).toBe(indexNameFromSql(second))
    expect(name).not.toBe(indexNameFromSql(other))
    expect(first).toContain(`ON \`${table}\` (\`${field}\`)`)
  })
})

describe("mysqlMigrationDialect metadata upsert", () => {
  const record = {
    name: "todos",
    schema: '{"x":"y"}',
    updated_at: "2026-01-01"
  }

  it("renders ? placeholders and returns params in key order", () => {
    const statement = mysqlMigrationDialect.upsertStatement("_collections", record, ["name"])

    expect(statement.sql).toBe(
      "INSERT INTO `_collections` (`name`, `schema`, `updated_at`) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE `schema` = VALUES(`schema`), `updated_at` = VALUES(`updated_at`)"
    )
    expect(statement.params).toEqual(["todos", '{"x":"y"}', "2026-01-01"])
  })

  it("renders the literal form with quoted values and no params", () => {
    const sql = mysqlMigrationDialect.upsert("_collections", record, ["name"])

    expect(sql).toContain("INSERT INTO `_collections`")
    expect(sql).toContain("VALUES ('todos', '{\"x\":\"y\"}', '2026-01-01')")
    expect(sql).toContain("ON DUPLICATE KEY UPDATE")
    expect(sql).toContain("`schema` = VALUES(`schema`)")
  })

  it("rejects an upsert whose every column is a conflict key", () => {
    expect(() => mysqlMigrationDialect.upsertStatement("_t", { name: "x" }, ["name"])).toThrow(
      UnsupportedMigrationStepError
    )
  })
})

describe("mysqlMigrationDialect migration model", () => {
  const model = mysqlMigrationDialect.migrationModel

  it("uses a single-quoted literal in the system table existence probe", () => {
    const sql = model.systemTableExistsSql("_collections")

    expect(sql).toContain("table_schema = DATABASE()")
    expect(sql).toContain("table_name = '_collections'")
    expect(sql).not.toContain("`_collections`")
  })

  it("classifies the six retryable conflict codes", () => {
    for (const code of [1050, 1060, 1061, 1091, 1205, 1213]) {
      expect(model.isRetryableConflict({ code })).toBe(true)
    }
  })

  it("does not retry duplicate data, foreign key, or syntax errors", () => {
    for (const code of [1062, 1215, 1064]) {
      expect(model.isRetryableConflict({ code })).toBe(false)
    }
    expect(model.isRetryableConflict({ cause: { errno: 1213 } })).toBe(true)
    expect(model.isRetryableConflict(new Error("boom"))).toBe(false)
  })

  it("declares a database-scoped session lock with parameterized statements", () => {
    expect(model.kind).toBe("statement")
    if (model.kind !== "statement") return
    const lock = model.lock
    expect(lock).toBeDefined()
    if (lock === undefined) return

    expect(lock.databaseNameSql).toBe("SELECT DATABASE() AS database_name")
    expect(lock.namePrefix).toBe("mira.migrations")
    expect(lock.maxNameLength).toBe(64)
    expect(lock.defaultTimeoutSeconds).toBe(60)
    expect(lock.heartbeatIntervalSeconds).toBe(60)
    expect(lock.openConnection).toBeUndefined()
    expect(Object.keys(mysqlMigrationDialect)).not.toContain("lock")

    expect(lock.acquireStatement("mira.migrations:abc", 30)).toEqual({
      sql: "SELECT GET_LOCK(?, ?) AS acquired",
      params: ["mira.migrations:abc", 30]
    })
    expect(lock.releaseStatement("mira.migrations:abc")).toEqual({
      sql: "SELECT RELEASE_LOCK(?) AS released",
      params: ["mira.migrations:abc"]
    })
    expect(lock.usedStatement("mira.migrations:abc")).toEqual({
      sql: "SELECT IS_USED_LOCK(?) = CONNECTION_ID() AS held_by_me",
      params: ["mira.migrations:abc"]
    })
    expect(lock.holderStatement("mira.migrations:abc")).toEqual({
      sql: "SELECT IS_USED_LOCK(?) AS holder",
      params: ["mira.migrations:abc"]
    })
    expect(lock.killSelfStatement).toEqual({ sql: "KILL CONNECTION_ID()", params: [] })
  })

  it("bounds the migration session's wait_timeout", () => {
    expect(model.kind).toBe("statement")
    if (model.kind !== "statement") return
    const session = model.session
    expect(session).toBeDefined()
    if (session === undefined) return

    expect(session.readSql).toContain("@@SESSION.wait_timeout AS wait_timeout")
    expect(session.setupSql).toContain("SET SESSION wait_timeout = 600")
    expect(session.previewSetupSql).toContain("SET SESSION wait_timeout = 600")
    expect(session.restoreSql({ wait_timeout: 4321, sql_mode: "STRICT", lock_wait_timeout: 5 })).toContain(
      "SET SESSION wait_timeout = 4321"
    )
  })
})

describe("mysqlMigrationDialect translatePlan", () => {
  it.effect("renders every statement for a fresh plan and skips nothing", () =>
    Effect.gen(function* () {
      const { ctx } = makeContext()
      const result = yield* plan(
        [
          {
            kind: "createTable",
            table: "todos",
            columns: [id, column("priority", "integer")]
          },
          {
            kind: "createIndex",
            table: "todos",
            fields: ["priority"],
            unique: false
          }
        ],
        ctx
      )

      expect(result.statements).toEqual([
        "CREATE TABLE `todos` (\n  `id` VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL UNIQUE,\n  `priority` INT NOT NULL\n) ENGINE=InnoDB",
        "CREATE INDEX `idx_todos_priority` ON `todos` (`priority`)"
      ])
      expect(result.cleanup).toEqual([])
      expect(result.skipped).toEqual([])
    })
  )

  it.effect("skips a done step with a note and its index in skipped", () =>
    Effect.gen(function* () {
      const { ctx } = makeContext()
      const result = yield* plan([{ kind: "dropTable", table: "gone" }], ctx)

      expect(result.statements).toEqual([])
      expect(result.skipped).toEqual([0])
      expect(result.notes).toEqual(["skip dropTable gone (already present)"])
    })
  )

  it.effect("treats a createTable with inline keys and absent explicit indexes as done", () =>
    Effect.gen(function* () {
      const desiredColumns = [seqId, id, column("priority", "integer")]
      const { ctx } = makeContext({
        catalogTables: [
          {
            name: "todos",
            columns: [
              { name: "seqId", type: "bigint", autoIncrement: true },
              { name: "id", type: "varchar(255)" },
              { name: "priority", type: "int" }
            ],
            indexes: [
              { name: "PRIMARY", unique: true, fields: ["seqId"] },
              { name: "id", unique: true, fields: ["id"] }
            ]
          }
        ],
        shapes: new Map([["todos", tableShapes(desiredColumns, [{ fields: ["priority"], unique: false }])]])
      })

      const result = yield* plan([{ kind: "createTable", table: "todos", columns: desiredColumns }], ctx)

      expect(result.statements).toEqual([])
      expect(result.skipped).toEqual([0])
    })
  )

  it.effect("treats a createTable with its explicit planned index as done", () =>
    Effect.gen(function* () {
      const desiredColumns = [seqId, id, column("priority", "integer")]
      const { ctx } = makeContext({
        catalogTables: [
          {
            name: "todos",
            columns: [
              { name: "seqId", type: "bigint", autoIncrement: true },
              { name: "id", type: "varchar(255)" },
              { name: "priority", type: "int" }
            ],
            indexes: [
              { name: "PRIMARY", unique: true, fields: ["seqId"] },
              { name: "id", unique: true, fields: ["id"] },
              {
                name: "idx_todos_priority",
                unique: false,
                fields: ["priority"]
              }
            ]
          }
        ],
        shapes: new Map([["todos", tableShapes(desiredColumns, [{ fields: ["priority"], unique: false }])]])
      })

      const result = yield* plan([{ kind: "createTable", table: "todos", columns: desiredColumns }], ctx)

      expect(result.statements).toEqual([])
      expect(result.skipped).toEqual([0])
    })
  )

  it.effect("drifts a createTable that finds an unplanned index", () =>
    Effect.gen(function* () {
      const desiredColumns = [seqId, id, column("priority", "integer")]
      const { ctx } = makeContext({
        catalogTables: [
          {
            name: "todos",
            columns: [
              { name: "seqId", type: "bigint", autoIncrement: true },
              { name: "id", type: "varchar(255)" },
              { name: "priority", type: "int" }
            ],
            indexes: [
              { name: "PRIMARY", unique: true, fields: ["seqId"] },
              { name: "id", unique: true, fields: ["id"] },
              { name: "legacy_idx", unique: false, fields: ["priority"] }
            ]
          }
        ],
        shapes: new Map([["todos", tableShapes(desiredColumns, [{ fields: ["priority"], unique: false }])]])
      })

      const detail = yield* failureDetail([{ kind: "createTable", table: "todos", columns: desiredColumns }], ctx)

      expect(detail).toContain('unexpected index "legacy_idx"')
    })
  )

  it.effect("compares an alterColumn against to, from, and a third shape", () =>
    Effect.gen(function* () {
      const matchingTo = makeContext({
        catalogTables: [{ name: "t", columns: [{ name: "n", type: "int" }] }]
      })
      const done = yield* plan(
        [
          {
            kind: "alterColumn",
            table: "t",
            from: column("n", "text", { nullable: true }),
            to: column("n", "integer")
          }
        ],
        matchingTo.ctx
      )
      expect(done.statements).toEqual([])
      expect(done.skipped).toEqual([0])

      const matchingFrom = makeContext({
        catalogTables: [{ name: "t", columns: [{ name: "n", type: "int", nullable: true }] }]
      })
      const pendingFrom = yield* plan(
        [
          {
            kind: "alterColumn",
            table: "t",
            from: column("n", "integer", { nullable: true }),
            to: column("n", "integer", { default: 0 })
          }
        ],
        matchingFrom.ctx
      )
      expect(pendingFrom.skipped).toEqual([])
      expect(pendingFrom.statements).toEqual([
        "UPDATE `t` SET `n` = 0 WHERE `n` IS NULL",
        "ALTER TABLE `t` MODIFY COLUMN `n` INT NOT NULL DEFAULT 0"
      ])

      const thirdShape = makeContext({
        catalogTables: [{ name: "t", columns: [{ name: "n", type: "double", nullable: true }] }]
      })
      const drift = yield* failureDetail(
        [
          {
            kind: "alterColumn",
            table: "t",
            from: column("n", "integer", { nullable: true }),
            to: column("n", "integer")
          }
        ],
        thirdShape.ctx
      )
      expect(drift).toContain("differs from both plan shapes")
    })
  )

  it.effect("applies an alterColumn whose only difference is the default", () =>
    Effect.gen(function* () {
      const { ctx } = makeContext({
        catalogTables: [{ name: "t", columns: [{ name: "n", type: "int", defaultValue: "0" }] }]
      })
      const result = yield* plan(
        [
          {
            kind: "alterColumn",
            table: "t",
            from: column("n", "integer", { default: 0 }),
            to: column("n", "integer", { default: 5 })
          }
        ],
        ctx
      )

      expect(result.skipped).toEqual([])
      expect(result.statements).toEqual(["ALTER TABLE `t` MODIFY COLUMN `n` INT NOT NULL DEFAULT 5"])
    })
  )

  it.effect("finishes a non-null addColumn from the nullable intermediate shape", () =>
    Effect.gen(function* () {
      const { ctx } = makeContext({
        catalogTables: [
          {
            name: "t",
            columns: [{ name: "code", type: "longtext", nullable: true }]
          }
        ]
      })
      const result = yield* plan(
        [{ kind: "addColumn", table: "t", column: column("code", "text", { maxLength: 255 }) }],
        ctx
      )

      expect(result.skipped).toEqual([])
      expect(result.statements).toEqual([
        "UPDATE `t` SET `code` = ('') WHERE `code` IS NULL",
        "ALTER TABLE `t` MODIFY COLUMN `code` LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL"
      ])
    })
  )

  it.effect("treats the final NOT NULL addColumn shape as done", () =>
    Effect.gen(function* () {
      const { ctx } = makeContext({
        catalogTables: [
          {
            name: "t",
            columns: [{ name: "code", type: "longtext" }]
          }
        ]
      })
      const result = yield* plan(
        [{ kind: "addColumn", table: "t", column: column("code", "text", { maxLength: 255 }) }],
        ctx
      )

      expect(result.statements).toEqual([])
      expect(result.skipped).toEqual([0])
    })
  )

  it.effect("drifts an addColumn with a different type or default", () =>
    Effect.gen(function* () {
      const wrongType = yield* failureDetail(
        [{ kind: "addColumn", table: "t", column: column("code", "text", { maxLength: 255 }) }],
        makeContext({
          catalogTables: [{ name: "t", columns: [{ name: "code", type: "varchar(255)" }] }]
        }).ctx
      )
      expect(wrongType).toContain('column "t"."code" differs')

      const wrongDefault = yield* failureDetail(
        [{ kind: "addColumn", table: "t", column: column("code", "text", { maxLength: 255 }) }],
        makeContext({
          catalogTables: [
            {
              name: "t",
              columns: [
                {
                  name: "code",
                  type: "longtext",
                  nullable: true,
                  defaultValue: "_utf8mb4'x'"
                }
              ]
            }
          ]
        }).ctx
      )
      expect(wrongDefault).toContain('column "t"."code" differs')
    })
  )

  it.effect("rejects indexed text without a declared length", () =>
    Effect.gen(function* () {
      const { ctx } = makeContext({
        catalogTables: [{ name: "t", columns: [{ name: "body", type: "longtext" }] }],
        shapes: new Map([["t", tableShapes([column("body", "text")], [{ fields: ["body"], unique: false }])]])
      })
      const detail = yield* failureDetail([{ kind: "createIndex", table: "t", fields: ["body"], unique: false }], ctx)

      expect(detail).toContain("has no maxLength")
      expect(detail).toContain("768")
    })
  )

  it.effect("drifts a system table that is missing a column", () =>
    Effect.gen(function* () {
      const { ctx } = makeContext({
        catalogTables: [
          {
            name: "_collections",
            columns: [{ name: "name", type: "varchar(255)" }],
            indexes: [{ name: "PRIMARY", unique: true, fields: ["name"] }]
          }
        ]
      })
      const detail = yield* failureDetail(
        [
          {
            kind: "createSystemTable",
            table: "_collections",
            columns: [
              column("name", "text", { primaryKey: true, maxLength: 255 }),
              column("schema", "text"),
              column("updated_at", "text")
            ]
          }
        ],
        ctx
      )

      expect(detail).toContain("column set differs")
    })
  )

  it.effect("rejects 65-code-point table, column, and index-field names before SQL", () =>
    Effect.gen(function* () {
      const longName = "a".repeat(65)

      const tableContext = makeContext()
      const tableDetail = yield* failureDetail([{ kind: "dropTable", table: longName }], tableContext.ctx)
      expect(tableDetail).toContain("65 code points")
      expect(tableContext.queries).toHaveLength(0)

      const columnContext = makeContext()
      const columnDetail = yield* failureDetail(
        [
          {
            kind: "createTable",
            table: "t",
            columns: [column(longName, "text")]
          }
        ],
        columnContext.ctx
      )
      expect(columnDetail).toContain("65 code points")
      expect(columnContext.queries).toHaveLength(0)

      const indexContext = makeContext()
      const indexDetail = yield* failureDetail(
        [
          {
            kind: "createIndex",
            table: "t",
            fields: [longName],
            unique: false
          }
        ],
        indexContext.ctx
      )
      expect(indexDetail).toContain("65 code points")
      expect(indexContext.queries).toHaveLength(0)
    })
  )

  it.effect("rejects invalid defaults before SQL", () =>
    Effect.gen(function* () {
      const invalid = makeContext()
      const invalidDetail = yield* failureDetail(
        [
          {
            kind: "createTable",
            table: "t",
            columns: [column("a", "integer", { default: "abc" })]
          }
        ],
        invalid.ctx
      )
      expect(invalidDetail).toContain("is not valid for type integer")
      expect(invalid.queries).toHaveLength(0)

      const outOfRange = makeContext()
      const outOfRangeDetail = yield* failureDetail(
        [
          {
            kind: "createTable",
            table: "t",
            columns: [column("a", "integer", { default: 3000000000 })]
          }
        ],
        outOfRange.ctx
      )
      expect(outOfRangeDetail).toContain("is out of range for type integer")
      expect(outOfRange.queries).toHaveLength(0)
    })
  )

  it.effect("rejects a unique non-null addColumn without a default before SQL", () =>
    Effect.gen(function* () {
      const { ctx, queries } = makeContext({
        shapes: new Map([
          ["t", tableShapes([column("code", "text", { maxLength: 255 })], [{ fields: ["code"], unique: true }])]
        ])
      })
      const detail = yield* failureDetail(
        [{ kind: "addColumn", table: "t", column: column("code", "text", { maxLength: 255 }) }],
        ctx
      )

      expect(detail).toContain("collide in a unique index")
      expect(queries).toHaveLength(0)
    })
  )

  it.effect("rejects an identity alterColumn before SQL", () =>
    Effect.gen(function* () {
      const { ctx, queries } = makeContext()
      const detail = yield* failureDetail(
        [
          {
            kind: "alterColumn",
            table: "t",
            from: seqId,
            to: { ...seqId, type: "real" }
          }
        ],
        ctx
      )

      expect(detail).toContain('changing identity column "t"."seqId" is not supported')
      expect(queries).toHaveLength(0)
    })
  )

  it.effect("normalizes int(11), bigint(20), tinyint(1), and varchar(255)", () =>
    Effect.gen(function* () {
      const desiredColumns = [
        column("a", "integer"),
        column("b", "integer", { autoIncrement: true }),
        column("c", "boolean"),
        column("d", "text", { unique: true, maxLength: 255 })
      ]
      const { ctx } = makeContext({
        catalogTables: [
          {
            name: "t",
            columns: [
              { name: "a", type: "int(11)" },
              { name: "b", type: "bigint(20)", autoIncrement: true },
              { name: "c", type: "tinyint(1)" },
              { name: "d", type: "varchar(255)" }
            ],
            indexes: [{ name: "d", unique: true, fields: ["d"] }]
          }
        ]
      })

      const result = yield* plan([{ kind: "createTable", table: "t", columns: desiredColumns }], ctx)

      expect(result.statements).toEqual([])
      expect(result.skipped).toEqual([0])
    })
  )

  it.effect("creates a view on a view or absent name but drifts on a base table", () =>
    Effect.gen(function* () {
      const onView = yield* plan(
        [{ kind: "createView", view: "v", query: "SELECT 1" }],
        makeContext({ catalogTables: [{ name: "v", kind: "view" }] }).ctx
      )
      expect(onView.statements).toEqual(["CREATE OR REPLACE VIEW `v` AS SELECT 1"])
      expect(onView.skipped).toEqual([])

      const absent = yield* plan([{ kind: "createView", view: "v", query: "SELECT 1" }], makeContext().ctx)
      expect(absent.statements).toEqual(["CREATE OR REPLACE VIEW `v` AS SELECT 1"])

      const baseDetail = yield* failureDetail(
        [{ kind: "createView", view: "v", query: "SELECT 1" }],
        makeContext({ catalogTables: [{ name: "v" }] }).ctx
      )
      expect(baseDetail).toContain("a base table")
    })
  )

  it.effect("rejects a dropColumn that a view outside the plan references", () =>
    Effect.gen(function* () {
      const { ctx } = dependentViewContext()
      const detail = yield* failureDetail([{ kind: "dropColumn", table: "t", column: "a" }], ctx)

      expect(detail).toContain('view "v"')
      expect(detail).toContain("dropView")
    })
  )

  it.effect("allows the same dropColumn when the view is recreated in the plan", () =>
    Effect.gen(function* () {
      const { ctx } = dependentViewContext()
      const result = yield* plan(
        [
          { kind: "dropColumn", table: "t", column: "a" },
          { kind: "createView", view: "v", query: "SELECT b FROM t" }
        ],
        ctx
      )

      expect(result.statements).toEqual([
        "ALTER TABLE `t` DROP COLUMN `a`",
        "CREATE OR REPLACE VIEW `v` AS SELECT b FROM t"
      ])
    })
  )

  it.effect("flags a transitive dependent view and requires both recreations", () =>
    Effect.gen(function* () {
      const partial = yield* failureDetail(
        [
          { kind: "dropColumn", table: "t", column: "a" },
          { kind: "createView", view: "v1", query: "SELECT 1" }
        ],
        transitiveViewContext().ctx
      )
      expect(partial).toContain('view "v2"')

      const result = yield* plan(
        [
          { kind: "dropColumn", table: "t", column: "a" },
          { kind: "createView", view: "v1", query: "SELECT 1" },
          { kind: "createView", view: "v2", query: "SELECT 1 FROM v1" }
        ],
        transitiveViewContext().ctx
      )

      expect(result.statements.filter((statement) => statement.includes("`v1`"))).toHaveLength(1)
      expect(result.statements.filter((statement) => statement.includes("`v2`"))).toHaveLength(1)
    })
  )

  it.effect("creates an inner view before the outer view that reads it", () =>
    Effect.gen(function* () {
      const { ctx } = makeContext({
        viewShapes: new Map([
          ["outer", { stored: null, desired: { query: "SELECT a FROM inner" } }],
          ["inner", { stored: null, desired: { query: "SELECT a FROM t" } }]
        ])
      })
      const result = yield* plan(
        [
          { kind: "createView", view: "outer", query: "SELECT a FROM inner" },
          { kind: "createView", view: "inner", query: "SELECT a FROM t" }
        ],
        ctx
      )

      expect(result.statements).toEqual([
        "CREATE OR REPLACE VIEW `inner` AS SELECT a FROM t",
        "CREATE OR REPLACE VIEW `outer` AS SELECT a FROM inner"
      ])
    })
  )

  it.effect("drops an outer view before the inner view it reads", () =>
    Effect.gen(function* () {
      const { ctx } = makeContext({
        catalogTables: [
          { name: "outer", kind: "view" },
          { name: "inner", kind: "view" }
        ],
        catalogViews: [
          { name: "outer", definition: "SELECT a FROM inner" },
          { name: "inner", definition: "SELECT a FROM t" }
        ],
        viewShapes: new Map([
          ["outer", { stored: { query: "SELECT a FROM inner" }, desired: null }],
          ["inner", { stored: { query: "SELECT a FROM t" }, desired: null }]
        ])
      })
      const result = yield* plan(
        [
          { kind: "dropView", view: "outer" },
          { kind: "dropView", view: "inner" }
        ],
        ctx
      )

      expect(result.statements).toEqual(["DROP VIEW IF EXISTS `outer`", "DROP VIEW IF EXISTS `inner`"])
    })
  )

  it.effect("agrees with translate for non-indexed text and keys text only through the plan", () =>
    Effect.gen(function* () {
      const translated = mysqlMigrationDialect.translate({
        kind: "createTable",
        table: "todos",
        columns: [id, title]
      })
      const translatedPlan = yield* plan(
        [{ kind: "createTable", table: "todos", columns: [id, title] }],
        makeContext({
          shapes: new Map([["todos", tableShapes([id, title])]])
        }).ctx
      )

      expect(translatedPlan.statements).toEqual(translated)
      expect(translated[0]).toContain("`title` LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL")

      const indexedTitle = column("title", "text", { maxLength: 200 })
      const indexed = yield* plan(
        [{ kind: "createTable", table: "todos", columns: [indexedTitle] }],
        makeContext({
          shapes: new Map([["todos", tableShapes([indexedTitle], [{ fields: ["title"], unique: false }])]])
        }).ctx
      )

      expect(indexed.statements[0]).toContain(
        "`title` VARCHAR(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL"
      )
      expect(
        mysqlMigrationDialect.translate({
          kind: "createTable",
          table: "todos",
          columns: [title]
        })[0]
      ).toContain("`title` LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL")
    })
  )
})

describe("mysqlMigrationDialect verifyPlan", () => {
  it.effect("accepts an existing view and rejects a missing one", () =>
    Effect.gen(function* () {
      const steps: ReadonlyArray<MigrationStep> = [{ kind: "createView", view: "v", query: "SELECT 1" }]

      yield* mysqlMigrationDialect.verifyPlan(steps, makeContext({ catalogTables: [{ name: "v", kind: "view" }] }).ctx)

      const detail = yield* verifyDetail(steps, makeContext().ctx)
      expect(detail).toContain('view "v" does not exist')
    })
  )
})

describe("mysqlMigrationDialect normalizeDefault through translatePlan", () => {
  it.effect("treats the engine text default encodings as one value", () =>
    Effect.gen(function* () {
      const charsetEmpty = yield* createTableWithCatalogDefault(column("label", "text", { default: "" }), "_utf8mb4''")
      expect(charsetEmpty.skipped).toEqual([0])

      const parenthesizedEmpty = yield* createTableWithCatalogDefault(column("label", "text", { default: "" }), "('')")
      expect(parenthesizedEmpty.skipped).toEqual([0])

      const escaped = yield* createTableWithCatalogDefault(
        column("label", "text", { default: "it's a\\path" }),
        "_utf8mb4'it\\'s a\\\\path'"
      )
      expect(escaped.skipped).toEqual([0])
    })
  )

  it.effect("treats SQL NULL and the string NULL as no default", () =>
    Effect.gen(function* () {
      const sqlNull = yield* createTableWithCatalogDefault(
        column("label", "text", { nullable: true, default: null }),
        null
      )
      expect(sqlNull.skipped).toEqual([0])

      const stringNull = yield* createTableWithCatalogDefault(
        column("label", "text", { nullable: true, default: null }),
        "NULL"
      )
      expect(stringNull.skipped).toEqual([0])
    })
  )

  it.effect("coerces bit and numeric string defaults", () =>
    Effect.gen(function* () {
      const bit = yield* createTableWithCatalogDefault(column("ok", "boolean", { default: true }), "b'1'")
      expect(bit.skipped).toEqual([0])

      const integer = yield* createTableWithCatalogDefault(column("n", "integer", { default: 3 }), "3")
      expect(integer.skipped).toEqual([0])

      const real = yield* createTableWithCatalogDefault(column("score", "real", { default: 1.5 }), "1.50")
      expect(real.skipped).toEqual([0])
    })
  )

  it.effect("still drifts a genuinely different default", () =>
    Effect.gen(function* () {
      const { ctx } = makeContext({
        catalogTables: [{ name: "t", columns: [{ name: "n", type: "int", defaultValue: "4" }] }]
      })
      const detail = yield* failureDetail(
        [
          {
            kind: "createTable",
            table: "t",
            columns: [column("n", "integer", { default: 3 })]
          }
        ],
        ctx
      )

      expect(detail).toContain('column "t"."n" differs')
    })
  )
})

describe("mysqlMigrationDialect text strategy", () => {
  it.effect("rejects a keyed text column without a length", () =>
    Effect.gen(function* () {
      const detail = yield* failureDetail(
        [{ kind: "createTable", table: "t", columns: [column("title", "text")] }],
        makeContext({
          shapes: new Map([["t", tableShapes([column("title", "text")], [{ fields: ["title"], unique: false }])]])
        }).ctx
      )
      expect(detail).toContain("has no maxLength")
      expect(detail).toContain("768")
    })
  )

  it.effect("rejects a keyed text column over 768 characters", () =>
    Effect.gen(function* () {
      const detail = yield* failureDetail(
        [{ kind: "createTable", table: "t", columns: [column("title", "text", { maxLength: 769 })] }],
        makeContext({
          shapes: new Map([
            ["t", tableShapes([column("title", "text", { maxLength: 769 })], [{ fields: ["title"], unique: false }])]
          ])
        }).ctx
      )
      expect(detail).toContain("768")
    })
  )

  it.effect("rejects a composite index over 3072 bytes", () =>
    Effect.gen(function* () {
      const columns = [column("a", "text", { maxLength: 500 }), column("b", "text", { maxLength: 500 })]
      const detail = yield* failureDetail(
        [{ kind: "createTable", table: "t", columns }],
        makeContext({
          shapes: new Map([["t", tableShapes(columns, [{ fields: ["a", "b"], unique: false }])]])
        }).ctx
      )
      expect(detail).toContain("3072")
    })
  )

  it.effect("renders the email collation and probes with it", () =>
    Effect.gen(function* () {
      const email = column("email", "text", { maxLength: 320, collation: "utf8mb4_0900_as_ci", unique: true })
      const { ctx, queries } = makeContext({
        catalogTables: [
          { name: "users", columns: [{ name: "email", type: "varchar(320)", collationName: "utf8mb4_0900_as_ci" }] }
        ],
        shapes: new Map([["users", tableShapes([email])]])
      })
      const result = yield* plan([{ kind: "createIndex", table: "users", fields: ["email"], unique: true }], ctx)
      expect(result.statements[0]).toContain("CREATE UNIQUE INDEX")
      expect(queries.some((query) => query.includes("utf8mb4_0900_as_ci"))).toBe(true)
    })
  )

  it.effect("reconciles a legacy text shape before an index", () =>
    Effect.gen(function* () {
      const title = column("title", "text", { maxLength: 200 })
      const other = column("other", "integer")
      const { ctx, queries } = makeContext({
        catalogTables: [
          {
            name: "t",
            columns: [
              { name: "title", type: "varchar(255)" },
              { name: "other", type: "int" }
            ]
          }
        ],
        shapes: new Map([
          [
            "t",
            {
              stored: { columns: [column("title", "text"), other], indexes: [] },
              desired: {
                columns: [title, other],
                indexes: [
                  { fields: ["title"], unique: false },
                  { fields: ["other"], unique: false }
                ]
              }
            }
          ]
        ])
      })
      const result = yield* plan([{ kind: "createIndex", table: "t", fields: ["other"], unique: false }], ctx)
      expect(result.statements[0]).toContain("MODIFY COLUMN")
      expect(result.statements[0]).toContain("VARCHAR(200)")
      expect(result.statements[0]).toContain("ALGORITHM=COPY, LOCK=SHARED")
      expect(result.notes?.some((note) => note.includes("reconcile text shape"))).toBe(true)
      expect(queries.length).toBeGreaterThan(0)
    })
  )

  it.effect("rejects duplicate rows before a unique index", () =>
    Effect.gen(function* () {
      const title = column("title", "text", { maxLength: 200 })
      const detail = yield* failureDetail(
        [{ kind: "createIndex", table: "t", fields: ["title"], unique: true }],
        makeContext({
          catalogTables: [{ name: "t", columns: [{ name: "title", type: "varchar(200)" }] }],
          shapes: new Map([["t", tableShapes([title])]]),
          duplicate: true
        }).ctx
      )
      expect(detail).toContain("would collapse")
    })
  )

  it.effect("audits a legacy text shape without repairing it", () =>
    Effect.gen(function* () {
      const title = column("title", "text", { maxLength: 200 })
      const { ctx } = makeContext({
        catalogTables: [{ name: "t", columns: [{ name: "title", type: "varchar(255)" }] }],
        shapes: new Map([["t", tableShapes([title])]])
      })
      const audit = mysqlMigrationDialect.auditTextShape
      if (audit === undefined) return yield* Effect.die(new Error("auditTextShape missing"))
      const drift = yield* audit(ctx)
      expect(drift.some((detail) => detail.includes("title"))).toBe(true)
    })
  )

  it.effect("rejects a rename combined with a same-plan index step", () =>
    Effect.gen(function* () {
      const detail = yield* failureDetail(
        [
          { kind: "renameColumn", table: "t", from: "title", to: "name" },
          { kind: "createIndex", table: "t", fields: ["name"], unique: false }
        ],
        makeContext({
          shapes: new Map([["t", tableShapes([column("name", "text", { maxLength: 200 })])]])
        }).ctx
      )
      expect(detail).toContain("split the rename")
    })
  )

  it.effect("does not preflight an unchanged latent shape", () =>
    Effect.gen(function* () {
      const ctx = makeContext({
        shapes: new Map([["t", tableShapes([column("title", "text")], [{ fields: ["title"], unique: false }])]])
      }).ctx
      const preflight = mysqlMigrationDialect.preflightPlan
      if (preflight === undefined) return yield* Effect.die(new Error("preflightPlan missing"))
      yield* preflight([], ctx)
    })
  )

  it.effect("fails the collation sanity preflight on a PAD SPACE alias", () =>
    Effect.gen(function* () {
      const ctx: TranslatePlanContext = {
        tables: new Map(),
        views: new Map(),
        readonlyQuery: () => Effect.succeed([{ bin_padded: 1, email_padded: 0, email_case_equal: 1 }])
      }
      const preflight = mysqlMigrationDialect.preflightPlan
      if (preflight === undefined) return yield* Effect.die(new Error("preflightPlan missing"))
      const result = yield* preflight([], ctx).pipe(Effect.result)
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        const failure = result.failure
        expect(failure._tag).toBe("UnsupportedMigrationStepError")
        if (failure._tag === "UnsupportedMigrationStepError") {
          expect(failure.detail).toContain("PAD SPACE")
        }
      }
    })
  )
})
