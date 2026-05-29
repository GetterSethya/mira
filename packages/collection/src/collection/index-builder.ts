/**
 * A database index entry with field names and uniqueness flag.
 * Created via `Index.on()` or `Index.unique()`.
 */
export interface IndexEntry<K extends string> {
  readonly fields: Array<K>
  readonly unique: boolean
}

/**
 * A narrowed version of the Index builder where methods only accept field
 * names from `K`. Used as the argument type for the `indexes` callback.
 */
export type IndexBuilder<K extends string> = {
  on<F extends K>(...fields: Array<F>): IndexEntry<F>
  unique<F extends K>(...fields: Array<F>): IndexEntry<F>
}

/**
 * Index builder API.
 * Pass the result to a collection config's `indexes` option.
 *
 * @example
 * BaseCollection.define({
 *   name: "posts",
 *   fields: { slug: Field.text(), authorId: Field.text() },
 *   indexes: [
 *     Index.unique("slug"),
 *     Index.on("authorId", "createdAt")
 *   ]
 * })
 */
export const Index = {
  /**
   * Create a non-unique (plain) index on one or more fields.
   * Composite indexes are created by passing multiple field names — order matters
   * for query performance (leftmost prefix rule).
   *
   * @param fields - One or more field names to include in the index
   * @returns An IndexEntry with `unique: false`
   *
   * @example
   * Index.on("authorId")              // single-field index
   * Index.on("authorId", "createdAt") // composite index
   */
  on: <const K extends string>(...fields: Array<K>): IndexEntry<K> => ({ fields, unique: false }),

  /**
   * Create a unique index on one or more fields.
   * Enforces that the combination of field values is unique across all records.
   * Composite unique indexes check uniqueness across all listed columns together.
   *
   * @param fields - One or more field names to include in the unique constraint
   * @returns An IndexEntry with `unique: true`
   *
   * @example
   * Index.unique("slug")             // single-field unique constraint
   * Index.unique("teamId", "name")   // composite unique constraint
   */
  unique: <const K extends string>(...fields: Array<K>): IndexEntry<K> => ({ fields, unique: true })
}
