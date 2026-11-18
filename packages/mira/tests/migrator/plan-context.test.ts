import { SqliteClient } from "@effect/sql-sqlite-node"
import { describe, it } from "@effect/vitest"
import type { CollectionSchema } from "@gettersethya/mira-client"
import { Effect, Layer } from "effect"
import { expect } from "vitest"

import type { DialectType, TranslatePlanContext } from "@/dialect/dialect.js"
import { Dialect } from "@/dialect/dialect.js"
import { sqliteDialect } from "@/dialect/dialect-sqlite.js"
import { Migrator, MigratorLive } from "@/migrator/migrator.js"

const sqliteLayer = SqliteClient.layer({ filename: ":memory:" })

const capturingDialect = (
  captured: Array<TranslatePlanContext>,
  notes?: ReadonlyArray<string>
): DialectType => ({
  ...sqliteDialect,
  translatePlan: (steps, ctx) => {
    captured.push(ctx)
    const result = sqliteDialect.translatePlan(steps, ctx)
    return notes === undefined
      ? result
      : Effect.map(result, (translated) => ({ ...translated, notes }))
  }
})

const testLayer = (dialect: DialectType) =>
  Layer.mergeAll(
    MigratorLive.pipe(
      Layer.provide(Layer.mergeAll(Layer.succeed(Dialect, dialect), sqliteLayer))
    ),
    sqliteLayer
  )

const baseSchema: CollectionSchema = {
  "x-collection-kind": "base",
  type: "object",
  properties: {
    seqId: { type: "integer", "x-kind": "seqId", "x-system": true },
    id: { type: "string", "x-system": true },
    title: { type: "string" }
  },
  required: ["id", "title"]
}

const viewSchema: CollectionSchema = {
  "x-collection-kind": "view",
  "x-view-query": "SELECT id, seqId, title FROM todos",
  type: "object",
  properties: {
    id: { type: "string", "x-view-only": true },
    seqId: { type: "integer", "x-view-only": true },
    title: { type: "string", "x-view-only": true }
  },
  required: ["id", "seqId", "title"]
}

const viewWithoutQuery: CollectionSchema = {
  "x-collection-kind": "view",
  type: "object",
  properties: {
    id: { type: "string", "x-view-only": true },
    seqId: { type: "integer", "x-view-only": true }
  },
  required: ["id", "seqId"]
}

const todos = { name: "todos", schema: baseSchema }
const todosView = { name: "todos_view", schema: viewSchema }

describe("buildPlanContext views", () => {
  it.effect("captures a desired view with stored and desired queries", () => {
    const captured: Array<TranslatePlanContext> = []

    return Effect.gen(function* () {
      const migrator = yield* Migrator
      yield* migrator.migrate([todos, todosView])
      captured.length = 0

      yield* migrator.plan([todos, todosView])

      expect(captured[0]?.views.get("todos_view")).toEqual({
        stored: { query: "SELECT id, seqId, title FROM todos" },
        desired: { query: "SELECT id, seqId, title FROM todos" }
      })
    }).pipe(Effect.provide(testLayer(capturingDialect(captured))))
  })

  it.effect("captures a stored-only orphan with desired null", () => {
    const captured: Array<TranslatePlanContext> = []

    return Effect.gen(function* () {
      const migrator = yield* Migrator
      yield* migrator.migrate([todos, todosView])
      captured.length = 0

      yield* migrator.plan([todos], { allowDestructive: true })

      expect(captured[0]?.views.get("todos_view")).toEqual({
        stored: { query: "SELECT id, seqId, title FROM todos" },
        desired: null
      })
    }).pipe(Effect.provide(testLayer(capturingDialect(captured))))
  })

  it.effect("captures a desired view without x-view-query as a null query", () => {
    const captured: Array<TranslatePlanContext> = []

    return Effect.gen(function* () {
      const migrator = yield* Migrator

      yield* migrator.plan([todos, { name: "bad_view", schema: viewWithoutQuery }])

      expect(captured[0]?.views.get("bad_view")).toEqual({
        stored: null,
        desired: { query: null }
      })
    }).pipe(Effect.provide(testLayer(capturingDialect(captured))))
  })

  it.effect("returns dialect notes on MigrationPlan", () =>
    Effect.gen(function* () {
      const migrator = yield* Migrator
      const plan = yield* migrator.plan([todos])
      expect(plan.notes).toEqual(["drop view x"])
    }).pipe(Effect.provide(testLayer(capturingDialect([], ["drop view x"])))))

  it.effect("omits notes when the dialect returns none", () =>
    Effect.gen(function* () {
      const migrator = yield* Migrator
      const plan = yield* migrator.plan([todos])
      expect(plan.notes).toBeUndefined()
    }).pipe(Effect.provide(testLayer(capturingDialect([])))))
})
