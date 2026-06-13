import { FileSystem, HttpRouter, HttpServer, Path } from "@effect/platform"
import type { SqlClient } from "@effect/sql"
import { Effect, Layer } from "effect"
import { RepositoryLive } from "@/repository/repository.js"
import { Migrator, MigratorLive } from "@/migrator/migrator.js"
import type { NamedSchema } from "@/migrator/types.js"
import { makeCachedCollectionServiceLayer } from "@/cache/index.js"
import { makeCollectionRouter } from "@/http/router.js"
import { ThumbnailServicePhotonLive } from "@/thumbnail/index.js"
import { ipAnnotationMiddleware } from "@/http/ip-middleware.js"
import { AppConfig, AppConfigLive } from "@/config/index.js"
import type { AuthService } from "@/http/auth.js"
import { HttpServerFactory } from "@/http/server-factory.js"
import type { Repository } from "@/repository/index.js"
import type { CollectionService } from "@/collection-service/collection-service.js"
import type { AnyCollectionDef } from "@gettersethya/mira-client"
import type { MiraAppConfig } from "./builder.js"
import type { MiraPlugin } from "./plugin.js"
import { makeHookServiceLayer } from "@/hooks/hook-service.js"
import { makeHookCollectionServiceLayer } from "@/hooks/hook-collection.js"
import { HookService } from "@/hooks/hook-service.js"
import { makeCronServiceLayer } from "@/cron/cron-service.js"
import { CronService } from "@/cron/cron-service.js"
import type { CronDef } from "@/cron/types.js"

function assertUniqueCronNames(defs: ReadonlyArray<CronDef>) {
  const seen = new Set<string>()
  for (const def of defs) {
    if (seen.has(def.name)) {
      throw new Error(`Duplicate cron name: "${def.name}". Cron names must be globally unique.`)
    }
    seen.add(def.name)
  }
}

/**
 * The assembled Mira application, ready to serve.
 *
 * Created by `MiraBuilder.build()`. Do not construct directly — use the
 * `Mira.builder()` fluent API.
 *
 * `MiraApp` wires all layers (database, storage, collection service, HTTP server,
 * telemetry, auto-migration) and provides `serve()` to start the server.
 * Use `extend()` to add plugins before serving.
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
 * // With plugin
 * app.extend(MiraDashboard).serve({ port: 8080 })
 *
 * @see MiraBuilder — builds MiraApp
 * @see Mira — entry point: Mira.builder()
 */
export class MiraApp {
  readonly #config: MiraAppConfig
  readonly #extras: Array<MiraPlugin>

  constructor(config: MiraAppConfig) {
    this.#config = config
    this.#extras = []
  }

  /** @internal for tests only */
  _getConfig(): MiraAppConfig {
    return this.#config
  }

  /** @internal for tests only */
  _getExtras(): ReadonlyArray<MiraPlugin> {
    return this.#extras
  }

  /**
   * Add a plugin to the application. Plugins can register lifecycle hooks,
   * record-lifecycle hooks, custom routes, service layers, and additional
   * collection definitions.
   *
   * @param plugin - A MiraPlugin (use `fromLayer()` to wrap a plain Layer)
   * @returns this (for chaining)
   *
   * @example
   * app.extend(MiraDashboard).serve()
   */
  extend(plugin: MiraPlugin) {
    this.#extras.push(plugin)
    return this
  }

  #getAllCollections(): ReadonlyArray<AnyCollectionDef> {
    return [
      ...(this.#config.collections as ReadonlyArray<AnyCollectionDef>),
      ...this.#extras.flatMap((p) => p.collections ?? [])
    ]
  }

