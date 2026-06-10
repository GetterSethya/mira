import { Effect } from "effect"
import type { MiraPlugin } from "@gettersethya/mira"
import { AppConfig, CollectionService } from "@gettersethya/mira"
import { SuperAdminCollection, setRegisterToken, generateRegisterToken } from "./superadmin.js"
import { makeDashboardRouter } from "./router.js"

export const MiraDashboard: MiraPlugin = {
  _tag: "MiraPlugin",

  collections: [SuperAdminCollection],

  routes: makeDashboardRouter([SuperAdminCollection]),

  onBootstrap: () =>
    Effect.gen(function* () {
      const token = generateRegisterToken()
      const cfg = yield* AppConfig
      const svc = yield* CollectionService
      const results = yield* svc
        .list(SuperAdminCollection, null, 1, { headers: {}, query: {}, admin: true })
        .pipe(Effect.orDie)

      yield* Effect.log("[dashboard] Dashboard plugin loaded")

      if (results.items.length === 0) {
        setRegisterToken(token)
        yield* Effect.log(`[dashboard] Register at: ${cfg.applicationUrl}/_dashboard/register?token=${token}`)
      } else {
        yield* Effect.log(`[dashboard] run at: ${cfg.applicationUrl}/_dashboard/`)
      }
    }),

  onServe: () => Effect.log("[dashboard] Available at /_dashboard/"),

  onRecordCreateSuccess: {
    handler: (ctx) => Effect.log(`[dashboard] audit: created ${String(ctx.result["id"])} in ${ctx.collection.name}`)
  },

  onRecordUpdateSuccess: {
    handler: (ctx) => Effect.log(`[dashboard] audit: updated ${String(ctx.result["id"])} in ${ctx.collection.name}`)
  },

  onRecordDeleteSuccess: {
    handler: (ctx) => Effect.log(`[dashboard] audit: deleted ${String(ctx.result["id"])} in ${ctx.collection.name}`)
  }
}

export { SuperAdminCollection } from "./superadmin.js"
export { getRegisterToken, setRegisterToken, generateRegisterToken } from "./superadmin.js"
export { makeDashboardRouter } from "./router.js"
export type { MiraPlugin } from "@gettersethya/mira"
