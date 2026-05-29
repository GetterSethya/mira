import type { FileSystem, Path } from "@effect/platform"
import type { Effect, Layer } from "effect"
import type { SqlClient } from "@effect/sql"
import type { AuthService } from "@/http/auth.js"
import type { HttpServerFactory } from "@/http/server-factory.js"
import type { CryptoService } from "@/crypto/crypto.js"
import type { Dialect } from "@/migrator/dialect.js"
import type { FileStorage } from "@/storage/storage.js"

/**
 * Services that a platform preset must provide.
 * Union type including CryptoService, FileSystem, Path, HttpServerFactory, and AuthService.
 *
 * @see MiraPlatform — requires a Layer providing these services
 */
export type PlatformServices =
  | CryptoService
  | FileSystem.FileSystem
  | Path.Path
  | HttpServerFactory
  | AuthService

/**
 * Services that a database preset must provide.
 * Union type including SqlClient and Dialect.
 *
 * @see MiraDatabase — requires a Layer providing these services
 */
export type DatabaseServices = SqlClient.SqlClient | Dialect

/**
 * Interface for a platform preset (e.g., Node, Bun).
 * Must provide a Layer with all PlatformServices and a `runMain` function
 * that runs an Effect to completion.
 *
 * @see NodePlatform — Node.js implementation
 * @see MiraBuilder.platform — where MiraPlatform is used
 */
export interface MiraPlatform {
  layer: Layer.Layer<PlatformServices>
  runMain: (effect: Effect.Effect<never, never, never>) => void
}

/**
 * Interface for a database preset (e.g., SQLite).
 * Must provide a Layer with all DatabaseServices.
 *
 * @see SqliteDatabase — SQLite implementation
 * @see MiraBuilder.database — where MiraDatabase is used
 */
export interface MiraDatabase {
  layer: Layer.Layer<DatabaseServices>
}

/**
 * Interface for a storage preset (e.g., local disk, S3).
 * Must provide a Layer with FileStorage, requiring FileSystem and Path.
 *
 * @see LocalFileStorage — local disk implementation
 * @see MiraBuilder.storage — where MiraStorage is used
 */
export interface MiraStorage {
  layer: Layer.Layer<FileStorage, never, FileSystem.FileSystem | Path.Path>
}
