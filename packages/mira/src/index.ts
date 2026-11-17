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
export type {
  BatchMutationFlush,
  BatchMutationStatsSnapshot,
  BatchOperationStatsSnapshot,
  MiraBatchMutationConfig,
  MiraBatchOperationConfig,
  MutationBatchEntry,
  MutationBatchResult,
  PreparedCreate,
  ResolvedBatchMutationConfig,
  ResolvedBatchOperationConfig,
  ResolvedBatchQueueConfig
} from "./collection-service/index.js"
export {
  CollectionService,
  MutationBatcher,
  MutationBatcherDisabledLive,
  BatchMutationStats,
  estimateRowBytes,
  makeBatchedCollectionServiceLayer,
  makeCollectionServiceLayer,
  makeMutationBatcherLayer,
  makeBatchMutationStatsLayer,
  MAX_BULK_CREATE_RECORDS,
  MAX_BULK_RECORDS,
  resolveBatchMutationConfig,
  resolveBatchOperationConfig
} from "./collection-service/index.js"
export { AppConfig, AppConfigLive } from "./config/index.js"
export {
  bytesToBase64Url,
  CryptoHashError,
  CryptoService,
  hmacSha256Base64,
  hmacSha256Base64Url,
  sha256Base64Url
} from "./crypto/index.js"
export * from "./rate-limit/index.js"
export {
  RateLimiterLive,
  RateLimitKeySecretLive,
  SqliteRateLimitStoreLive
} from "./rate-limit/sqlite.js"
export * from "./email/index.js"
export {
  AuthChallengeStore,
  AuthChallengeStoreLive,
  constantTimeEqual,
  generateChallengeId,
  generateOtp,
  generateResetToken,
  hashOtp,
  hashResetToken
} from "./auth/index.js"
export type {
  AuthChallengeStoreShape,
  AuthEmailError,
  ChallengePurpose,
  ChallengeRecord
} from "./auth/index.js"
export {
  AuthService,
  authenticateSession,
  hashPassword,
  mintSession,
  verifyJwt,
  verifyPassword
} from "./http/auth.js"
export type { CorsConfig } from "./http/cors.js"
export { defaultCorsConfig, makeCorsMiddleware } from "./http/cors.js"
export { catchCollectionErrors } from "./http/errors.js"
export { TokenStore, TokenStoreLive } from "./http/token-store.js"
export { Repository, RepositoryLive } from "./repository/index.js"
export {
  DEFAULT_THUMBNAIL_MAX_PIXELS,
  makeThumbnailServicePhotonLive,
  parseThumbSpec,
  ThumbnailError,
  ThumbnailService,
  ThumbnailServiceNoopLive,
  ThumbnailServicePhotonLive
} from "./thumbnail/index.js"
export type { PhotonThumbnailOptions, ThumbSpec } from "./thumbnail/index.js"

// Telemetry (store + SQL implementation)
export type {
  TelemetryCoreConfig,
  TelemetryDatabase,
  TelemetryDeleteResult,
  TelemetryListQuery,
  TelemetryLogEntry,
  TelemetryLogPage,
  TelemetryLogRow,
  TelemetryLoggerConfig,
  TelemetryReadShape,
  TelemetrySpanEntry,
  TelemetrySpanPage,
  TelemetrySpanRow,
  TelemetryStorageConfig,
  TelemetryStoreShape
} from "./telemetry/index.js"
export {
  logCleanupCronDef,
  makeSqlTelemetryStoreLayer,
  makeTelemetryLayer,
  makeTelemetryLayerForClient,
  SqlTelemetryStoreLive,
  TelemetryDuplicateEntryError,
  TelemetryStore,
  TelemetryStoreError
} from "./telemetry/index.js"

// Telemetry (console tracer/logger)
export type { ConsolePrintOptions } from "./telemetry/index-core.js"
export { ConsoleTelemetryLayer, makeConsoleTelemetryLayer } from "./telemetry/index-core.js"

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
