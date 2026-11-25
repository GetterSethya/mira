import type { CollectionSchema } from "@gettersethya/mira-client"
import { Cause, Context, Effect, Exit, Layer, Option, References, Schema } from "effect"
import { SqlClient, SqlError } from "effect/sql"
import type { Connection } from "effect/sql/SqlConnection"

import type {
  MigrationDialect,
  MigrationModel,
  TranslatedPlan,
  TranslatePlanContext,
  ViewShape
} from "@/dialect/dialect.js"
import { Dialect } from "@/dialect/dialect.js"

import type { MigrationError } from "./errors.js"
import {
  InvalidMigrationStatementError,
  MigrationBusyError,
  MigrationRollbackError,
  UnsupportedMigrationStepError
} from "./errors.js"
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
  MigrationExecutor,
  MigrationPlan,
  MigrationRunner,
  MigrationStep,
  NamedSchema,
  TableShapes
} from "./types.js"
import { toEffectLogLevel } from "./types.js"

const parseJsonSchema = Schema.fromJsonString(Schema.Unknown)

/**
 * Total executions of the statement-mode apply loop: the initial attempt plus
 * up to five retries.
 *
 * A retry re-renders the whole plan against a fresh catalog, so each retry can
 * converge at most one conflicting statement. A competing boot that commits one
 * statement per attempt therefore needs about as many attempts as the plan has
 * statements. Five retries cover the largest plan this migrator emits with
 * margin; the backoff below gives the winner time to finish before each retry.
 */
const MAX_STATEMENT_MIGRATION_ATTEMPTS = 6

/**
 * Backoff before retry `attempt + 1`: 200 ms, 400 ms, 800 ms, 1.6 s, then a
 * 2 s cap. The growing gap lets the other migrator finish its remaining DDL so
 * the next catalog render sees a settled shape instead of racing it again.
 */
function statementRetryBackoff(attempt: number) {
  return Math.min(2000, 200 * 2 ** (attempt - 1))
}

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
  run: TranslatePlanContext["readonlyQuery"]
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
    return run(trimmed)
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
 * - `migrate` â€” apply all pending DDL steps.
 * - `plan` â€” dry-run diff returning the `MigrationPlan` without executing anything.
 * - `status` â€” per-collection status report (`"current"` | `"behind"` | `"ahead"`).
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
 * The dialect may read the catalog through `ctx.readonlyQuery` while rendering.
 * A statement-mode drift therefore fails before any plan DDL.
 */
