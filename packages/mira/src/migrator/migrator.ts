import type { CollectionSchema } from "@gettersethya/mira-client"
import { Cause, Context, Effect, Layer, References, Schema } from "effect"
import { SqlClient, SqlError } from "effect/sql"

import type { DialectType, TranslatePlanContext, ViewShape } from "@/dialect/dialect.js"
import { Dialect } from "@/dialect/dialect.js"

import type { MigrationError } from "./errors.js"
import { InvalidMigrationStatementError, MigrationBusyError } from "./errors.js"
import {
  computePlan,
  diffSchemas,
  isDestructiveStep,
  schemaToColumns,
  schemaToIndexEntries
} from "./schema-diff.js"
import type {
  ColumnDef,
  MigrateOptions,
  MigrationPlan,
  MigrationStep,
  NamedSchema,
  TableShapes
} from "./types.js"
import { toEffectLogLevel } from "./types.js"

const parseJsonSchema = Schema.fromJsonString(Schema.Unknown)

function sqlError(message: string): SqlError.SqlError {
  return new SqlError.SqlError({ reason: new SqlError.UnknownError({ cause: undefined, message }) })
}

/**
 * Builds the guarded read-only executor a dialect uses to read the catalog
 * during render.
 *
 * The guard is deliberately narrower than SQL's read-only surface: the first
 * token must be `SELECT`, so `WITH` cannot lead into DML, and any semicolon is
 * rejected, so a second statement cannot ride along. Every other statement
 * fails with an `SqlError` before reaching the driver.
 */
function makeReadonlyQueryGuard(
  sql: SqlClient.SqlClient
): TranslatePlanContext["readonlyQuery"] {
  return (statement) => {
    const trimmed = statement.trim()
    const firstToken = trimmed.split(/\s+/, 1)[0]?.toUpperCase() ?? ""
    if (firstToken !== "SELECT") {
      return Effect.fail(
        sqlError(`readonlyQuery rejected a statement that does not start with SELECT: ${trimmed}`)
      )
    }
    if (trimmed.includes(";")) {
      return Effect.fail(
        sqlError(`readonlyQuery rejected a statement containing a semicolon: ${trimmed}`)
      )
    }
    return sql.unsafe<Record<string, unknown>>(trimmed)
  }
}

function isCollectionSchema(value: unknown): value is CollectionSchema {
  return typeof value === "object" && value !== null && "properties" in value
}

function decodeStoredSchema(json: string) {
  return Schema.decodeUnknownEffect(parseJsonSchema)(json).pipe(
    Effect.mapError(
      (e: Schema.SchemaError) => sqlError(`Invalid stored schema: ${e.message}`)
    ),
    Effect.flatMap((v) =>
      isCollectionSchema(v)
        ? Effect.succeed(v)
        : Effect.fail(sqlError("Invalid stored schema: missing properties"))
    )
  )
}

function encodeStoredSchema(schema: CollectionSchema) {
  return Schema.encodeEffect(parseJsonSchema)(schema).pipe(
    Effect.mapError(
      (e: Schema.SchemaError) => sqlError(`Failed to serialize schema: ${e.message}`)
    )
  )
}

const collectionsColumns: Array<ColumnDef> = [
  { name: "name", type: "text", nullable: false, primaryKey: true },
  { name: "schema", type: "text", nullable: false },
  { name: "updated_at", type: "text", nullable: false }
]

const migrationsColumns: Array<ColumnDef> = [
  { name: "id", type: "text", nullable: false, primaryKey: true },
  { name: "name", type: "text", nullable: false },
  { name: "steps", type: "text", nullable: false },
  { name: "applied_at", type: "text", nullable: false }
]

/** DDL steps to bootstrap the collection and migration metadata tables. */
export function systemTableSteps(
  schemaTable = "_collections",
  migrationsTable = "_migrations"
): Array<MigrationStep> {
  return [
    {
      kind: "createSystemTable",
      table: schemaTable,
      columns: collectionsColumns
    },
    {
      kind: "createSystemTable",
      table: migrationsTable,
      columns: migrationsColumns
    }
  ]
}

