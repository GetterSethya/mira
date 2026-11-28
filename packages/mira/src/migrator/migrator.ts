import type { CollectionSchema } from "@gettersethya/mira-client"
import { Cause, Context, Duration, Effect, Exit, Layer, Option, Ref, References, Schema } from "effect"
import type { Scope } from "effect"
import { SqlClient, SqlError } from "effect/sql"
import type { Connection } from "effect/sql/SqlConnection"

import type {
  LockConnection,
  MigrationDialect,
  MigrationLock,
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
  MigrationLockError,
  MigrationLockReleaseError,
  MigrationRollbackError,
  UnsupportedMigrationStepError
} from "./errors.js"
import {
  boundLockName,
  classifyAcquire,
  databaseNameFromRows,
  isHeldByThisSession,
  isSessionLoss,
  resolveLockTimeoutSeconds
} from "./lock.js"
import {
  computePlan,
  diffSchemas,
  isDestructiveStep,
  keyedFieldNames,
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
function makeReadonlyQueryGuard(run: TranslatePlanContext["readonlyQuery"]): TranslatePlanContext["readonlyQuery"] {
  return (statement) => {
    const trimmed = statement.trim()
    const firstToken = trimmed.split(/\s+/, 1)[0]?.toUpperCase() ?? ""
    if (firstToken !== "SELECT") {
      return Effect.fail(sqlError(`readonlyQuery rejected a statement that does not start with SELECT: ${trimmed}`))
    }
    if (trimmed.includes(";")) {
      return Effect.fail(sqlError(`readonlyQuery rejected a statement containing a semicolon: ${trimmed}`))
    }
    return run(trimmed)
  }
}

function isCollectionSchema(value: unknown): value is CollectionSchema {
  return typeof value === "object" && value !== null && "properties" in value
}

function decodeStoredSchema(json: string) {
  return Schema.decodeEffect(parseJsonSchema)(json).pipe(
    Effect.mapError((e: Schema.SchemaError) => sqlError(`Invalid stored schema: ${e.message}`)),
    Effect.filterOrFail(isCollectionSchema, () => sqlError("Invalid stored schema: missing properties"))
  )
}

function encodeStoredSchema(schema: CollectionSchema) {
  return Schema.encodeEffect(parseJsonSchema)(schema).pipe(
    Effect.mapError((e: Schema.SchemaError) => sqlError(`Failed to serialize schema: ${e.message}`))
  )
}

const collectionsColumns: Array<ColumnDef> = [
  { name: "name", type: "text", nullable: false, primaryKey: true, maxLength: 255 },
  { name: "schema", type: "text", nullable: false },
  { name: "updated_at", type: "text", nullable: false }
]

const migrationsColumns: Array<ColumnDef> = [
  { name: "id", type: "text", nullable: false, primaryKey: true, maxLength: 255 },
  { name: "name", type: "text", nullable: false },
  { name: "steps", type: "text", nullable: false },
  { name: "applied_at", type: "text", nullable: false }
]

/** DDL steps to bootstrap the collection and migration metadata tables. */
export function systemTableSteps(schemaTable = "_collections", migrationsTable = "_migrations"): Array<MigrationStep> {
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

const compareTextFor = (dialect: MigrationDialect) => dialect.reconcilesTextLength === true

const planOptionsFor = (dialect: MigrationDialect, options?: MigrateOptions) => ({
  ...options,
  compareTextLength: compareTextFor(dialect)
})

const auditTextShapeSafe = (
  dialect: MigrationDialect,
  ctx: TranslatePlanContext
): Effect.Effect<ReadonlyArray<string>> =>
  dialect.auditTextShape === undefined
    ? Effect.succeed([])
    : dialect
        .auditTextShape(ctx)
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning(`Text-shape audit failed: ${Cause.pretty(cause)}`).pipe(Effect.as([]))
          )
        )

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
    readonly plan: (
      schemas: Array<NamedSchema>,
      options?: MigrateOptions
    ) => Effect.Effect<MigrationPlan, MigrationError>
    readonly status: (
      schemas: Array<NamedSchema>,
      options?: MigrateOptions
    ) => Effect.Effect<Array<{ name: string; status: "current" | "ahead" | "behind" }>, MigrationError>
  }
>()("Migrator") {}

