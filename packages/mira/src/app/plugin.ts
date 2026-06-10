import type { Effect, Layer } from "effect"
import type { HttpRouter, FileSystem, Path } from "@effect/platform"
import type { SqlClient } from "@effect/sql"
import type { AnyCollectionDef } from "@gettersethya/mira-client"
import type { Repository } from "@/repository/index.js"
import type { AppConfig } from "@/config/index.js"
import type { AuthService } from "@/http/auth.js"
import type { CollectionService } from "@/collection-service/collection-service.js"
import type { PlatformServices } from "./types.js"
import type {
  RecordHookContext,
  RecordResultContext,
  ListHookContext,
  ListResultContext,
  ViewHookContext,
  ViewResultContext,
  HookErrorContext
} from "@/hooks/types.js"

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

export const onCollection = <T>(
  collections: ReadonlyArray<string>,
  handler: (ctx: T) => Effect.Effect<T, never, never>
): RecordHook<T> => ({ collections, handler })

export const onCollectionSuccess = <T>(
  collections: ReadonlyArray<string>,
  handler: (ctx: T) => Effect.Effect<void, never, never>
): RecordSuccessHook<T> => ({ collections, handler })

export interface MiraPlugin {
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

  readonly layer?: Layer.Layer<never, never, PlatformServices | AppConfig | Repository | CollectionService>
  readonly routes?: HttpRouter.HttpRouter<
    never,
    FileSystem.FileSystem | Path.Path | Repository | AppConfig | AuthService | SqlClient.SqlClient | CollectionService
  >
  readonly collections?: ReadonlyArray<AnyCollectionDef>
}

interface MiraPluginInstance extends MiraPlugin {
  readonly _tag: "MiraPlugin"
}

export const MiraPlugin = {
  define: (opts: MiraPlugin): MiraPlugin => {
    const instance: MiraPluginInstance = { _tag: "MiraPlugin", ...opts }
    return instance
  },

  fromLayer: (layer: Layer.Layer<never, never, never>): MiraPlugin => {
    const instance: MiraPluginInstance = { _tag: "MiraPlugin", layer }
    return instance
  },

  isMiraPlugin: (ext: unknown): ext is MiraPlugin => {
    if (typeof ext !== "object" || ext === null) return false
    if (!("_tag" in ext)) return false
    return ext._tag === "MiraPlugin"
  }
}
