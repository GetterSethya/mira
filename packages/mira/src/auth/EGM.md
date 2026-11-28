# Auth challenge store

`AuthChallengeStoreLive` stores one row per email or OTP challenge in
`_auth_challenges`. It is used by password reset, email verification, email
change, login OTP, and passwordless login.

## Schema and capabilities

- `id`, `collection`, `user_id`, `purpose`, and `token_hash` use
  `dialect.store.keyColumnType`. MySQL uses `VARCHAR(191)` with
  `utf8mb4_0900_bin`; SQLite and PostgreSQL use `TEXT`.
- `new_email` uses `dialect.store.textColumnType` (`LONGTEXT` on MySQL).
- The store keeps the pre-existing `new_email` upgrade through
  `ensureStoreColumn`, so an older table without that column keeps working.
- All indexes go through `ensureStoreIndex`: the live index, hash, user, and
  expiry. MySQL does not support `CREATE UNIQUE INDEX IF NOT EXISTS`; duplicate
  index errors are ignored through `isIgnorableBootstrapError`.

## One live challenge per user and purpose

SQLite and PostgreSQL keep the existing partial unique index
`_auth_challenges_live` on `(collection, user_id, purpose) WHERE consumed_at IS
NULL`.

MySQL cannot express a partial index. `store.challengeLive` supplies a generated
column and a unique index:

- `live_key TINYINT GENERATED ALWAYS AS (IF(consumed_at IS NULL, 1, NULL)) STORED`
- a unique index on `(collection, user_id, purpose, live_key)` named
  `_auth_challenges_live`.

The generated column has no DML writes and is derived from `consumed_at`, so
there is no dual truth. The exact DDL was proved on MySQL 8.4.13 and MariaDB
11.4.13 in the #30 spike.

## Consume paths

- `attemptAndConsume` keeps the single `UPDATE ... RETURNING attempts` on
  SQLite/PostgreSQL.
- MySQL runs one transaction: `SELECT attempts, consumed_at, expires_at ...
  FOR UPDATE`, computes the next count, updates, and returns it. It
  retries once on `store.isRetryable`; a second failure propagates as a SQL
  error.
- `consumeById` and `consumeToken` keep `RETURNING` on SQLite/PostgreSQL. On
  MySQL they run one bound UPDATE through `sql.unsafe(..., params).raw`, read
  the `ResultSetHeader` through `store.mutationResult.read`, and die with
  `AuthChallengeResultUnknownError` when the result is unreadable.