/** The stored and desired shape of every physical collection a plan may touch. */
export function buildPlanContext(
  schemas: Array<NamedSchema>,
  stored: Record<string, CollectionSchema>,
  readonlyQuery: TranslatePlanContext["readonlyQuery"],
  skipDataPreflight = false
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

  return { tables, views, readonlyQuery, skipDataPreflight }
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
function renderPlan(dialect: MigrationDialect, steps: ReadonlyArray<MigrationStep>, ctx: TranslatePlanContext) {
  return Effect.gen(function* () {
    const translated = yield* dialect.translatePlan(steps, ctx)
    for (const statement of [...translated.statements, ...(translated.validations ?? [])]) {
      if (!isExecutable(statement)) {
        return yield* new InvalidMigrationStatementError({ statement })
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
      executor
        .run(statement)
        .pipe(Effect.catchCause(() => Effect.logWarning(`Migration cleanup statement failed: ${statement}`))),
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
      executor
        .run(statement)
        .pipe(Effect.catchCause(() => Effect.logError(`Migration session restore statement failed: ${statement}`))),
    { discard: true }
  )
}

const MIGRATION_BUSY_MESSAGE = "A migration is in progress"
const LOCK_STEP_TIMEOUT = "2 seconds"
const HEARTBEAT_QUERY_TIMEOUT = "10 seconds"
const MAX_LOCK_CLEAR_ATTEMPTS = 8

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "object" && error !== null) {
    if ("message" in error && typeof error.message === "string") return error.message
    if ("cause" in error && typeof error.cause === "string") return error.cause
  }
  return String(error)
}

function readDatabaseNameRaw(executor: MigrationExecutor, lock: MigrationLock) {
  return executor.query(lock.databaseNameSql).pipe(
    Effect.map(databaseNameFromRows),
    Effect.mapError(
      (cause) =>
        new MigrationLockError({
          detail: `Could not read the current database: ${describeError(cause)}`
        })
    )
  )
}

/** Reads the database name and fails before acquiring when none is selected. */
export function readDatabaseName(
  executor: MigrationExecutor,
  lock: MigrationLock
): Effect.Effect<string, MigrationLockError> {
  return Effect.gen(function* () {
    const name = yield* readDatabaseNameRaw(executor, lock)
    if (name === null) {
      return yield* new MigrationLockError({
        detail: "No database is selected on the connection; include a database in the URL"
      })
    }
    return name
  })
}

/** Rejects a dedicated lock connection pointed at a different database than the DDL connection. */
export function assertSameDatabase(
  lockExecutor: MigrationExecutor,
  ddlExecutor: MigrationExecutor,
  lock: MigrationLock
): Effect.Effect<void, MigrationLockError> {
  return Effect.gen(function* () {
    const lockDb = yield* readDatabaseNameRaw(lockExecutor, lock)
    const ddlDb = yield* readDatabaseNameRaw(ddlExecutor, lock)
    if (lockDb !== null && ddlDb !== null && lockDb !== ddlDb) {
      return yield* new MigrationLockError({
        detail:
          `The dedicated lock connection targets database '${lockDb}' but the DDL connection ` +
          `targets '${ddlDb}'; the lock would not protect the migration target.`
      })
    }
  })
}

function isHeldByLock(
  executor: MigrationExecutor,
  lock: MigrationLock,
  name: string
): Effect.Effect<boolean, MigrationLockError> {
  return executor.queryParameterized(lock.usedStatement(name)).pipe(
    Effect.map((rows) => isHeldByThisSession(rows[0]?.["held_by_me"])),
    Effect.mapError(
      (cause) =>
        new MigrationLockError({
          detail: `Migration lock '${name}' could not be verified: ${describeError(cause)}`
        })
    )
  )
}

/** Never fails; an unreadable state is treated as still held unless the session is gone. */
function isHeldByLockSafe(executor: MigrationExecutor, lock: MigrationLock, name: string): Effect.Effect<boolean> {
  return Effect.exit(isHeldByLock(executor, lock, name)).pipe(
    Effect.map((exit) => (Exit.isSuccess(exit) ? exit.value : !isSessionLoss(exit.cause)))
  )
}

/** Reads the holder connection id for diagnostics; errors are ignored. */
function holderId(executor: MigrationExecutor, lock: MigrationLock, name: string): Effect.Effect<string | undefined> {
  return executor.queryParameterized(lock.holderStatement(name)).pipe(
    Effect.map((rows) => {
      const value = rows[0]?.["holder"]
      if (typeof value === "number") return String(value)
      if (typeof value === "bigint") return value.toString()
      if (typeof value === "string") return value
      return undefined
    }),
    Effect.catchCause(() => Effect.undefined)
  )
}

/**
 * Acquires the session lock, failing busy on `0` and with a lock error on any
 * other value. SQL failures are wrapped with an engine-support hint.
 */
export function acquireSessionLock(
  executor: MigrationExecutor,
  lock: MigrationLock,
  name: string,
  timeoutSeconds: number,
  operation: "plan" | "status" | "migrate"
): Effect.Effect<void, MigrationBusyError | MigrationLockError> {
  return Effect.gen(function* () {
    const rows = yield* executor.queryParameterized(lock.acquireStatement(name, timeoutSeconds)).pipe(
      Effect.mapError(
        (cause) =>
          new MigrationLockError({
            detail:
              `Migration lock '${name}' could not be acquired: ${describeError(cause)}. ` +
              "Check that the engine or proxy supports GET_LOCK."
          })
      )
    )
    const value = rows[0]?.["acquired"]
    const result = classifyAcquire(value)
    if (result === "acquired") return
    if (result === "busy") {
      const holder = yield* holderId(executor, lock, name)
      const base =
        operation === "migrate"
          ? `A migration is in progress: migration lock '${name}' was not acquired within ${timeoutSeconds}s`
          : `${operation} cannot run: a migration or preview holds lock '${name}'`
      return yield* new MigrationBusyError({
        operation,
        message: holder === undefined ? base : `${base} (holder ${holder})`
      })
    }
    return yield* new MigrationLockError({
      detail: `Migration lock '${name}' returned an unexpected result: ${String(value)}`
    })
  })
}

/**
 * Clears only the Mira lock name on the reserved connection, repeating while the
 * same connection still holds it. Other user locks are never touched.
 */
export function clearReservedName(
  executor: MigrationExecutor,
  lock: MigrationLock,
  name: string
): Effect.Effect<number, MigrationLockError> {
  return Effect.gen(function* () {
    let cleared = 0
    for (let attempt = 0; attempt < MAX_LOCK_CLEAR_ATTEMPTS; attempt++) {
      const held = yield* isHeldByLock(executor, lock, name)
      if (!held) return cleared
      yield* executor.queryParameterized(lock.releaseStatement(name)).pipe(
        Effect.mapError(
          (cause) =>
            new MigrationLockError({
              detail: `Migration lock '${name}' could not be cleared: ${describeError(cause)}`
            })
        )
      )
      cleared++
    }
    const stillHeld = yield* isHeldByLock(executor, lock, name)
    if (stillHeld) {
      return yield* new MigrationLockError({
        detail: `Migration lock '${name}' is still held by this connection after eight releases.`
      })
    }
    return cleared
  })
}

export type LockReleaseResult = {
  readonly released: boolean
  readonly killed: boolean
}

/**
 * Releases the lock, verifies that this connection no longer owns it, and falls
 * back to killing the holder session. Never fails; a lost session counts as
 * released because the server has ended it.
 */
export function releaseSessionLock(
  executor: MigrationExecutor,
  lock: MigrationLock,
  name: string
): Effect.Effect<LockReleaseResult> {
  return Effect.gen(function* () {
    const releaseExit = yield* Effect.exit(executor.queryParameterized(lock.releaseStatement(name)))
    if (Exit.isFailure(releaseExit) && isSessionLoss(releaseExit.cause)) {
      return { released: true, killed: false }
    }
    const held = yield* isHeldByLockSafe(executor, lock, name)
    if (!held) return { released: true, killed: false }
    if (lock.killSelfStatement !== undefined) {
      yield* Effect.exit(executor.queryParameterized(lock.killSelfStatement)).pipe(Effect.asVoid)
      return { released: false, killed: true }
    }
    return { released: false, killed: false }
  })
}

type LockHandle = {
  readonly name: string
  readonly executor: MigrationExecutor
  readonly dedicated: LockConnection | undefined
  readonly heartbeatStop: Ref.Ref<boolean>
  readonly lockLost: Ref.Ref<boolean>
}

function resolveTimeoutSeconds(
  lock: MigrationLock,
  options: MigrateOptions | undefined
): Effect.Effect<number, MigrationLockError> {
  const resolved = resolveLockTimeoutSeconds(options?.migrationLockTimeoutSeconds, lock.defaultTimeoutSeconds)
  if ("detail" in resolved) {
    return Effect.fail(new MigrationLockError({ detail: resolved.detail }))
  }
  return Effect.succeed(resolved.seconds)
}

function startLockHeartbeat(
  executor: MigrationExecutor,
  intervalSeconds: number,
  stop: Ref.Ref<boolean>,
  lost: Ref.Ref<boolean>
): Effect.Effect<void> {
  return Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep(Duration.seconds(intervalSeconds))
      if (yield* Ref.get(stop)) return
      const exit = yield* Effect.exit(executor.query("SELECT 1 AS ok").pipe(Effect.timeout(HEARTBEAT_QUERY_TIMEOUT)))
      if (Exit.isFailure(exit)) {
        yield* Ref.set(lost, true)
        return
      }
    }
  })
}

