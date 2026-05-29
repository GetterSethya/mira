import type {
  AnyCollectionDef,
  EmailConstraintKind,
  FieldDef,
  FieldKind,
  IntegerConstraintKind,
  NumberConstraintKind,
  SimpleConstraintKind,
  TextConstraintKind,
} from "./types.js"

/** Common options shared by all field types. */
type BaseFieldOptions = {
  /** Alternative field name in the database (defaults to the key in the fields map). */
  name?: string
  /** Whether the field is required (defaults to `true` if no default is set). */
  required?: boolean
  /** Creates a unique index on this field. */
  unique?: boolean
  /** Creates a non-unique index on this field. */
  indexed?: boolean
  /** Default value for the field when creating a record. */
  default?: unknown
}

// Generic over D so the caller's specific field type (kind literal, required literal, etc.) is preserved.
// Object.assign is used (not spread) because TypeScript infers the intersection type precisely.
function withView<D extends FieldDef>(def: D): D & { view(): D & { viewOnly: true } } {
  const viewOnlyPatch: { viewOnly: true } = { viewOnly: true }
  function view(): D & { viewOnly: true } {
    return Object.assign({}, def, viewOnlyPatch)
  }
  return Object.assign({}, def, { view })
}

// Generic field builder — K is the kind literal, O is the caller's opts (preserving required: false, etc.)
function makeField<K extends FieldKind, O extends BaseFieldOptions>(
  kind: K,
  opts?: O
): FieldDef & { kind: K } & O & { view(): FieldDef & { kind: K } & O & { viewOnly: true } } {
  const def = { _tag: "FieldDef" as "FieldDef", kind, ...opts } as FieldDef & { kind: K } & O
  return withView(def)
}

/**
 * Field builder API.
 * Every method returns a typed `FieldDef` with `.view()` for use in `ViewCollection`.
 *
 * @example
 * const Posts = BaseCollection.define("posts", {
 *   title: Field.text({ maxLength: 200 }),
 *   body: Field.text({ required: false }),
 *   published: Field.boolean({ default: false }),
 *   author: Field.relation(Users)
 * })
 */