/** Default DDL steps for the app's `_collections` and `_migrations` tables. */
export const SYSTEM_TABLE_STEPS: Array<MigrationStep> = systemTableSteps()

const metadataFor = (options?: MigrateOptions) => ({
  schemaTable: options?.schemaTable ?? "_collections",
  migrationsTable: options?.migrationsTable ?? "_migrations"
})

/**
 * Effect `Context.Tag` for the migration service.
 * Provides three operations:
 * - `migrate` — apply all pending DDL steps inside a transaction.
 * - `plan` — dry-run diff returning the `MigrationPlan` without executing anything.
 * - `status` — per-collection status report (`"current"` | `"behind"` | `"ahead"`).
 *
 * Inject via `MigratorLive` layer.
 */
export class Migrator extends Context.Service<
  Migrator,
  {
    readonly migrate: (schemas: Array<NamedSchema>, options?: MigrateOptions) => Effect.Effect<void, MigrationError>
    readonly plan: (schemas: Array<NamedSchema>, options?: MigrateOptions) => Effect.Effect<MigrationPlan, MigrationError>
    readonly status: (
      schemas: Array<NamedSchema>,
      options?: MigrateOptions
    ) => Effect.Effect<Array<{ name: string; status: "current" | "ahead" | "behind" }>, MigrationError>
  }
>()("Migrator") {}

/** The stored and desired shape of every physical collection a plan may touch. */
function buildPlanContext(
  schemas: Array<NamedSchema>,
  stored: Record<string, CollectionSchema>,
  readonlyQuery: TranslatePlanContext["readonlyQuery"]
): TranslatePlanContext {
  const tables = new Map<string, TableShapes>()
  for (const { name, schema } of schemas) {
    if (schema["x-collection-kind"] === "view") continue
    const storedSchema = stored[name]
    tables.set(name, {
      stored:
        storedSchema === undefined
          ? null
          : { columns: schemaToColumns(storedSchema), indexes: schemaToIndexEntries(storedSchema) },
      desired: { columns: schemaToColumns(schema), indexes: schemaToIndexEntries(schema) }
    })
  }

  const views = new Map<string, ViewShape>()
  for (const { name, schema } of schemas) {
    if (schema["x-collection-kind"] !== "view") continue
    const storedSchema = stored[name]
    const storedQuery = storedSchema?.["x-view-query"]
    const desiredQuery = schema["x-view-query"]
    views.set(name, {
      stored: storedSchema === undefined ? null : { query: storedQuery ?? null },
      desired: {
        query: desiredQuery ?? null,
        properties: Object.keys(schema.properties)
      }
    })
  }
  for (const [name, schema] of Object.entries(stored)) {
    if (schema["x-collection-kind"] !== "view" || views.has(name)) continue
    views.set(name, {
      stored: { query: schema["x-view-query"] ?? null },
      desired: null
    })
  }

  return { tables, views, readonlyQuery }
}

/** A statement is only worth executing when it contains SQL, not just comments or whitespace. */
function isExecutable(statement: string) {
  const withoutComments = statement.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "")
  return withoutComments.trim().length > 0
}

/**
 * Renders a plan and rejects anything that could not be executed.
 *
 * Rendering runs inside the migration transaction, after the stored-schema read
 * and plan computation. A dialect check or statement check failure rolls the
 * transaction back, so no rendered statement executes.
 */
function renderPlan(
  dialect: DialectType,
  steps: ReadonlyArray<MigrationStep>,
  ctx: TranslatePlanContext
) {
  return Effect.gen(function* () {
    const translated = yield* dialect.translatePlan(steps, ctx)
    for (const statement of [...translated.statements, ...(translated.validations ?? [])]) {
      if (!isExecutable(statement)) {
        return yield* Effect.fail(new InvalidMigrationStatementError({ statement }))
      }
    }
    return translated
  })
}

