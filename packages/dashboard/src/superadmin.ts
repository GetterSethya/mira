import { AuthCollection } from "@gettersethya/mira-client"
import type { AnyCollectionDef } from "@gettersethya/mira-client"

export const SuperAdminCollection: AnyCollectionDef = AuthCollection.define("_superadmin", {}).rules((R) => ({
  list: R.field("email").eq(R.literal("")),
  view: R.field("email").eq(R.literal("")),
  create: R.public(),
  update: R.field("email").eq(R.literal("")),
  delete: R.field("email").eq(R.literal("")),
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
