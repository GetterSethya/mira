import { Context, Effect, Layer } from "effect"
import type { SqlError } from "effect/sql"
import { SqlClient } from "effect/sql"

export type ChallengePurpose = "password_reset" | "verify_email" | "login_otp" | "passwordless"

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

const key = (collection: string, userId: string, purpose: ChallengePurpose) =>
  `${collection}\u0000${userId}\u0000${purpose}`

const liveKey = (record: ChallengeRecord) => key(record.collection, record.userId, record.purpose)

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
  createdAt: Number(row.created_at)
})

export const AuthChallengeStoreLive = Layer.effect(
  AuthChallengeStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    yield* sql.unsafe(
      `CREATE TABLE IF NOT EXISTS _auth_challenges (
        id TEXT PRIMARY KEY,
        collection TEXT NOT NULL,
        user_id TEXT NOT NULL,
        purpose TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      )`
    )
    yield* sql.unsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS _auth_challenges_live
       ON _auth_challenges (collection, user_id, purpose)
       WHERE consumed_at IS NULL`
    )
    yield* sql.unsafe(
      `CREATE INDEX IF NOT EXISTS _auth_challenges_hash
       ON _auth_challenges (collection, purpose, token_hash)`
    )
    yield* sql.unsafe(
      `CREATE INDEX IF NOT EXISTS _auth_challenges_user
       ON _auth_challenges (collection, user_id, purpose, created_at)`
    )
    yield* sql.unsafe(
      `CREATE INDEX IF NOT EXISTS _auth_challenges_expires ON _auth_challenges (expires_at)`
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
          created_at: record.createdAt
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

    const attemptAndConsume: AuthChallengeStoreShape["attemptAndConsume"] = (id, maxAttempts, now) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ attempts: number }>`
          UPDATE ${sql("_auth_challenges")}
          SET attempts = attempts + 1,
              consumed_at = CASE WHEN attempts + 1 >= ${maxAttempts} THEN ${now} ELSE consumed_at END
          WHERE id = ${id} AND consumed_at IS NULL AND expires_at > ${now} AND attempts < ${maxAttempts}
          RETURNING attempts
        `
        const row = rows[0]
        return row === undefined ? null : { attempts: Number(row.attempts), consumed: Number(row.attempts) >= maxAttempts }
      })

    const consumeById: AuthChallengeStoreShape["consumeById"] = (id, now) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ id: string }>`
          UPDATE ${sql("_auth_challenges")} SET consumed_at = ${now}
          WHERE id = ${id} AND consumed_at IS NULL AND expires_at > ${now}
          RETURNING id
        `
        return rows.length > 0
      })

    const consumeToken: AuthChallengeStoreShape["consumeToken"] = (collection, purpose, tokenHash, now) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ id: string }>`
          UPDATE ${sql("_auth_challenges")} SET consumed_at = ${now}
          WHERE collection = ${collection} AND purpose = ${purpose} AND token_hash = ${tokenHash}
            AND consumed_at IS NULL AND expires_at > ${now}
          RETURNING id
        `
        return rows.length > 0
      })

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
