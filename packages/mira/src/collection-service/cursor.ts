import type { Cursor } from "@gettersethya/mira-client"

/** Maximum non-negative value of a PostgreSQL BIGINT and a SQLite INTEGER. */
export const MAX_SEQ_ID = 9223372036854775807n

/** Number of decimal digits in {@link MAX_SEQ_ID}. */
export const MAX_SEQ_ID_DIGITS = 19

const CANONICAL_DECIMAL = /^(0|[1-9][0-9]*)$/

const isCanonicalCursorString = (value: string): boolean => {
  if (value.length > MAX_SEQ_ID_DIGITS || !CANONICAL_DECIMAL.test(value)) return false
  return BigInt(value) <= MAX_SEQ_ID
}

/**
 * Converts a driver `seqId` value into a JSON-safe cursor.
 *
 * SQLite and libSQL return numbers. `@effect/sql-pg` returns a `bigint` for
 * `BIGINT`; `pg` returns a decimal string. Numbers stay numbers only when they
 * are exact. Bigints and canonical decimal strings become strings so the full
 * non-negative 64-bit range survives JSON.
 *
 * Returns `null` for a missing, negative, fractional, non-finite, unsafe, or
 * out-of-range value.
 */
export function cursorFromSeqId(value: unknown): Cursor | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null
  }
  if (typeof value === "bigint") {
    return value >= 0n && value <= MAX_SEQ_ID ? value.toString() : null
  }
  if (typeof value === "string") {
    return isCanonicalCursorString(value) ? value : null
  }
  return null
}

/**
 * Parses the raw `after` query value.
 *
 * The number path preserves the existing parser behavior for forms such as
 * `1.9`, `1e3`, `0x10`, and `+5`, but only when the floored value is a safe
 * integer. A large canonical decimal string stays a string and is never rounded
 * through `Number`. Everything else is treated as an absent cursor.
 */
export function parseCursor(raw: string | null): Cursor | null {
  if (raw === null) return null

  const asNumber = Number(raw)
  if (!Number.isNaN(asNumber) && asNumber >= 0) {
    const floored = Math.floor(asNumber)
    if (Number.isSafeInteger(floored)) return floored
  }

  const trimmed = raw.trim()
  return isCanonicalCursorString(trimmed) ? trimmed : null
}