function renderPlan(
  dialect: MigrationDialect,
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
function runStatements(executor: MigrationExecutor, statements: ReadonlyArray<string>) {
  return Effect.gen(function* () {
    for (const statement of statements) {
      yield* Effect.logDebug(`SQL: ${statement}`)
      yield* executor.run(statement).pipe(
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
 * Runs the statements a dialect needs to restore connection-level state it
 * mutated.
 *
 * Runs whether or not the migration succeeded. A failure here is logged, never
 * propagated: the migration has already succeeded or failed on its own terms.
 */
function runCleanup(executor: MigrationExecutor, statements: ReadonlyArray<string>) {
  return Effect.forEach(
    statements,
    (statement) =>
      executor.run(statement).pipe(
        Effect.catchCause(() => Effect.logWarning(`Migration cleanup statement failed: ${statement}`))
      ),
    { discard: true }
  )
}

/**
 * Restores session settings on the reserved connection. A failure is logged at
 * error because the connection returns to the pool with migration settings.
 */
function runSessionRestore(executor: MigrationExecutor, statements: ReadonlyArray<string>) {
  return Effect.forEach(
    statements,
    (statement) =>
      executor.run(statement).pipe(
        Effect.catchCause(() =>
          Effect.logError(`Migration session restore statement failed: ${statement}`)
        )
      ),
    { discard: true }
  )
}

const MIGRATION_BUSY_MESSAGE = "A migration is in progress"

/**
 * Takes the dialect's non-blocking migration preview lock when it declares one.
 *
 * `plan` and `status` run this first. A dialect that supplies the statement
 * returns one boolean `acquired` column; false or an empty result means a
 * migration holds the lock, and the preview fails instead of waiting or racing
 * the bootstrap.
 */
function acquireMigrationPreviewLock(
  executor: MigrationExecutor,
  dialect: MigrationDialect,
  operation: "plan" | "status"
) {
  const lockSql = dialect.migrationPreviewLockSql
  if (lockSql === undefined) {
    return Effect.void
  }
  return Effect.gen(function* () {
    const rows = yield* executor.query(lockSql)
    const acquired = rows[0]?.["acquired"]
    if (acquired !== true) {
      return yield* Effect.fail(
        new MigrationBusyError({ operation, message: MIGRATION_BUSY_MESSAGE })
      )
    }
  })
}

function readStoredSchemas(
  executor: MigrationExecutor,
  dialect: MigrationDialect,
  schemaTable: string
) {
  return Effect.gen(function* () {
    const rows = yield* executor.query(
      `SELECT ${dialect.quoteIdentifier("name")}, ${dialect.quoteIdentifier("schema")} FROM ${dialect.quoteIdentifier(schemaTable)}`
    )
    const storedRecord: Record<string, CollectionSchema> = {}
    for (const row of rows) {
      const name = row["name"]
      const schema = row["schema"]
      if (typeof name !== "string" || typeof schema !== "string") {
        return yield* Effect.fail(sqlError("Invalid stored schema row"))
      }
      storedRecord[name] = yield* decodeStoredSchema(schema)
    }
    return storedRecord
  })
}

function tableExists(
  executor: MigrationExecutor,
  dialect: MigrationDialect,
  table: string
) {
  if (dialect.migrationModel.kind !== "statement") {
    return Effect.succeed(true)
  }
  return executor
    .query(dialect.migrationModel.systemTableExistsSql(table))
    .pipe(Effect.map((rows) => rows.length > 0))
}

function readStoredSchemasIfPresent(
  executor: MigrationExecutor,
  dialect: MigrationDialect,
  schemaTable: string
) {
  return Effect.gen(function* () {
    const exists = yield* tableExists(executor, dialect, schemaTable)
    if (!exists) return {}
    return yield* readStoredSchemas(executor, dialect, schemaTable)
  })
}

const transactionalExecutor = (sql: SqlClient.SqlClient): MigrationExecutor => ({
  run: (statement) => sql.unsafe(statement).pipe(Effect.asVoid),
  runParameterized: (statement) =>
    sql.unsafe(statement.sql, [...statement.params]).pipe(Effect.asVoid),
  query: (statement) => sql.unsafe<Record<string, unknown>>(statement)
})

const connectionExecutor = (conn: Connection): MigrationExecutor => ({
  run: (statement) => conn.executeUnprepared(statement, [], undefined).pipe(Effect.asVoid),
  runParameterized: (statement) =>
    conn.executeUnprepared(statement.sql, [...statement.params], undefined).pipe(Effect.asVoid),
  query: (statement) => conn.executeUnprepared(statement, [], undefined)
})

const makeRunner = (
  executor: MigrationExecutor,
  model: Extract<MigrationModel, { kind: "statement" }>
): MigrationRunner => ({
  ...executor,
  begin: () => executor.run(model.transaction.beginSql),
  commit: () => executor.run(model.transaction.commitSql),
  rollback: () => executor.run(model.transaction.rollbackSql)
})

function migrateTransactional(
  sql: SqlClient.SqlClient,
  dialect: MigrationDialect,
  schemas: Array<NamedSchema>,
  options?: MigrateOptions
) {
  const { schemaTable, migrationsTable } = metadataFor(options)
  const executor = transactionalExecutor(sql)
  let cleanupStatements: ReadonlyArray<string> = []
  return Effect.gen(function* () {
    const transaction = sql.withTransaction(
      Effect.gen(function* () {
        yield* Effect.logDebug("Starting migration transaction")
        yield* runStatements(executor, dialect.migrationTransactionSetupSql ?? [])

        yield* Effect.logDebug("Creating system tables if not exist")
        yield* runStatements(
          executor,
          systemTableSteps(schemaTable, migrationsTable).flatMap((step) => dialect.translate(step))
        )

        yield* Effect.logInfo(`Migrating ${schemas.length} collections...`)
        const storedRecord = yield* readStoredSchemas(executor, dialect, schemaTable)
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
          buildPlanContext(schemas, storedRecord, makeReadonlyQueryGuard(executor.query))
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
        yield* runStatements(executor, translated.statements)
        yield* runStatements(executor, translated.validations ?? [])
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
      Effect.ensuring(Effect.suspend(() => runCleanup(executor, cleanupStatements)))
    )

    yield* transaction
    yield* Effect.logInfo(`Migration complete - ${schemas.length} collections migrated`)
  })
}

function writeStatementMetadata(
  runner: MigrationRunner,
  dialect: MigrationDialect,
  plan: MigrationPlan,
  schemas: Array<NamedSchema>,
  schemaTable: string,
  migrationsTable: string
) {
  return Effect.gen(function* () {
    const upsert = dialect.upsertStatement
    if (upsert === undefined) {
      return yield* Effect.fail(
        new UnsupportedMigrationStepError({
          step: "createTable",
          detail: "statement mode requires a parameterized upsertStatement"
        })
      )
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

    yield* runner.begin()
    const write = Effect.gen(function* () {
      yield* runner.runParameterized(
        upsert(
          migrationsTable,
          {
            id: migrationId,
            name: migrationName,
            steps: stepsJson,
            applied_at: new Date().toJSON()
          },
          ["id"]
        )
      )
      for (const [name, schemaJson] of schemaJsonByName) {
        yield* runner.runParameterized(
          upsert(
            schemaTable,
            { name, schema: schemaJson, updated_at: new Date().toJSON() },
            ["name"]
          )
        )
      }
      yield* runner.commit()
    })

    yield* write.pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          yield* runner.rollback().pipe(
            Effect.catchCause((rollbackCause) =>
              Effect.die(new MigrationRollbackError({ cause: Cause.pretty(rollbackCause) }))
            )
          )
          return yield* Effect.failCause(cause)
        })
      )
    )
  })
}

function migrateStatement(
  sql: SqlClient.SqlClient,
  dialect: MigrationDialect,
  schemas: Array<NamedSchema>,
  options?: MigrateOptions
) {
  const model = dialect.migrationModel
  if (model.kind !== "statement") {
    return Effect.void
  }
  const upsertStatement = dialect.upsertStatement
  const verifyPlan = dialect.verifyPlan
  if (upsertStatement === undefined || verifyPlan === undefined) {
    return Effect.fail(
      new UnsupportedMigrationStepError({
        step: "createTable",
        detail: "statement mode requires upsertStatement and verifyPlan"
      })
    )
  }

  const { schemaTable, migrationsTable } = metadataFor(options)

  return Effect.scoped(
    Effect.gen(function* () {
      const conn = yield* sql.reserve
      const executor = connectionExecutor(conn)
      const runner = makeRunner(executor, model)
      let cleanupStatements: ReadonlyArray<string> = []
      let previousSession: Record<string, unknown> | undefined

      const body = Effect.gen(function* () {
        const session = model.session
        if (session !== undefined) {
          const rows = yield* executor.query(session.readSql)
          previousSession = rows[0] ?? {}
          yield* runStatements(executor, session.setupSql)
        }

        yield* Effect.logDebug("Creating system tables if not exist")
        const systemTranslated = yield* renderPlan(dialect, systemTableSteps(schemaTable, migrationsTable), {
          tables: new Map(),
          views: new Map(),
          readonlyQuery: makeReadonlyQueryGuard(executor.query)
        })
        yield* runStatements(executor, systemTranslated.statements)

        yield* Effect.logInfo(`Migrating ${schemas.length} collections...`)
        const storedRecord = yield* readStoredSchemas(executor, dialect, schemaTable)
        yield* Effect.logDebug(`Stored schemas: ${Object.keys(storedRecord).length} found`)

        const plan = computePlan(schemas, storedRecord, options)
        yield* Effect.logDebug(`Diff: ${plan.steps.length} steps computed`)
        if (plan.steps.length === 0) {
          yield* Effect.logInfo("All collections up to date - nothing to migrate")
          return
        }
        yield* Effect.logInfo(`Migration plan: ${plan.steps.length} steps (destructive: ${plan.destructive})`)

        let applied: TranslatedPlan | undefined
        for (let attempt = 1; attempt <= MAX_STATEMENT_MIGRATION_ATTEMPTS; attempt++) {
          const translated = yield* renderPlan(
            dialect,
            plan.steps,
            buildPlanContext(schemas, storedRecord, makeReadonlyQueryGuard(executor.query))
          )
          cleanupStatements = translated.cleanup

          const skipped = translated.skipped
          if (skipped === undefined) {
            return yield* Effect.fail(
              new UnsupportedMigrationStepError({
                step: "createTable",
                detail: "statement mode requires TranslatedPlan.skipped"
              })
            )
          }
          const pending = plan.steps.filter((_, index) => !skipped.includes(index))

          if (pending.some(isDestructiveStep) && !options?.allowDestructive) {
            yield* Effect.logWarning(
              "Destructive steps detected but allowDestructive is false - skipping. Re-run with allowDestructive: true to proceed."
            )
            for (const step of pending.filter(isDestructiveStep)) {
              const tableLabel = "table" in step ? step.table : "unknown"
              yield* Effect.logWarning(`  Destructive step: ${step.kind} on ${tableLabel}`)
            }
            return
          }

          for (const note of translated.notes ?? []) {
            yield* Effect.logInfo(note)
          }

          if (translated.statements.length === 0) {
            applied = translated
            break
          }

          const exit = yield* Effect.exit(runStatements(executor, translated.statements))
          if (Exit.isSuccess(exit)) {
            applied = translated
            break
          }

          const failure = Cause.findErrorOption(exit.cause)
          if (
            attempt < MAX_STATEMENT_MIGRATION_ATTEMPTS &&
            Option.isSome(failure) &&
            model.isRetryableConflict(failure.value)
          ) {
            yield* Effect.logWarning(
              `Migration conflict on attempt ${attempt}/${MAX_STATEMENT_MIGRATION_ATTEMPTS}; re-rendering the catalog`
            )
            yield* Effect.sleep(statementRetryBackoff(attempt))
            continue
          }

          if (
            attempt >= MAX_STATEMENT_MIGRATION_ATTEMPTS &&
            Option.isSome(failure) &&
            model.isRetryableConflict(failure.value)
          ) {
            yield* Effect.logError(
              `Migration still conflicts after ${MAX_STATEMENT_MIGRATION_ATTEMPTS} attempts. ` +
                "A persistent lock wait is usually a long-running transaction holding a schema lock: " +
                "inspect the engine's lock tables, drain or cancel that transaction, then retry.",
              failure.value
            )
          }

          return yield* Effect.failCause(exit.cause)
        }

        if (applied === undefined) {
          return yield* Effect.fail(
            new UnsupportedMigrationStepError({
              step: "createTable",
              detail: "statement migration did not complete an apply attempt"
            })
          )
        }

        const verifyContext = buildPlanContext(
          schemas,
          storedRecord,
          makeReadonlyQueryGuard(executor.query)
        )
        yield* verifyPlan(plan.steps, verifyContext)
        yield* runStatements(executor, applied.validations ?? [])
        yield* writeStatementMetadata(
          runner,
          dialect,
          plan,
          schemas,
          schemaTable,
          migrationsTable
        )
      })

      const restore = Effect.gen(function* () {
        yield* runCleanup(executor, cleanupStatements)
        const session = model.session
        if (session !== undefined && previousSession !== undefined) {
          yield* runSessionRestore(executor, session.restoreSql(previousSession))
        }
      })

      yield* body.pipe(Effect.ensuring(restore))
      yield* Effect.logInfo(`Migration complete - ${schemas.length} collections migrated`)
    })
  )
}

function migrateImplWith(
  sql: SqlClient.SqlClient,
  dialect: MigrationDialect,
  schemas: Array<NamedSchema>,
  options?: MigrateOptions
) {
  return dialect.migrationModel.kind === "statement"
    ? migrateStatement(sql, dialect, schemas, options)
    : migrateTransactional(sql, dialect, schemas, options)
}

function migrateTransactionalPlan(
  sql: SqlClient.SqlClient,
  dialect: MigrationDialect,
  schemas: Array<NamedSchema>,
  options?: MigrateOptions
) {
  const { schemaTable, migrationsTable } = metadataFor(options)
  const executor = transactionalExecutor(sql)
  return sql.withTransaction(
    Effect.gen(function* () {
      yield* Effect.logDebug("Computing migration plan (dry run)")
      yield* acquireMigrationPreviewLock(executor, dialect, "plan")

      yield* runStatements(
        executor,
        systemTableSteps(schemaTable, migrationsTable).flatMap((step) => dialect.translate(step))
      )

      const storedRecord = yield* readStoredSchemas(executor, dialect, schemaTable)
      const plan = computePlan(schemas, storedRecord, options)
      const translated = yield* renderPlan(
        dialect,
        plan.steps,
        buildPlanContext(schemas, storedRecord, makeReadonlyQueryGuard(executor.query))
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

function withStatementPreview<A>(
  sql: SqlClient.SqlClient,
  dialect: MigrationDialect,
  operation: "plan" | "status",
  body: (executor: MigrationExecutor) => Effect.Effect<A, MigrationError>
): Effect.Effect<A, MigrationError> {
  const model = dialect.migrationModel
  if (model.kind !== "statement") {
    return Effect.fail(
      new UnsupportedMigrationStepError({
        step: "createView",
        detail: "statement preview requires a statement migration model"
      })
    )
  }
  const lock = dialect.migrationPreviewLockSql
  const unlock = dialect.migrationPreviewUnlockSql
  if ((lock === undefined) !== (unlock === undefined)) {
    return Effect.fail(
      new UnsupportedMigrationStepError({
        step: "createView",
        detail: "migrationPreviewLockSql and migrationPreviewUnlockSql must be supplied together"
      })
    )
  }

  return Effect.scoped(
    Effect.gen(function* () {
      const conn = yield* sql.reserve
      const executor = connectionExecutor(conn)
      const session = model.session
      let previous: Record<string, unknown> | undefined
      if (session !== undefined) {
        const rows = yield* executor.query(session.readSql)
        previous = rows[0] ?? {}
        yield* runStatements(executor, session.previewSetupSql ?? [])
      }
      if (lock !== undefined) {
        yield* acquireMigrationPreviewLock(executor, dialect, operation)
      }

      const restore = Effect.gen(function* () {
        if (unlock !== undefined) {
          yield* executor.run(unlock).pipe(
            Effect.catchCause(() => Effect.logWarning("Migration preview lock release failed"))
          )
        }
        if (session !== undefined && previous !== undefined) {
          yield* runSessionRestore(executor, session.restoreSql(previous))
        }
      })

      return yield* body(executor).pipe(Effect.ensuring(restore))
    })
  )
}

function planStatement(
  sql: SqlClient.SqlClient,
  dialect: MigrationDialect,
  schemas: Array<NamedSchema>,
  options?: MigrateOptions
) {
  const { schemaTable } = metadataFor(options)
  return withStatementPreview(sql, dialect, "plan", (executor) =>
    Effect.gen(function* () {
      const storedRecord = yield* readStoredSchemasIfPresent(executor, dialect, schemaTable)
      const plan = computePlan(schemas, storedRecord, options)
      const translated = yield* renderPlan(
        dialect,
        plan.steps,
        buildPlanContext(schemas, storedRecord, makeReadonlyQueryGuard(executor.query))
      )
      yield* Effect.logInfo(`Plan: ${plan.steps.length} steps`)
      return translated.notes !== undefined && translated.notes.length > 0
        ? { ...plan, notes: translated.notes }
        : plan
    })
  )
}

function statusFor(
  schemas: Array<NamedSchema>,
  stored: Record<string, CollectionSchema>
) {
  const storedMap = new Map(Object.entries(stored))
  const result: Array<{ name: string; status: "current" | "ahead" | "behind" }> = []
  for (const { name, schema: desired } of schemas) {
    const storedSchema = storedMap.get(name)
    if (!storedSchema) {
      result.push({ name, status: "behind" })
    } else {
      const steps = diffSchemas(name, storedSchema, desired)
      if (steps.length === 0) {
        result.push({ name, status: "current" })
      } else {
        const hasNew = steps.some(
          (s) =>
            s.kind === "addColumn" ||
            s.kind === "createIndex" ||
            s.kind === "createTable" ||
            s.kind === "createView"
        )
        result.push({ name, status: hasNew ? "behind" : "ahead" })
      }
    }
  }
  return result
}

function statusTransactional(
  sql: SqlClient.SqlClient,
  dialect: MigrationDialect,
  schemas: Array<NamedSchema>,
  options?: MigrateOptions
) {
  const { schemaTable, migrationsTable } = metadataFor(options)
  const executor = transactionalExecutor(sql)
  return sql.withTransaction(
    Effect.gen(function* () {
      yield* Effect.logDebug("Checking migration status")
      yield* acquireMigrationPreviewLock(executor, dialect, "status")

      yield* runStatements(
        executor,
        systemTableSteps(schemaTable, migrationsTable).flatMap((step) => dialect.translate(step))
      )

      const stored = yield* readStoredSchemas(executor, dialect, schemaTable)
      const result: Array<{ name: string; status: "current" | "ahead" | "behind" }> = []
      for (const { name, schema: desired } of schemas) {
        const storedSchema = stored[name]
        if (!storedSchema) {
          result.push({ name, status: "behind" })
          yield* Effect.logDebug(`${name}: behind (not in stored)`)
        } else {
          const steps = diffSchemas(name, storedSchema, desired)
          if (steps.length === 0) {
            result.push({ name, status: "current" })
          } else {
            const hasNew = steps.some(
              (s) =>
                s.kind === "addColumn" ||
                s.kind === "createIndex" ||
                s.kind === "createTable" ||
                s.kind === "createView"
            )
            result.push({ name, status: hasNew ? "behind" : "ahead" })
          }
        }
      }
      return result
    })
  )
}

function statusStatement(
  sql: SqlClient.SqlClient,
  dialect: MigrationDialect,
  schemas: Array<NamedSchema>,
  options?: MigrateOptions
) {
  const { schemaTable } = metadataFor(options)
  return withStatementPreview(sql, dialect, "status", (executor) =>
    Effect.gen(function* () {
      const storedRecord = yield* readStoredSchemasIfPresent(executor, dialect, schemaTable)
      const plan = computePlan(schemas, storedRecord, options)
      if (plan.steps.length > 0) {
        yield* renderPlan(
          dialect,
          plan.steps,
          buildPlanContext(schemas, storedRecord, makeReadonlyQueryGuard(executor.query))
        ).pipe(
          Effect.tap((translated) =>
            (translated.skipped?.length ?? 0) > 0
              ? Effect.logWarning("catalog ahead of metadata; run migrate to reconcile")
              : Effect.void
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning(`Migration status preview failed: ${Cause.pretty(cause)}`)
          )
        )
      }
      return statusFor(schemas, storedRecord)
    })
  )
}

function planImplWith(
  sql: SqlClient.SqlClient,
  dialect: MigrationDialect,
  schemas: Array<NamedSchema>,
  options?: MigrateOptions
) {
  return dialect.migrationModel.kind === "statement"
    ? planStatement(sql, dialect, schemas, options)
    : migrateTransactionalPlan(sql, dialect, schemas, options)
}

function statusImplWith(
  sql: SqlClient.SqlClient,
  dialect: MigrationDialect,
  schemas: Array<NamedSchema>,
  options?: MigrateOptions
) {
  return dialect.migrationModel.kind === "statement"
    ? statusStatement(sql, dialect, schemas, options)
    : statusTransactional(sql, dialect, schemas, options)
}

const makeMigrator = (sql: SqlClient.SqlClient, dialect: MigrationDialect) => ({
  migrate: (schemas: Array<NamedSchema>, options?: MigrateOptions) => {
    const level = toEffectLogLevel(options?.logLevel)
    return migrateImplWith(sql, dialect, schemas, options).pipe(
      Effect.provideService(References.MinimumLogLevel, level)
    )
  },
  plan: (schemas: Array<NamedSchema>, options?: MigrateOptions) => {
    const level = toEffectLogLevel(options?.logLevel)
    return planImplWith(sql, dialect, schemas, options).pipe(
      Effect.provideService(References.MinimumLogLevel, level)
    )
  },
  status: (schemas: Array<NamedSchema>, options?: MigrateOptions) =>
    statusImplWith(sql, dialect, schemas, options)
})

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
    return makeMigrator(sql, dialect)
  })
)

/**
 * Internal factory for a narrow migration dialect, used by the MySQL E2E suite.
 * Not re-exported from the migrator barrel.
 */
export const makeMigratorLive = (dialect: MigrationDialect) =>
  Layer.effect(
    Migrator,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      return makeMigrator(sql, dialect)
    })
  )
