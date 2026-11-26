import type { MigrationLock } from "@/dialect/dialect.js"

/**
 * Pure helpers for the session-scoped migration lock.
 *
 * The lock name is always a stable FNV-1a 64-bit hash of the lowercased
 * database name rendered as ASCII hex. That keeps every name within the engine
 * limit and avoids the MySQL charset failure for non-ASCII database names.
 */

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n
const FNV_PRIME = 0x100000001b3n
const FNV_MASK = 0xffffffffffffffffn

/** FNV-1a 64-bit over the UTF-8 bytes, rendered as 16 lowercase hex characters. */
function fnv1a64(value: string): string {
  let hash = FNV_OFFSET_BASIS
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte)
    hash = (hash * FNV_PRIME) & FNV_MASK
  }
  return hash.toString(16).padStart(16, "0")
}

/**
 * Builds `namePrefix:<digest>`, lowercased and bounded to `maxNameLength`.
 *
 * The prefix is assumed to be lowercase ASCII by contract. When the prefix
 * leaves no room (or the whole name still exceeds the limit), the digest is
 * truncated instead.
 */
export function boundLockName(
  config: Pick<MigrationLock, "namePrefix" | "maxNameLength">,
  databaseName: string
): string {
  const base = databaseName.trim().toLowerCase()
  const digest = fnv1a64(base)
  const head = `${config.namePrefix}:`
  if (head.length >= config.maxNameLength) {
    return digest.slice(0, config.maxNameLength)
  }
  return (head + digest).slice(0, config.maxNameLength)
}

/** Returns the trimmed database name, or null when it is missing or empty. */
export function databaseNameFromRows(
  rows: ReadonlyArray<Record<string, unknown>>
): string | null {
  const value = rows[0]?.["database_name"]
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed
}

export type LockTimeoutResolution =
  | { readonly seconds: number }
  | { readonly detail: string }

/** Resolves the caller's timeout; an invalid supplied value is an error, not a fallback. */
export function resolveLockTimeoutSeconds(
  value: number | undefined,
  fallback: number
): LockTimeoutResolution {
  if (value === undefined) return { seconds: fallback }
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return { seconds: value }
  }
  return {
    detail: `migrationLockTimeoutSeconds must be a finite number >= 0; received ${String(value)}`
  }
}

export type LockAcquireResult = "acquired" | "busy" | "unexpected"

const isOne = (value: unknown) =>
  value === true || value === 1 || value === 1n || value === "1"

const isZero = (value: unknown) =>
  value === false || value === 0 || value === 0n || value === "0"

/** Classifies `GET_LOCK`'s `1` / `0` / anything-else result. */
export function classifyAcquire(value: unknown): LockAcquireResult {
  if (isOne(value)) return "acquired"
  if (isZero(value)) return "busy"
  return "unexpected"
}

/** True when `IS_USED_LOCK(name) = CONNECTION_ID()` returned a truthy value. */
export function isHeldByThisSession(value: unknown): boolean {
  return isOne(value)
}

const SESSION_LOSS_MARKERS: ReadonlyArray<string> = [
  "PROTOCOL_CONNECTION_LOST",
  "PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ECONNREFUSED",
  "ENOTFOUND",
  "ER_QUERY_INTERRUPTED",
  "ER_CONNECTION_KILLED",
  "Connection lost",
  "connection is closed",
  "Cannot enqueue",
  "socket hang up"
]

function errorText(error: unknown): string {
  if (typeof error === "string") return error
  if (error instanceof Error) return `${error.name}: ${error.message}`
  if (typeof error === "object" && error !== null) {
    const parts: Array<string> = []
    for (const key of ["_tag", "code", "message", "sqlMessage", "reason", "cause"]) {
      const value = Reflect.get(error, key)
      if (typeof value === "string") parts.push(value)
      else if (typeof value === "object" && value !== null) parts.push(errorText(value))
    }
    return parts.join(" ")
  }
  return String(error)
}

/**
 * True when an error means the session is gone, so the server has already
 * released its user locks. A live-connection permission or syntax error is not
 * session loss and must be treated as a failed release.
 */
export function isSessionLoss(error: unknown): boolean {
  const text = errorText(error)
  return SESSION_LOSS_MARKERS.some((marker) => text.includes(marker))
}
