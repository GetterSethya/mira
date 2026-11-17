// Bun entry point. Re-export the isomorphic client package so Bun users only
// need the Bun subpath.
export * from "@gettersethya/mira-client"

// App builder + Bun runtime presets.
export * from "./app/index.js"
export { BunSqliteDatabase, BunSqliteDatabase as SqliteDatabase } from "./databases/sqlite-bun.js"
export type { LibsqlDatabaseConfig } from "./databases/libsql.js"
export { LibsqlConfigError, LibsqlDatabase, TursoDatabase } from "./databases/libsql.js"
export * from "./platforms/bun.js"
export * from "./storage/index.js"

// Server errors.
export * from "./collection-service/errors.js"

// Server-side types (WhereClause is already re-exported via @gettersethya/mira-client).
export type { CursorResult, ExpandDef, FilterOptions, ListOptions, RepoRecord, SortOrder } from "./repository/types.js"

// Plugin system.
export * from "./hooks/index.js"

// Server services (for plugins and advanced usage).
export type { CursorPage, RequestCtx } from "./collection-service/index.js"
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
  BunCryptoLayer,
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
export { BunAuthServiceLayer } from "./http/auth-bun.js"
export { NodeAuthServiceLayer } from "./http/auth-node.js"
export type { CorsConfig } from "./http/cors.js"
export { defaultCorsConfig, makeCorsMiddleware } from "./http/cors.js"
export { catchCollectionErrors } from "./http/errors.js"
export { TokenStore, TokenStoreLive } from "./http/token-store.js"
export { Repository, RepositoryLive } from "./repository/index.js"
export {
  DEFAULT_THUMBNAIL_MAX_PIXELS,
  makeThumbnailServiceBunLive,
  makeThumbnailServicePhotonLive,
  parseThumbSpec,
  SUPPORTED_THUMBNAIL_MIME_TYPES,
  ThumbnailError,
  ThumbnailService,
  ThumbnailServiceBunLive,
  ThumbnailServiceNoopLive,
  ThumbnailServicePhotonLive
} from "./thumbnail/index.js"
export type { BunThumbnailOptions, PhotonThumbnailOptions, ThumbSpec } from "./thumbnail/index.js"

// Telemetry. The SQL store is driver-neutral: pass a Bun SQLite database preset.
export * from "./telemetry/index-core.js"
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

// Cron system.
export type {
  CronContext,
  CronDef,
  CronErrorContext,
  CronFinishedContext,
  CronResultContext,
  CronState
} from "./cron/index.js"
export { CronNotFoundError, CronService, makeCronServiceLayer } from "./cron/index.js"
