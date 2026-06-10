import { AuthCollection } from "@gettersethya/mira-client"
import type { AnyCollectionDef } from "@gettersethya/mira-client"

export const SuperAdminCollection: AnyCollectionDef = AuthCollection.define("_superadmin", {}).rules((R) => ({
  list: R.authCollection().eq(R.literal("_superadmin")),
  view: R.authCollection().eq(R.literal("_superadmin")),
  create: R.public(),
  update: R.authCollection().eq(R.literal("_superadmin")),
  delete: R.authCollection().eq(R.literal("_superadmin"))
}))

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