/** Executes rendered statements in order, naming the statement that fails. */
function runStatements(sql: SqlClient.SqlClient, statements: ReadonlyArray<string>) {
  return Effect.gen(function* () {
    for (const statement of statements) {
      yield* Effect.logDebug(`SQL: ${statement}`)
      yield* sql.unsafe(statement).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* Effect.logError(`Failed SQL: ${statement}`)
            return yield* Effect.failCause(cause)
          })
        )
      )
    }
  })
}

/**
 * Runs the statements a dialect needs to restore connection-level state it mutated.
 *
 * Runs whether or not the transaction committed — a rollback skips any reset the plan
 * appended at its own end. A failure here is logged, never propagated: the migration
 * has already succeeded or failed on its own terms.
 */
function runCleanup(sql: SqlClient.SqlClient, statements: ReadonlyArray<string>) {
  return Effect.forEach(
    statements,
    (statement) =>
      sql.unsafe(statement).pipe(
        Effect.catchCause(() => Effect.logWarning(`Migration cleanup statement failed: ${statement}`))
      ),
    { discard: true }
  )
}

const MIGRATION_BUSY_MESSAGE = "A migration is in progress"

/**
 * Takes the dialect's non-blocking migration preview lock when it declares one.
 *
 * `plan` and `status` run this first inside their transaction. SQLite and
 * libSQL omit the lock, so their previews keep the existing behavior. A dialect
 * that supplies the statement returns one boolean `acquired` column; false or
 * an empty result means a migration holds the lock, and the preview fails
 * instead of waiting or racing the bootstrap.
 */
function acquireMigrationPreviewLock(
  sql: SqlClient.SqlClient,
  dialect: DialectType,
  operation: "plan" | "status"
) {
  const lockSql = dialect.migrationPreviewLockSql
  if (lockSql === undefined) {
    return Effect.void
  }
  return Effect.gen(function* () {
    const rows = yield* sql.unsafe<{ acquired: boolean | null }>(lockSql)
    const acquired = rows[0]?.acquired
    if (acquired !== true) {
      return yield* Effect.fail(
        new MigrationBusyError({ operation, message: MIGRATION_BUSY_MESSAGE })
      )
    }
  })
}

