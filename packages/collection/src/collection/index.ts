/**
 * Collection definition system.
 *
 * Provides builders for defining collections (base, auth, view), their fields,
 * indexes, and byte-size helpers. The primary entry points are:
 *
 * - `BaseCollection.define()` — standard CRUD collections
 * - `AuthCollection.define()` — auth/user collections with system fields
 * - `ViewCollection.define()` — read-only SQL view collections
 * - `Field.*()` — field type builders
 * - `Index.*()` — index builders
 * - `Bytes.*` — human-readable byte size constants
 */

export { AuthCollection } from "./auth.js"
export { BaseCollection } from "./base.js"
export { Bytes } from "./bytes.js"
export { ValidationError } from "./errors.js"
export { Field } from "./field.js"
export { Index } from "./index-builder.js"
export type { AnyCollectionDef, CollectionSchema, FieldDef, FieldsMap, LiteralTextConstraintKind } from "./types.js"
export { ViewCollection } from "./view.js"
