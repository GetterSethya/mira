import { Context, Data, Effect, Layer, Option, Schedule } from "effect"
import type { SqlError } from "effect/sql"
import { SqlClient } from "effect/sql"

import { Dialect } from "@/dialect/dialect.js"
import { ensureStoreColumn, ensureStoreIndex, withStoreBootstrap } from "@/dialect/store-sql.js"

/** The driver returned a raw UPDATE result the dialect could not read. */
class AuthChallengeResultUnknownError extends Data.TaggedError(
  "AuthChallengeResultUnknownError"
)<{ readonly id: string }> {}

export type ChallengePurpose =
  | "password_reset"
  | "verify_email"
  | "change_email"
  | "login_otp"
  | "passwordless"

export interface ChallengeRecord {
  readonly id: string
  readonly collection: string
  readonly userId: string
  readonly purpose: ChallengePurpose
  readonly tokenHash: string
  readonly expiresAt: number
  readonly consumedAt: number | null
  readonly attempts: number
  readonly createdAt: number
  /** Target address for a `change_email` challenge; null for every other purpose. */
  readonly newEmail: string | null
}

export interface AuthChallengeStoreShape {
  create(record: ChallengeRecord): Effect.Effect<void, SqlError.SqlError>
  findByTokenHash(
    collection: string,
    purpose: ChallengePurpose,
    tokenHash: string
  ): Effect.Effect<ChallengeRecord | undefined, SqlError.SqlError>
  findById(
    collection: string,
    id: string,
    purpose: ChallengePurpose
  ): Effect.Effect<ChallengeRecord | undefined, SqlError.SqlError>
  findLatestForUser(
    collection: string,
    userId: string,
    purpose: ChallengePurpose
  ): Effect.Effect<ChallengeRecord | undefined, SqlError.SqlError>
  supersedeLive(
    collection: string,
    userId: string,
    purpose: ChallengePurpose,
    now: number
  ): Effect.Effect<void, SqlError.SqlError>
  attemptAndConsume(
    id: string,
    maxAttempts: number,
    now: number
  ): Effect.Effect<{ readonly attempts: number; readonly consumed: boolean } | null, SqlError.SqlError>
  consumeById(id: string, now: number): Effect.Effect<boolean, SqlError.SqlError>
  consumeToken(
    collection: string,
    purpose: ChallengePurpose,
    tokenHash: string,
    now: number
  ): Effect.Effect<boolean, SqlError.SqlError>
  consumeAllForUser(collection: string, userId: string, now: number): Effect.Effect<void, SqlError.SqlError>
  deleteExpired(now: number): Effect.Effect<void, SqlError.SqlError>
}

const liveChallenges = new Map<string, ChallengeRecord>()

const isLive = (record: ChallengeRecord, now: number) =>
  record.consumedAt === null && record.expiresAt > now

