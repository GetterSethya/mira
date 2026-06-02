// Re-export everything from the client package so server users only need @gettersethya/mira
export * from "@gettersethya/mira-client"

// App builder
export * from "./app/index.js"
export * from "./platforms/node.js"
export * from "./databases/index.js"
export * from "./storage/index.js"

// Server errors
export * from "./collection-service/errors.js"

// Server-side types (WhereClause is already re-exported via @gettersethya/mira-client)
export type { CursorResult, ExpandDef, FilterOptions, ListOptions, RepoRecord, SortOrder } from "./repository/types.js"

// Plugin system
export * from "./hooks/index.js"

// Server services (for plugins and advanced usage)
export { Repository, RepositoryLive } from "./repository/index.js"
export { AuthService, hashPassword, verifyPassword } from "./http/auth.js"
export { AppConfig, AppConfigLive } from "./config/index.js"
export { CryptoService } from "./crypto/index.js"

// Telemetry (sqlite logger)
export { makeSqliteTelemetryLayer } from "./telemetry/sqlite-logger.js"
export type { SqliteLoggerConfig } from "./telemetry/sqlite-logger.js"