function migrateImplWith(
  sql: SqlClient.SqlClient,
  dialect: DialectType,
  schemas: Array<NamedSchema>,
  options?: MigrateOptions
) {
  const { schemaTable, migrationsTable } = metadataFor(options)
  // Rendering now happens inside the transaction, so the cleanup statements are
  // only known once the plan translates. The finalizer reads them after the
  // transaction settles on either the committed or the failed path.
  let cleanupStatements: ReadonlyArray<string> = []
  return Effect.gen(function* () {
    const transaction = sql.withTransaction(
      Effect.gen(function* () {
        yield* Effect.logDebug("Starting migration transaction")
        yield* runStatements(sql, dialect.migrationTransactionSetupSql ?? [])

        yield* Effect.logDebug("Creating system tables if not exist")
        yield* runStatements(
          sql,
          systemTableSteps(schemaTable, migrationsTable).flatMap((step) => dialect.translate(step))
        )

        yield* Effect.logInfo(`Migrating ${schemas.length} collections...`)
        const storedRows = yield* sql.unsafe<{ name: string; schema: string }>(
          `SELECT ${dialect.quoteIdentifier("name")}, ${dialect.quoteIdentifier("schema")} FROM ${dialect.quoteIdentifier(schemaTable)}`
        )
        const storedRecord: Record<string, CollectionSchema> = {}
        for (const row of storedRows) {
          storedRecord[row.name] = yield* decodeStoredSchema(row.schema)
        }
        yield* Effect.logDebug(`Stored schemas: ${Object.keys(storedRecord).length} found`)

        const plan = computePlan(schemas, storedRecord, options)
        yield* Effect.logDebug(`Diff: ${plan.steps.length} steps computed`)
        if (plan.steps.length === 0) {
          yield* Effect.logInfo("All collections up to date - nothing to migrate")
          return
        }
        yield* Effect.logInfo(`Migration plan: ${plan.steps.length} steps (destructive: ${plan.destructive})`)

        if (plan.destructive && !options?.allowDestructive) {
          yield* Effect.logWarning(
            "Destructive steps detected but allowDestructive is false - skipping. Re-run with allowDestructive: true to proceed."
          )
          for (const step of plan.steps.filter(isDestructiveStep)) {
            const tableLabel = "table" in step ? step.table : "unknown"
            yield* Effect.logWarning(`  Destructive step: ${step.kind} on ${tableLabel}`)
          }
          return
        }

        for (let i = 0; i < plan.steps.length; i++) {
          const step = plan.steps[i]
          yield* Effect.logInfo(
            `Step [${i + 1}/${plan.steps.length}]: ${step.kind} on ${"table" in step ? step.table : ""}`
          )
        }

        const translated = yield* renderPlan(
          dialect,
          plan.steps,
          buildPlanContext(schemas, storedRecord, makeReadonlyQueryGuard(sql))
        )
        cleanupStatements = translated.cleanup

        for (const note of translated.notes ?? []) {
          yield* Effect.logInfo(note)
        }

        const stepsJson = yield* Schema.encodeEffect(parseJsonSchema)(plan.steps).pipe(
          Effect.mapError((e: Schema.SchemaError) => sqlError(String(e)))
        )
        const schemaJsonByName = new Map<string, string>()
        for (const { name, schema } of schemas) {
          schemaJsonByName.set(name, yield* encodeStoredSchema(schema))
        }
        const migrationId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        const migrationName = schemas.map((s) => s.name).join(", ")

        yield* Effect.logDebug(`Steps: ${stepsJson}`)
        yield* runStatements(sql, translated.statements)
        yield* runStatements(sql, translated.validations ?? [])
        yield* sql`INSERT INTO ${sql(migrationsTable)} ${sql.insert({ id: migrationId, name: migrationName, steps: stepsJson, applied_at: new Date().toJSON() })}`

        for (const [name, schemaJson] of schemaJsonByName) {
          yield* Effect.logDebug(`Writing schema for ${name}`)
          yield* sql.unsafe(
            dialect.upsert(
              schemaTable,
              {
                name,
                schema: schemaJson,
                updated_at: new Date().toJSON()
              },
              ["name"]
            )
          )
        }
      })
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logError(`Migration failed: ${Cause.pretty(cause)}`).pipe(
          Effect.andThen(Effect.failCause(cause))
        )
      ),
      Effect.ensuring(Effect.suspend(() => runCleanup(sql, cleanupStatements)))
    )

    yield* transaction
    yield* Effect.logInfo(`Migration complete - ${schemas.length} collections migrated`)
  })
}

function planImplWith(
  sql: SqlClient.SqlClient,
  dialect: DialectType,
  schemas: Array<NamedSchema>,
  options?: MigrateOptions
) {
  const { schemaTable, migrationsTable } = metadataFor(options)
  return sql.withTransaction(
    Effect.gen(function* () {
      yield* Effect.logDebug("Computing migration plan (dry run)")
      yield* acquireMigrationPreviewLock(sql, dialect, "plan")

      yield* runStatements(
        sql,
        systemTableSteps(schemaTable, migrationsTable).flatMap((step) => dialect.translate(step))
      )

      const storedRows = yield* sql.unsafe<{ name: string; schema: string }>(
        `SELECT ${dialect.quoteIdentifier("name")}, ${dialect.quoteIdentifier("schema")} FROM ${dialect.quoteIdentifier(schemaTable)}`
      )
      const storedRecord: Record<string, CollectionSchema> = {}
      for (const row of storedRows) {
        storedRecord[row.name] = yield* decodeStoredSchema(row.schema)
      }
      const plan = computePlan(schemas, storedRecord, options)
      // Render (and reject) the plan here too, so a dry run surfaces an impossible plan
      // instead of leaving it to the next boot.
      const translated = yield* renderPlan(
        dialect,
        plan.steps,
        buildPlanContext(schemas, storedRecord, makeReadonlyQueryGuard(sql))
      )

      yield* Effect.logInfo(`Plan: ${plan.steps.length} steps`)
      const planJson = yield* Schema.encodeEffect(parseJsonSchema)(plan.steps).pipe(
        Effect.mapError((e: Schema.SchemaError) => sqlError(String(e)))
      )
      yield* Effect.logDebug(`Steps: ${planJson}`)
      return translated.notes !== undefined && translated.notes.length > 0
        ? { ...plan, notes: translated.notes }
        : plan
    })
  )
}

