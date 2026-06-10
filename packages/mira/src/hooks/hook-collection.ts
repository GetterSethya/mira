import { Effect, Layer } from "effect"
import type { AnyCollectionDef, FilterNode } from "@gettersethya/mira-client"
import { CollectionService } from "@/collection-service/collection-service.js"
import type { RequestCtx } from "@/collection-service/context.js"
import type { CollectionError } from "@/collection-service/errors.js"
import type { RepoRecord, SortOrder } from "@/repository/types.js"
import { HookService } from "./hook-service.js"
import type { AuthContext } from "./types.js"

function toAuth(auth: { collection: string; record: RepoRecord } | undefined): AuthContext | undefined {
  if (auth === undefined) return undefined
  return { collection: auth.collection, record: auth.record }
}

export function makeHookCollectionServiceLayer(): Layer.Layer<
  CollectionService,
  never,
  CollectionService | HookService
> {
  return Layer.effect(
    CollectionService,
    Effect.gen(function* () {
      const inner = yield* CollectionService
      const hooks = yield* HookService

      return CollectionService.of({
        list: (
          collection: AnyCollectionDef,
          cursor: number | null,
          perPage: number,
          ctx: RequestCtx,
          filter?: FilterNode,
          sort?: SortOrder,
          select?: ReadonlyArray<string> | null,
          expand?: ReadonlyArray<string> | null
        ) =>
          Effect.gen(function* () {
            const auth = toAuth(ctx.auth)
            const hookCtx = yield* hooks.runRecordList({
              collection,
              filter,
              sort,
              select,
              expand,
              cursor,
              limit: perPage,
              auth
            })
            const result = yield* inner.list(
              collection,
              cursor,
              hookCtx.limit,
              ctx,
              hookCtx.filter,
              hookCtx.sort,
              hookCtx.select,
              hookCtx.expand
            )
            yield* hooks
              .runRecordListSuccess({ ...hookCtx, items: result.items, nextCursor: result.nextCursor })
              .pipe(Effect.orElse(() => Effect.void))
            return result
          }).pipe(
            Effect.catchAll((error: CollectionError) =>
              hooks
                .runRecordListError({ collection, action: "list", error, auth: toAuth(ctx.auth) })
                .pipe(Effect.zipRight(Effect.fail(error)))
            ),
            Effect.withSpan("hook.list", { kind: "internal", attributes: { collection: collection.name } })
          ),

        view: (
          collection: AnyCollectionDef,
          id: string,
          ctx: RequestCtx,
          select?: ReadonlyArray<string> | null,
          expand?: ReadonlyArray<string> | null
        ) =>
          Effect.gen(function* () {
            const auth = toAuth(ctx.auth)
            const hookCtx = yield* hooks.runRecordView({ collection, id, select, expand, auth })
            const result = yield* inner.view(collection, id, ctx, hookCtx.select, hookCtx.expand)
            yield* hooks.runRecordViewSuccess({ ...hookCtx, result }).pipe(Effect.orElse(() => Effect.void))
            return result
          }).pipe(
            Effect.catchAll((error: CollectionError) =>
              hooks
                .runRecordViewError({ collection, action: "view", error, auth: toAuth(ctx.auth) })
                .pipe(Effect.zipRight(Effect.fail(error)))
            ),
            Effect.withSpan("hook.view", { kind: "internal", attributes: { collection: collection.name } })
          ),

        create: (collection: AnyCollectionDef, data: RepoRecord, ctx: RequestCtx) =>
          Effect.gen(function* () {
            const auth = toAuth(ctx.auth)
            const hookCtx = yield* hooks.runRecordCreate({ collection, data, record: undefined, auth })
            const execCtx = yield* hooks.runRecordCreateExecute(hookCtx)
            const result = yield* inner.create(collection, execCtx.data, ctx)
            yield* hooks.runRecordCreateSuccess({ ...execCtx, result }).pipe(Effect.orElse(() => Effect.void))
            return result
          }).pipe(
            Effect.catchAll((error: CollectionError) =>
              hooks
                .runRecordCreateError({ collection, action: "create", error, auth: toAuth(ctx.auth) })
                .pipe(Effect.zipRight(Effect.fail(error)))
            ),
            Effect.withSpan("hook.create", { kind: "internal", attributes: { collection: collection.name } })
          ),

        update: (collection: AnyCollectionDef, id: string, data: RepoRecord, ctx: RequestCtx) =>
          Effect.gen(function* () {
            const auth = toAuth(ctx.auth)
            const existing = yield* inner.view(collection, id, ctx)
            const hookCtx = yield* hooks.runRecordUpdate({ collection, data, record: existing, auth })
            const execCtx = yield* hooks.runRecordUpdateExecute(hookCtx)
            const result = yield* inner.update(collection, id, execCtx.data, ctx)
            yield* hooks.runRecordUpdateSuccess({ ...execCtx, result }).pipe(Effect.orElse(() => Effect.void))
            return result
          }).pipe(
            Effect.catchAll((error: CollectionError) =>
              hooks
                .runRecordUpdateError({ collection, action: "update", error, auth: toAuth(ctx.auth) })
                .pipe(Effect.zipRight(Effect.fail(error)))
            ),
            Effect.withSpan("hook.update", { kind: "internal", attributes: { collection: collection.name } })
          ),

        delete: (collection: AnyCollectionDef, id: string, ctx: RequestCtx) =>
          Effect.gen(function* () {
            const auth = toAuth(ctx.auth)
            const existing = yield* inner.view(collection, id, ctx)
            const hookCtx = yield* hooks.runRecordDelete({ collection, data: existing, record: existing, auth })
            const execCtx = yield* hooks.runRecordDeleteExecute(hookCtx)
            yield* inner.delete(collection, id, ctx)
            yield* hooks.runRecordDeleteSuccess({ ...execCtx, result: existing }).pipe(Effect.orElse(() => Effect.void))
          }).pipe(
            Effect.catchAll((error: CollectionError) =>
              hooks
                .runRecordDeleteError({ collection, action: "delete", error, auth: toAuth(ctx.auth) })
                .pipe(Effect.zipRight(Effect.fail(error)))
            ),
            Effect.withSpan("hook.delete", { kind: "internal", attributes: { collection: collection.name } })
          )
      })
    })
  )
}
