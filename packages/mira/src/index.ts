// Re-export everything from the client package so server users only need @gettersethya/mira
export * from "@gettersethya/mira-client"

// App builder
export * from "./app/index.js"
export * from "./databases/index.js"
export * from "./platforms/node.js"
export * from "./storage/index.js"

// Server errors
export * from "./collection-service/errors.js"

// Server-side types (WhereClause is already re-exported via @gettersethya/mira-client)
export type { CursorResult, ExpandDef, FilterOptions, ListOptions, RepoRecord, SortOrder } from "./repository/types.js"

// Plugin system
export * from "./hooks/index.js"

// Server services (for plugins and advanced usage)
export type { CursorPage,RequestCtx } from "./collection-service/index.js"
export { CollectionService, makeCollectionServiceLayer } from "./collection-service/index.js"
export { AppConfig, AppConfigLive } from "./config/index.js"
export { CryptoService } from "./crypto/index.js"
export { AuthService, hashPassword, verifyJwt,verifyPassword } from "./http/auth.js"
export type { CorsConfig } from "./http/cors.js"
export { defaultCorsConfig, makeCorsMiddleware } from "./http/cors.js"
export { catchCollectionErrors } from "./http/errors.js"
export { Repository, RepositoryLive } from "./repository/index.js"

// Telemetry (sqlite logger)
export type { SqliteLoggerConfig } from "./telemetry/sqlite-logger.js"
export { logCleanupCronDef,makeSqliteTelemetryLayer } from "./telemetry/sqlite-logger.js"
export { TelemetrySqlClient } from "./telemetry/telemetry-sql-client.js"

// Telemetry (console tracer/logger)
export type { ConsolePrintOptions } from "./telemetry/index.js"
export { ConsoleTelemetryLayer, makeConsoleTelemetryLayer } from "./telemetry/index.js"

// Cron system
export type {
  CronContext,
  CronDef,
  CronErrorContext,
  CronFinishedContext,
  CronResultContext,
  CronState
} from "./cron/index.js"
export { CronNotFoundError,CronService, makeCronServiceLayer } from "./cron/index.js"
