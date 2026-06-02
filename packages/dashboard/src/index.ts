import { Effect } from "effect"
import type { MiraPlugin } from "@gettersethya/mira"
import { SuperAdminCollection, getRegisterToken, setRegisterToken, generateRegisterToken } from "./superadmin.js"
import { makeDashboardRouter } from "./router.js"

export const MiraDashboard: MiraPlugin = {
  _tag: "MiraPlugin",

  collections: [SuperAdminCollection],

  routes: makeDashboardRouter([SuperAdminCollection]),

  onBootstrap: () =>
    Effect.sync(() => {
      const token = generateRegisterToken()
      setRegisterToken(token)
    }).pipe(Effect.tap(() => Effect.log("[dashboard] Dashboard plugin loaded"))),

  onServe: () => Effect.log("[dashboard] Available at /_dashboard/"),

  onRecordCreateSuccess: {
    handler: (ctx) =>
      Effect.log(`[dashboard] audit: created ${String(ctx.result["id"])} in ${ctx.collection.name}`),
  },

  onRecordUpdateSuccess: {
    handler: (ctx) =>
      Effect.log(`[dashboard] audit: updated ${String(ctx.result["id"])} in ${ctx.collection.name}`),
  },

  onRecordDeleteSuccess: {
    handler: (ctx) =>
      Effect.log(`[dashboard] audit: deleted ${String(ctx.result["id"])} in ${ctx.collection.name}`),
  },
}

export { SuperAdminCollection } from "./superadmin.js"
export { getRegisterToken, setRegisterToken, generateRegisterToken } from "./superadmin.js"
export { makeDashboardRouter } from "./router.js"
export type { MiraPlugin } from "@gettersethya/mira"
