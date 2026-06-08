import { Effect } from "effect"
import type { MiraPlugin } from "@gettersethya/mira"
import { AppConfig } from "@gettersethya/mira"
import { SuperAdminCollection, setRegisterToken, generateRegisterToken } from "./superadmin.js"
import { makeDashboardRouter } from "./router.js"

export const MiraDashboard: MiraPlugin = {
  _tag: "MiraPlugin",

  collections: [SuperAdminCollection],

  routes: makeDashboardRouter([SuperAdminCollection]),

  onBootstrap: () =>
    Effect.gen(function* () {
      const token = generateRegisterToken()
      setRegisterToken(token)
      const cfg = yield* AppConfig
      yield* Effect.log("[dashboard] Dashboard plugin loaded")
      yield* Effect.log(`[dashboard] Register at: ${cfg.applicationUrl}/_dashboard/register?token=${token}`)
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
