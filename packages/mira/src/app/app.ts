import type { AnyCollectionDef } from "@gettersethya/mira-client"
import type { RuleMap } from "@gettersethya/mira-client"
import { Effect, Layer } from "effect"
import { HttpRouter } from "effect/http"

import { AuthChallengeStoreLive } from "@/auth/index.js"
import { makeCachedCollectionServiceLayer } from "@/cache/index.js"
import { makeCollectionServiceLayer } from "@/collection-service/collection-service.js"
import {
  makeBatchedCollectionServiceLayer,
  makeBatchMutationStatsLayer,
  resolveBatchMutationConfig
} from "@/collection-service/index.js"
import { AppConfig, AppConfigLive } from "@/config/index.js"
import { makeHookedEmailServiceLayer } from "@/email/index.js"
import { EmailTemplates, makeEmailTemplates } from "@/email/index.js"
import type { EmailTemplatesConfig } from "@/email/index.js"
import { makeCronServiceLayer } from "@/cron/cron-service.js"
import type { CronDef } from "@/cron/types.js"
import { makeHookCollectionServiceLayer } from "@/hooks/hook-collection.js"
import { makeHookServiceLayer } from "@/hooks/hook-service.js"
import { HookService } from "@/hooks/hook-service.js"
import { defaultCorsConfig, makeCorsMiddleware } from "@/http/cors.js"
import { ipAnnotationMiddleware } from "@/http/ip-middleware.js"
import { makePortRetryServerLayer } from "@/http/port-retry.js"
import { makeCollectionRouter } from "@/http/router.js"
import { HttpServerFactory } from "@/http/server-factory.js"
import { TokenStoreLive } from "@/http/token-store.js"
import { Migrator, MigratorLive } from "@/migrator/migrator.js"
import type { NamedSchema } from "@/migrator/types.js"
import {
  assertValidAuthRateLimitPolicies,
  assertValidEmailRateLimitPolicies,
  AuthRateLimitConfig,
  defaultAuthRateLimitPolicies,
  defaultEmailRateLimitPolicies,
  EmailRateLimitConfig
} from "@/rate-limit/index.js"
import {
  RateLimiterLive,
  RateLimitKeySecretLive,
  SqliteRateLimitStoreLive
} from "@/rate-limit/sqlite.js"
import { RepositoryLive } from "@/repository/repository.js"
import { ThumbnailServicePhotonLive } from "@/thumbnail/lazy.js"
import { ThumbnailServiceNoopLive } from "@/thumbnail/types.js"

import type { MiraAppConfig } from "./builder.js"
import type { RuleBinding } from "./define-rule.js"
import type { MiraPlugin } from "./plugin.js"

function assertUniqueCronNames(defs: ReadonlyArray<CronDef<any>>) {
  const seen = new Set<string>()
  for (const def of defs) {
    if (seen.has(def.name)) {
      throw new Error(`Duplicate cron name: "${def.name}". Cron names must be globally unique.`)
    }
    seen.add(def.name)
  }
}

/**
 * Validates `.emailTemplates({ collections })` keys at build time. Every key
 * must name a registered auth collection; unknown or non-auth keys throw so a
 * typo cannot silently fall back to built-in mail.
 */
export function assertValidEmailTemplateCollections(
  collections: ReadonlyArray<AnyCollectionDef>,
  config: EmailTemplatesConfig
) {
  const names = Object.keys(config.collections ?? {})
  if (names.length === 0) return
  const byName = new Map(collections.map((c) => [c.name, c]))
  for (const name of names) {
    const collection = byName.get(name)
    if (collection === undefined) {
      throw new Error(
        `emailTemplates.collections references unknown collection "${name}". ` +
          `Available collections: ${[...byName.keys()].join(", ")}.`
      )
    }
    if (collection.schema["x-collection-kind"] !== "auth") {
      throw new Error(
        `emailTemplates.collections key "${name}" is not an auth collection. ` +
          `Email template overrides apply only to auth collections.`
      )
    }
  }
}

