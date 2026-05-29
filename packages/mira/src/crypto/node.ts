import * as nodeCrypto from "node:crypto"
import { Effect, Layer } from "effect"
import { CryptoService } from "./crypto.js"

export const NodeCryptoLayer = Layer.succeed(
  CryptoService,
  CryptoService.of({
    randomBytesSync: (size) => nodeCrypto.randomBytes(size),
    randomBytes: (size) => Effect.sync(() => nodeCrypto.randomBytes(size)),
    randomUUID: () => Effect.sync(() => nodeCrypto.randomUUID())
  })
)
