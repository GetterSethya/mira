import { Effect, Layer, Option, Redacted } from "effect"
import { describe, it } from "@effect/vitest"
import { expect } from "vitest"
import { BaseCollection, Field } from "@gettersethya/mira-client"
import { HookService, makeHookServiceLayer } from "@/hooks/hook-service.js"
import { MiraPlugin } from "@/app/plugin.js"
import type { RecordHookContext, ListHookContext, ViewHookContext } from "@/hooks/types.js"
import { AppConfig } from "@/config/index.js"
import { CollectionService } from "@/collection-service/collection-service.js"

const TestCollectionService = Layer.succeed(
  CollectionService,
  CollectionService.of({
    create: () => Effect.die("stub"),
    view: () => Effect.die("stub"),
    update: () => Effect.die("stub"),
    delete: () => Effect.die("stub"),
    list: () => Effect.die("stub")
  })
)

const TestAppConfig = Layer.succeed(AppConfig, {
  appName: "test",
  port: 8080,
  applicationUrl: "http://localhost:8080",
  jwtSecret: Redacted.make("test-secret"),
  useS3: false,
  s3Config: Option.none()
})

const Posts = BaseCollection.define("posts", {
  title: Field.text()
}).rules((R) => ({
  list: R.public(),
  view: R.public(),
  create: R.public(),
  update: R.public(),
  delete: R.public()
}))