export function applyRulesToCollections<C extends AnyCollectionDef>(
  collections: ReadonlyArray<C>,
  rules: ReadonlyArray<RuleBinding>
): Array<C> {
  const collectionNames = new Set(collections.map((c) => c.name))
  for (const rb of rules) {
    if (!collectionNames.has(rb.collectionName)) {
      throw new Error(
        `RuleBinding references unknown collection "${rb.collectionName}". ` +
          `Available collections: ${[...collectionNames].join(", ")}.`
      )
    }
  }
  const ruleMap = new Map<string, RuleMap>(rules.map((r) => [r.collectionName, r.ruleMap]))
  return collections.map((c): C => {
    const rm = ruleMap.get(c.name)
    if (rm) {
      return { ...c, schema: { ...c.schema, "x-rules": rm } }
    }
    return c
  })
}

/**
 * Options for `MiraApp.serve()` and `MiraApp.buildLayer()`.
 */
export interface ServeOptions {
  /** Port to listen on. Defaults to the port from `AppConfig`. */
  port?: number
  /**
   * Total number of ports to try when the requested port is already in use.
   * The server increments the port and retries until a free one is found.
   * Defaults to 10. Pass `1` to disable retrying.
   */
  maxPortAttempts?: number
  /**
   * Disable the HTTP router's per-request access log. Defaults to `false`.
   *
   * The access log is useful in development but costs a log record, formatting
   * and a write to the configured logger on every request. Disable it for
   * throughput-sensitive deployments and benchmarks.
   */
  disableLogger?: boolean
  /**
   * Disable span registration globally. Defaults to `false`.
   *
   * When telemetry is not exported, the Effect runtime still creates native
   * spans and captures a short stack trace for each `withSpan`. Disabling
   * tracing removes that overhead, at the cost of losing all spans and
   * trace propagation for the process.
   */
  disableTracing?: boolean
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
export class MiraApp<R = never, Telemetry = never> {
  readonly #config: MiraAppConfig<Telemetry>
  readonly #extras: Array<MiraPlugin<any>>
  constructor(config: MiraAppConfig<Telemetry>) {
    this.#config = config
    this.#extras = []
  }

  /** @internal for tests only */
  _getConfig(): MiraAppConfig<Telemetry> {
    return this.#config
  }

  /** @internal for tests only */
  _getExtras(): ReadonlyArray<MiraPlugin<any>> {
    return this.#extras
  }

  /** @internal for tests only */
  _resolveAdminCollections(): ReadonlyArray<AnyCollectionDef> {
    return this.#getAdminCollections()
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
  extend(plugin: MiraPlugin<any>): MiraApp<R, Telemetry> {
    this.#extras.push(plugin)
    return this
  }

  #getAllCollections(): ReadonlyArray<AnyCollectionDef> {
    const configCollections = applyRulesToCollections(this.#config.collections, this.#config.rules ?? [])
    const all = [
      ...configCollections,
      ...this.#extras.flatMap((p) => p.collections ?? []),
      ...this.#getAdminCollections()
    ]
    const byName = new Map<string, AnyCollectionDef>()
    for (const c of all) {
      if (!byName.has(c.name)) {
        byName.set(c.name, c)
      }
    }
    return [...byName.values()]
  }

  #getAllPlugins(): ReadonlyArray<MiraPlugin<any>> {
    return this.#extras
  }

  #getAllCrons(): ReadonlyArray<CronDef<any>> {
    return [...this.#config.crons, ...this.#extras.flatMap((p) => p.crons ?? [])]
  }

