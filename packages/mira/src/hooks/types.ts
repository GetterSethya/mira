import type { AnyCollectionDef } from "@gettersethya/mira-client"
import type { FilterNode } from "@gettersethya/mira-client"
import type { RepoRecord, SortOrder } from "@/repository/types.js"

export interface AuthContext {
  readonly collection: string
  readonly record: RepoRecord
}

export interface RequestContext {
  readonly auth: AuthContext | undefined
  readonly headers: Record<string, string>
  readonly query: Record<string, string>
}

export interface RecordHookContext {
  readonly collection: AnyCollectionDef
  readonly data: RepoRecord
  readonly record: RepoRecord | undefined
  readonly auth: AuthContext | undefined
}

export interface ListHookContext {
  readonly collection: AnyCollectionDef
  readonly filter: FilterNode | undefined
  readonly sort: SortOrder | undefined
  readonly select: ReadonlyArray<string> | null | undefined
  readonly expand: ReadonlyArray<string> | null | undefined
  readonly cursor: number | null
  readonly limit: number
  readonly auth: AuthContext | undefined
}

export interface ViewHookContext {
  readonly collection: AnyCollectionDef
  readonly id: string
  readonly select: ReadonlyArray<string> | null | undefined
  readonly expand: ReadonlyArray<string> | null | undefined
  readonly auth: AuthContext | undefined
}

export interface RecordResultContext extends RecordHookContext {
  readonly result: RepoRecord
}

export interface ListResultContext extends ListHookContext {
  readonly items: ReadonlyArray<RepoRecord>
  readonly nextCursor: number | null
}

export interface ViewResultContext extends ViewHookContext {
  readonly result: RepoRecord
}

export interface HookErrorContext {
  readonly collection: AnyCollectionDef
  readonly action: string
  readonly error: unknown
  readonly auth: AuthContext | undefined
}
