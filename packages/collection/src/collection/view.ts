import { toJSONSchema } from "./serialize.js"
import type { CollectionSchema, FieldDef, FieldsMap } from "./types.js"

type ViewFields = {
  id:    FieldDef & { viewOnly: true }
  seqId: FieldDef & { viewOnly: true }
}

/**
 * Builder returned by `ViewCollection.define()`.
 * Immediately satisfies `AnyCollectionDef` — no terminal `.build()` needed.
 * Views have no `.indexes()` — they are not physical tables.
 * Each chained method returns a new builder; the original is unchanged.
 */
export type ViewCollectionBuilder<F extends FieldsMap> = {
  name: string
  fields: F
  schema: CollectionSchema & { "x-collection-kind": "view" }
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
  fields: F
): ViewCollectionBuilder<F> {
  let _schema: (CollectionSchema & { "x-collection-kind": "view" }) | undefined
  return {
    name,
    fields,
    get schema(): CollectionSchema & { "x-collection-kind": "view" } {
      if (_schema === undefined) {
        _schema = toJSONSchema("view", name, fields, {
          viewQuery: query,
        })
      }
      return _schema!
    },
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