function statusImplWith(
  sql: SqlClient.SqlClient,
  dialect: DialectType,
  schemas: Array<NamedSchema>,
  options?: MigrateOptions
) {
  const { schemaTable, migrationsTable } = metadataFor(options)
  return sql.withTransaction(
    Effect.gen(function* () {
      yield* Effect.logDebug("Checking migration status")
      yield* acquireMigrationPreviewLock(sql, dialect, "status")

      yield* runStatements(
        sql,
        systemTableSteps(schemaTable, migrationsTable).flatMap((step) => dialect.translate(step))
      )

      const storedRows = yield* sql.unsafe<{ name: string; schema: string }>(
        `SELECT ${dialect.quoteIdentifier("name")}, ${dialect.quoteIdentifier("schema")} FROM ${dialect.quoteIdentifier(schemaTable)}`
      )
      const parsedEntries: Array<[string, CollectionSchema]> = []
      for (const r of storedRows) {
        parsedEntries.push([r.name, yield* decodeStoredSchema(r.schema)])
      }
      const stored = new Map(parsedEntries)

      const result: Array<{ name: string; status: "current" | "ahead" | "behind" }> = []
      for (const { name, schema: desired } of schemas) {
        const storedSchema = stored.get(name)
        if (!storedSchema) {
          result.push({ name, status: "behind" })
          yield* Effect.logDebug(`${name}: behind (not in stored)`)
        } else {
          const steps = diffSchemas(name, storedSchema, desired)
          if (steps.length === 0) {
            result.push({ name, status: "current" })
          } else {
            const hasNew = steps.some(
              (s) => s.kind === "addColumn" || s.kind === "createIndex" || s.kind === "createTable" || s.kind === "createView"
            )
            const hasRemoved = steps.some(
              (s) => s.kind === "dropColumn" || s.kind === "dropIndex" || s.kind === "dropTable" || s.kind === "dropView"
            )
            if (hasNew && hasRemoved) {
              result.push({ name, status: "behind" })
            } else if (hasNew) {
              result.push({ name, status: "behind" })
            } else {
              result.push({ name, status: "ahead" })
            }
          }
        }
      }
      return result
    })
  )
}

/**
 * Live `Layer` for `Migrator`. Requires `SqlClient.SqlClient` and `Dialect` in the environment.
 *
 * @example
 * const appLayer = MigratorLive.pipe(
 *   Layer.provideMerge(Layer.mergeAll(Layer.succeed(Dialect, sqliteDialect), SqliteClient.layer({ filename: "app.db" })))
 * )
 */
export const MigratorLive = Layer.effect(
  Migrator,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const dialect = yield* Dialect
    return {
      migrate: (schemas: Array<NamedSchema>, options?: MigrateOptions) => {
        const level = toEffectLogLevel(options?.logLevel)
        return migrateImplWith(sql, dialect, schemas, options).pipe(Effect.provideService(References.MinimumLogLevel, level))
      },
      plan: (schemas: Array<NamedSchema>, options?: MigrateOptions) => {
        const level = toEffectLogLevel(options?.logLevel)
        return planImplWith(sql, dialect, schemas, options).pipe(Effect.provideService(References.MinimumLogLevel, level))
      },
      status: (schemas: Array<NamedSchema>, options?: MigrateOptions) =>
        statusImplWith(sql, dialect, schemas, options)
    }
  })
)
