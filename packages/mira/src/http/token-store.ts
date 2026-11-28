/**
 * Durable, shareable store for JWT session state.
 *
 * Two pieces of state live here:
 *
 * 1. A deny-list of revoked token ids (`jti`). `POST /api/auth/logout` adds the
 *    presented token's `jti` so a logged-out session token can no longer
 *    authenticate, even though the JWT is still cryptographically valid until
 *    it expires.
 * 2. A per-`(collection, user)` "generation" counter. Bumping it invalidates
 *    *every* previously minted token for that user — this is what powers
 *    "log out everywhere" (`POST /api/auth/logout-all`).
 *
 * `TokenStore` is a `Context.Reference`: it has a built-in in-memory default, so
 * every existing test layer that never mentions it keeps working unchanged
 * (against the process-local default). `MiraApp` overrides it with the
 * SQL-backed `TokenStoreLive`, which is durable across restarts and shared
 * between instances that point at the same database.
 */
import { Context, Effect, Layer } from "effect"
import type { SqlError } from "effect/sql"
import { SqlClient } from "effect/sql"

import { Dialect } from "@/dialect/dialect.js"
import { ensureStoreIndex, withStoreBootstrap } from "@/dialect/store-sql.js"

/**
 * The behaviour every `TokenStore` implementation must provide. The SQL-backed
 * implementation can fail with `SqlError`; callers must treat such a failure as
 * "deny" (fail closed), never as "authenticated".
 */
export interface TokenStoreShape {
  /** Revoke `jti` until `expiresAtMs` (ms since the epoch). */
  revoke(jti: string, expiresAtMs: number): Effect.Effect<void, SqlError.SqlError>
  /** Whether `jti` is currently revoked. */
  isRevoked(jti: string): Effect.Effect<boolean, SqlError.SqlError>
  /** Current generation for a user; `0` when the user has never been bumped. */
  currentGeneration(collection: string, userId: string): Effect.Effect<number, SqlError.SqlError>
  /** Invalidate every token minted for this user so far. */
  bumpGeneration(collection: string, userId: string): Effect.Effect<void, SqlError.SqlError>
}

// ---------------------------------------------------------------------------
// In-memory default (per process, per instance)
// ---------------------------------------------------------------------------

/** Map of revoked `jti` -> token expiry (ms since epoch). */
const revoked = new Map<string, number>()
/** Map of `collection\u0000userId` -> generation. */
const generations = new Map<string, number>()

/**
 * Drop every expired deny-list entry. Only called on `revoke` (a rare, explicit
 * write) so the per-request `isRevoked` read stays O(1) and never scans the
 * whole map.
 */
function pruneExpired(now: number) {
  for (const [key, expiresAt] of revoked) {
    if (expiresAt <= now) revoked.delete(key)
  }
}

const generationKey = (collection: string, userId: string) => `${collection}\u0000${userId}`

/**
 * Process-local default implementation.
 *
 * `isRevoked` is an O(1) hash lookup. It lazily drops the *single* entry it was
 * asked about once that entry has expired — it never scans the map on the read
 * path, so an authenticated request stays O(1) regardless of deny-list size.
 */
export const inMemoryTokenStore: TokenStoreShape = {
  revoke: (jti, expiresAtMs) =>
    Effect.sync(() => {
      pruneExpired(Date.now())
      revoked.set(jti, expiresAtMs)
    }),
  isRevoked: (jti) =>
    Effect.sync(() => {
      const expiresAt = revoked.get(jti)
      if (expiresAt === undefined) return false
      if (expiresAt <= Date.now()) {
        revoked.delete(jti)
        return false
      }
      return true
    }),
  currentGeneration: (collection, userId) =>
    Effect.sync(() => generations.get(generationKey(collection, userId)) ?? 0),
  bumpGeneration: (collection, userId) =>
    Effect.sync(() => {
      const key = generationKey(collection, userId)
      generations.set(key, (generations.get(key) ?? 0) + 1)
    })
}

/**
 * Service key with a default value: reading `TokenStore` always yields an
 * implementation. `MiraApp` overrides the default with `TokenStoreLive`.
 */
export const TokenStore = Context.Reference<TokenStoreShape>("mira/TokenStore", {
  defaultValue: () => inMemoryTokenStore
})

// ---------------------------------------------------------------------------
// SQL-backed implementation (shared + durable)
// ---------------------------------------------------------------------------

/**
 * SQL-backed `TokenStore`.
 *
 * Pruning strategy: expired deny-list rows are deleted on `revoke` (a rare,
 * explicit write). The read path is a single primary-key lookup on `jti`, so it
 * is O(log n), hot-cacheable, and never a full scan.
 */
export const TokenStoreLive = Layer.effect(
  TokenStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const dialect = yield* Dialect
    const store = dialect.store
    const quote = dialect.quoteIdentifier

    yield* withStoreBootstrap(sql, store, (tx) =>
      Effect.gen(function* () {
        yield* tx.unsafe(
          `CREATE TABLE IF NOT EXISTS ${quote("_revoked_tokens")} (${quote("jti")} ${store.keyColumnType} PRIMARY KEY, ${quote("expires_at")} BIGINT NOT NULL)`
        )
        yield* ensureStoreIndex(
          tx,
          store,
          store.createIndexIfNotExists(
            "_revoked_tokens_expires",
            "_revoked_tokens",
            ["expires_at"],
            false
          )
        )
        yield* tx.unsafe(
          `CREATE TABLE IF NOT EXISTS ${quote("_auth_generations")} (` +
            `${quote("collection")} ${store.keyColumnType} NOT NULL, ${quote("user_id")} ${store.keyColumnType} NOT NULL, ${quote("gen")} INTEGER NOT NULL DEFAULT 0, ` +
            `PRIMARY KEY (${quote("collection")}, ${quote("user_id")}))`
        )
      })
    )

    const revoke = (jti: string, expiresAtMs: number) =>
      Effect.gen(function* () {
        // Prune on the write path only; the read path stays indexed/O(1)-ish.
        yield* sql`DELETE FROM ${sql("_revoked_tokens")} WHERE ${sql("expires_at")} <= ${Date.now()}`
        yield* sql`
          INSERT INTO ${sql("_revoked_tokens")} (${sql("jti")}, ${sql("expires_at")})
          VALUES (${jti}, ${expiresAtMs})
          ${sql.literal(store.insertIgnoreClause(["jti"]))}
        `
      })

    const isRevoked = (jti: string) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ ok: number }>`
          SELECT 1 AS ok FROM ${sql("_revoked_tokens")}
          WHERE ${sql("jti")} = ${jti} AND ${sql("expires_at")} > ${Date.now()}
          LIMIT 1
        `
        return rows.length > 0
      })

    const currentGeneration = (collection: string, userId: string) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ gen: number }>`
          SELECT ${sql("gen")} FROM ${sql("_auth_generations")}
          WHERE ${sql("collection")} = ${collection} AND ${sql("user_id")} = ${userId}
          LIMIT 1
        `
        const row = rows[0]
        return row === undefined ? 0 : Number(row.gen)
      })

    const bumpGeneration = (collection: string, userId: string) =>
      sql`
        INSERT INTO ${sql("_auth_generations")} (${sql("collection")}, ${sql("user_id")}, ${sql("gen")})
        VALUES (${collection}, ${userId}, 1)
        ${sql.literal(
          store.upsertClause(
            ["collection", "user_id"],
            [{ column: "gen", kind: "increment-by-one" }]
          )
        )}
      `.pipe(Effect.asVoid)

    return { revoke, isRevoked, currentGeneration, bumpGeneration }
  })
)
