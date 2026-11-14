import { BunFileSystem, BunPath, BunRuntime } from "@effect/platform-bun"
import { Effect, Layer } from "effect"

import type { MiraPlatform } from "@/app/types.js"
import { BunCryptoLayer } from "@/crypto/bun.js"
import { BunAuthServiceLayer } from "@/http/auth-bun.js"
import { NodeAuthServiceLayer } from "@/http/auth-node.js"
import { BunHttpServerFactoryLayer } from "@/http/server-factory-bun.js"
import { ThumbnailServiceBunLive } from "@/thumbnail/bun.js"

import { isSupportedBunVersion, MINIMUM_BUN_VERSION } from "./bun-version.js"
import { NodeMailTransportLayer } from "./node-email.js"

/**
 * Fail the layer build early on an unsupported Bun instead of silently
 * degrading the native image path.
 */
const assertSupportedBunRuntime = Layer.effectDiscard(
  Effect.sync(() => {
    const version = (globalThis as { Bun?: { version?: string } }).Bun?.version
    if (version === undefined) return
    if (!isSupportedBunVersion(version)) {
      throw new Error(
        `Mira's Bun platform requires Bun >= ${MINIMUM_BUN_VERSION}; found ${version}`
      )
    }
  })
)

/**
 * Bun platform layer preset.
 *
 * Requires Bun `>=1.3.14` (the first release with `Bun.Image`); the layer
 * checks the runtime version at build time and fails fast below that floor.
 * Filesystem, path, HTTP server, crypto, password hashing, and image resizing
 * use native Bun implementations. SMTP still reuses `nodemailer` because Bun
 * has no built-in SMTP client; Bun's native `node:net` and TLS back that stack.
 */
export const BunPlatformLayer = Layer.mergeAll(
  assertSupportedBunRuntime,
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
export { isSupportedBunVersion, MINIMUM_BUN_VERSION } from "./bun-version.js"