export const inMemoryAuthChallengeStore: AuthChallengeStoreShape = {
  create: (record) =>
    Effect.sync(() => {
      liveChallenges.set(record.id, record)
    }),
  findByTokenHash: (collection, purpose, tokenHash) =>
    Effect.sync(() =>
      [...liveChallenges.values()].find(
        (r) =>
          r.collection === collection &&
          r.purpose === purpose &&
          r.tokenHash === tokenHash &&
          isLive(r, Date.now())
      )
    ),
  findById: (collection, id, purpose) =>
    Effect.sync(() => {
      const record = liveChallenges.get(id)
      return record !== undefined && record.collection === collection && record.purpose === purpose
        ? record
        : undefined
    }),
  findLatestForUser: (collection, userId, purpose) =>
    Effect.sync(() =>
      [...liveChallenges.values()]
        .filter((r) => r.collection === collection && r.userId === userId && r.purpose === purpose && isLive(r, Date.now()))
        .sort((a, b) => b.createdAt - a.createdAt)[0]
    ),
  supersedeLive: (collection, userId, purpose, now) =>
    Effect.sync(() => {
      for (const [id, record] of liveChallenges) {
        if (
          record.collection === collection &&
          record.userId === userId &&
          record.purpose === purpose &&
          record.consumedAt === null
        ) {
          liveChallenges.set(id, { ...record, consumedAt: now })
        }
      }
    }),
  attemptAndConsume: (id, maxAttempts, now) =>
    Effect.sync(() => {
      const record = liveChallenges.get(id)
      if (record === undefined || !isLive(record, now) || record.attempts >= maxAttempts) return null
      const attempts = record.attempts + 1
      const consumed = attempts >= maxAttempts
      liveChallenges.set(id, { ...record, attempts, consumedAt: consumed ? now : record.consumedAt })
      return { attempts, consumed }
    }),
  consumeById: (id, now) =>
    Effect.sync(() => {
      const record = liveChallenges.get(id)
      if (record === undefined || record.consumedAt !== null || record.expiresAt <= now) return false
      liveChallenges.set(id, { ...record, consumedAt: now })
      return true
    }),
  consumeToken: (collection, purpose, tokenHash, now) =>
    Effect.sync(() => {
      const record = [...liveChallenges.values()].find(
        (r) =>
          r.collection === collection &&
          r.purpose === purpose &&
          r.tokenHash === tokenHash &&
          isLive(r, now)
      )
      if (record === undefined) return false
      liveChallenges.set(record.id, { ...record, consumedAt: now })
      return true
    }),
  consumeAllForUser: (collection, userId, now) =>
    Effect.sync(() => {
      for (const [id, record] of liveChallenges) {
        if (record.collection === collection && record.userId === userId && record.consumedAt === null) {
          liveChallenges.set(id, { ...record, consumedAt: now })
        }
      }
    }),
  deleteExpired: (now) =>
    Effect.sync(() => {
      for (const [id, record] of liveChallenges) {
        if (record.expiresAt <= now) liveChallenges.delete(id)
      }
    })
}

export const AuthChallengeStore = Context.Reference<AuthChallengeStoreShape>("mira/AuthChallengeStore", {
  defaultValue: () => inMemoryAuthChallengeStore
})

interface ChallengeRow {
  readonly id: string
  readonly collection: string
  readonly user_id: string
  readonly purpose: ChallengePurpose
  readonly token_hash: string
  readonly expires_at: number
  readonly consumed_at: number | null
  readonly attempts: number
  readonly created_at: number
  readonly new_email: string | null
}

const toRecord = (row: ChallengeRow): ChallengeRecord => ({
  id: row.id,
  collection: row.collection,
  userId: row.user_id,
  purpose: row.purpose,
  tokenHash: row.token_hash,
  expiresAt: Number(row.expires_at),
  consumedAt: row.consumed_at === null ? null : Number(row.consumed_at),
  attempts: Number(row.attempts),
  createdAt: Number(row.created_at),
  newEmail: row.new_email
})

