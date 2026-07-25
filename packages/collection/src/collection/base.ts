import { Index } from "./index-builder.js"
import type { IndexBuilder, IndexEntry } from "./index-builder.js"
import { toJSONSchema } from "./serialize.js"
import type { CollectionSchema, FieldsMap } from "./types.js"

type BaseForbiddenField = "id" | "seqId"
type BaseSystemField = "id" | "seqId" | "created" | "updated"

type IndexCb<F extends FieldsMap> = (
  I: IndexBuilder<(keyof F & string) | BaseSystemField>
) => Array<IndexEntry<(keyof F & string) | BaseSystemField>>

/**
 * Builder returned by `BaseCollection.define()`.
 * Immediately satisfies `AnyCollectionDef` — no terminal `.build()` needed.
 * Chain `.indexes()` to add optional indexes.
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
}

function makeBaseBuilder<F extends FieldsMap>(
  name: string,
  fields: F,
  indexesCb?: IndexCb<F>
): BaseCollectionBuilder<F> {
  type AF = (keyof F & string) | BaseSystemField
  let _schema: CollectionSchema | undefined
  return {
    name,
    fields,
    get schema(): CollectionSchema {
      if (_schema === undefined) {
        const indexes = indexesCb?.(Index as IndexBuilder<AF>)
        _schema = toJSONSchema("base", name, fields, {
          ...(indexes !== undefined ? { indexes } : {})
        })
      }
      return _schema!
    },
    indexes: (cb) => makeBaseBuilder(name, fields, cb)
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
 */
export const BaseCollection = {
  define<F extends FieldsMap & { [K in keyof F & BaseForbiddenField]?: never }>(
    name: string,
    fields: F
  ): BaseCollectionBuilder<F> {
    return makeBaseBuilder(name, fields)
  }
}
