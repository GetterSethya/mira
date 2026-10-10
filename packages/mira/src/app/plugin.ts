import type { AnyCollectionDef } from "@gettersethya/mira-client"
import type { Effect, Layer } from "effect"
import type { HttpRouter } from "effect/http"

import type { CollectionService } from "@/collection-service/collection-service.js"
import type { AppConfig } from "@/config/index.js"
import type { CronDef } from "@/cron/types.js"
import type {
  CronContext,
  CronErrorContext,
  CronFinishedContext,
  CronResultContext,
  HookErrorContext,
  ListHookContext,
  ListResultContext,
  RecordHookContext,
  RecordResultContext,
  ViewHookContext,
  ViewResultContext} from "@/hooks/types.js"
import type { Repository } from "@/repository/index.js"

import type { PlatformServices } from "./types.js"

export interface RecordHook<T> {
  readonly collections?: ReadonlyArray<string>
  readonly handler: (ctx: T) => Effect.Effect<T, never, never>
}

export interface RecordSuccessHook<T> {
  readonly collections?: ReadonlyArray<string>
  readonly handler: (ctx: T) => Effect.Effect<void, never, never>
}

export interface ListHook<T> {
  readonly collections?: ReadonlyArray<string>
  readonly handler: (ctx: T) => Effect.Effect<T, never, never>
}

export interface ListSuccessHook<T> {
  readonly collections?: ReadonlyArray<string>
  readonly handler: (ctx: T) => Effect.Effect<void, never, never>
}

export interface CronHook<T> {
  readonly crons?: ReadonlyArray<string>
  readonly handler: (ctx: T) => Effect.Effect<T, never, never>
}

export interface CronObserverHook<T> {
  readonly crons?: ReadonlyArray<string>
  readonly handler: (ctx: T) => Effect.Effect<void, never, never>
}

export const onCollection = <T>(
  collections: ReadonlyArray<string>,
  handler: (ctx: T) => Effect.Effect<T, never, never>
): RecordHook<T> => ({ collections, handler })

export const onCollectionSuccess = <T>(
  collections: ReadonlyArray<string>,
  handler: (ctx: T) => Effect.Effect<void, never, never>
): RecordSuccessHook<T> => ({ collections, handler })

export interface MiraPlugin<R = never> {
  readonly onBootstrap?: () => Effect.Effect<void, never, AppConfig | CollectionService>
  readonly onServe?: () => Effect.Effect<void, never, never>
  readonly onTerminate?: () => Effect.Effect<void, never, never>

  readonly onRecordCreate?: RecordHook<RecordHookContext>
  readonly onRecordCreateExecute?: RecordHook<RecordHookContext>
  readonly onRecordCreateSuccess?: RecordSuccessHook<RecordResultContext>
  readonly onRecordCreateError?: RecordSuccessHook<HookErrorContext>

  readonly onRecordUpdate?: RecordHook<RecordHookContext>
  readonly onRecordUpdateExecute?: RecordHook<RecordHookContext>
  readonly onRecordUpdateSuccess?: RecordSuccessHook<RecordResultContext>
  readonly onRecordUpdateError?: RecordSuccessHook<HookErrorContext>

  readonly onRecordDelete?: RecordHook<RecordHookContext>
  readonly onRecordDeleteExecute?: RecordHook<RecordHookContext>
  readonly onRecordDeleteSuccess?: RecordSuccessHook<RecordResultContext>
  readonly onRecordDeleteError?: RecordSuccessHook<HookErrorContext>

  readonly onRecordList?: ListHook<ListHookContext>
  readonly onRecordListSuccess?: ListSuccessHook<ListResultContext>
  readonly onRecordListError?: ListSuccessHook<HookErrorContext>

  readonly onRecordView?: ListHook<ViewHookContext>
  readonly onRecordViewSuccess?: ListSuccessHook<ViewResultContext>
  readonly onRecordViewError?: ListSuccessHook<HookErrorContext>

  readonly crons?: ReadonlyArray<CronDef<R>>
  readonly onCronStart?: CronHook<CronContext>
  readonly onCronExecute?: CronHook<CronContext>
  readonly onCronFinished?: CronObserverHook<CronFinishedContext>
  readonly onCronSuccess?: CronObserverHook<CronResultContext>
  readonly onCronError?: CronObserverHook<CronErrorContext>

  readonly layer?: Layer.Layer<never, never, PlatformServices | AppConfig | Repository | CollectionService>
  readonly routes?: ReadonlyArray<HttpRouter.Route<never, R>>
  readonly collections?: ReadonlyArray<AnyCollectionDef>
  /**
   * Auth collections whose authenticated tokens are granted `admin: true` on the
   * request context, bypassing all rule enforcement on the generic
   * `/api/collections/*` and file routes. Declared by admin plugins (e.g. the
   * dashboard declares its superadmin collection here). These definitions are
   * also automatically added to the app's collection set, so a plugin only needs
   * to list its admin collection once. An app with no such plugin has no admin
   * bypass and enforces rules for everyone.
   */
  readonly adminCollections?: ReadonlyArray<AnyCollectionDef>
}

interface MiraPluginInstance<R> extends MiraPlugin<R> {
  readonly _tag: "MiraPlugin"
}

export const MiraPlugin = {
  define: <R = never>(opts: MiraPlugin<R>): MiraPlugin<R> => {
    const instance: MiraPluginInstance<R> = { _tag: "MiraPlugin", ...opts }
    return instance
  },

  fromLayer: (layer: Layer.Layer<never, never, never>): MiraPlugin<never> => {
    const instance: MiraPluginInstance<never> = { _tag: "MiraPlugin", layer }
    return instance
  },

  isMiraPlugin: (ext: unknown): ext is MiraPlugin<any> => {
    if (typeof ext !== "object" || ext === null) return false
    if (!("_tag" in ext)) return false
    return ext._tag === "MiraPlugin"
  }
}
