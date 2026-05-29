import { makeRuleBuilder } from "@/rule/builder.js"
import type { RuleBuilder } from "@/rule/builder.js"
import type { RuleMap } from "@/rule/types.js"
import { Index } from "./index-builder.js"
import type { IndexBuilder, IndexEntry } from "./index-builder.js"
import { toJSONSchema } from "./serialize.js"
import type { CollectionSchema, FieldDef, FieldsMap } from "./types.js"

type BaseForbiddenField = "id" | "seqId"
type BaseSystemField = "id" | "seqId" | "created" | "updated"

type BaseSystemFieldDefs = {
  id:      FieldDef & { kind: "text" }
  created: FieldDef & { kind: "date" }
  updated: FieldDef & { kind: "date" }
  seqId:   FieldDef & { kind: "seqId" }
}

type IndexCb<F extends FieldsMap> = (
  I: IndexBuilder<(keyof F & string) | BaseSystemField>
) => Array<IndexEntry<(keyof F & string) | BaseSystemField>>

type RuleCb<F extends FieldsMap> = (
  R: RuleBuilder<F & BaseSystemFieldDefs>
) => RuleMap

/**
 * Builder returned by `BaseCollection.define()`.
 * Immediately satisfies `AnyCollectionDef` — no terminal `.build()` needed.
 * Chain `.indexes()` and/or `.rules()` to add optional concerns.
 * Each chained method returns a new builder; the original is unchanged.
 */
export type BaseCollectionBuilder<F extends FieldsMap> = {
  name: string
  fields: F
  schema: CollectionSchema
  /**
   * Add collection-level indexes (in addition to field-level `unique`/`indexed` flags).
   * Pass a callback to get a typed index builder with auto-completion over field names.
   */
  indexes(cb: IndexCb<F>): BaseCollectionBuilder<F>
  /**
   * Add per-action access rules. No rule means deny all.
   * Pass a callback to get a typed rule builder with auto-completion over field names.
   */
  rules(cb: RuleCb<F>): BaseCollectionBuilder<F>
}

function makeBaseBuilder<F extends FieldsMap>(
  name: string,
  fields: F,
  indexesCb?: IndexCb<F>,
  rulesCb?: RuleCb<F>
): BaseCollectionBuilder<F> {
  type AF = (keyof F & string) | BaseSystemField
  let _schema: CollectionSchema | undefined
  return {
    name,
    fields,
    get schema(): CollectionSchema {
      if (_schema === undefined) {
        const indexes = indexesCb?.(Index as IndexBuilder<AF>)
        const rules = rulesCb?.(makeRuleBuilder<F & BaseSystemFieldDefs>())
        _schema = toJSONSchema("base", name, fields, {
          ...(indexes !== undefined ? { indexes } : {}),
          ...(rules !== undefined ? { rules } : {})
        })
      }
      return _schema!
    },
    indexes: (cb) => makeBaseBuilder(name, fields, cb, rulesCb),
    rules: (cb) => makeBaseBuilder(name, fields, indexesCb, cb)
  }
}

/**
 * Defines a standard data collection.
 * Base collections are the primary storage type with full CRUD support.
 *
 * @example
 * const Tasks = BaseCollection.define("tasks", {
 *   title: Field.text({ maxLength: 200 }),
 *   completed: Field.boolean({ default: false }),
 *   ownerId: Field.text()
 * })
 * .indexes((I) => [I.on("ownerId")])
 * .rules((R) => ({
 *   list: Rule.public(),
 *   view: R.field("ownerId").eq(R.authId(Users))
 * }))
 */
export const BaseCollection = {
  define<F extends FieldsMap & { [K in keyof F & BaseForbiddenField]?: never }>(
    name: string,
    fields: F
  ): BaseCollectionBuilder<F> {
    return makeBaseBuilder(name, fields)
  }
}
