import { HttpMiddleware } from "effect/http"

/**
 * CORS configuration for the Mira HTTP server.
 *
 * Applied as `HttpMiddleware.cors(...)` in `MiraApp.buildLayer()`, alongside
 * the IP annotation middleware. Covers all routes (including error responses —
 * the middleware stamps headers via a pre-response handler, which also runs on
 * the failure path) and answers `OPTIONS` preflights with a `204`.
 *
 * When `cors()` is never called on the builder, the server uses
 * `defaultCorsConfig` (fully permissive), so a separately-hosted frontend
 * works with zero configuration in development.
 *
 * @see defaultCorsConfig — the permissive default
 * @see makeCorsMiddleware — maps this config onto `HttpMiddleware.cors`
 * @see MiraBuilder.cors — where this config is set
 */
export interface CorsConfig {
  /**
   * Origins allowed to access the API.
   *
   * - Omitted or `[]` → `Access-Control-Allow-Origin: *` (all origins).
   * - One origin → that origin is always echoed with `Vary: Origin`.
   * - Several origins → the request origin is echoed only when listed,
   *   otherwise no `Access-Control-Allow-Origin` header is sent.
   * - Predicate → the request origin is echoed only when it returns true.
   *
   * A literal `"*"` entry combined with `credentials: true` is rejected by
   * `assertValidCorsConfig` — browsers forbid wildcard + credentials.
   */
  readonly allowedOrigins?: ReadonlyArray<string> | ((origin: string) => boolean)
  /**
   * Value of the `Access-Control-Allow-Methods` preflight header.
   * Defaults to `["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE"]`.
   */
  readonly allowedMethods?: ReadonlyArray<string>
  /**
   * Value of the `Access-Control-Allow-Headers` preflight header.
   * Defaults to reflecting the request's `Access-Control-Request-Headers`,
   * which always covers every header the client SDK sends.
   */
  readonly allowedHeaders?: ReadonlyArray<string>
  /**
   * Value of the `Access-Control-Expose-Headers` header.
   * Unset by default (no headers exposed).
   */
  readonly exposedHeaders?: ReadonlyArray<string>
  /**
   * Value of the `Access-Control-Max-Age` preflight header, in seconds.
   * Unset by default (preflights are not cached).
   */
  readonly maxAge?: number
  /**
   * Whether to send `Access-Control-Allow-Credentials: true`.
   * Requires explicit `allowedOrigins` — wildcard + credentials throws.
   * Defaults to false.
   */
  readonly credentials?: boolean
}

/**
 * The default CORS configuration: fully permissive (`*`, default methods,
 * reflected request headers), so a frontend on another origin works with
 * zero configuration.
 *
 * @see CorsConfig
 */
export const defaultCorsConfig: CorsConfig = {}

/**
 * Rejects CORS configurations that browsers refuse to honor: `credentials`
 * combined with a wildcard origin (omitted, empty, or containing `"*"`).
 * A predicate origin check cannot be inspected statically and is always
 * allowed — it echoes only origins it accepts, which is safe.
 *
 * @throws If the config combines `credentials: true` with a wildcard origin.
 */
export function assertValidCorsConfig(config: CorsConfig) {
  if (config.credentials !== true) return
  const origins = config.allowedOrigins
  if (origins === undefined || (Array.isArray(origins) && (origins.length === 0 || origins.includes("*")))) {
    throw new Error(
      "Invalid CORS config: credentials: true requires explicit allowedOrigins. " +
        'Browsers reject Access-Control-Allow-Origin: "*" with credentials — list the allowed origins explicitly or use a predicate.'
    )
  }
}

/**
 * Maps a `CorsConfig` onto Effect's `HttpMiddleware.cors` middleware.
 * Validates first, so misconfiguration fails at boot, not per request.
 *
 * @see CorsConfig
 */
export const makeCorsMiddleware = (config: CorsConfig) => {
  assertValidCorsConfig(config)
  return HttpMiddleware.cors({
    allowedOrigins: config.allowedOrigins,
    allowedMethods: config.allowedMethods,
    allowedHeaders: config.allowedHeaders,
    exposedHeaders: config.exposedHeaders,
    maxAge: config.maxAge,
    credentials: config.credentials
  })
}
