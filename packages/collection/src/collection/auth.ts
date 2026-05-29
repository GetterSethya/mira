import { makeRuleBuilder } from "@/rule/builder.js"
import type { RuleBuilder } from "@/rule/builder.js"
import type { RuleMap } from "@/rule/types.js"
import type { OperandNode } from "@/rule/types.js"
import { Index } from "./index-builder.js"
import type { IndexBuilder, IndexEntry } from "./index-builder.js"
import { toJSONSchema } from "./serialize.js"
import type { CollectionSchema, FieldDef, FieldsMap, IndexDef, JsonSchemaProperty } from "./types.js"

type AuthSystemField = "id" | "email" | "password" | "emailVerified" | "created" | "updated" | "seqId"
type AuthRuleField = "id" | "email" | "emailVerified" | "created" | "updated" | "seqId"

type AuthSystemFieldDefs = {
  id:            FieldDef & { kind: "text" }
  email:         FieldDef & { kind: "email" }
  emailVerified: FieldDef & { kind: "boolean" }
  created:       FieldDef & { kind: "date" }
  updated:       FieldDef & { kind: "date" }
  seqId:         FieldDef & { kind: "seqId" }
}

/** Rule builder for auth collections — extends RuleBuilder with `selfId()`. */
type AuthRuleBuilder<F extends FieldsMap> = RuleBuilder<F> & {
  /** authId operand for this collection. Use instead of `Rule.authId(ThisCollection)` to avoid circular references. */
  selfId(): OperandNode<any, string>
}

type IndexCb<F extends FieldsMap> = (
  I: IndexBuilder<(keyof F & string) | AuthRuleField>
) => Array<IndexEntry<(keyof F & string) | AuthRuleField>>

type RuleCb<F extends FieldsMap> = (
  R: AuthRuleBuilder<F & AuthSystemFieldDefs>
) => RuleMap

/**
 * Builder returned by `AuthCollection.define()`.
 * Immediately satisfies `AnyCollectionDef` — no terminal `.build()` needed.
 * Chain `.indexes()` and/or `.rules()` to add optional concerns.
 * Each chained method returns a new builder; the original is unchanged.
 */
export type AuthCollectionBuilder<F extends FieldsMap> = {
  name: string
  fields: F
  schema: CollectionSchema & { "x-collection-kind": "auth" }
  /**
   * Add collection-level indexes (in addition to the system email unique index
   * and any field-level `unique`/`indexed` flags).
   * Pass a callback to get a typed index builder with auto-completion over field names.
   */
  indexes(cb: IndexCb<F>): AuthCollectionBuilder<F>
  /**
   * Add per-action access rules. No rule means deny all.
   * The rule builder includes `.selfId()` as a shorthand for the authenticated user's id
   * on this collection — use it instead of `Rule.authId(ThisCollection)` to avoid circular references.
   */
  rules(cb: RuleCb<F>): AuthCollectionBuilder<F>
}

const AUTH_SYSTEM_PROPERTIES: Record<string, JsonSchemaProperty> = {
  email: { type: "string", format: "email", "x-system": true },
  password: { type: "string", "x-system": true, "x-hidden": true },
  emailVerified: { type: "boolean", "x-system": true, default: false }
}

const AUTH_SYSTEM_INDEXES: Array<IndexDef> = [{ fields: ["email"], unique: true }]

function makeAuthBuilder<F extends FieldsMap>(
  name: string,
  extraFields: F,
  indexesCb?: IndexCb<F>,
  rulesCb?: RuleCb<F>
): AuthCollectionBuilder<F> {
  type AF = (keyof F & string) | AuthRuleField
  const indexes = indexesCb?.(Index as IndexBuilder<AF>)
  const authRuleBuilder: AuthRuleBuilder<F & AuthSystemFieldDefs> = {
    ...makeRuleBuilder<F & AuthSystemFieldDefs>(),
    selfId(): OperandNode<any, string> { return { kind: "authId", collection: name } }
  }
  const rules = rulesCb?.(authRuleBuilder)
  const schema = toJSONSchema("auth", name, extraFields, {
    indexes: [...AUTH_SYSTEM_INDEXES, ...(indexes ?? [])],
    systemFields: AUTH_SYSTEM_PROPERTIES,
    ...(rules !== undefined ? { rules } : {})
  })
  return {
    name,
    fields: extraFields,
    schema,
    indexes: (cb) => makeAuthBuilder(name, extraFields, cb, rulesCb),
    rules: (cb) => makeAuthBuilder(name, extraFields, indexesCb, cb)
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
 * .rules((R) => ({
 *   list: R.field("id").eq(R.selfId()),
 *   create: R.public()
 * }))
 */
export const AuthCollection = {
  define<F extends FieldsMap & { [K in keyof F & AuthSystemField]?: never }>(
    name: string,
    extraFields: F
  ): AuthCollectionBuilder<F> {
    return makeAuthBuilder(name, extraFields)
  }
}