/**
 * Opens the dedicated lock connection when the dialect supplies one, resolves
 * the lock name, and clears a stale instance. It does not acquire; the caller
 * records the handle before acquiring so an interrupted acquire can still be
 * released by the finalizer.
 */
function prepareLockHandle(
  lock: MigrationLock,
  ddlExecutor: MigrationExecutor
): Effect.Effect<LockHandle, MigrationError, Scope.Scope> {
  return Effect.gen(function* () {
    let dedicated: LockConnection | undefined
    if (lock.openConnection !== undefined) {
      dedicated = yield* lock.openConnection.pipe(
        Effect.mapError(
          (cause) =>
            new MigrationLockError({
              detail: `Could not open the dedicated lock connection: ${describeError(cause)}`
            })
        )
      )
    }
    const lockExecutor = dedicated?.executor ?? ddlExecutor
    if (dedicated !== undefined) {
      yield* assertSameDatabase(lockExecutor, ddlExecutor, lock)
    }
    const databaseName = yield* readDatabaseName(lockExecutor, lock)
    const name = boundLockName(lock, databaseName)
    const cleared = yield* clearReservedName(lockExecutor, lock, name)
    if (cleared > 0) {
      yield* Effect.logWarning(
        `Cleared ${cleared} stale instance(s) of migration lock '${name}' on the holder connection`
      )
    }
    yield* Effect.logDebug(`Resolved migration lock '${name}' for database '${databaseName}'`)

    const heartbeatStop = yield* Ref.make(false)
    const lockLost = yield* Ref.make(false)
    return { name, executor: lockExecutor, dedicated, heartbeatStop, lockLost }
  })
}