  #getAllPlugins(): ReadonlyArray<MiraPlugin> {
    return this.#extras
  }

  #getAllCrons(): ReadonlyArray<CronDef> {
    return [...this.#config.crons, ...this.#extras.flatMap((p) => p.crons ?? [])]
  }

  /**
   * Build the full service layer without the HTTP server.
   * Useful for testing — you can run Effects against the service layer without
   * starting a network server.
   *
   * Includes: database, storage, telemetry, repository, migrator, app config,
   * collection service (with cache + hooks), and auto-migration.
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
    const { platform, database, storage, telemetry } = this.#config
    const allCollections = this.#getAllCollections()
    const allPlugins = this.#getAllPlugins()
    const allCronDefs = this.#getAllCrons()
    assertUniqueCronNames(allCronDefs)

    const pluginLayers = allPlugins.filter((p) => p.layer !== undefined).map((p) => p.layer!)

    const extrasLayer = pluginLayers.length > 0 ? pluginLayers.reduce((acc, l) => Layer.merge(acc, l)) : Layer.empty

    // Foundation: database + storage + thumbnail + telemetry, wired on platform
    const foundation = Layer.mergeAll(database.layer, storage.layer, ThumbnailServicePhotonLive, telemetry).pipe(
      Layer.provideMerge(platform.layer)
    )

    // Mid: Repository + Migrator + AppConfig, wired on foundation
    const mid = Layer.mergeAll(RepositoryLive, MigratorLive, AppConfigLive).pipe(Layer.provideMerge(foundation))

    // Extras: plugin layers run after mid so they can depend on AppConfig + platform services
    const extrasProvided = extrasLayer.pipe(Layer.provide(mid))
    const fullMid = Layer.merge(mid, extrasProvided)

    // Auto-migrate on boot: runs during layer initialization before requests are served
    const schemas: NamedSchema[] = allCollections.map((c) => ({ name: c.name, schema: c.schema }))
    const autoMigrateLayer = Layer.effectDiscard(
      Effect.gen(function* () {
        const migrator = yield* Migrator
        yield* migrator.migrate(schemas)
      }).pipe(Effect.orDie)
    ).pipe(Layer.provide(fullMid))

    // Core collection service (cached)
    const cachedCollectionLayer = makeCachedCollectionServiceLayer(allCollections)

    // Hook service layer (collects all plugin hooks)
    const hookServiceLayer = makeHookServiceLayer(allPlugins)

    // Hook collection service decorator: wraps cached collection service with hooks
    const hookCollectionLayer = makeHookCollectionServiceLayer().pipe(
      Layer.provide(Layer.mergeAll(cachedCollectionLayer, hookServiceLayer))
    )

    // Full top layer: hook-wrapped collection service + all mid services + auto-migration side effect
    const topLayer = hookCollectionLayer.pipe(Layer.provideMerge(Layer.merge(fullMid, autoMigrateLayer)))

    // Cron service: scoped fibers die when server stops; provided with full service stack + hook service
    const cronServiceLayer = makeCronServiceLayer(allCronDefs).pipe(
      Layer.provide(Layer.mergeAll(topLayer, hookServiceLayer))
    )

    return Layer.merge(topLayer, cronServiceLayer)
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
    const allCollections = this.#getAllCollections()
    const collectionRouter = makeCollectionRouter(allCollections)

    // Plugin routes
    let pluginRouter: HttpRouter.HttpRouter<
      never,
      | FileSystem.FileSystem
      | Path.Path
      | Repository
      | AppConfig
      | AuthService
      | SqlClient.SqlClient
      | CollectionService
      | CronService
    > = HttpRouter.empty
    for (const plugin of this.#extras) {
      if (plugin.routes !== undefined) {
        pluginRouter = HttpRouter.concat(pluginRouter, plugin.routes)
      }
    }

    const router = HttpRouter.concat(collectionRouter, pluginRouter)
    const serviceLayer = this.buildServiceLayer()

    const serverLayer = Layer.unwrapEffect(
      Effect.gen(function* () {
        const cfg = yield* AppConfig
        const factory = yield* HttpServerFactory
        return factory.makeLayer(options?.port ?? cfg.port)
      })
    )

    return HttpServer.serve(ipAnnotationMiddleware(router)).pipe(
      Layer.provideMerge(serverLayer),
      Layer.provideMerge(serviceLayer)
    )
  }

  /**
   * Start the Mira HTTP server.
   * Sets up all services, runs auto-migration, runs plugin lifecycle hooks,
   * and listens for incoming requests.
   * Blocks the main thread until the server is shut down.
   *
   * @param options.port - Optional port override (default: from AppConfig, typically 8080)
   *
   * @example
   * app.serve()              // default port
   * app.serve({ port: 8080 }) // port override
   */
  serve(options?: { port?: number }): void {
    const allPlugins = this.#getAllPlugins()
    const hookServiceLayer = makeHookServiceLayer(allPlugins)
    const fullLayer = this.buildLayer(options)

    this.#config.platform.runMain(
      Effect.gen(this, function* () {
        const hookService = yield* HookService.pipe(Effect.provide(hookServiceLayer))
        const bootstrapLayer = Layer.effectDiscard(hookService.runBootstrap())
        yield* Layer.launch(bootstrapLayer.pipe(Layer.provideMerge(fullLayer)))
        yield* hookService.runServe()
      }) as Effect.Effect<never, never, never>
    )
  }
}
