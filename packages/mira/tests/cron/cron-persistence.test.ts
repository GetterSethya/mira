import { SqlClient } from "@effect/sql"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { randomBytes } from "node:crypto"
import { Chunk, Context, Effect, Layer, Queue, Schedule } from "effect"
import { describe, it } from "@effect/vitest"
import { expect } from "vitest"
import { CronService, makeCronServiceLayer } from "@/cron/cron-service.js"
import type { CronDef } from "@/cron/types.js"
import { makeHookServiceLayer } from "@/hooks/hook-service.js"
import type { CompletedSpan } from "@/telemetry/tracer.js"
import { makeConsoleTracer } from "@/telemetry/tracer.js"

type StubDef = CronDef<never>

// Boots a CronService against an already-open SqlClient context — simulates a "restart"
// against the same database, since `:memory:` SQLite is per-connection and a fresh
// SqliteClient.layer() would otherwise open an unrelated empty database.
// Builds the layer into the *caller's* surrounding `Effect.scoped` rather than closing
// its own scope immediately — background fibers and FiberRef-scoped state (like a custom
// tracer) must stay alive past this call, for the lifetime of the whole test.
function bootCronService(
  defs: ReadonlyArray<StubDef>,
  dbContext: Context.Context<SqlClient.SqlClient>,
  extra: Layer.Layer<never> = Layer.empty
) {
  const layer = makeCronServiceLayer(defs).pipe(
    Layer.provide(makeHookServiceLayer([])),
    Layer.provide(Layer.succeedContext(dbContext)),
    Layer.provide(extra)
  )
  return Layer.build(layer).pipe(Effect.map((ctx) => Context.get(ctx, CronService)))
}

function collectSpans(queue: Queue.Queue<CompletedSpan>) {
  return Queue.takeAll(queue).pipe(Effect.map(Chunk.toArray))
}