function startHeartbeatFor(handle: LockHandle, lock: MigrationLock) {
  if (handle.dedicated === undefined) return Effect.void
  const interval = lock.heartbeatIntervalSeconds ?? 60
  return Effect.forkScoped(startLockHeartbeat(handle.executor, interval, handle.heartbeatStop, handle.lockLost)).pipe(
    Effect.asVoid
  )
}

function lockLost(name: string, where: string): MigrationLockError {
  return new MigrationLockError({
    detail: `Migration lock '${name}' was lost ${where}; the plan is not recorded.`
  })
}

function assertLockHeld(handle: LockHandle, lock: MigrationLock, where: string): Effect.Effect<void, MigrationError> {
  return Effect.gen(function* () {
    const lost = yield* Ref.get(handle.lockLost)
    if (lost) return yield* lockLost(handle.name, where)
    const held = yield* isHeldByLock(handle.executor, lock, handle.name)
    if (!held) return yield* lockLost(handle.name, where)
  })
}

/**
 * Runs rendered statements in order and checks the heartbeat flag and holder
 * after each one. The current statement is allowed to finish.
 */
function runStatementsWithLockCheck(
  executor: MigrationExecutor,
  statements: ReadonlyArray<string>,
  check: (statementIndex: number) => Effect.Effect<void, MigrationError>
) {
  return Effect.gen(function* () {
    for (let index = 0; index < statements.length; index++) {
      const statement = statements[index]
      if (statement === undefined) continue
      yield* Effect.logDebug(`SQL: ${statement}`)
      yield* executor.run(statement).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* Effect.logError(`Failed SQL: ${statement}`)
            return yield* Effect.failCause(cause)
          })
        )
      )
      yield* check(index + 1)
    }
  })
}

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
      return yield* new MigrationBusyError({ operation, message: MIGRATION_BUSY_MESSAGE })
    }
  })
}

function readStoredSchemas(executor: MigrationExecutor, dialect: MigrationDialect, schemaTable: string) {
  return Effect.gen(function* () {
    const rows = yield* executor.query(
      `SELECT ${dialect.quoteIdentifier("name")}, ${dialect.quoteIdentifier("schema")} FROM ${dialect.quoteIdentifier(schemaTable)}`
    )
    const storedRecord: Record<string, CollectionSchema> = {}
    for (const row of rows) {
      const name = row["name"]
      const schema = row["schema"]
      if (typeof name !== "string" || typeof schema !== "string") {
        return yield* sqlError("Invalid stored schema row")
      }
      storedRecord[name] = yield* decodeStoredSchema(schema)
    }
    return storedRecord
  })
}