describe("HookService", () => {
  it.effect("runs no-op when no plugins registered", () =>
    Effect.gen(function* () {
      const hooks = yield* HookService
      const ctx: RecordHookContext = {
        collection: Posts,
        data: { title: "test" },
        record: undefined,
        auth: undefined
      }
      const result = yield* hooks.runRecordCreate(ctx)
      expect(result.data).toEqual({ title: "test" })
    }).pipe(Effect.provide(makeHookServiceLayer([])))
  )

  it.effect("runs onRecordCreate hook and can modify data", () =>
    Effect.gen(function* () {
      const hooks = yield* HookService
      const ctx: RecordHookContext = {
        collection: Posts,
        data: { title: "original" },
        record: undefined,
        auth: undefined
      }
      const result = yield* hooks.runRecordCreate(ctx)
      expect(result.data.title).toBe("modified")
    }).pipe(
      Effect.provide(
        makeHookServiceLayer([
          MiraPlugin.define({
            onRecordCreate: {
              handler: (ctx) =>
                Effect.succeed({
                  ...ctx,
                  data: { ...ctx.data, title: "modified" }
                })
            }
          })
        ])
      )
    )
  )

  it.effect("runs multiple create hooks in registration order", () =>
    Effect.gen(function* () {
      const hooks = yield* HookService
      const ctx: RecordHookContext = {
        collection: Posts,
        data: { title: "start" },
        record: undefined,
        auth: undefined
      }
      const result = yield* hooks.runRecordCreate(ctx)
      expect(result.data.title).toBe("start-first-second")
    }).pipe(
      Effect.provide(
        makeHookServiceLayer([
          MiraPlugin.define({
            onRecordCreate: {
              handler: (ctx) =>
                Effect.succeed({
                  ...ctx,
                  data: { ...ctx.data, title: `${ctx.data.title}-first` }
                })
            }
          }),
          MiraPlugin.define({
            onRecordCreate: {
              handler: (ctx) =>
                Effect.succeed({
                  ...ctx,
                  data: { ...ctx.data, title: `${ctx.data.title}-second` }
                })
            }
          })
        ])
      )
    )
  )

  it.effect("filters hooks by collection name", () =>
    Effect.gen(function* () {
      const hooks = yield* HookService
      const ctx: RecordHookContext = {
        collection: Posts,
        data: { title: "original" },
        record: undefined,
        auth: undefined
      }
      const result = yield* hooks.runRecordCreate(ctx)
      expect(result.data.title).toBe("original")
    }).pipe(
      Effect.provide(
        makeHookServiceLayer([
          MiraPlugin.define({
            onRecordCreate: {
              collections: ["other"],
              handler: (ctx) =>
                Effect.succeed({
                  ...ctx,
                  data: { ...ctx.data, title: "modified" }
                })
            }
          })
        ])
      )
    )
  )

  it.effect("runs lifecycle hooks", () =>
    Effect.gen(function* () {
      const hooks = yield* HookService
      yield* hooks.runBootstrap()
      yield* hooks.runServe()
      yield* hooks.runTerminate()
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          makeHookServiceLayer([
            MiraPlugin.define({
              onBootstrap: () => Effect.void,
              onServe: () => Effect.void,
              onTerminate: () => Effect.void
            })
          ]),
          TestAppConfig,
          TestCollectionService
        )
      )
    )
  )

  it.effect("runs onRecordUpdate hook", () =>
    Effect.gen(function* () {
      const hooks = yield* HookService
      const ctx: RecordHookContext = {
        collection: Posts,
        data: { title: "old" },
        record: { id: "1", title: "old" },
        auth: undefined
      }
      const result = yield* hooks.runRecordUpdate(ctx)
      expect(result.data.title).toBe("updated")
    }).pipe(
      Effect.provide(
        makeHookServiceLayer([
          MiraPlugin.define({
            onRecordUpdate: {
              handler: (ctx) =>
                Effect.succeed({
                  ...ctx,
                  data: { ...ctx.data, title: "updated" }
                })
            }
          })
        ])
      )
    )
  )

  it.effect("runs onRecordDelete hook", () =>
    Effect.gen(function* () {
      const hooks = yield* HookService
      const ctx: RecordHookContext = {
        collection: Posts,
        data: { id: "1", title: "to-delete" },
        record: { id: "1", title: "to-delete" },
        auth: undefined
      }
      yield* hooks.runRecordDelete(ctx)
    }).pipe(
      Effect.provide(
        makeHookServiceLayer([
          MiraPlugin.define({
            onRecordDelete: {
              handler: (ctx) => Effect.succeed(ctx)
            }
          })
        ])
      )
    )
  )

  it.effect("runs onRecordList hook and can modify limit", () =>
    Effect.gen(function* () {
      const hooks = yield* HookService
      const ctx: ListHookContext = {
        collection: Posts,
        cursor: null,
        limit: 20,
        filter: undefined,
        sort: undefined,
        select: undefined,
        expand: undefined,
        auth: undefined
      }
      const result = yield* hooks.runRecordList(ctx)
      expect(result.limit).toBe(50)
    }).pipe(
      Effect.provide(
        makeHookServiceLayer([
          MiraPlugin.define({
            onRecordList: {
              handler: (ctx) =>
                Effect.succeed({
                  ...ctx,
                  limit: 50
                })
            }
          })
        ])
      )
    )
  )

  it.effect("runs onRecordView hook and can modify select", () =>
    Effect.gen(function* () {
      const hooks = yield* HookService
      const ctx: ViewHookContext = {
        collection: Posts,
        id: "1",
        select: undefined,
        expand: undefined,
        auth: undefined
      }
      const result = yield* hooks.runRecordView(ctx)
      expect(result.select).toEqual(["title"])
    }).pipe(
      Effect.provide(
        makeHookServiceLayer([
          MiraPlugin.define({
            onRecordView: {
              handler: (ctx) =>
                Effect.succeed({
                  ...ctx,
                  select: ["title"]
                })
            }
          })
        ])
      )
    )
  )
})

describe("MiraPlugin.fromLayer()", () => {
  it("creates a MiraPlugin from a Layer", () => {
    const layer = Layer.empty
    const plugin = MiraPlugin.fromLayer(layer)
    expect(MiraPlugin.isMiraPlugin(plugin)).toBe(true)
    expect(plugin.layer).toBe(layer)
  })
})
