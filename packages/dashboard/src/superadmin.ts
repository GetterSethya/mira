import { defineRule, applyRulesToCollections } from "@gettersethya/mira"
import { SuperAdminDef } from "./collection.js"

export const SuperAdminRules = defineRule(SuperAdminDef, (R) => ({
  list: R.authCollection().eq(R.literal("_superadmin")),
  view: R.authCollection().eq(R.literal("_superadmin")),
  create: R.public(),
  update: R.authCollection().eq(R.literal("_superadmin")),
  delete: R.authCollection().eq(R.literal("_superadmin"))
}))

export const SuperAdminCollection = applyRulesToCollections([SuperAdminDef], [SuperAdminRules])[0]

export { SuperAdminDef } from "./collection.js"

let _registerToken = ""

export function getRegisterToken(): string {
  return _registerToken
}

export function setRegisterToken(token: string): void {
  _registerToken = token
}

export function generateRegisterToken(): string {
  const arr = new Uint8Array(32)
  globalThis.crypto.getRandomValues(arr)
  return Buffer.from(arr).toString("hex")
}
