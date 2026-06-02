import { AuthCollection } from "@gettersethya/mira-client"
import type { AnyCollectionDef } from "@gettersethya/mira-client"
import { CryptoService, AppConfig, Repository } from "@gettersethya/mira"
import { Effect, Layer } from "effect"

export const SuperAdminCollection: AnyCollectionDef = AuthCollection.define("_superadmin", {}).rules((R) => ({
  list: R.field("email").eq(R.literal("")),
  view: R.field("email").eq(R.literal("")),
  create: R.public(),
  update: R.field("email").eq(R.literal("")),
  delete: R.field("email").eq(R.literal("")),
}))

let _registerToken = ""

export const RegisterTokenLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const repo = yield* Repository
    const rows = yield* repo.list("_superadmin", 1).pipe(
      Effect.map((r) => r.items),
      Effect.orElseSucceed(() => [])
    )
    if (rows.length > 0) return
    const crypto = yield* CryptoService
    const config = yield* AppConfig
    const bytes = yield* crypto.randomBytes(32)
    const token = Buffer.from(bytes).toString("hex")
    _registerToken = token
    yield* Effect.log(`[dashboard] No superadmin? Register at ${config.applicationUrl}/_dashboard/register?token=${token}`)
  })
)

export const getRegisterToken = () => _registerToken
