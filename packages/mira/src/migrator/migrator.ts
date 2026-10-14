import type { CollectionSchema } from "@gettersethya/mira-client"
import { Context, Effect, Layer, References, Schema } from "effect"
import { SqlClient, SqlError } from "effect/sql"

import type { DialectType, TranslatePlanContext } from "@/dialect/dialect.js"
import { Dialect } from "@/dialect/dialect.js"

import type { MigrationError } from "./errors.js"
import { InvalidMigrationStatementError } from "./errors.js"
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

function decodeStoredSchema(json: string) {
  return Schema.decodeUnknownEffect(parseJsonSchema)(json).pipe(
    Effect.mapError(
      (e: Schema.SchemaError) => sqlError(`Invalid stored schema: ${e.message}`)
    ),
    Effect.map((v) => v as CollectionSchema)
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

/** DDL steps to bootstrap the `_collections` and `_migrations` system tables on first run. */
export const SYSTEM_TABLE_STEPS: Array<MigrationStep> = [
  {
    kind: "createSystemTable",
    table: "_collections",
    columns: collectionsColumns
  },
  {
    kind: "createSystemTable",
    table: "_migrations",
    columns: migrationsColumns
  }
]

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
      schemas: Array<NamedSchema>
    ) => Effect.Effect<Array<{ name: string; status: "current" | "ahead" | "behind" }>, SqlError.SqlError>
  }
>()("Migrator") {}

/** The stored and desired shape of every physical collection a plan may touch. */
function buildPlanContext(
  schemas: Array<NamedSchema>,
  stored: Record<string, CollectionSchema>
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
  return { tables }
}

/** A statement is only worth executing when it contains SQL, not just comments or whitespace. */
function isExecutable(statement: string) {
  const withoutComments = statement.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "")
  return withoutComments.trim().length > 0
}

/**
 * Renders a plan and rejects anything that could not be executed.
 *
 * Both the dialect check and the statement check happen before the transaction
 * opens: an impossible plan must not reach the driver, and must not roll back a
 * transaction it never needed.
 */
function renderPlan(
  dialect: DialectType,
  steps: ReadonlyArray<MigrationStep>,
  ctx: TranslatePlanContext
) {
  return Effect.gen(function* () {
    const translated = yield* dialect.translatePlan(steps, ctx)
    for (const statement of translated.statements) {
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

function migrateImplWith(
  sql: SqlClient.SqlClient,
  dialect: DialectType,
  schemas: Array<NamedSchema>,
  options?: MigrateOptions
) {
  return Effect.gen(function* () {
    yield* Effect.logDebug("Creating system tables if not exist")
    yield* runStatements(
      sql,
      SYSTEM_TABLE_STEPS.flatMap((step) => dialect.translate(step))
    )

    yield* Effect.logInfo(`Migrating ${schemas.length} collections...`)
    const storedRows = yield* sql<{ name: string; schema: string }>`SELECT name, schema FROM _collections`
    const storedRecord: Record<string, CollectionSchema> = {}
    for (const row of storedRows) {
      storedRecord[row.name] = yield* decodeStoredSchema(row.schema)
    }
    yield* Effect.logDebug(`Stored schemas: ${Object.keys(storedRecord).length} found`)

    const plan = computePlan(schemas, storedRecord, options)
    yield* Effect.logDebug(`Diff: ${plan.steps.length} steps computed`)
    if (plan.steps.length === 0) {
      yield* Effect.logInfo("All collections up to date — nothing to migrate")
      return
    }
    yield* Effect.logInfo(`Migration plan: ${plan.steps.length} steps (destructive: ${plan.destructive})`)

    if (plan.destructive && !options?.allowDestructive) {
      yield* Effect.logWarning(
        "Destructive steps detected but allowDestructive is false — skipping. Re-run with allowDestructive: true to proceed."
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

    const { statements, cleanup } = yield* renderPlan(dialect, plan.steps, buildPlanContext(schemas, storedRecord))

    const transaction = Effect.gen(function* () {
      yield* Effect.logDebug("Starting transaction")
      yield* sql`BEGIN TRANSACTION`

      yield* Effect.catch(
        Effect.gen(function* () {
          const stepsJson = yield* Schema.encodeEffect(parseJsonSchema)(plan.steps).pipe(
            Effect.mapError((e: Schema.SchemaError) => sqlError(String(e)))
          )
          yield* Effect.logDebug(`Steps: ${stepsJson}`)
          yield* runStatements(sql, statements)
          const migrationId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
          const migrationName = schemas.map((s) => s.name).join(", ")
          yield* sql`INSERT INTO ${sql("_migrations")} ${sql.insert({ id: migrationId, name: migrationName, steps: stepsJson, applied_at: new Date().toJSON() })}`
          yield* sql`COMMIT`
        }),
        (e: SqlError.SqlError) =>
          Effect.gen(function* () {
            yield* sql`ROLLBACK`
            yield* Effect.logError(`Migration failed: ${String(e)}`)
            return yield* e
          })
      )
    })

    yield* transaction.pipe(Effect.ensuring(runCleanup(sql, cleanup)))

    for (const { name, schema } of schemas) {
      yield* Effect.logDebug(`Writing schema for ${name}`)
      const schemaJson = yield* encodeStoredSchema(schema)
      yield* sql`INSERT OR REPLACE INTO ${sql("_collections")} ${sql.insert({ name, schema: schemaJson, updated_at: new Date().toJSON() })}`
    }
    yield* Effect.logInfo(`Migration complete — ${schemas.length} collections migrated`)
  })
}

function planImplWith(
  sql: SqlClient.SqlClient,
  dialect: DialectType,
  schemas: Array<NamedSchema>,
  options?: MigrateOptions
) {
  return Effect.gen(function* () {
    yield* Effect.logDebug("Computing migration plan (dry run)")

    for (const step of SYSTEM_TABLE_STEPS) {
      for (const stmt of dialect.translate(step)) {
        yield* sql.unsafe(stmt)
      }
    }

    const storedRows = yield* sql<{ name: string; schema: string }>`SELECT name, schema FROM _collections`
    const storedRecord: Record<string, CollectionSchema> = {}
    for (const row of storedRows) {
      storedRecord[row.name] = yield* decodeStoredSchema(row.schema)
    }
    const plan = computePlan(schemas, storedRecord, options)
    // Render (and reject) the plan here too, so a dry run surfaces an impossible plan
    // instead of leaving it to the next boot.
    yield* renderPlan(dialect, plan.steps, buildPlanContext(schemas, storedRecord))

    yield* Effect.logInfo(`Plan: ${plan.steps.length} steps`)
    const planJson = yield* Schema.encodeEffect(parseJsonSchema)(plan.steps).pipe(
      Effect.mapError((e: Schema.SchemaError) => sqlError(String(e)))
    )
    yield* Effect.logDebug(`Steps: ${planJson}`)
    return plan
  })
}

function statusImplWith(sql: SqlClient.SqlClient, dialect: DialectType, schemas: Array<NamedSchema>) {
  return Effect.gen(function* () {
    yield* Effect.logDebug("Checking migration status")

    for (const step of SYSTEM_TABLE_STEPS) {
      for (const stmt of dialect.translate(step)) {
        yield* sql.unsafe(stmt)
      }
    }

    const storedRows = yield* sql<{ name: string; schema: string }>`SELECT name, schema FROM _collections`
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
      status: (schemas: Array<NamedSchema>) => statusImplWith(sql, dialect, schemas)
    }
  })
)
