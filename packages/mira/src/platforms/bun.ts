import { BunFileSystem, BunPath, BunRuntime } from "@effect/platform-bun"
import { Layer } from "effect"

import type { MiraPlatform } from "@/app/types.js"
import { NodeCryptoLayer } from "@/crypto/node.js"
import { NodeAuthServiceLayer } from "@/http/auth-node.js"
import { BunHttpServerFactoryLayer } from "@/http/server-factory-bun.js"

import { NodeMailTransportLayer } from "./node-email.js"

/**
 * Bun platform layer preset.
 *
 * Filesystem, path, and HTTP server are native Bun implementations. Crypto,
 * password hashing, and SMTP reuse the Node-compatible layers: Bun 1.4.2
 * implements `node:crypto` and `nodemailer`'s transport stack.
 */
export const BunPlatformLayer = Layer.mergeAll(
  BunFileSystem.layer,
  BunPath.layer,
  NodeCryptoLayer,
  BunHttpServerFactoryLayer,
  NodeMailTransportLayer
)

/**
 * Bun platform preset consumed by `Mira.builder().platform(...)`.
 *
 * @example
 * import { BunPlatform, BunSqliteDatabase, LocalFileStorage, Mira } from "@gettersethya/mira/bun"
 *
 * Mira.builder()
 *   .platform(BunPlatform)
 *   .database(BunSqliteDatabase({ filename: "./data.db" }))
 *   .storage(LocalFileStorage({ directory: "./uploads" }))
 *   .collections([Posts])
 *   .build()
 *   .serve()
 */
export const BunPlatform: MiraPlatform = {
  layer: Layer.mergeAll(BunPlatformLayer, NodeAuthServiceLayer),
  runMain: (effect) => BunRuntime.runMain(effect)
}

/** Re-exported so custom Bun entrypoints can reach the runtime. */
export { BunRuntime }
