import type { RepoRecord } from "@/repository/types.js"

/** Auth-resolved request context. JWT parsing is not done here — the route handler provides this. */
export type RequestCtx = {
  auth?: { collection: string; record: RepoRecord }
  headers: Record<string, string>
  query: Record<string, string | ReadonlyArray<string>>
  /** When true, skip all rule enforcement (validation still applies). Used by admin/dashboard routes. */
  admin?: boolean
}

/** Paginated result — cursor-based via seqId. Used for all collection kinds. */
export type CursorPage = {
  items: ReadonlyArray<RepoRecord>
  /** seqId of the last item. Pass as `after` to fetch the next page. null = no more pages. */
  nextCursor: number | null
}
