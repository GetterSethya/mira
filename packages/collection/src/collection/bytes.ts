/**
 * Human-readable byte size helpers.
 * Use instead of raw byte values in `Field.file({ maxSize })`.
 *
 * @example
 * Field.file({ maxSize: Bytes.fromMB(5) })
 * Bytes.fromGB(2) // => 2 * 1024^3
 */
export const Bytes = {
  /**
   * Convert kilobytes to bytes.
   *
   * @param n - Size in kilobytes
   * @returns Size in bytes
   *
   * @example
   * Bytes.fromKB(500)  // 512000
   */
  fromKB: (n: number) => n * 1024,

  /**
   * Convert megabytes to bytes.
   *
   * @param n - Size in megabytes
   * @returns Size in bytes
   *
   * @example
   * Bytes.fromMB(5)  // 5242880
   */
  fromMB: (n: number) => n * 1024 ** 2,

  /**
   * Convert gigabytes to bytes.
   *
   * @param n - Size in gigabytes
   * @returns Size in bytes
   *
   * @example
   * Bytes.fromGB(2)  // 2147483648
   */
  fromGB: (n: number) => n * 1024 ** 3,

  /**
   * Convert terabytes to bytes.
   *
   * @param n - Size in terabytes
   * @returns Size in bytes
   *
   * @example
   * Bytes.fromTB(1)  // 1099511627776
   */
  fromTB: (n: number) => n * 1024 ** 4
}
