import type { AnyCollectionDef, FieldDef, FieldsMap, InferFieldValue } from "./types.js"

/**
 * Narrows `AnyCollectionDef` to auth collections only.
 * Used to constrain auth-only client methods (e.g. the per-collection `me()`)
 * so that only auth collection definitions are accepted at compile time.
 *
 * @example
 * // Only auth collections expose an auth tail:
 * const client = createMiraClient("/").withCollections({ users: UsersAuth })
 * const result = await client.users.me().raw()
 */
export type AnyAuthCollectionDef = AnyCollectionDef & {
  schema: { "x-collection-kind": "auth" }
}

/** Resolves the mutation value type for a field: File | Blob for file fields, InferFieldValue for everything else. */
type MutationFieldValue<F extends FieldDef> = F["kind"] extends "file" ? File | Blob : InferFieldValue<F>

/**
 * The input type for creating/updating records when file uploads are involved.
 * Same structure as `InferCreateInput` but file fields accept `File | Blob`
 * instead of the server-returned URL string.
 *
 * When the input contains any `Blob` values, the client SDK automatically
 * dispatches a `multipart/form-data` request instead of JSON.
 *
 * @example
 * // For a collection with { avatar: Field.file() }
 * // InferMutationInput resolves avatar to: File | Blob
 *
 * @see InferCreateInput — create input without file upload support
 * @see InferRecord — the corresponding output type
 */
export type InferMutationInput<F extends FieldsMap> = {
  [K in keyof F as F[K]["kind"] extends "seqId" ? never : F[K]["viewOnly"] extends true ? never : F[K]["required"] extends false ? K : never]?:
    MutationFieldValue<F[K]> | null
} & {
  [K in keyof F as F[K]["kind"] extends "seqId" ? never : F[K]["viewOnly"] extends true ? never : F[K]["required"] extends false ? never : K]:
    MutationFieldValue<F[K]>
}

/**
 * The full record type returned from the server for a collection.
 * Includes the system-managed `id`, `created`, and `updated` fields plus all
 * user-defined fields with their correct TypeScript types.
 *
 * Optional fields (`required: false`) are typed as `T | null`.
 *
 * @example
 * interface Post { title: Field.text(); body: Field.text({ required: false }) }
 * // InferRecord<Post> resolves to:
 * // { id: string; created: string; updated: string } & {
 * //   title: string;
 * //   body: string | null;
 * // }
 *
 * @see InferCreateInput — input type for creating records
 * @see InferMutationInput — mutation input type (file fields use File | Blob)
 */
export type InferRecord<F extends FieldsMap> =
  { id: string; created: string; updated: string } &
  {
    [K in keyof F as F[K]["kind"] extends "seqId" ? never : K]:
      F[K]["required"] extends false
        ? InferFieldValue<F[K]> | null
        : InferFieldValue<F[K]>
  }

/**
 * The input type for creating a new record.
 * Excludes system-managed fields (`seqId`) and view-only fields.
 * Optional fields (`required: false`) are typed as `T | null` and are
 * themselves optional (`K?`)
 *
 * @example
 * // InferCreateInput<Post> resolves to:
 * // { title: string; body?: string | null }
 *
 * @see InferRecord — the corresponding output type
 * @see InferMutationInput — mutation variant that uses File | Blob for file fields
 */
export type InferCreateInput<F extends FieldsMap> = {
  [K in keyof F as F[K]["kind"] extends "seqId" ? never : F[K]["viewOnly"] extends true ? never : F[K]["required"] extends false ? K : never]?:
    InferFieldValue<F[K]> | null
} & {
  [K in keyof F as F[K]["kind"] extends "seqId" ? never : F[K]["viewOnly"] extends true ? never : F[K]["required"] extends false ? never : K]:
    InferFieldValue<F[K]>
}

/**
 * Extracts the field names of type `relation` from a FieldsMap.
 * Used to constrain the `expand` option in collection queries.
 *
 * @example
 * // For { author: Field.relation(Users), title: Field.text() }
 * // RelationKeys resolves to: "author"
 *
 * @see WithExpand — uses RelationKeys to type the expand parameter
 */
export type RelationKeys<F extends FieldsMap> = {
  [K in keyof F]: F[K]["kind"] extends "relation" ? K : never
}[keyof F] & string

/**
 * Extracts the field names of type `file` from a FieldsMap.
 *
 * @example
 * // For { avatar: Field.file(), name: Field.text() }
 * // FileKeys resolves to: "avatar"
 */
export type FileKeys<F extends FieldsMap> = {
  [K in keyof F]: F[K]["kind"] extends "file" ? K : never
}[keyof F] & string

/**
 * Augments `InferRecord<F>` with an `expand` property containing the resolved
 * related records for the requested relation field names.
 *
 * When `E` is an empty tuple (no expand requested), the result is just
 * `InferRecord<F>` without the `expand` property.
 *
 * @example
 * // WithExpand<PostFields, ["author"]> resolves to:
 * // InferRecord<Post> & {
 * //   expand: { author: InferRecord<UserFields> }
 * // }
 *
 * @see InferRecord — the base record type
 * @see RelationKeys — used to constrain E to relation fields
 */