  #getAdminCollections(): ReadonlyArray<AnyCollectionDef> {
    return this.#extras.flatMap((p) => p.adminCollections ?? [])
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
    const { database, email, migrations: migrateOptions, platform, storage, telemetry } = this.#config
    const allCollections = this.#getAllCollections()
    const allPlugins = this.#getAllPlugins()
    const allCronDefs = this.#getAllCrons()
    assertUniqueCronNames(allCronDefs)
    assertValidEmailTemplateCollections(allCollections, this.#config.emailTemplates ?? {})

    const pluginLayers = allPlugins.filter((p) => p.layer !== undefined).map((p) => p.layer!)

    const extrasLayer = pluginLayers.length > 0 ? pluginLayers.reduce((acc, l) => Layer.merge(acc, l)) : Layer.empty

    // Foundation: database + storage + thumbnails + telemetry, wired on platform.
    // Platforms may supply a native thumbnail backend; Photon is the default,
    // but there is no reason to load an image backend when no collection can
    // store a file. `ThumbnailServicePhotonLive` is the lazy layer: it imports
    // `@cf-wasm/photon` only when the layer is actually built, so an app with no
    // file fields never pays the WASM module-init cost.
    const hasFileFields = allCollections.some((collection) =>
      Object.values(collection.schema.properties).some((prop) => prop["x-kind"] === "file")
    )
    const thumbnailLayer =
      platform.thumbnailLayer ?? (hasFileFields ? ThumbnailServicePhotonLive : ThumbnailServiceNoopLive)
    // Shared-mode telemetry reuses the application `SqlClient` and `Dialect`.
    // Providing the database layer here only satisfies that requirement; it does
    // not hide `TelemetryStore`, because the telemetry layer uses
    // `Layer.provideMerge` internally.
    const telemetryLayer = telemetry.pipe(Layer.provide(database.layer))
    const foundation = Layer.mergeAll(
      database.layer,
      storage.layer,
      thumbnailLayer,
      telemetryLayer
    ).pipe(Layer.provideMerge(platform.layer))

    // Rate limiting: the store is the swap point. The default is SQLite.
    const appConfigLayer = AppConfigLive
    const rateLimitStoreLayer = this.#config.rateLimits?.store ?? SqliteRateLimitStoreLive
    const rateLimiterLayer = RateLimiterLive.pipe(Layer.provide(rateLimitStoreLayer))
    const rateLimitKeySecretLayer = RateLimitKeySecretLive.pipe(Layer.provide(appConfigLayer))
    const emailRateLimitPolicies = {
      ...defaultEmailRateLimitPolicies,
      ...this.#config.rateLimits?.emailPolicies
    }
    assertValidEmailRateLimitPolicies(emailRateLimitPolicies)
    const emailRateLimitConfigLayer = Layer.succeed(EmailRateLimitConfig, emailRateLimitPolicies)
    const authRateLimitPolicies = {
      ...defaultAuthRateLimitPolicies,
      ...this.#config.rateLimits?.authPolicies
    }
    assertValidAuthRateLimitPolicies(authRateLimitPolicies)
    const authRateLimitConfigLayer = Layer.succeed(AuthRateLimitConfig, authRateLimitPolicies)

    // Mid: Repository + Migrator + AppConfig + durable TokenStore + challenge and rate stores
    const mid = Layer.mergeAll(
      RepositoryLive,
      MigratorLive,
      appConfigLayer,
      TokenStoreLive,
      AuthChallengeStoreLive,
      rateLimitStoreLayer,
      rateLimiterLayer,
      rateLimitKeySecretLayer,
      emailRateLimitConfigLayer,
      authRateLimitConfigLayer,
      Layer.succeed(EmailTemplates, makeEmailTemplates(this.#config.emailTemplates ?? {}))
    ).pipe(Layer.provideMerge(foundation))

    // Hook service is independent of the collection service; email hooks need it early.
    const hookServiceLayer = makeHookServiceLayer(allPlugins)

    // Email: base transport after AppConfig, then the hook decorator.
    const baseEmail = email.layer.pipe(Layer.provide(mid), Layer.orDie)
    const hookedEmail = makeHookedEmailServiceLayer().pipe(
      Layer.provide(Layer.mergeAll(baseEmail, hookServiceLayer, mid))
    )

    // Extras: plugin layers run after mid + email so they can depend on both
    const extrasProvided = extrasLayer.pipe(Layer.provide(Layer.merge(mid, hookedEmail)))
    const fullMid = Layer.mergeAll(mid, hookedEmail, extrasProvided)

    // Auto-migrate on boot: runs during layer initialization before requests are served
    const schemas: Array<NamedSchema> = allCollections.map((c) => ({ name: c.name, schema: c.schema }))
    const autoMigrateLayer = Layer.effectDiscard(
      Effect.gen(function* () {
        const migrator = yield* Migrator
        yield* migrator.migrate(schemas, migrateOptions)
      }).pipe(Effect.orDie)
    ).pipe(Layer.provide(fullMid))

    // Mutation batching. One stats value per app build: it is merged below (so
    // plugin routes can read it) and passed to the batched base service.
    // `queue === null` means the feature is off — the disabled batcher runs
    // mutations inline and no queue/fiber is created.
    const batchMutation = resolveBatchMutationConfig(this.#config.batchMutation)
    const batchingEnabled = batchMutation.queue !== null
    const batchMutationStatsLayer = makeBatchMutationStatsLayer()

    // Core collection service: cached by default, or uncached when the app
    // explicitly disables the cache. The hook decorator wraps either one.
    const cacheConfig = this.#config.cache ?? {}
    const collectionServiceLayer =
      cacheConfig.enabled === false
        ? batchingEnabled
          ? makeBatchedCollectionServiceLayer(allCollections, batchMutation, batchMutationStatsLayer)
          : makeCollectionServiceLayer(allCollections)
        : makeCachedCollectionServiceLayer(
            allCollections,
            cacheConfig,
            batchingEnabled
              ? {
                  batchMutation,
                  statsLayer: batchMutationStatsLayer
                }
              : {}
          )

    // Hook collection service decorator: wraps the selected collection service with hooks
    const hookCollectionLayer = makeHookCollectionServiceLayer().pipe(
      Layer.provide(Layer.mergeAll(collectionServiceLayer, hookServiceLayer))
    )

    // Full top layer: hook-wrapped collection service + all mid services +
    // auto-migration side effect + the app-wide create-batch stats value (so
    // plugin routes can resolve `BatchMutationStats`).
    const topLayer = hookCollectionLayer.pipe(
      Layer.provideMerge(Layer.mergeAll(fullMid, autoMigrateLayer, batchMutationStatsLayer))
    )

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
   * @param options - Optional serve options (`port`, `maxPortAttempts`, `disableLogger`, `disableTracing`)
   * @returns A Layer ready to be launched
   *
   * @internal Called by serve() — most users should use serve() directly.
   */
  buildLayer(options?: ServeOptions) {
    const allCollections = this.#getAllCollections()
    const adminCollections = this.#getAdminCollections().map((c) => c.name)
    const collectionRoutes = makeCollectionRouter(allCollections, adminCollections)
    const pluginRoutes = this.#extras.flatMap((p) =>
      typeof p.routes === "function" ? p.routes(allCollections) : p.routes ?? []
    )
    const routes = [...collectionRoutes, ...pluginRoutes]

    const serviceLayer = this.buildServiceLayer()

    const serverLayer = Layer.unwrap(
      Effect.gen(function* () {
        const cfg = yield* AppConfig
        const factory = yield* HttpServerFactory
        const effectivePort = options?.port ?? cfg.port
        return makePortRetryServerLayer(factory, effectivePort, options?.maxPortAttempts, (boundPort) =>
          cfg.updateBoundPort?.(boundPort)
        )
      })
    ).pipe(Layer.provide(serviceLayer))

    return HttpRouter.serve(HttpRouter.addAll(routes), {
      middleware: (effect) => ipAnnotationMiddleware(makeCorsMiddleware(this.#config.cors)(effect)),
      disableLogger: options?.disableLogger === true
    }).pipe(Layer.provide(serverLayer), Layer.provideMerge(serviceLayer))
  }

  /**
   * Start the Mira HTTP server.
   * Sets up all services, runs auto-migration, runs plugin lifecycle hooks,
   * and listens for incoming requests.
   * Blocks the main thread until the server is shut down.
   *
   * If the requested port is already in use, the server automatically retries
   * on the next available port (up to `maxPortAttempts`, default 10).
   *
   * @param options - Optional serve options (`port`, `maxPortAttempts`, `disableLogger`, `disableTracing`)
   *
   * @example
   * app.serve()                       // default port, auto-increment if busy
   * app.serve({ port: 8080 })         // explicit port, auto-increment if busy
   * app.serve({ port: 8080, maxPortAttempts: 1 }) // fail instead of incrementing
   */
  serve(options?: ServeOptions): void {
    const allPlugins = this.#getAllPlugins()
    const hookServiceLayer = makeHookServiceLayer(allPlugins)
    const fullLayer = this.buildLayer(options)
    const usingDefaultCors = this.#config.cors === defaultCorsConfig

    const appEffect = Effect.gen(function* () {
        if (usingDefaultCors) {
          yield* Effect.logWarning(
            "CORS: using the permissive default — every Origin is reflected and credentials are allowed. " +
              "Configure Mira.builder().cors({ allowedOrigins, credentials }) for production."
          )
        }
        const hookService = yield* HookService.pipe(Effect.provide(hookServiceLayer))
        const bootstrapLayer = Layer.effectDiscard(hookService.runBootstrap())
        yield* Layer.launch(bootstrapLayer.pipe(Layer.provideMerge(fullLayer)))
        yield* hookService.runServe()
    }) as Effect.Effect<never, never, never>

    this.#config.platform.runMain(
      options?.disableTracing === true ? Effect.withTracerEnabled(false)(appEffect) : appEffect
    )
  }
}
