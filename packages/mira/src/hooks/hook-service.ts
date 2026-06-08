import { Context, Effect, Layer } from "effect"
import type { MiraPlugin } from "@/app/plugin.js"
import type { AppConfig } from "@/config/index.js"
import type {
  RecordHookContext, RecordResultContext,
  ListHookContext, ListResultContext,
  ViewHookContext, ViewResultContext,
  HookErrorContext,
} from "./types.js"

export class HookService extends Context.Tag("HookService")<HookService, {
  runRecordCreate(ctx: RecordHookContext): Effect.Effect<RecordHookContext, never, never>
  runRecordCreateExecute(ctx: RecordHookContext): Effect.Effect<RecordHookContext, never, never>
  runRecordCreateSuccess(ctx: RecordResultContext): Effect.Effect<void, never, never>
  runRecordCreateError(ctx: HookErrorContext): Effect.Effect<void, never, never>

  runRecordUpdate(ctx: RecordHookContext): Effect.Effect<RecordHookContext, never, never>
  runRecordUpdateExecute(ctx: RecordHookContext): Effect.Effect<RecordHookContext, never, never>
  runRecordUpdateSuccess(ctx: RecordResultContext): Effect.Effect<void, never, never>
  runRecordUpdateError(ctx: HookErrorContext): Effect.Effect<void, never, never>

  runRecordDelete(ctx: RecordHookContext): Effect.Effect<RecordHookContext, never, never>
  runRecordDeleteExecute(ctx: RecordHookContext): Effect.Effect<RecordHookContext, never, never>
  runRecordDeleteSuccess(ctx: RecordResultContext): Effect.Effect<void, never, never>
  runRecordDeleteError(ctx: HookErrorContext): Effect.Effect<void, never, never>

  runRecordList(ctx: ListHookContext): Effect.Effect<ListHookContext, never, never>
  runRecordListSuccess(ctx: ListResultContext): Effect.Effect<void, never, never>
  runRecordListError(ctx: HookErrorContext): Effect.Effect<void, never, never>

  runRecordView(ctx: ViewHookContext): Effect.Effect<ViewHookContext, never, never>
  runRecordViewSuccess(ctx: ViewResultContext): Effect.Effect<void, never, never>
  runRecordViewError(ctx: HookErrorContext): Effect.Effect<void, never, never>

  runBootstrap(): Effect.Effect<void, never, AppConfig>
  runServe(): Effect.Effect<void, never, never>
  runTerminate(): Effect.Effect<void, never, never>
}>() {}

function matchesCollection(
  hook: { collections?: ReadonlyArray<string> } | undefined,
  collectionName: string
): boolean {
  if (!hook || !hook.collections) return true
  return hook.collections.includes(collectionName)
}

