/**
 * Pure MySQL/MariaDB text capability (issue #71).
 *
 * The migration dialect imports the constants. #30 composes
 * `mysqlCaseInsensitiveLike` and `mysqlFilterSql` into the full MySQL
 * `DialectType`. This module has no I/O and no driver dependency, and it is not
 * exported from the package barrel.
 */
import type { DialectType } from "./dialect.js"

/** Binary, NO PAD collation for ordinary text columns. */
export const mysqlTextCollation = "utf8mb4_0900_bin"

/** Case-insensitive, accent-sensitive collation for the auth email identity. */
export const mysqlEmailCollation = "utf8mb4_0900_as_ci"

/** Largest indexed text column under the 3072-byte utf8mb4 key limit. */
export const mysqlMaxIndexedTextLength = 768

/** InnoDB composite index key limit. */
export const mysqlMaxIndexKeyBytes = 3072

/**
 * Case-insensitive prefix or infix match on a binary-collation column.
 * `LOWER` is multibyte-aware on MySQL and MariaDB. `CONCAT` is the MySQL
 * concatenation operator; `||` is not portable unless PIPES_AS_CONCAT is set.
 */
export const mysqlCaseInsensitiveLike: DialectType["caseInsensitiveLike"] = (
  left,
  right,
  mode
) =>
  mode === "prefix"
    ? `LOWER(${left}) LIKE LOWER(CONCAT(${right}, '%'))`
    : `LOWER(${left}) LIKE LOWER(CONCAT('%', ${right}, '%'))`

/**
 * Complete-pattern case-insensitive match. The pattern stays a bound
 * parameter and is not transformed.
 */
export const mysqlFilterSql: Pick<DialectType, "caseInsensitivePattern"> = {
  caseInsensitivePattern: (left, right) =>
    `LOWER(${left}) LIKE LOWER(${right})`
}
