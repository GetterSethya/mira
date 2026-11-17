import { isSqlError } from "effect/sql/SqlError"

import type { DialectType } from "./dialect.js"
import { errorHasCode } from "./dialect.js"
import { sqliteDialect } from "./dialect-sqlite.js"

/** How Mira talks to a libSQL endpoint. */
export type LibsqlConnectionMode = "local" | "remote"

const REMOTE_SCHEMES = new Set(["libsql", "http", "https", "ws", "wss"])

/**
 * Classifies a libSQL URL without opening a connection.
 *
 * `file:` and `:memory:` are local SQLite files. Everything the libSQL client
 * sends over a network transport is remote, including embedded replicas, which
 * use a `file:` URL plus `syncUrl`.
 */
export function libsqlConnectionMode(url: string): LibsqlConnectionMode {
  if (url === ":memory:" || url.startsWith("file:")) return "local"

  const separator = url.indexOf(":")
  if (separator > 0 && REMOTE_SCHEMES.has(url.slice(0, separator).toLowerCase())) {
    return "remote"
  }

  throw new Error(
    `Unsupported libSQL URL "${url}". Use file:, :memory:, libsql:, http:, https:, ws:, or wss:.`
  )
}

const RETRYABLE_CODES = [
  "SQLITE_BUSY",
  "SQLITE_LOCKED",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED"
] as const

/**
 * Remote libSQL failures arrive as `SqlError` values around a fetch or hrana
 * error. Use the structured `isRetryable` flag first, then the nested network
 * codes the driver leaves in the cause. No message-substring matching is used.
 */
const isLibsqlRetryable = (error: unknown) => {
  if (isSqlError(error) && error.isRetryable) return true
  return errorHasCode(error, RETRYABLE_CODES)
}

/**
 * libSQL reuses the SQLite dialect for every SQL-generation behavior. The only
 * proven difference is connection handling: remote sqld rejects writable
 * pragmas, so setup and cleanup are empty there. A dedicated second dialect is
 * not justified.
 */
export function libsqlDialect(mode: LibsqlConnectionMode): DialectType {
  if (mode === "local") return sqliteDialect

  return {
    ...sqliteDialect,
    telemetry: {
      setup: [],
      cleanup: [],
      isRetryable: isLibsqlRetryable,
      isDuplicateKey: sqliteDialect.telemetry!.isDuplicateKey
    }
  }
}
