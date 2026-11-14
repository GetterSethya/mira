import type { FileSystem, Path } from "effect"
import type { Effect, Layer } from "effect"
import type { SqlClient } from "effect/sql"

import type { AppConfig } from "@/config/index.js"
import type { CryptoService } from "@/crypto/crypto.js"
import type { Dialect } from "@/dialect/dialect.js"
import type { MailTransport } from "@/email/types.js"
import type { AuthService } from "@/http/auth.js"
import type { HttpServerFactory } from "@/http/server-factory.js"
import type { AuthRateLimitPolicies, EmailRateLimitPolicies } from "@/rate-limit/policies.js"
import type { RateLimitStore } from "@/rate-limit/types.js"
import type { FileStorage } from "@/storage/storage.js"
import type { ThumbnailService } from "@/thumbnail/types.js"

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
  | MailTransport

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
  /**
   * Optional platform image backend. Defaults to the Photon layer. Bun supplies
   * a native `Bun.Image` layer for contain/fill specs.
   */
  readonly thumbnailLayer?: Layer.Layer<ThumbnailService>
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
 * @see S3CompatibleStorage — S3-compatible implementation
 * @see MiraBuilder.storage — where MiraStorage is used
 */
export interface MiraStorage {
  layer: Layer.Layer<FileStorage, never, FileSystem.FileSystem | Path.Path>
}

/**
 * Optional email preset. Mirrors {@link MiraStorage}: the builder selects the
 * transport, and the layer resolves settings once at build time.
 */
export interface MiraEmail {
  /** `EmailService` is a referenced service; the layer output type is never. */
  readonly layer: Layer.Layer<never, never, PlatformServices | AppConfig>
}

/**
 * Optional rate-limit configuration. The default store is SQLite; a custom
 * store layer must be self-contained so the app does not need to know its
 * backend. `emailPolicies` overrides the default limits for the email flows.
 */
export interface MiraRateLimits {
  readonly store?: Layer.Layer<RateLimitStore, never, never>
  readonly emailPolicies?: Partial<EmailRateLimitPolicies>
  /** Password-login limits. These fail closed on store errors. */
  readonly authPolicies?: Partial<AuthRateLimitPolicies>
}
