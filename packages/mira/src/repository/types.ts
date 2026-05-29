/** A raw database row — no domain types at this layer. */
export type RepoRecord = Record<string, unknown>

/** A cursor-based result from a paginated list query. No COUNT(*) overhead. */
export type CursorResult<A> = {
  items: ReadonlyArray<A>
}

/**
 * A pre-compiled WHERE fragment from `enforcerForAction()`.
 * The repository wraps it in `unsafeFragment` and splices it into template literals.
 */
export type WhereClause = {
  sql: string
  params: ReadonlyArray<unknown>
}

export type SortOrder = {
  field: string
  direction: "asc" | "desc"
}

/** One LEFT JOIN to inline a related record alongside the main row. */
export type ExpandDef = {
  localField: string
  targetTable: string
  targetColumns: ReadonlyArray<string>
}

/** Options for list() — where is optional (omit for public collections). */
export type ListOptions = {
  where?: WhereClause
  sort?: SortOrder
  fields?: ReadonlyArray<string>
  expand?: ReadonlyArray<ExpandDef>
}

/**
 * Options for viewFilter() — where is required because the caller always
 * specifies what they are filtering by.
 */
export type FilterOptions = {
  where: WhereClause
  sort?: SortOrder
  fields?: ReadonlyArray<string>
  expand?: ReadonlyArray<ExpandDef>
}