function tableExists(executor: MigrationExecutor, dialect: MigrationDialect, table: string) {
  if (dialect.migrationModel.kind !== "statement") {
    return Effect.succeed(true)
  }
  return executor.query(dialect.migrationModel.systemTableExistsSql(table)).pipe(Effect.map((rows) => rows.length > 0))
}

function readStoredSchemasIfPresent(executor: MigrationExecutor, dialect: MigrationDialect, schemaTable: string) {
  return Effect.gen(function* () {
    const exists = yield* tableExists(executor, dialect, schemaTable)
    if (!exists) return {}
    return yield* readStoredSchemas(executor, dialect, schemaTable)
  })
}

const transactionalExecutor = (sql: SqlClient.SqlClient): MigrationExecutor => ({
  run: (statement) => sql.unsafe(statement).pipe(Effect.asVoid),
  runParameterized: (statement) => sql.unsafe(statement.sql, [...statement.params]).pipe(Effect.asVoid),
  query: (statement) => sql.unsafe<Record<string, unknown>>(statement),
  queryParameterized: (statement) => sql.unsafe<Record<string, unknown>>(statement.sql, [...statement.params])
})

const connectionExecutor = (conn: Connection): MigrationExecutor => ({
  run: (statement) => conn.executeUnprepared(statement, [], undefined).pipe(Effect.asVoid),
  runParameterized: (statement) =>
    conn.executeUnprepared(statement.sql, [...statement.params], undefined).pipe(Effect.asVoid),
  query: (statement) => conn.executeUnprepared(statement, [], undefined),
  queryParameterized: (statement) => conn.executeUnprepared(statement.sql, [...statement.params], undefined)
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
    const transaction = sql
      .withTransaction(
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

          const plan = computePlan(schemas, storedRecord, planOptionsFor(dialect, options))
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
      )
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logError(`Migration failed: ${Cause.pretty(cause)}`).pipe(Effect.andThen(Effect.failCause(cause)))
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
      return yield* new UnsupportedMigrationStepError({
        step: "createTable",
        detail: "statement mode requires a parameterized upsertStatement"
      })
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
          upsert(schemaTable, { name, schema: schemaJson, updated_at: new Date().toJSON() }, ["name"])
        )
      }
      yield* runner.commit()
    })

    yield* write.pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          yield* runner
            .rollback()
            .pipe(
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
  const lockConfig = model.lock

  return Effect.scoped(
    Effect.gen(function* () {
      const conn = yield* sql.reserve
      const ddlExecutor = connectionExecutor(conn)
      const runner = makeRunner(ddlExecutor, model)
      let cleanupStatements: ReadonlyArray<string> = []
      let previousSession: Record<string, unknown> | undefined
      let handle: LockHandle | undefined

      const body = Effect.gen(function* () {
        const session = model.session
        if (session !== undefined) {
          const rows = yield* ddlExecutor.query(session.readSql)
          previousSession = rows[0] ?? {}
          yield* runStatements(ddlExecutor, session.setupSql)
        }

        if (lockConfig !== undefined) {
          const timeoutSeconds = yield* resolveTimeoutSeconds(lockConfig, options)
          const prepared = yield* prepareLockHandle(lockConfig, ddlExecutor)
          handle = prepared
          yield* acquireSessionLock(prepared.executor, lockConfig, prepared.name, timeoutSeconds, "migrate")
          yield* Effect.logDebug(`Acquired migration lock '${prepared.name}'`)
          yield* startHeartbeatFor(prepared, lockConfig)
        }

        if (dialect.preflightPlan !== undefined) {
          const exists = yield* tableExists(ddlExecutor, dialect, schemaTable)
          let preflightStored: Record<string, CollectionSchema> = {}
          let runPreflight = true
          if (exists) {
            const read = yield* Effect.result(readStoredSchemas(ddlExecutor, dialect, schemaTable))
            if (read._tag === "Success") {
              preflightStored = read.success
            } else {
              // A malformed metadata table is diagnosed by the system-table
              // bootstrap below. Do not turn its SQL error into a preflight
              // error or skip the bootstrap.
              runPreflight = false
            }
          }
          if (runPreflight) {
            const preflightSteps = computePlan(schemas, preflightStored, planOptionsFor(dialect, options)).steps
            yield* dialect.preflightPlan(
              preflightSteps,
              buildPlanContext(schemas, preflightStored, makeReadonlyQueryGuard(ddlExecutor.query), true)
            )
          }
        }

        yield* Effect.logDebug("Creating system tables if not exist")
        const systemTranslated = yield* renderPlan(dialect, systemTableSteps(schemaTable, migrationsTable), {
          tables: new Map(),
          views: new Map(),
          readonlyQuery: makeReadonlyQueryGuard(ddlExecutor.query),
          skipDataPreflight: true
        })
        yield* runStatements(ddlExecutor, systemTranslated.statements)

        yield* Effect.logInfo(`Migrating ${schemas.length} collections...`)
        const storedRecord = yield* readStoredSchemas(ddlExecutor, dialect, schemaTable)
        yield* Effect.logDebug(`Stored schemas: ${Object.keys(storedRecord).length} found`)

        const plan = computePlan(schemas, storedRecord, planOptionsFor(dialect, options))
        yield* Effect.logDebug(`Diff: ${plan.steps.length} steps computed`)
        if (options?.auditTextShape === true && dialect.auditTextShape !== undefined) {
          const drift = yield* auditTextShapeSafe(
            dialect,
            buildPlanContext(schemas, storedRecord, makeReadonlyQueryGuard(ddlExecutor.query), true)
          )
          for (const detail of drift) yield* Effect.logWarning(detail)
        }
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
            buildPlanContext(schemas, storedRecord, makeReadonlyQueryGuard(ddlExecutor.query))
          )
          cleanupStatements = translated.cleanup

          const skipped = translated.skipped
          if (skipped === undefined) {
            return yield* new UnsupportedMigrationStepError({
              step: "createTable",
              detail: "statement mode requires TranslatedPlan.skipped"
            })
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

          const check = (statementIndex: number): Effect.Effect<void, MigrationError> =>
            handle === undefined || lockConfig === undefined
              ? Effect.void
              : assertLockHeld(handle, lockConfig, `before statement ${statementIndex}; the plan is not recorded`)

          const exit = yield* Effect.exit(runStatementsWithLockCheck(ddlExecutor, translated.statements, check))
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
          return yield* new UnsupportedMigrationStepError({
            step: "createTable",
            detail: "statement migration did not complete an apply attempt"
          })
        }

        const verifyContext = buildPlanContext(schemas, storedRecord, makeReadonlyQueryGuard(ddlExecutor.query))
        yield* verifyPlan(plan.steps, verifyContext)
        yield* runStatements(ddlExecutor, applied.validations ?? [])

        if (handle !== undefined && lockConfig !== undefined) {
          yield* assertLockHeld(handle, lockConfig, "before metadata; the plan is not recorded")
        }

        yield* writeStatementMetadata(runner, dialect, plan, schemas, schemaTable, migrationsTable)
      })

      yield* Effect.onExit(body, (exit) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            let outcome: LockReleaseResult = { released: true, killed: false }
            let destroyed = false

            const step = (effect: Effect.Effect<unknown, SqlError.SqlError>) =>
              restore(effect).pipe(
                Effect.timeout(LOCK_STEP_TIMEOUT),
                Effect.catchCause((cause) => Effect.logError(`Migration finalizer step failed: ${Cause.pretty(cause)}`))
              )

            if (handle !== undefined) {
              yield* step(Ref.set(handle.heartbeatStop, true))
            }
            yield* step(runCleanup(ddlExecutor, cleanupStatements))
            if (handle !== undefined && lockConfig !== undefined) {
              outcome = yield* restore(releaseSessionLock(handle.executor, lockConfig, handle.name)).pipe(
                Effect.timeout(LOCK_STEP_TIMEOUT),
                Effect.catchCause(() => Effect.succeed({ released: false, killed: false }))
              )
            }
            if (handle?.dedicated !== undefined) {
              destroyed = true
              yield* step(handle.dedicated.destroy)
            }

            const shouldRestore = lockConfig === undefined || handle?.dedicated !== undefined || outcome.released
            if (shouldRestore && model.session !== undefined && previousSession !== undefined) {
              yield* step(runSessionRestore(ddlExecutor, model.session.restoreSql(previousSession)))
            }

            if (Exit.isFailure(exit)) {
              if (handle !== undefined && !outcome.released) {
                yield* Effect.logError(
                  `Migration lock '${handle.name}' could not be verified as released after the migration failed; ` +
                    "the original error is preserved."
                )
              }
              return
            }

            if (handle !== undefined && !outcome.released) {
              yield* Effect.logError(
                `Migration lock '${handle.name}' is still held after release; ` +
                  (destroyed
                    ? "the dedicated lock connection was destroyed."
                    : outcome.killed
                      ? "the same-session kill was issued."
                      : "no kill or destroy path was available.")
              )
              return yield* Effect.die(
                new MigrationLockReleaseError({
                  lockName: handle.name,
                  killed: outcome.killed,
                  destroyed,
                  cause: "the release could not be verified"
                })
              )
            }
          })
        )
      )

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
      const plan = computePlan(schemas, storedRecord, planOptionsFor(dialect, options))
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
      return translated.notes !== undefined && translated.notes.length > 0 ? { ...plan, notes: translated.notes } : plan
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
  const legacyLock = dialect.migrationPreviewLockSql
  const legacyUnlock = dialect.migrationPreviewUnlockSql
  if ((legacyLock === undefined) !== (legacyUnlock === undefined)) {
    return Effect.fail(
      new UnsupportedMigrationStepError({
        step: "createView",
        detail: "migrationPreviewLockSql and migrationPreviewUnlockSql must be supplied together"
      })
    )
  }
  const lockConfig = model.lock

  return Effect.scoped(
    Effect.gen(function* () {
      const conn = yield* sql.reserve
      const ddlExecutor = connectionExecutor(conn)
      const session = model.session
      let previous: Record<string, unknown> | undefined
      let handle: LockHandle | undefined
      let result: { readonly value: A } | undefined

      const bodyEffect = Effect.gen(function* () {
        if (session !== undefined) {
          const rows = yield* ddlExecutor.query(session.readSql)
          previous = rows[0] ?? {}
          yield* runStatements(ddlExecutor, session.previewSetupSql ?? [])
        }
        if (lockConfig !== undefined) {
          const prepared = yield* prepareLockHandle(lockConfig, ddlExecutor)
          handle = prepared
          yield* acquireSessionLock(prepared.executor, lockConfig, prepared.name, 0, operation)
          yield* Effect.logDebug(`Acquired migration lock '${prepared.name}' for a preview`)
          yield* startHeartbeatFor(prepared, lockConfig)
        } else if (legacyLock !== undefined) {
          yield* acquireMigrationPreviewLock(ddlExecutor, dialect, operation)
        }

        result = { value: yield* body(ddlExecutor) }

        if (handle !== undefined && lockConfig !== undefined) {
          yield* assertLockHeld(
            handle,
            lockConfig,
            "before the preview returned; the preview result is not trustworthy"
          )
        }
      })

      yield* Effect.onExit(bodyEffect, (exit) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            let outcome: LockReleaseResult = { released: true, killed: false }
            let destroyed = false

            const step = (effect: Effect.Effect<unknown, SqlError.SqlError>) =>
              restore(effect).pipe(
                Effect.timeout(LOCK_STEP_TIMEOUT),
                Effect.catchCause((cause) =>
                  Effect.logWarning(`Migration preview finalizer step failed: ${Cause.pretty(cause)}`)
                )
              )

            if (handle !== undefined) {
              yield* step(Ref.set(handle.heartbeatStop, true))
            }
            if (handle !== undefined && lockConfig !== undefined) {
              outcome = yield* restore(releaseSessionLock(handle.executor, lockConfig, handle.name)).pipe(
                Effect.timeout(LOCK_STEP_TIMEOUT),
                Effect.catchCause(() => Effect.succeed({ released: false, killed: false }))
              )
            } else if (legacyUnlock !== undefined) {
              yield* step(ddlExecutor.run(legacyUnlock))
            }
            if (handle?.dedicated !== undefined) {
              destroyed = true
              yield* step(handle.dedicated.destroy)
            }

            const shouldRestore = handle === undefined || handle.dedicated !== undefined || outcome.released
            if (shouldRestore && session !== undefined && previous !== undefined) {
              yield* step(runSessionRestore(ddlExecutor, session.restoreSql(previous)))
            }

            if (Exit.isFailure(exit)) return
            if (handle !== undefined && !outcome.released) {
              return yield* Effect.die(
                new MigrationLockReleaseError({
                  lockName: handle.name,
                  killed: outcome.killed,
                  destroyed,
                  cause: "the preview release could not be verified"
                })
              )
            }
          })
        )
      )

      if (result === undefined) {
        return yield* Effect.die(new Error("Migration preview body returned no result"))
      }
      return result.value
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
      const plan = computePlan(schemas, storedRecord, planOptionsFor(dialect, options))
      const ctx = buildPlanContext(schemas, storedRecord, makeReadonlyQueryGuard(executor.query))
      const translated = yield* renderPlan(dialect, plan.steps, ctx)
      const audit =
        options?.auditTextShape === true && dialect.auditTextShape !== undefined
          ? yield* auditTextShapeSafe(dialect, ctx)
          : []
      const notes = [...(translated.notes ?? []), ...audit]
      yield* Effect.logInfo(`Plan: ${plan.steps.length} steps`)
      return notes.length > 0 ? { ...plan, notes } : plan
    })
  )
}

