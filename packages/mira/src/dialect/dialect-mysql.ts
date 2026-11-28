import { errorHasCode } from "./dialect.js"
import type {
  DialectType,
  RuleSqlDialect,
  StoreSqlCapabilities,
  StoreUpsertAssignment,
  TelemetryDialectHooks
} from "./dialect.js"
import {
  isMysqlDuplicateKey,
  isMysqlIgnorableBootstrapError,
  isMysqlRetryable,
  mysqlCastValue,
  mysqlCurrentTimestamp,
  mysqlIndexName,
  mysqlNativeType,
  mysqlQuoteIdentifier,
  mysqlQuoteLiteral,
  mysqlRuleSql,
  mysqlTimestampAdd,
  mysqlTimestampDiff,
  readMysqlAffectedRows
} from "./dialect-mysql-core.js"
import { mysqlMigrationDialect } from "./dialect-mysql-migrations.js"
import {
  mysqlCaseInsensitiveLike,
  mysqlFilterSql,
  mysqlTextCollation
} from "./dialect-mysql-text.js"
import { mysqlTransactionProbe } from "./dialect-mysql-transactions.js"

const q = mysqlQuoteIdentifier

const mysqlStoreSql: StoreSqlCapabilities = {
  bootstrapMode: "transaction",
  bootstrapSql: [],
  bootstrapSetupSql: [
    "SET SESSION lock_wait_timeout = 5",
    "SET SESSION innodb_lock_wait_timeout = 5"
  ],
  bootstrapRestoreSql: [
    "SET SESSION lock_wait_timeout = DEFAULT",
    "SET SESSION innodb_lock_wait_timeout = DEFAULT"
  ],
  keyColumnType: `VARCHAR(191) CHARACTER SET utf8mb4 COLLATE ${mysqlTextCollation}`,
  textColumnType: "LONGTEXT",
  bucketColumnType: `VARCHAR(512) CHARACTER SET utf8mb4 COLLATE ${mysqlTextCollation}`,
  bucketMaxLength: 512,
  createIndexIfNotExists: (name, table, columns, unique) =>
    `CREATE ${unique ? "UNIQUE " : ""}INDEX ${q(name)} ON ${q(table)} (${columns.map(q).join(", ")})`,
  isIgnorableBootstrapError: isMysqlIgnorableBootstrapError,
  insertIgnoreClause: (conflictKeys) =>
    `ON DUPLICATE KEY UPDATE ${conflictKeys
      .map((key) => `${q(key)} = ${q(key)}`)
      .join(", ")}`,
  upsertClause: (
    _conflictKeys: ReadonlyArray<string>,
    assignments: ReadonlyArray<StoreUpsertAssignment>
  ) =>
    `ON DUPLICATE KEY UPDATE ${assignments
      .map((assignment) =>
        assignment.kind === "excluded"
          ? `${q(assignment.column)} = VALUES(${q(assignment.column)})`
          : `${q(assignment.column)} = ${q(assignment.column)} + 1`
      )
      .join(", ")}`,
  mutationResult: { _tag: "affectedRows", read: readMysqlAffectedRows },
  challengeLive: {
    mode: "generated",
    column: "live_key",
    addColumnStatement: `ALTER TABLE ${q("_auth_challenges")} ADD COLUMN ${q("live_key")} TINYINT GENERATED ALWAYS AS (IF(${q("consumed_at")} IS NULL, 1, NULL)) STORED`,
    indexName: "_auth_challenges_live",
    indexStatement: `CREATE UNIQUE INDEX ${q("_auth_challenges_live")} ON ${q("_auth_challenges")} (${["collection", "user_id", "purpose", "live_key"].map(q).join(", ")})`
  },
  columnExistsSql: (table, column) =>
    `SELECT 1 AS present FROM information_schema.columns
     WHERE table_schema = DATABASE()
       AND table_name = ${mysqlQuoteLiteral(table)}
       AND column_name = ${mysqlQuoteLiteral(column)}
     LIMIT 1`,
  isRetryable: isMysqlRetryable,
  isDuplicateKey: isMysqlDuplicateKey
}

const mysqlTelemetry: TelemetryDialectHooks = {
  setup: [],
  cleanup: [],
  isRetryable: mysqlStoreSql.isRetryable,
  retryDml: true,
  isDmlRetryable: (error) =>
    errorHasCode(error, [1205, "ER_LOCK_WAIT_TIMEOUT"]),
  insertConflictClause: (quotedId) =>
    `ON DUPLICATE KEY UPDATE ${quotedId} = ${quotedId}`
}

const mysqlRuleDialect: RuleSqlDialect = {
  ...mysqlRuleSql,
  caseInsensitiveLike: mysqlCaseInsensitiveLike
}

export const mysqlDialect: DialectType = {
  ...mysqlMigrationDialect,
  ...mysqlRuleDialect,
  ...mysqlFilterSql,
  placeholder: () => "?",
  nativeType: mysqlNativeType,
  currentTimestamp: mysqlCurrentTimestamp,
  timestampAdd: mysqlTimestampAdd,
  timestampDiff: mysqlTimestampDiff,
  castValue: mysqlCastValue,
  quoteIdentifier: mysqlQuoteIdentifier,
  quoteLiteral: mysqlQuoteLiteral,
  indexName: mysqlIndexName,
  storesBooleanAsInteger: true,
  deleteResult: { _tag: "affectedRows", read: readMysqlAffectedRows },
  transactionProbe: mysqlTransactionProbe,
  store: mysqlStoreSql,
  telemetry: mysqlTelemetry
}

export { mysqlRuleDialect, mysqlStoreSql, mysqlTelemetry }