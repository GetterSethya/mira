import { HttpServer } from "@effect/platform"
import { Effect, Layer } from "effect"
import { RepositoryLive } from "@/repository/repository.js"
import { Migrator, MigratorLive } from "@/migrator/migrator.js"
import type { NamedSchema } from "@/migrator/types.js"
import { makeCachedCollectionServiceLayer } from "@/cache/index.js"
import { makeCollectionRouter } from "@/http/router.js"
import { ThumbnailServicePhotonLive } from "@/thumbnail/index.js"
import { ipAnnotationMiddleware } from "@/http/ip-middleware.js"
import { AppConfig, AppConfigLive } from "@/config/index.js"
import { HttpServerFactory } from "@/http/server-factory.js"
import type { AnyCollectionDef } from "@gettersethya/mira-client"
import type { MiraAppConfig } from "./builder.js"

/**
 * The assembled Mira application, ready to serve.
 *
 * Created by `MiraBuilder.build()`. Do not construct directly — use the
 * `Mira.builder()` fluent API.
 *
 * `MiraApp` wires all layers (database, storage, collection service, HTTP server,
 * telemetry, auto-migration) and provides `serve()` to start the server.
 * Use `extend()` to add custom layers before serving.
 *
 * @example
 * const app = Mira.builder()
 *   .platform(NodePlatform)
 *   .database(SqliteDatabase({ filename: "data.db" }))
 *   .storage(LocalFileStorage({ directory: "./uploads" }))
 *   .collections([Posts, Users])
 *   .build()
 *
 * app.serve()
 *
 * @example
 * // With custom layer
 * app.extend(MyCustomLayer).serve({ port: 8080 })
 *
 * @see MiraBuilder — builds MiraApp
 * @see Mira — entry point: Mira.builder()
 */
export class MiraApp {
  readonly #config: MiraAppConfig
  readonly #extras: Array<Layer.Layer<never, never, never>>

  constructor(config: MiraAppConfig) {
    this.#config = config
    this.#extras = []
  }

  /** @internal for tests only */
  _getConfig(): MiraAppConfig {
    return this.#config
  }

  /** @internal for tests only */
  _getExtras(): ReadonlyArray<Layer.Layer<never, never, never>> {
    return this.#extras
  }

  /**
   * Add an arbitrary Effect Layer to the application's layer composition.
   * Useful for providing custom services (e.g., custom telemetry, custom auth).
   * Layers are merged in order of calls to `extend()`.
   *
   * @param layer - Any Layer<never, never, never>
   * @returns this (for chaining)
   *
   * @example
   * app.extend(Layer.succeed(MyTag, myImpl))
   */
  extend(layer: Layer.Layer<never, never, never>): this {
    this.#extras.push(layer)
    return this
  }

  /**
   * Build the full service layer without the HTTP server.
   * Useful for testing — you can run Effects against the service layer without
   * starting a network server.
   *
   * Includes: database, storage, telemetry, repository, migrator, app config,
   * collection service (with cache), and auto-migration.
   *
   * @returns A Layer providing all services
   *
   * @example
   * const serviceLayer = app.buildServiceLayer()
   * const result = await Effect.runPromise(
   *   Effect.gen(function* () { ... }).pipe(Effect.provide(serviceLayer))
   * )
   */
  buildServiceLayer() {
    const { platform, database, storage, collections, telemetry } = this.#config
    const collectionList = collections as ReadonlyArray<AnyCollectionDef>

    const extrasLayer =
      this.#extras.length > 0
        ? this.#extras.reduce((acc, l) => Layer.merge(acc, l))
        : Layer.empty

    // Foundation: database + storage + thumbnail + telemetry + extras, wired on platform
    const foundation = Layer.mergeAll(
      database.layer,
      storage.layer,
      ThumbnailServicePhotonLive,
      telemetry,
      extrasLayer,
    ).pipe(Layer.provideMerge(platform.layer))

    // Mid: Repository + Migrator + AppConfig, wired on foundation
    const mid = Layer.mergeAll(RepositoryLive, MigratorLive, AppConfigLive).pipe(
      Layer.provideMerge(foundation),
    )

    // Auto-migrate on boot: runs during layer initialization before requests are served
    const schemas: NamedSchema[] = collectionList.map((c) => ({ name: c.name, schema: c.schema }))
    const autoMigrateLayer = Layer.effectDiscard(
      Effect.gen(function* () {
        const migrator = yield* Migrator
        yield* migrator.migrate(schemas)
      }).pipe(Effect.orDie),
    ).pipe(Layer.provide(mid))

    // Top: CollectionService + all mid services + auto-migration side effect
    return makeCachedCollectionServiceLayer(collectionList).pipe(
      Layer.provideMerge(Layer.merge(mid, autoMigrateLayer)),
    )
  }

  /**
   * Build the complete server layer including the HTTP router and server.
   * Accepts an optional port override (otherwise uses the port from AppConfig).
   *
   * @param options.port - Optional port number override
   * @returns A Layer ready to be launched
   *
   * @internal Called by serve() — most users should use serve() directly.
   */
  buildLayer(options?: { port?: number }) {
    const { collections } = this.#config
    const collectionList = collections as ReadonlyArray<AnyCollectionDef>
    const router = makeCollectionRouter(collectionList)
    const serviceLayer = this.buildServiceLayer()

    const serverLayer = Layer.unwrapEffect(
      Effect.gen(function* () {
        const cfg = yield* AppConfig
        const factory = yield* HttpServerFactory
        return factory.makeLayer(options?.port ?? cfg.port)
      }),
    )

    return HttpServer.serve(ipAnnotationMiddleware(router)).pipe(
      Layer.provideMerge(serverLayer),
      Layer.provideMerge(serviceLayer),
    )
  }

  /**
   * Start the Mira HTTP server.
   * Sets up all services, runs auto-migration, and listens for incoming requests.
   * Blocks the main thread until the server is shut down.
   *
   * @param options.port - Optional port override (default: from AppConfig, typically 8080)
   *
   * @example
   * app.serve()              // default port
   * app.serve({ port: 8080 }) // port override
   */
  serve(options?: { port?: number }): void {
    this.#config.platform.runMain(
      Layer.launch(this.buildLayer(options)).pipe(Effect.orDie),
    )
  }
}