export type WithExpand<
  F extends FieldsMap,
  E extends ReadonlyArray<string>
> = InferRecord<F> & (
  [E] extends [[]]
    ? {}
    : {
        expand: {
          [K in E[number] & RelationKeys<F>]:
            F[K] extends { _target: infer Target extends AnyCollectionDef }
              ? InferRecord<Target["fields"]>
              : Record<string, unknown>
        }
      }
)

/**
 * Extracts the field names that may appear in a `select` option.
 * Fields marked `hidden: true` (serialized as `x-hidden`) are excluded —
 * passing one in `select` is a compile error.
 *
 * @example
 * // For { title: Field.text(), secret: Field.text({ hidden: true }) }
 * // SelectableKeys resolves to: "title"
 *
 * @see WithSelect — uses S (constrained to SelectableKeys) to narrow the result
 */
export type SelectableKeys<F extends FieldsMap> = {
  [K in keyof F]: F[K] extends { hidden: true } ? never : K
}[keyof F] & string

/**
 * Narrows `InferRecord<F>` to the shape the server returns when `select` is
 * passed: the selected fields plus the system fields (`id`/`created`/`updated`),
 * the local id column of each expanded relation, and `expand` when requested.
 *
 * When `S` is `undefined` (no `select` passed) this resolves to the current
 * full type (`WithExpand<F, E>`). An empty select (`select: []`) narrows to
 * the system fields (+ expanded ids) only, matching the runtime.
 *
 * `seqId` is stripped from responses at runtime, so it never appears here even
 * when selected (it is excluded from `InferRecord` already).
 *
 * @example
 * // WithSelect<PostFields, ["title"], []> resolves to:
 * // Pick<InferRecord<PostFields>, "id" | "created" | "updated" | "title">
 *
 * @see InferRecord — the base record type
 * @see WithExpand — the no-select result shape
 * @see SelectableKeys — constrains S to non-hidden keys
 */
export type WithSelect<
  F extends FieldsMap,
  S extends ReadonlyArray<string> | undefined,
  E extends ReadonlyArray<string>
> = [S] extends [undefined]
  ? WithExpand<F, E>
  : Pick<
      InferRecord<F>,
      Extract<Exclude<S, undefined>[number] | E[number] | "id" | "created" | "updated", keyof InferRecord<F>>
    > & (
      [E] extends [[]]
        ? {}
        : {
            expand: {
              [K in E[number] & RelationKeys<F>]:
                F[K] extends { _target: infer Target extends AnyCollectionDef }
                  ? InferRecord<Target["fields"]>
                  : Record<string, unknown>
            }
          }
    )

/** The collection kinds understood by the client. Mirrors `CollectionSchema["x-collection-kind"]`. */
export type CollectionKind = "base" | "auth" | "view"

/** Credential fields accepted when creating an auth-collection record. */
export type AuthCreateExtras = {
  password: string
  passwordConfirm: string
  emailVerified?: boolean
}

/** Credential fields accepted when updating an auth-collection record (all optional). */
export type AuthUpdateCreds = {
  password?: string
  passwordConfirm?: string
  oldPassword?: string
  emailVerified?: boolean
}

/**
 * The create-record input, kind-aware. For auth collections it adds the credential
 * fields (`password` + matching `passwordConfirm`) and makes `emailVerified` optional
 * (server-controlled for non-manage callers).
 *
 * `password`/`passwordConfirm` never appear on `InferRecord`/`InferCreateInput`.
 *
 * @see AuthCreateInput — auth-specific alias
 * @see RegisterInput — the ergonomic self-signup variant
 */
export type CreateInput<F extends FieldsMap, K extends CollectionKind = "base"> =
  Omit<InferMutationInput<F>, "emailVerified"> & (K extends "auth" ? AuthCreateExtras : {})

/**
 * The update-record input, kind-aware. For auth collections every credential field is
 * optional because the server enforces which are required: changing the password needs
 * `passwordConfirm` (+ `oldPassword` unless manager/admin); changing email needs `oldPassword`.
 *
 * @see AuthUpdateInput — auth-specific alias
 */
export type UpdateInput<F extends FieldsMap, K extends CollectionKind = "base"> = {
  id: string
  data: Partial<InferMutationInput<F>> & (K extends "auth" ? AuthUpdateCreds : {})
}

/** The create-record input for auth collections. */
export type AuthCreateInput<F extends FieldsMap> = CreateInput<F, "auth">

/** The update-record input for auth collections. */
export type AuthUpdateInput<F extends FieldsMap> = UpdateInput<F, "auth">

/**
 * The input for `register()` — self-service signup on an auth collection.
 * Requires `email`, `password`, and a matching `passwordConfirm`; all user-defined
 * extra fields are accepted; `emailVerified` is server-controlled.
 */
export type RegisterInput<F extends FieldsMap> =
  Omit<InferMutationInput<F>, "email" | "emailVerified"> & {
    email: string
    password: string
    passwordConfirm: string
    emailVerified?: boolean
  }