describe("cron state persistence", () => {
  it.effect("a successful run persists lastStatus/lastDurationMs/lastRunAt/lastError:null into _config", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dbContext = yield* Layer.build(SqliteClient.layer({ filename: ":memory:" }))
        const sql = Context.get(dbContext, SqlClient.SqlClient)

        const svc = yield* bootCronService(
          [{ name: "ok-cron", schedule: Schedule.duration("24 hours"), handler: () => Effect.void }],
          dbContext
        )
        yield* svc.runNow("ok-cron")
        yield* Effect.yieldNow()
        yield* Effect.sleep(0)

        const rows = yield* sql`SELECT value FROM ${sql("_config")} WHERE key = 'cron_state'`
        expect(rows).toHaveLength(1)
        const blob = JSON.parse((rows[0] as { value: string }).value) as Record<string, unknown>
        expect(blob["ok-cron"]).toMatchObject({ lastStatus: "success", lastError: null })
        expect((blob["ok-cron"] as { lastRunAt: unknown }).lastRunAt).toBeTruthy()
        expect((blob["ok-cron"] as { lastDurationMs: unknown }).lastDurationMs).toBeGreaterThanOrEqual(0)
      })
    )
  )

  it.effect("a failing run persists lastStatus: 'error' and a stringified lastError", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dbContext = yield* Layer.build(SqliteClient.layer({ filename: ":memory:" }))
        const sql = Context.get(dbContext, SqlClient.SqlClient)

        const svc = yield* bootCronService(
          [
            {
              name: "fail-cron",
              schedule: Schedule.duration("24 hours"),
              handler: () => Effect.fail(new Error("boom"))
            }
          ],
          dbContext
        )
        yield* svc.runNow("fail-cron")
        yield* Effect.yieldNow()
        yield* Effect.sleep(0)

        const rows = yield* sql`SELECT value FROM ${sql("_config")} WHERE key = 'cron_state'`
        const blob = JSON.parse((rows[0] as { value: string }).value) as Record<
          string,
          { lastStatus: string; lastError: string }
        >
        expect(blob["fail-cron"].lastStatus).toBe("error")
        expect(blob["fail-cron"].lastError).toContain("boom")
      })
    )
  )

  it.effect("rebuilding the layer against the same DB hydrates lastRun* while status starts standby", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dbContext = yield* Layer.build(SqliteClient.layer({ filename: ":memory:" }))
        const def: StubDef = {
          name: "persist-cron",
          schedule: Schedule.duration("24 hours"),
          handler: () => Effect.void
        }

        const svc1 = yield* bootCronService([def], dbContext)
        yield* svc1.runNow("persist-cron")
        yield* Effect.yieldNow()
        yield* Effect.sleep(0)
        const [before] = yield* svc1.getAll()
        expect(before.lastStatus).toBe("success")

        const svc2 = yield* bootCronService([def], dbContext)
        const [after] = yield* svc2.getAll()
        expect(after.status).toBe("standby")
        expect(after.lastStatus).toBe("success")
        expect(after.lastRunAt).toBeInstanceOf(Date)
        expect(after.lastDurationMs).toBeGreaterThanOrEqual(0)
      })
    )
  )

  it.effect("a cron removed between boots is absent from the next persisted blob", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dbContext = yield* Layer.build(SqliteClient.layer({ filename: ":memory:" }))
        const sql = Context.get(dbContext, SqlClient.SqlClient)
        const defA: StubDef = { name: "cron-a", schedule: Schedule.duration("24 hours"), handler: () => Effect.void }
        const defB: StubDef = { name: "cron-b", schedule: Schedule.duration("24 hours"), handler: () => Effect.void }

        const svc1 = yield* bootCronService([defA, defB], dbContext)
        yield* svc1.runNow("cron-a")
        yield* svc1.runNow("cron-b")
        yield* Effect.yieldNow()
        yield* Effect.sleep(0)

        // Reboot with only cron-a registered, then run it so a fresh save occurs
        const svc2 = yield* bootCronService([defA], dbContext)
        yield* svc2.runNow("cron-a")
        yield* Effect.yieldNow()
        yield* Effect.sleep(0)

        const rows = yield* sql`SELECT value FROM ${sql("_config")} WHERE key = 'cron_state'`
        const blob = JSON.parse((rows[0] as { value: string }).value) as Record<string, unknown>
        expect(Object.keys(blob)).toEqual(["cron-a"])
      })
    )
  )

  it.effect("a corrupted cron_state value doesn't fail boot — crons start with empty history", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dbContext = yield* Layer.build(SqliteClient.layer({ filename: ":memory:" }))
        const sql = Context.get(dbContext, SqlClient.SqlClient)
        yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS _config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
        yield* sql`INSERT INTO ${sql("_config")} ${sql.insert({ key: "cron_state", value: "not json{{{" })}`

        const svc = yield* bootCronService(
          [{ name: "fresh-cron", schedule: Schedule.duration("24 hours"), handler: () => Effect.void }],
          dbContext
        )
        const [state] = yield* svc.getAll()
        expect(state.status).toBe("standby")
        expect(state.lastStatus).toBeUndefined()
        expect(state.lastRunAt).toBeUndefined()
      })
    )
  )

  it.effect("cron.persistence.save and cron.persistence.load spans are emitted with table: '_config'", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dbContext = yield* Layer.build(SqliteClient.layer({ filename: ":memory:" }))
        const queue = yield* Queue.unbounded<CompletedSpan>()
        const tracerLayer = Layer.setTracer(makeConsoleTracer(queue, (size) => randomBytes(size)))

        const svc = yield* bootCronService(
          [{ name: "span-cron", schedule: Schedule.duration("24 hours"), handler: () => Effect.void }],
          dbContext,
          tracerLayer
        )
        yield* svc.runNow("span-cron")
        yield* Effect.yieldNow()
        yield* Effect.sleep(0)

        const spans = yield* collectSpans(queue)
        const loadSpan = spans.find((s) => s.name === "cron.persistence.load")
        const saveSpan = spans.find((s) => s.name === "cron.persistence.save")
        expect(loadSpan).toBeDefined()
        expect(loadSpan?.attributes.table).toBe("_config")
        expect(saveSpan).toBeDefined()
        expect(saveSpan?.attributes.table).toBe("_config")
      })
    )
  )
})