const keyedForSchema = (schema: CollectionSchema) =>
  keyedFieldNames(schemaToColumns(schema), schemaToIndexEntries(schema))

/**
 * Classifies one collection's steps. The only text-specific rule is a keyed
 * text length increase: the stored column is physically too narrow, so the
 * collection is `behind`. A decrease is `ahead`. Every other alter keeps the
 * existing behavior.
 */
export function classifyStatus(
  steps: ReadonlyArray<MigrationStep>,
  compareTextLength: boolean,
  storedKeyed: ReadonlySet<string>,
  desiredKeyed: ReadonlySet<string>
): "current" | "ahead" | "behind" {
  if (steps.length === 0) return "current"
  const hasNew = steps.some(
    (step) =>
      step.kind === "addColumn" ||
      step.kind === "createIndex" ||
      step.kind === "createTable" ||
      step.kind === "createView"
  )
  const textIncrease =
    compareTextLength &&
    steps.some(
      (step) =>
        step.kind === "alterColumn" &&
        step.to.type === "text" &&
        (storedKeyed.has(step.to.name) || desiredKeyed.has(step.to.name)) &&
        (step.to.maxLength ?? 255) > (step.from.maxLength ?? 255)
    )
  return hasNew || textIncrease ? "behind" : "ahead"
}