export const Field = {
  /**
   * A UTF-8 text/string field with optional min/max length constraints.
   * Stored as `TEXT` in SQLite.
   *
   * @param opts.required - Whether the field is required (default: true, unless `default` is set)
   * @param opts.default - Default value for new records
   * @param opts.unique - Create a unique index on this field
   * @param opts.indexed - Create a non-unique index on this field
   * @param opts.name - Alternative column name in the database
   * @param opts.minLength - Minimum string length (validated on create and update)
   * @param opts.maxLength - Maximum string length (validated on create and update)
   * @param opts.error - Callback for custom validation error messages, keyed by constraint kind
   * @returns A text-type FieldDef with `.view()` method
   *
   * @example
   * Field.text({ maxLength: 500, required: true })
   * Field.text({ minLength: 3, maxLength: 100, default: "untitled" })
   */
  text: <O extends BaseFieldOptions & { minLength?: number; maxLength?: number }>(
    opts?: O & { error?: (kind: TextConstraintKind) => string | undefined }
  ) => makeField("text", opts),

  /**
   * A floating-point number field with optional min/max constraints.
   * Stored as `REAL` in SQLite.
   *
   * @param opts.min - Minimum allowed value (inclusive)
   * @param opts.max - Maximum allowed value (inclusive)
   *
   * @example
   * Field.number({ min: 0, max: 100 })
   * Field.number({ required: false })
   */
  number: <O extends BaseFieldOptions & { min?: number; max?: number }>(
    opts?: O & { error?: (kind: NumberConstraintKind) => string | undefined }
  ) => makeField("number", opts),

  /**
   * An integer field with optional min/max constraints.
   * Stored as `INTEGER` in SQLite. Values are validated to be whole numbers.
   *
   * @param opts.min - Minimum allowed value (inclusive)
   * @param opts.max - Maximum allowed value (inclusive)
   *
   * @example
   * Field.integer({ min: 1, max: 5 })
   */
  integer: <O extends BaseFieldOptions & { min?: number; max?: number }>(
    opts?: O & { error?: (kind: IntegerConstraintKind) => string | undefined }
  ) => makeField("integer", opts),

  /**
   * A boolean (true/false) field.
   * Stored as `INTEGER` (0/1) in SQLite.
   * Typically paired with a `default` value since new records default to false.
   *
   * @param opts.default - Default value (recommended to always set this)
   *
   * @example
   * Field.boolean({ default: false })
   */
  boolean: <O extends Omit<BaseFieldOptions, "default"> & { default?: boolean }>(
    opts?: O & { error?: (kind: SimpleConstraintKind) => string | undefined }
  ) => makeField("boolean", opts),

  /**
   * A date/time field stored as an ISO 8601 string.
   * Stored as `TEXT` in SQLite. Values should be ISO 8601 strings.
   * The server does not parse or transform date values — they are stored verbatim.
   *
   * @example
   * Field.date({ required: true })
   */
  date: <O extends BaseFieldOptions>(
    opts?: O & { error?: (kind: SimpleConstraintKind) => string | undefined }
  ) => makeField("date", opts),

  /**
   * An email address field with built-in format validation.
   * Stored as `TEXT` in SQLite. The server validates the email format
   * on both create and update operations.
   *
   * @example
   * Field.email({ required: false })
   */
  email: <O extends BaseFieldOptions>(
    opts?: O & { error?: (kind: EmailConstraintKind) => string | undefined }
  ) => makeField("email", opts),

  /**
   * A JSON field for storing arbitrary structured data.
   * Stored as `TEXT` (JSON string) in SQLite. The server serializes/deserializes
   * values automatically. Can be used for dynamic metadata, nested objects, arrays, etc.
   *
   * @example
   * Field.json({ required: false })
   */
  json: <O extends BaseFieldOptions>(
    opts?: O & { error?: (kind: SimpleConstraintKind) => string | undefined }
  ) => makeField("json", opts),

  /**
   * Auto-incrementing sequence ID (system-managed, hidden from API responses).
   * Stored as `INTEGER` in SQLite with `AUTOINCREMENT`.
   * This field is always present on base and auth collections and does NOT expose
   * `.view()` — it is always a physical column.
   *
   * @example
   * // seqId is automatically included in base/auth collections — typically
   * // only used in ViewCollection where you map a query column to seqId.
   * Field.seqId()
   */
  seqId: (opts?: BaseFieldOptions): FieldDef => ({
    _tag: "FieldDef",
    kind: "seqId",
    ...opts
  }),

  /**
   * A file/attachment field referencing an uploaded file.
   * Stored as `TEXT` (filename string) in SQLite. The actual file content is
   * stored in the file storage backend (local disk or S3).
   *
   * When `protected: true`, the file requires a short-lived JWT token to access.
   * Protected files are served via the async token endpoint.
   *
   * @param opts.maxSize - Maximum file size in bytes (use `Bytes.*` helpers)
   * @param opts.mimeTypes - Allowed MIME types (e.g., ["image/jpeg", "image/png"])
   * @param opts.protected - Whether the file requires auth token to access
   *
   * @example
   * Field.file({ maxSize: Bytes.fromMB(5), mimeTypes: ["image/jpeg"] })
   * Field.file({ protected: true, maxSize: Bytes.fromMB(10) })
   *
   * @see Bytes — byte size helpers for maxSize
   */
  file: <O extends BaseFieldOptions & { maxSize?: number; mimeTypes?: Array<string>; protected?: boolean }>(
    opts?: O & { error?: (kind: SimpleConstraintKind) => string | undefined }
  ) => makeField("file", opts),

  /**
   * A relation field referencing another collection's record.
   * Stores the target record's field value (defaults to `"id"`).
   * Resolves collection names at definition time — only the name string survives
   * into the serialized JSON Schema.
   *
   * The `_target` phantom property carries the collection definition at compile time
   * for type inference in `WithExpand`.
   *
   * @param collection - The target collection definition (AnyCollectionDef)
   * @param opts.field - The target field to reference (defaults to `"id"`)
   *
   * @example
   * Field.relation(Users)
   * Field.relation(Users, { field: "email" })
   *
   * @see WithExpand — uses _target to type expanded related records
   */
  relation: <C extends AnyCollectionDef, O extends BaseFieldOptions>(
    collection: C,
    opts?: O & { field?: (keyof C["fields"] & string) | "id" | "created" | "updated"; error?: (kind: SimpleConstraintKind) => string | undefined }
  ) => {
    const targetField = opts?.field ?? "id"
    const { field: _field, ...fieldOpts } = (opts ?? {}) as { field?: string } & O
    const def = {
      _tag: "FieldDef" as "FieldDef",
      kind: "relation" as "relation",
      targetCollection: collection.name,
      targetField,
      _target: collection,
      ...fieldOpts
    } as FieldDef & { kind: "relation"; _target: C } & O
    return withView(def)
  }
}
