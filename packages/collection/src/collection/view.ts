import { makeRuleBuilder } from "@/rule/builder.js"
import type { RuleBuilder } from "@/rule/builder.js"
import type { RuleMap } from "@/rule/types.js"
import { toJSONSchema } from "./serialize.js"
import type { CollectionSchema, FieldDef, FieldsMap } from "./types.js"

type ViewFields = {
  id:    FieldDef & { viewOnly: true }
  seqId: FieldDef & { viewOnly: true }
}

type RuleCb<F extends FieldsMap> = (
  R: RuleBuilder<F>
) => RuleMap

/**
 * Builder returned by `ViewCollection.define()`.
 * Immediately satisfies `AnyCollectionDef` — no terminal `.build()` needed.
 * Chain `.rules()` to add access rules. Views have no `.indexes()` — they are not physical tables.
 * Each chained method returns a new builder; the original is unchanged.
 */
export type ViewCollectionBuilder<F extends FieldsMap> = {
  name: string
  fields: F
  schema: CollectionSchema
  /**
   * Add per-action access rules. No rule means deny all.
   * Pass a callback to get a typed rule builder with auto-completion over field names.
   */
  rules(cb: RuleCb<F>): ViewCollectionBuilder<F>
}

/** @internal Exported for testing only. */
export function validateViewFields(name: string, fields: Record<string, { viewOnly?: boolean }>): void {
  if (!fields.id || fields.id.viewOnly !== true)
    throw new Error(`ViewCollection "${name}": "id" must be declared with .view()`)
  if (!fields.seqId || fields.seqId.viewOnly !== true)
    throw new Error(`ViewCollection "${name}": "seqId" must be declared with .view()`)
}

function makeViewBuilder<F extends ViewFields & FieldsMap>(
  name: string,
  query: string,
  fields: F,
  rulesCb?: RuleCb<F>
): ViewCollectionBuilder<F> {
  const rules = rulesCb?.(makeRuleBuilder<F>())
  const schema = toJSONSchema("view", name, fields, {
    viewQuery: query,
    ...(rules !== undefined ? { rules } : {})
  })
  return {
    name,
    fields,
    schema,
    rules: (cb) => makeViewBuilder(name, query, fields, cb)
  }
}

/**
 * Defines a read-only view collection backed by a raw SQL query.
 * Requires `id` and `seqId` in the field map, both declared with `.view()`.
 * No indexes are supported.
 *
 * @example
 * const ActivePosts = ViewCollection.define(
 *   "active_posts",
 *   `WITH ranked AS (
 *      SELECT p.id, p.title, ROW_NUMBER() OVER (ORDER BY p.created DESC) AS seqId
 *      FROM posts p WHERE p.status = 'active'
 *    ) SELECT * FROM ranked`,
 *   {
 *     id:    Field.text().view(),
 *     seqId: Field.integer().view(),
 *     title: Field.text().view()
 *   }
 * )
 * .rules((R) => ({ list: R.public(), view: R.public() }))
 */
export const ViewCollection = {
  define<F extends ViewFields & FieldsMap>(
    name: string,
    query: string,
    fields: F
  ): ViewCollectionBuilder<F> {
    validateViewFields(name, fields)
    return makeViewBuilder(name, query, fields)
  }
}
