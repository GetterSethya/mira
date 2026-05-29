import { SqlClient, SqlError } from "@effect/sql"
import { Context, Effect, Layer, Logger, ParseResult, Schema } from "effect"
import type { CollectionSchema } from "@gettersethya/mira-client"
import { computePlan, diffSchemas } from "./schema-diff.js"
import type { DialectType } from "./dialect.js"
import { Dialect } from "./dialect.js"
import type { ColumnDef, MigrationPlan, MigrationStep, MigrateOptions, NamedSchema } from "./types.js"
import { toEffectLogLevel } from "./types.js"

const parseJsonSchema = Schema.parseJson()

function decodeStoredSchema(json: string) {
  return Schema.decodeUnknown(parseJsonSchema)(json).pipe(
    Effect.mapError(
      (e: ParseResult.ParseError) => new SqlError.SqlError({ message: `Invalid stored schema: ${e.message}` })
    ),
    Effect.map((v) => v as CollectionSchema)
  )
}

function encodeStoredSchema(schema: CollectionSchema) {
  return Schema.encode(parseJsonSchema)(schema).pipe(
    Effect.mapError(
      (e: ParseResult.ParseError) => new SqlError.SqlError({ message: `Failed to serialize schema: ${e.message}` })
    )
  )
}

const collectionsColumns: ColumnDef[] = [
  { name: "name", type: "text", nullable: false, primaryKey: true },
  { name: "schema", type: "text", nullable: false },
  { name: "updated_at", type: "text", nullable: false }
]

const migrationsColumns: ColumnDef[] = [
  { name: "id", type: "text", nullable: false, primaryKey: true },
  { name: "name", type: "text", nullable: false },
  { name: "steps", type: "text", nullable: false },
  { name: "applied_at", type: "text", nullable: false }
]

/** DDL steps to bootstrap the `_collections` and `_migrations` system tables on first run. */
export const SYSTEM_TABLE_STEPS: MigrationStep[] = [
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
export class Migrator extends Context.Tag("Migrator")<
  Migrator,
  {
    readonly migrate: (schemas: NamedSchema[], options?: MigrateOptions) => Effect.Effect<void, SqlError.SqlError>
    readonly plan: (schemas: NamedSchema[], options?: MigrateOptions) => Effect.Effect<MigrationPlan, SqlError.SqlError>
    readonly status: (
      schemas: NamedSchema[]
    ) => Effect.Effect<Array<{ name: string; status: "current" | "ahead" | "behind" }>, SqlError.SqlError>
  }
>() {}

function migrateImplWith(
  sql: SqlClient.SqlClient,
  dialect: DialectType,
  schemas: NamedSchema[],
  options?: MigrateOptions
) {
  return Effect.gen(function* () {
    yield* Effect.logDebug("Creating system tables if not exist")
    for (const step of SYSTEM_TABLE_STEPS) {
      for (const stmt of dialect.translate(step)) {
        yield* Effect.logDebug(`SQL: ${stmt}`)
        yield* sql.unsafe(stmt)
      }
    }

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
      for (const step of plan.steps) {
        if (step.kind === "dropTable" || step.kind === "dropColumn" || step.kind === "alterColumn") {
          const tableLabel = "table" in step ? step.table : "unknown"
          yield* Effect.logWarning(`  Destructive step: ${step.kind} on ${tableLabel}`)
        }
      }
      return
    }

    yield* Effect.logDebug("Starting transaction")
    yield* sql`BEGIN TRANSACTION`

    yield* Effect.catchAll(
      Effect.gen(function* () {
        for (let i = 0; i < plan.steps.length; i++) {
          const step = plan.steps[i]
          yield* Effect.logInfo(
            `Step [${i + 1}/${plan.steps.length}]: ${step.kind} on ${"table" in step ? step.table : ""}`
          )
          const stepJson = yield* Schema.encode(parseJsonSchema)(step).pipe(
            Effect.mapError((e: ParseResult.ParseError) => new SqlError.SqlError({ message: String(e) }))
          )
          yield* Effect.logDebug(`Step details: ${stepJson}`)
          for (const stmt of dialect.translate(step)) {
            yield* Effect.logDebug(`SQL: ${stmt}`)
            yield* sql.unsafe(stmt)
          }
          yield* Effect.logDebug(`Step ${i + 1} applied successfully`)
        }
        const stepsJson = yield* Schema.encode(parseJsonSchema)(plan.steps).pipe(
          Effect.mapError((e: ParseResult.ParseError) => new SqlError.SqlError({ message: String(e) }))
        )
        const migrationId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        const migrationName = schemas.map((s) => s.name).join(", ")
        yield* sql`INSERT INTO ${sql("_migrations")} ${sql.insert({ id: migrationId, name: migrationName, steps: stepsJson, applied_at: new Date().toJSON() })}`
        yield* sql`COMMIT`
      }),
      (e: SqlError.SqlError) =>
        Effect.gen(function* () {
          yield* sql`ROLLBACK`
          yield* Effect.logError(`Migration failed at step: ${String(e)}`)
          return yield* e
        })
    )

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
  schemas: NamedSchema[],
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

    yield* Effect.logInfo(`Plan: ${plan.steps.length} steps`)
    const planJson = yield* Schema.encode(parseJsonSchema)(plan.steps).pipe(
      Effect.mapError((e: ParseResult.ParseError) => new SqlError.SqlError({ message: String(e) }))
    )
    yield* Effect.logDebug(`Steps: ${planJson}`)
    return plan
  })
}

function statusImplWith(sql: SqlClient.SqlClient, dialect: DialectType, schemas: NamedSchema[]) {
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
      migrate: (schemas: NamedSchema[], options?: MigrateOptions) => {
        const level = toEffectLogLevel(options?.logLevel)
        return migrateImplWith(sql, dialect, schemas, options).pipe(Logger.withMinimumLogLevel(level))
      },
      plan: (schemas: NamedSchema[], options?: MigrateOptions) => {
        const level = toEffectLogLevel(options?.logLevel)
        return planImplWith(sql, dialect, schemas, options).pipe(Logger.withMinimumLogLevel(level))
      },
      status: (schemas: NamedSchema[]) => statusImplWith(sql, dialect, schemas)
    }
  })
)
