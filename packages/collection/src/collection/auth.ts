import type { IndexBuilder, IndexEntry } from "./index-builder.js"
import { Index } from "./index-builder.js"
import { toJSONSchema } from "./serialize.js"
import type { CollectionSchema, FieldDef, FieldsMap, IndexDef, JsonSchemaProperty } from "./types.js"

type AuthSystemField = "id" | "email" | "password" | "emailVerified" | "created" | "updated" | "seqId"
type AuthRuleField = "id" | "email" | "emailVerified" | "created" | "updated" | "seqId"

/** Only the auth-specific fields not already provided by InferRecord's base type. */
type AuthPublicFieldDefs = {
  email:         FieldDef & { kind: "email" }
  emailVerified: FieldDef & { kind: "boolean" }
}

type IndexCb<F extends FieldsMap> = (
  I: IndexBuilder<(keyof F & string) | AuthRuleField>
) => Array<IndexEntry<(keyof F & string) | AuthRuleField>>

/**
 * Builder returned by `AuthCollection.define()`.
 * Immediately satisfies `AnyCollectionDef` — no terminal `.build()` needed.
 * Chain `.indexes()` to add optional indexes.
 * Each chained method returns a new builder; the original is unchanged.
 */
export type AuthCollectionBuilder<F extends FieldsMap> = {
  name: string
  fields: F & AuthPublicFieldDefs
  schema: CollectionSchema & { "x-collection-kind": "auth" }
  /**
   * Add collection-level indexes (in addition to the system email unique index
   * and any field-level `unique`/`indexed` flags).
   * Pass a callback to get a typed index builder with auto-completion over field names.
   */
  indexes(cb: IndexCb<F>): AuthCollectionBuilder<F>
}

const AUTH_SYSTEM_PROPERTIES: Record<string, JsonSchemaProperty> = {
  email: { type: "string", format: "email", "x-system": true },
  password: { type: "string", "x-system": true, "x-hidden": true, "x-kind": "password" },
  emailVerified: { type: "boolean", "x-system": true, default: false }
}

const AUTH_SYSTEM_FIELD_DEFS: AuthPublicFieldDefs = {
  email:         { _tag: "FieldDef", kind: "email" },
  emailVerified: { _tag: "FieldDef", kind: "boolean" },
}

const AUTH_SYSTEM_INDEXES: Array<IndexDef> = [{ fields: ["email"], unique: true }]

function makeAuthBuilder<F extends FieldsMap>(
  name: string,
  extraFields: F,
  indexesCb?: IndexCb<F>
): AuthCollectionBuilder<F> {
  type AF = (keyof F & string) | AuthRuleField
  let _schema: (CollectionSchema & { "x-collection-kind": "auth" }) | undefined
  return {
    name,
    fields: Object.assign({}, AUTH_SYSTEM_FIELD_DEFS, extraFields),
    get schema(): CollectionSchema & { "x-collection-kind": "auth" } {
      if (_schema === undefined) {
        const indexes = indexesCb?.(Index as IndexBuilder<AF>)
        _schema = toJSONSchema("auth", name, extraFields, {
          indexes: [...AUTH_SYSTEM_INDEXES, ...(indexes ?? [])],
          systemFields: AUTH_SYSTEM_PROPERTIES,
        }) as CollectionSchema & { "x-collection-kind": "auth" }
      }
      return _schema!
    },
    indexes: (cb) => makeAuthBuilder(name, extraFields, cb)
  }
}

/**
 * Defines an auth collection for user authentication.
 * Includes system-managed fields: `id`, `email`, `password`, `emailVerified`, `created`, `updated`, `seqId`.
 * Only `extraFields` are user-defined; system field names are forbidden in `extraFields`.
 *
 * @example
 * const Users = AuthCollection.define("users", {
 *   name: Field.text(),
 *   avatar: Field.file({ maxSize: Bytes.fromMB(2) })
 * })
 */
export const AuthCollection = {
  define<F extends FieldsMap & { [K in keyof F & AuthSystemField]?: never }>(
    name: string,
    extraFields: F
  ): AuthCollectionBuilder<F> {
    return makeAuthBuilder(name, extraFields)
  }
}
