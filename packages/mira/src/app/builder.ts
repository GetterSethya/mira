import { ConsoleTelemetryLayer } from "@/telemetry/index.js"
import type { Layer } from "effect"
import type { AnyCollectionDef } from "@gettersethya/mira-client"
import type { MiraPlatform, MiraDatabase, MiraStorage } from "./types.js"
import { MiraApp } from "./app.js"

/**
 * Configuration object for `MiraApp`. Constructed by `MiraBuilder` after all
 * required steps are called. Only the `telemetry` field is optional — it defaults
 * to `ConsoleTelemetryLayer`.
 *
 * @see MiraBuilder — builds this config
 */
export interface MiraAppConfig {
  platform: MiraPlatform
  database: MiraDatabase
  storage: MiraStorage
  collections: ReadonlyArray<AnyCollectionDef>
  telemetry: Layer.Layer<never, never, never>
}

function isMiraAppConfig(config: Partial<MiraAppConfig>): config is MiraAppConfig {
  return (
    config.platform !== undefined &&
    config.database !== undefined &&
    config.storage !== undefined &&
    config.collections !== undefined
  )
}

/**
 * Phantom-type builder for constructing a `MiraApp`.
 *
 * Uses TypeScript's type system to enforce that all required steps are called
 * before `build()` is allowed. The type parameter `Has` tracks which steps have
 * been completed.
 *
 * Required steps (order does not matter):
 * 1. `.platform(p)` — choose Node, Bun, etc.
 * 2. `.database(d)` — choose SQLite, etc.
 * 3. `.storage(s)` — choose LocalFileStorage, S3, etc.
 * 4. `.collections(c)` — provide collection definitions
 *
 * Optional step: `.telemetry(l)` — custom telemetry layer
 *
 * @example
 * const app = Mira.builder()
 *   .platform(NodePlatform)
 *   .database(SqliteDatabase({ filename: "data.db" }))
 *   .storage(LocalFileStorage({ directory: "./uploads" }))
 *   .collections([Posts, Users])
 *   .build()
 *   .serve()
 *
 * @see MiraApp — the assembled application
 * @see Mira.builder — entry point
 */
export class MiraBuilder<Has extends string = never> {
  readonly #config: Partial<MiraAppConfig>

  constructor(config: Partial<MiraAppConfig> = {}) {
    this.#config = config
  }

  /** @internal for tests only */
  _getPartialConfig(): Partial<MiraAppConfig> {
    return this.#config
  }

  /**
   * Set the platform (runtime environment).
   * Required step. The platform provides CryptoService, FileSystem, Path,
   * HttpServerFactory, and AuthService implementations.
   *
   * @param p - A MiraPlatform preset (e.g., NodePlatform)
   * @returns A new builder with "platform" added to the phantom type
   */
  platform(p: MiraPlatform): MiraBuilder<Has | "platform"> {
    return new MiraBuilder({ ...this.#config, platform: p })
  }

  /**
   * Set the database backend.
   * Required step. The database provides SqlClient and Dialect implementations.
   *
   * @param d - A MiraDatabase preset (e.g., SqliteDatabase({ filename: "data.db" }))
   * @returns A new builder with "database" added to the phantom type
   */
  database(d: MiraDatabase): MiraBuilder<Has | "database"> {
    return new MiraBuilder({ ...this.#config, database: d })
  }

  /**
   * Set the file storage backend.
   * Required step. Storage provides FileStorage for file upload/download operations.
   *
   * @param s - A MiraStorage preset (e.g., LocalFileStorage({ directory: "./uploads" }))
   * @returns A new builder with "storage" added to the phantom type
   */
  storage(s: MiraStorage): MiraBuilder<Has | "storage"> {
    return new MiraBuilder({ ...this.#config, storage: s })
  }

  /**
   * Set the collection definitions.
   * Required step. The collections define the schema, rules, and indexes for all entities.
   *
   * @param c - Array of collection definitions from BaseCollection.define(), AuthCollection.define(),
   *            or ViewCollection.define()
   * @returns A new builder with "collections" added to the phantom type
   */
  collections(c: ReadonlyArray<AnyCollectionDef>): MiraBuilder<Has | "collections"> {
    return new MiraBuilder({ ...this.#config, collections: c })
  }

  /**
   * Set a custom telemetry layer (optional).
   * Defaults to `ConsoleTelemetryLayer` (prints JSON trace lines to stdout).
   *
   * @param l - A Layer providing telemetry services
   * @returns A new builder with "telemetry" added to the phantom type
   */
  telemetry(l: Layer.Layer<never, never, never>): MiraBuilder<Has | "telemetry"> {
    return new MiraBuilder({ ...this.#config, telemetry: l })
  }

  /**
   * Build the MiraApp from the accumulated configuration.
   * Only compiles when all required steps (platform, database, storage, collections)
   * have been called. If telemetry was not set, defaults to ConsoleTelemetryLayer.
   *
   * @param this - Constrained to MiraBuilder with all four required tags
   * @returns A fully configured MiraApp ready to serve()
   *
   * @throws If build() is called before all required steps are completed
   *         (caught at compile time by the phantom type)
   */
  build(this: MiraBuilder<"platform" | "database" | "storage" | "collections">) {
    const config = this._getPartialConfig()
    if (!isMiraAppConfig(config)) {
      throw new Error("build() called on incomplete builder")
    }
    return new MiraApp({
      platform: config.platform,
      database: config.database,
      storage: config.storage,
      collections: config.collections,
      telemetry: config.telemetry ?? ConsoleTelemetryLayer
    })
  }
}
