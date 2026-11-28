import type { AnyCollectionDef, Cursor, FilterNode } from "@gettersethya/mira-client"
import { Effect, Layer } from "effect"

import { CollectionService } from "@/collection-service/collection-service.js"
import type { RequestCtx } from "@/collection-service/context.js"
import type { CollectionError } from "@/collection-service/errors.js"
import type { RepoRecord, SortOrder } from "@/repository/types.js"
import { withSpanWhenEnabled } from "@/telemetry/span.js"

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
          cursor: Cursor | null,
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
            yield* hooks.runRecordListSuccess({
              ...hookCtx,
              items: result.items,
              nextCursor: result.nextCursor
            })
            return result
          }).pipe(
            Effect.tapError((error: CollectionError) =>
              hooks.runRecordListError({ collection, action: "list", error, auth: toAuth(ctx.auth) })
            ),
            withSpanWhenEnabled(
              "hook.list",
              { kind: "internal", attributes: { collection: collection.name } },
              { captureStackTrace: false }
            )
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
            yield* hooks.runRecordViewSuccess({ ...hookCtx, result })
            return result
          }).pipe(
            Effect.tapError((error: CollectionError) =>
              hooks.runRecordViewError({ collection, action: "view", error, auth: toAuth(ctx.auth) })
            ),
            withSpanWhenEnabled(
              "hook.view",
              { kind: "internal", attributes: { collection: collection.name } },
              { captureStackTrace: false }
            )
          ),

        create: (collection: AnyCollectionDef, data: RepoRecord, ctx: RequestCtx) =>
          Effect.gen(function* () {
            const auth = toAuth(ctx.auth)
            const hookCtx = yield* hooks.runRecordCreate({ collection, data, record: undefined, auth })
            const execCtx = yield* hooks.runRecordCreateExecute(hookCtx)
            const result = yield* inner.create(collection, execCtx.data, ctx)
            yield* hooks.runRecordCreateSuccess({ ...execCtx, result })
            return result
          }).pipe(
            Effect.tapError((error: CollectionError) =>
              hooks.runRecordCreateError({ collection, action: "create", error, auth: toAuth(ctx.auth) })
            ),
            withSpanWhenEnabled(
              "hook.create",
              { kind: "internal", attributes: { collection: collection.name } },
              { captureStackTrace: false }
            )
          ),

        // Bulk create keeps the record hooks: the pre/execute stages run per
        // record before the transaction opens (so a hook can still rewrite or
        // veto an item), the inserts then run as one transaction in the inner
        // service, and success hooks fire per created record afterwards.
        createMany: (collection: AnyCollectionDef, records: ReadonlyArray<RepoRecord>, ctx: RequestCtx) =>
          Effect.gen(function* () {
            const auth = toAuth(ctx.auth)
            const prepared = yield* Effect.forEach(
              records,
              (data) =>
                Effect.gen(function* () {
                  const hookCtx = yield* hooks.runRecordCreate({ collection, data, record: undefined, auth })
                  return yield* hooks.runRecordCreateExecute(hookCtx)
                }),
              { concurrency: 1 }
            )
            const results = yield* inner.createMany(
              collection,
              prepared.map((hookCtx) => hookCtx.data),
              ctx
            )
            yield* Effect.forEach(
              results,
              (result) => hooks.runRecordCreateSuccess({ collection, data: result, record: undefined, auth, result }),
              { concurrency: "unbounded" }
            )
            return results
          }).pipe(
            Effect.tapError((error: CollectionError) =>
              Effect.forEach(
                records,
                () => hooks.runRecordCreateError({ collection, action: "create", error, auth: toAuth(ctx.auth) }),
                { concurrency: "unbounded" }
              )
            ),
            withSpanWhenEnabled(
              "hook.createMany",
              { kind: "internal", attributes: { collection: collection.name } },
              { captureStackTrace: false }
            )
          ),

        update: (collection: AnyCollectionDef, id: string, data: RepoRecord, ctx: RequestCtx) =>
          Effect.gen(function* () {
            const auth = toAuth(ctx.auth)
            const existing = yield* inner.view(collection, id, ctx)
            const hookCtx = yield* hooks.runRecordUpdate({ collection, data, record: existing, auth })
            const execCtx = yield* hooks.runRecordUpdateExecute(hookCtx)
            const result = yield* inner.update(collection, id, execCtx.data, ctx)
            yield* hooks.runRecordUpdateSuccess({ ...execCtx, result })
            return result
          }).pipe(
            Effect.tapError((error: CollectionError) =>
              hooks.runRecordUpdateError({ collection, action: "update", error, auth: toAuth(ctx.auth) })
            ),
            withSpanWhenEnabled(
              "hook.update",
              { kind: "internal", attributes: { collection: collection.name } },
              { captureStackTrace: false }
            )
          ),

        // Bulk update keeps the per-record hooks: pre/execute stages (including
        // the stored-row view that `update` exposes as `record`) run per entry
        // before the transaction opens, the updates run as one transaction in
        // the inner service, and success observers fire per updated record.
        updateMany: (
          collection: AnyCollectionDef,
          updates: ReadonlyArray<{ id: string; data: RepoRecord }>,
          ctx: RequestCtx
        ) =>
          Effect.gen(function* () {
            const auth = toAuth(ctx.auth)
            const prepared = yield* Effect.forEach(
              updates,
              (update) =>
                Effect.gen(function* () {
                  const existing = yield* inner.view(collection, update.id, ctx)
                  const hookCtx = yield* hooks.runRecordUpdate({
                    collection,
                    data: update.data,
                    record: existing,
                    auth
                  })
                  return yield* hooks.runRecordUpdateExecute(hookCtx)
                }),
              { concurrency: 1 }
            )
            const results = yield* inner.updateMany(
              collection,
              prepared.map((execCtx, index) => ({ id: updates[index].id, data: execCtx.data })),
              ctx
            )
            yield* Effect.forEach(
              results.map((result, index) => ({ execCtx: prepared[index], result })),
              ({ execCtx, result }) => hooks.runRecordUpdateSuccess({ ...execCtx, result }),
              { concurrency: "unbounded" }
            )
            return results
          }).pipe(
            Effect.tapError((error: CollectionError) =>
              Effect.forEach(
                updates,
                () => hooks.runRecordUpdateError({ collection, action: "update", error, auth: toAuth(ctx.auth) }),
                { concurrency: "unbounded" }
              )
            ),
            withSpanWhenEnabled(
              "hook.updateMany",
              { kind: "internal", attributes: { collection: collection.name } },
              { captureStackTrace: false }
            )
          ),

        delete: (collection: AnyCollectionDef, id: string, ctx: RequestCtx) =>
          Effect.gen(function* () {
            const auth = toAuth(ctx.auth)
            const existing = yield* inner.view(collection, id, ctx)
            const hookCtx = yield* hooks.runRecordDelete({ collection, data: existing, record: existing, auth })
            const execCtx = yield* hooks.runRecordDeleteExecute(hookCtx)
            yield* inner.delete(collection, id, ctx)
            yield* hooks.runRecordDeleteSuccess({ ...execCtx, result: existing })
          }).pipe(
            Effect.tapError((error: CollectionError) =>
              hooks.runRecordDeleteError({ collection, action: "delete", error, auth: toAuth(ctx.auth) })
            ),
            withSpanWhenEnabled(
              "hook.delete",
              { kind: "internal", attributes: { collection: collection.name } },
              { captureStackTrace: false }
            )
          ),

        // Bulk delete keeps the per-record hooks: the stored-row view and the
        // delete pre/execute stages run per id before the transaction opens, the
        // deletes run as one transaction in the inner service, and success
        // observers fire per deleted record.
        deleteMany: (collection: AnyCollectionDef, ids: ReadonlyArray<string>, ctx: RequestCtx) =>
          Effect.gen(function* () {
            const auth = toAuth(ctx.auth)
            const prepared = yield* Effect.forEach(
              ids,
              (id) =>
                Effect.gen(function* () {
                  const existing = yield* inner.view(collection, id, ctx)
                  const hookCtx = yield* hooks.runRecordDelete({
                    collection,
                    data: existing,
                    record: existing,
                    auth
                  })
                  return yield* hooks.runRecordDeleteExecute(hookCtx)
                }),
              { concurrency: 1 }
            )
            const deleted = yield* inner.deleteMany(collection, ids, ctx)
            yield* Effect.forEach(
              deleted.map((id, index) => ({ execCtx: prepared[index], id })),
              ({ execCtx }) => hooks.runRecordDeleteSuccess({ ...execCtx, result: execCtx.data }),
              { concurrency: "unbounded" }
            )
            return deleted
          }).pipe(
            Effect.tapError((error: CollectionError) =>
              Effect.forEach(
                ids,
                () => hooks.runRecordDeleteError({ collection, action: "delete", error, auth: toAuth(ctx.auth) }),
                { concurrency: "unbounded" }
              )
            ),
            withSpanWhenEnabled(
              "hook.deleteMany",
              { kind: "internal", attributes: { collection: collection.name } },
              { captureStackTrace: false }
            )
          )
      })
    })
  )
}