export const AuthChallengeStoreLive = Layer.effect(
  AuthChallengeStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const dialect = yield* Dialect
    const store = dialect.store
    const quote = dialect.quoteIdentifier
    const table = "_auth_challenges"

    yield* withStoreBootstrap(sql, store, (tx) =>
      Effect.gen(function* () {
        yield* tx.unsafe(
          `CREATE TABLE IF NOT EXISTS ${quote(table)} (
            ${quote("id")} ${store.keyColumnType} PRIMARY KEY,
            ${quote("collection")} ${store.keyColumnType} NOT NULL,
            ${quote("user_id")} ${store.keyColumnType} NOT NULL,
            ${quote("purpose")} ${store.keyColumnType} NOT NULL,
            ${quote("token_hash")} ${store.keyColumnType} NOT NULL,
            ${quote("expires_at")} BIGINT NOT NULL,
            ${quote("consumed_at")} BIGINT,
            ${quote("attempts")} INTEGER NOT NULL DEFAULT 0,
            ${quote("created_at")} BIGINT NOT NULL,
            ${quote("new_email")} ${store.textColumnType}
          )`
        )

        yield* ensureStoreColumn(
          tx,
          store,
          table,
          "new_email",
          `ALTER TABLE ${quote(table)} ADD COLUMN ${quote("new_email")} ${store.textColumnType}`
        )

        if (store.challengeLive.mode === "generated") {
          yield* ensureStoreColumn(
            tx,
            store,
            table,
            store.challengeLive.column,
            store.challengeLive.addColumnStatement
          )
        }

        yield* ensureStoreIndex(tx, store, store.challengeLive.indexStatement)
        yield* ensureStoreIndex(
          tx,
          store,
          store.createIndexIfNotExists(
            "_auth_challenges_hash",
            table,
            ["collection", "purpose", "token_hash"],
            false
          )
        )
        yield* ensureStoreIndex(
          tx,
          store,
          store.createIndexIfNotExists(
            "_auth_challenges_user",
            table,
            ["collection", "user_id", "purpose", "created_at"],
            false
          )
        )
        yield* ensureStoreIndex(
          tx,
          store,
          store.createIndexIfNotExists(
            "_auth_challenges_expires",
            table,
            ["expires_at"],
            false
          )
        )
      })
    )

    const create: AuthChallengeStoreShape["create"] = (record) =>
      sql`
        INSERT INTO ${sql("_auth_challenges")} ${sql.insert({
          id: record.id,
          collection: record.collection,
          user_id: record.userId,
          purpose: record.purpose,
          token_hash: record.tokenHash,
          expires_at: record.expiresAt,
          consumed_at: record.consumedAt,
          attempts: record.attempts,
          created_at: record.createdAt,
          new_email: record.newEmail
        })}
      `.pipe(Effect.asVoid)

    const findByTokenHash: AuthChallengeStoreShape["findByTokenHash"] = (collection, purpose, tokenHash) =>
      Effect.gen(function* () {
        const rows = yield* sql<ChallengeRow>`
          SELECT * FROM ${sql("_auth_challenges")}
          WHERE collection = ${collection} AND purpose = ${purpose} AND token_hash = ${tokenHash}
            AND consumed_at IS NULL AND expires_at > ${Date.now()}
          LIMIT 1
        `
        const row = rows[0]
        return row === undefined ? undefined : toRecord(row)
      })

    const findById: AuthChallengeStoreShape["findById"] = (collection, id, purpose) =>
      Effect.gen(function* () {
        const rows = yield* sql<ChallengeRow>`
          SELECT * FROM ${sql("_auth_challenges")}
          WHERE collection = ${collection} AND id = ${id} AND purpose = ${purpose}
          LIMIT 1
        `
        const row = rows[0]
        return row === undefined ? undefined : toRecord(row)
      })

    const findLatestForUser: AuthChallengeStoreShape["findLatestForUser"] = (collection, userId, purpose) =>
      Effect.gen(function* () {
        const rows = yield* sql<ChallengeRow>`
          SELECT * FROM ${sql("_auth_challenges")}
          WHERE collection = ${collection} AND user_id = ${userId} AND purpose = ${purpose}
            AND consumed_at IS NULL AND expires_at > ${Date.now()}
          ORDER BY created_at DESC LIMIT 1
        `
        const row = rows[0]
        return row === undefined ? undefined : toRecord(row)
      })

    const supersedeLive: AuthChallengeStoreShape["supersedeLive"] = (collection, userId, purpose, now) =>
      sql`
        UPDATE ${sql("_auth_challenges")} SET consumed_at = ${now}
        WHERE collection = ${collection} AND user_id = ${userId} AND purpose = ${purpose}
          AND consumed_at IS NULL
      `.pipe(Effect.asVoid)

    const attemptAndConsume: AuthChallengeStoreShape["attemptAndConsume"] = (id, maxAttempts, now) => {
      if (store.mutationResult._tag === "returning") {
        return Effect.gen(function* () {
          const rows = yield* sql<{ attempts: number }>`
            UPDATE ${sql("_auth_challenges")}
            SET attempts = attempts + 1,
                consumed_at = CASE WHEN attempts + 1 >= ${maxAttempts} THEN ${now} ELSE consumed_at END
            WHERE id = ${id} AND consumed_at IS NULL AND expires_at > ${now} AND attempts < ${maxAttempts}
            RETURNING attempts
          `
          const row = rows[0]
          return row === undefined
            ? null
            : { attempts: Number(row.attempts), consumed: Number(row.attempts) >= maxAttempts }
        })
      }

      return sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<{
              attempts: number
              consumed_at: number | string | null
              expires_at: number | string
            }>`
              SELECT attempts, consumed_at, expires_at
              FROM ${sql("_auth_challenges")}
              WHERE id = ${id}
              FOR UPDATE
            `
            const row = rows[0]
            if (row === undefined) return null
            if (row.consumed_at !== null || Number(row.expires_at) <= now) return null
            const current = Number(row.attempts)
            if (current >= maxAttempts) return null

            const next = current + 1
            const consumed = next >= maxAttempts
            yield* sql`
              UPDATE ${sql("_auth_challenges")}
              SET attempts = ${next},
                  consumed_at = ${consumed ? now : row.consumed_at}
              WHERE id = ${id}
            `
            return { attempts: next, consumed }
          })
        )
        .pipe(
          Effect.retry({
            while: store.isRetryable,
            schedule: Schedule.spaced("10 millis"),
            times: 1
          })
        )
    }

    const consumeById: AuthChallengeStoreShape["consumeById"] = (id, now) => {
      const mutationResult = store.mutationResult
      if (mutationResult._tag === "returning") {
        return Effect.gen(function* () {
          const rows = yield* sql<{ id: string }>`
            UPDATE ${sql("_auth_challenges")} SET consumed_at = ${now}
            WHERE id = ${id} AND consumed_at IS NULL AND expires_at > ${now}
            RETURNING id
          `
          return rows.length > 0
        })
      }

      return Effect.gen(function* () {
        const raw = yield* sql
          .unsafe(
            `UPDATE ${quote("_auth_challenges")} SET ${quote("consumed_at")} = ? WHERE ${quote("id")} = ? AND ${quote("consumed_at")} IS NULL AND ${quote("expires_at")} > ?`,
            [now, id, now]
          )
          .raw
        const affected = mutationResult.read(raw)
        if (Option.isNone(affected)) {
          return yield* Effect.die(new AuthChallengeResultUnknownError({ id }))
        }
        return affected.value > 0
      })
    }

    const consumeToken: AuthChallengeStoreShape["consumeToken"] = (collection, purpose, tokenHash, now) => {
      const mutationResult = store.mutationResult
      if (mutationResult._tag === "returning") {
        return Effect.gen(function* () {
          const rows = yield* sql<{ id: string }>`
            UPDATE ${sql("_auth_challenges")} SET consumed_at = ${now}
            WHERE collection = ${collection} AND purpose = ${purpose} AND token_hash = ${tokenHash}
              AND consumed_at IS NULL AND expires_at > ${now}
            RETURNING id
          `
          return rows.length > 0
        })
      }

      return Effect.gen(function* () {
        const raw = yield* sql
          .unsafe(
            `UPDATE ${quote("_auth_challenges")} SET ${quote("consumed_at")} = ? WHERE ${quote("collection")} = ? AND ${quote("purpose")} = ? AND ${quote("token_hash")} = ? AND ${quote("consumed_at")} IS NULL AND ${quote("expires_at")} > ?`,
            [now, collection, purpose, tokenHash, now]
          )
          .raw
        const affected = mutationResult.read(raw)
        if (Option.isNone(affected)) {
          return yield* Effect.die(new AuthChallengeResultUnknownError({ id: tokenHash }))
        }
        return affected.value > 0
      })
    }

    const consumeAllForUser: AuthChallengeStoreShape["consumeAllForUser"] = (collection, userId, now) =>
      sql`
        UPDATE ${sql("_auth_challenges")} SET consumed_at = ${now}
        WHERE collection = ${collection} AND user_id = ${userId} AND consumed_at IS NULL
      `.pipe(Effect.asVoid)

    const deleteExpired: AuthChallengeStoreShape["deleteExpired"] = (now) =>
      sql`DELETE FROM ${sql("_auth_challenges")} WHERE expires_at <= ${now}`.pipe(Effect.asVoid)

    return {
      create,
      findByTokenHash,
      findById,
      findLatestForUser,
      supersedeLive,
      attemptAndConsume,
      consumeById,
      consumeToken,
      consumeAllForUser,
      deleteExpired
    }
  })
)