function statusFor(schemas: Array<NamedSchema>, stored: Record<string, CollectionSchema>, dialect: MigrationDialect) {
  const storedMap = new Map(Object.entries(stored))
  const result: Array<{ name: string; status: "current" | "ahead" | "behind" }> = []
  for (const { name, schema: desired } of schemas) {
    const storedSchema = storedMap.get(name)
    if (!storedSchema) {
      result.push({ name, status: "behind" })
    } else {
      const steps = diffSchemas(name, storedSchema, desired, {
        compareTextLength: compareTextFor(dialect)
      })
      result.push({
        name,
        status: classifyStatus(steps, compareTextFor(dialect), keyedForSchema(storedSchema), keyedForSchema(desired))
      })
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
          const steps = diffSchemas(name, storedSchema, desired, {
            compareTextLength: compareTextFor(dialect)
          })
          result.push({
            name,
            status: classifyStatus(
              steps,
              compareTextFor(dialect),
              keyedForSchema(storedSchema),
              keyedForSchema(desired)
            )
          })
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
      const plan = computePlan(schemas, storedRecord, planOptionsFor(dialect, options))
      if (plan.steps.length > 0) {
        yield* renderPlan(
          dialect,
          plan.steps,
          buildPlanContext(schemas, storedRecord, makeReadonlyQueryGuard(executor.query), true)
        ).pipe(
          Effect.tap((translated) =>
            (translated.skipped?.length ?? 0) > 0
              ? Effect.logWarning("catalog ahead of metadata; run migrate to reconcile")
              : Effect.void
          ),
          Effect.catchCause((cause) => Effect.logWarning(`Migration status preview failed: ${Cause.pretty(cause)}`))
        )
      }
      const result = statusFor(schemas, storedRecord, dialect)
      if (options?.auditTextShape === true && dialect.auditTextShape !== undefined) {
        const drift = yield* auditTextShapeSafe(
          dialect,
          buildPlanContext(schemas, storedRecord, makeReadonlyQueryGuard(executor.query), true)
        )
        for (const detail of drift) yield* Effect.logWarning(detail)
        const driftTables = new Set<string>()
        for (const detail of drift) {
          const match = /^(?:table|text column) "([^"]+)"/.exec(detail)
          if (match?.[1] !== undefined) driftTables.add(match[1])
        }
        return result.map((entry) => (driftTables.has(entry.name) ? { ...entry, status: "behind" as const } : entry))
      }
      return result
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
    return planImplWith(sql, dialect, schemas, options).pipe(Effect.provideService(References.MinimumLogLevel, level))
  },
  status: (schemas: Array<NamedSchema>, options?: MigrateOptions) => statusImplWith(sql, dialect, schemas, options)
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