export function makeHookServiceLayer(
  plugins: ReadonlyArray<MiraPlugin>
): Layer.Layer<HookService, never, never> {
  return Layer.succeed(HookService, {
    runRecordCreate: (ctx: RecordHookContext) =>
      Effect.gen(function* () {
        let current = ctx
        for (const plugin of plugins) {
          if (plugin.onRecordCreate && matchesCollection(plugin.onRecordCreate, ctx.collection.name)) {
            current = yield* plugin.onRecordCreate.handler(current)
          }
        }
        return current
      }),

    runRecordCreateExecute: (ctx: RecordHookContext) =>
      Effect.gen(function* () {
        let current = ctx
        for (const plugin of plugins) {
          if (plugin.onRecordCreateExecute && matchesCollection(plugin.onRecordCreateExecute, ctx.collection.name)) {
            current = yield* plugin.onRecordCreateExecute.handler(current)
          }
        }
        return current
      }),

    runRecordCreateSuccess: (ctx: RecordResultContext) =>
      Effect.forkDaemon(
        Effect.forEach(plugins, (p) =>
          p.onRecordCreateSuccess && matchesCollection(p.onRecordCreateSuccess, ctx.collection.name)
            ? p.onRecordCreateSuccess.handler(ctx).pipe(Effect.orDie)
            : Effect.void
        , { concurrency: "unbounded" })
      ).pipe(Effect.asVoid),

    runRecordCreateError: (ctx: HookErrorContext) =>
      Effect.forkDaemon(
        Effect.forEach(plugins, (p) =>
          p.onRecordCreateError && matchesCollection(p.onRecordCreateError, ctx.collection.name)
            ? p.onRecordCreateError.handler(ctx).pipe(Effect.orDie)
            : Effect.void
        , { concurrency: "unbounded" })
      ).pipe(Effect.asVoid),

    runRecordUpdate: (ctx: RecordHookContext) =>
      Effect.gen(function* () {
        let current = ctx
        for (const plugin of plugins) {
          if (plugin.onRecordUpdate && matchesCollection(plugin.onRecordUpdate, ctx.collection.name)) {
            current = yield* plugin.onRecordUpdate.handler(current)
          }
        }
        return current
      }),

    runRecordUpdateExecute: (ctx: RecordHookContext) =>
      Effect.gen(function* () {
        let current = ctx
        for (const plugin of plugins) {
          if (plugin.onRecordUpdateExecute && matchesCollection(plugin.onRecordUpdateExecute, ctx.collection.name)) {
            current = yield* plugin.onRecordUpdateExecute.handler(current)
          }
        }
        return current
      }),

    runRecordUpdateSuccess: (ctx: RecordResultContext) =>
      Effect.forkDaemon(
        Effect.forEach(plugins, (p) =>
          p.onRecordUpdateSuccess && matchesCollection(p.onRecordUpdateSuccess, ctx.collection.name)
            ? p.onRecordUpdateSuccess.handler(ctx).pipe(Effect.orDie)
            : Effect.void
        , { concurrency: "unbounded" })
      ).pipe(Effect.asVoid),

    runRecordUpdateError: (ctx: HookErrorContext) =>
      Effect.forkDaemon(
        Effect.forEach(plugins, (p) =>
          p.onRecordUpdateError && matchesCollection(p.onRecordUpdateError, ctx.collection.name)
            ? p.onRecordUpdateError.handler(ctx).pipe(Effect.orDie)
            : Effect.void
        , { concurrency: "unbounded" })
      ).pipe(Effect.asVoid),

    runRecordDelete: (ctx: RecordHookContext) =>
      Effect.gen(function* () {
        let current = ctx
        for (const plugin of plugins) {
          if (plugin.onRecordDelete && matchesCollection(plugin.onRecordDelete, ctx.collection.name)) {
            current = yield* plugin.onRecordDelete.handler(current)
          }
        }
        return current
      }),

    runRecordDeleteExecute: (ctx: RecordHookContext) =>
      Effect.gen(function* () {
        let current = ctx
        for (const plugin of plugins) {
          if (plugin.onRecordDeleteExecute && matchesCollection(plugin.onRecordDeleteExecute, ctx.collection.name)) {
            current = yield* plugin.onRecordDeleteExecute.handler(current)
          }
        }
        return current
      }),

    runRecordDeleteSuccess: (ctx: RecordResultContext) =>
      Effect.forkDaemon(
        Effect.forEach(plugins, (p) =>
          p.onRecordDeleteSuccess && matchesCollection(p.onRecordDeleteSuccess, ctx.collection.name)
            ? p.onRecordDeleteSuccess.handler(ctx).pipe(Effect.orDie)
            : Effect.void
        , { concurrency: "unbounded" })
      ).pipe(Effect.asVoid),

    runRecordDeleteError: (ctx: HookErrorContext) =>
      Effect.forkDaemon(
        Effect.forEach(plugins, (p) =>
          p.onRecordDeleteError && matchesCollection(p.onRecordDeleteError, ctx.collection.name)
            ? p.onRecordDeleteError.handler(ctx).pipe(Effect.orDie)
            : Effect.void
        , { concurrency: "unbounded" })
      ).pipe(Effect.asVoid),

    runRecordList: (ctx: ListHookContext) =>
      Effect.gen(function* () {
        let current = ctx
        for (const plugin of plugins) {
          if (plugin.onRecordList && matchesCollection(plugin.onRecordList, ctx.collection.name)) {
            current = yield* plugin.onRecordList.handler(current)
          }
        }
        return current
      }),

    runRecordListSuccess: (ctx: ListResultContext) =>
      Effect.forkDaemon(
        Effect.forEach(plugins, (p) =>
          p.onRecordListSuccess && matchesCollection(p.onRecordListSuccess, ctx.collection.name)
            ? p.onRecordListSuccess.handler(ctx).pipe(Effect.orDie)
            : Effect.void
        , { concurrency: "unbounded" })
      ).pipe(Effect.asVoid),

    runRecordListError: (ctx: HookErrorContext) =>
      Effect.forkDaemon(
        Effect.forEach(plugins, (p) =>
          p.onRecordListError && matchesCollection(p.onRecordListError, ctx.collection.name)
            ? p.onRecordListError.handler(ctx).pipe(Effect.orDie)
            : Effect.void
        , { concurrency: "unbounded" })
      ).pipe(Effect.asVoid),

    runRecordView: (ctx: ViewHookContext) =>
      Effect.gen(function* () {
        let current = ctx
        for (const plugin of plugins) {
          if (plugin.onRecordView && matchesCollection(plugin.onRecordView, ctx.collection.name)) {
            current = yield* plugin.onRecordView.handler(current)
          }
        }
        return current
      }),

    runRecordViewSuccess: (ctx: ViewResultContext) =>
      Effect.forkDaemon(
        Effect.forEach(plugins, (p) =>
          p.onRecordViewSuccess && matchesCollection(p.onRecordViewSuccess, ctx.collection.name)
            ? p.onRecordViewSuccess.handler(ctx).pipe(Effect.orDie)
            : Effect.void
        , { concurrency: "unbounded" })
      ).pipe(Effect.asVoid),

    runRecordViewError: (ctx: HookErrorContext) =>
      Effect.forkDaemon(
        Effect.forEach(plugins, (p) =>
          p.onRecordViewError && matchesCollection(p.onRecordViewError, ctx.collection.name)
            ? p.onRecordViewError.handler(ctx).pipe(Effect.orDie)
            : Effect.void
        , { concurrency: "unbounded" })
      ).pipe(Effect.asVoid),

    runBootstrap: () =>
      Effect.forEach(plugins, (p) => p.onBootstrap ? p.onBootstrap() : Effect.void),

    runServe: () =>
      Effect.forEach(plugins, (p) => p.onServe ? p.onServe() : Effect.void) as Effect.Effect<void, never, never>,

    runTerminate: () =>
      Effect.forEach(plugins, (p) => p.onTerminate ? p.onTerminate() : Effect.void) as Effect.Effect<void, never, never>,
  })
}
