import { NodeFileSystem, NodePath, NodeRuntime } from "@effect/platform-node"
import { Layer } from "effect"
import { NodeCryptoLayer } from "@/crypto/node.js"
import { NodeHttpServerFactoryLayer } from "@/http/server-factory-node.js"
import { NodeAuthServiceLayer } from "@/http/auth-node.js"
import type { MiraPlatform } from "@/app/types.js"

/**
 * Node.js platform layer preset.
 * Merges all Node-specific service implementations:
 * - NodeFileSystem
 * - NodePath
 * - NodeCryptoLayer (randomBytes, randomUUID via crypto module)
 * - NodeHttpServerFactoryLayer (HTTP server via @effect/platform-node)
 *
 * @example
 * import { NodePlatformLayer } from "@gettersethya/mira"
 *
 * @see NodePlatform — the preset that wraps this layer with runMain and auth
 */
export const NodePlatformLayer = Layer.mergeAll(
  NodeFileSystem.layer,
  NodePath.layer,
  NodeCryptoLayer,
  NodeHttpServerFactoryLayer,
)

/**
 * Node.js platform preset combining the platform layer with auth services.
 * Also re-exports `NodeRuntime` for custom main functions.
 *
 * @example
 * Mira.builder()
 *   .platform(NodePlatform)
 *   .database(SqliteDatabase({ filename: "data.db" }))
 *   .storage(LocalFileStorage({ directory: "./uploads" }))
 *   .collections([Posts])
 *   .build()
 *   .serve()
 *
 * @see NodePlatformLayer — the underlying service layer
 * @see MiraPlatform — the interface NodePlatform implements
 */
export const NodePlatform: MiraPlatform = {
  layer: Layer.mergeAll(NodePlatformLayer, NodeAuthServiceLayer),
  runMain: (effect) => NodeRuntime.runMain(effect),
}

/**
 * Node runtime from @effect/platform-node.
 * Re-exported for convenience when writing custom entrypoints.
 */
export { NodeRuntime }
