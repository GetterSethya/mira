import { BunFileSystem, BunPath, BunRuntime } from "@effect/platform-bun"
import { Layer } from "effect"

import type { MiraPlatform } from "@/app/types.js"
import { BunCryptoLayer } from "@/crypto/bun.js"
import { BunAuthServiceLayer } from "@/http/auth-bun.js"
import { NodeAuthServiceLayer } from "@/http/auth-node.js"
import { BunHttpServerFactoryLayer } from "@/http/server-factory-bun.js"
import { ThumbnailServiceBunLive } from "@/thumbnail/bun.js"

import { NodeMailTransportLayer } from "./node-email.js"

/**
 * Bun platform layer preset.
 *
 * Filesystem, path, HTTP server, crypto, password hashing, and image resizing
 * use native Bun implementations. SMTP still reuses `nodemailer` because Bun
 * has no built-in SMTP client; Bun's native `node:net` and TLS back that stack.
 */
export const BunPlatformLayer = Layer.mergeAll(
  BunFileSystem.layer,
  BunPath.layer,
  BunCryptoLayer,
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
  layer: Layer.mergeAll(BunPlatformLayer, BunAuthServiceLayer),
  runMain: (effect) => BunRuntime.runMain(effect),
  thumbnailLayer: ThumbnailServiceBunLive
}

/**
 * Bun preset that keeps the portable `scrypt$<salt>$<hash>` password format.
 *
 * Everything else is native Bun, but new passwords are hashed with the shared
 * Node scrypt implementation so a database can move from Bun back to Node
 * without resetting credentials. Use this instead of `BunPlatform` when
 * bidirectional runtime portability matters more than Argon2id.
 */
export const BunPortablePlatform: MiraPlatform = {
  layer: Layer.mergeAll(BunPlatformLayer, NodeAuthServiceLayer),
  runMain: (effect) => BunRuntime.runMain(effect),
  thumbnailLayer: ThumbnailServiceBunLive
}

/** Re-exported so custom Bun entrypoints can reach the runtime. */
export { BunRuntime }
