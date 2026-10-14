import type { AnyCollectionDef } from "@gettersethya/mira-client"

import type { RequestCtx } from "@/collection-service/context.js"
import { extractCtxRefs } from "@/collection-service/where.js"
import { enforcerForAction } from "@/rule/enforcer.js"

const NUL = "\u0000"

/**
 * Marker standing in for a value the rule resolver treats as `null`: a missing
 * query/header/body key, an absent body, or an empty array.
 *
 * Rendered as a lone `\N`. {@link encodeScalar} escapes a literal backslash to
 * `\\` *first*, so a present value that happens to be `\N` encodes to `\\N`.
 */
const ABSENT = "\\N"

/**
 * Escapes one present scalar: the `,` between references, the `=` between a key
 * and its value, and the `|` between the auth/query/header/body segments. The
 * backslash is escaped FIRST so the escape sequences introduced for the other
 * characters are unambiguous.
 */
function encodeScalar(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll(NUL, "\\0")
    .replaceAll(",", "\\,")
    .replaceAll("=", "\\=")
    .replaceAll("|", "\\|")
}

/**
 * Resolves and encodes one rule-referenced context value using the same semantics
 * as `resolveCtxPlaceholders`: arrays collapse to their first element (empty arrays
 * and absent values become the {@link ABSENT} marker); every other value is rendered
 * as its string form with the tag's structural characters escaped.
 */
function encodeCtxValue(raw: unknown): string {
  const resolved = Array.isArray(raw) ? raw[0] : raw
  if (resolved === undefined || resolved === null) return ABSENT
  return encodeScalar(String(resolved))
}

/**
 * Derives the portion of a cache key that captures everything a collection's
 * row-level access rule for `action` could depend on in `ctx`: the admin flag,
 * the authenticated identity, and only the specific request query/header/body keys
 * the compiled rule actually references.
 *
 * Each referenced value is encoded with the same resolution semantics the rule
 * resolver applies.
 *
 * Reference: `resolveCtxPlaceholders` in `@/collection-service/where.js`.
 */
export function buildCtxCacheTag(
  collection: AnyCollectionDef,
  action: "view" | "list",
  ctx: RequestCtx
): string {
  if (ctx.admin === true) return "admin"

  const compiled = enforcerForAction(collection.schema, action)
  if (compiled === null) return "denied"

  const refs = extractCtxRefs(compiled.sql)

  const authPart =
    refs.authFields.length > 0
      ? `auth:${refs.authFields
          .map((field) =>
            field === "collection"
              ? `collection=${encodeCtxValue(ctx.auth?.collection)}`
              : `${field}=${encodeCtxValue(ctx.auth?.record[field])}`
          )
          .join(",")}`
      : ""

  const queryPart =
    refs.queryKeys.length > 0
      ? `q:${refs.queryKeys.map((key) => `${key}=${encodeCtxValue(ctx.query[key])}`).join(",")}`
      : ""

  const headerPart =
    refs.headerKeys.length > 0
      ? `h:${refs.headerKeys.map((key) => `${key}=${encodeCtxValue(ctx.headers[key])}`).join(",")}`
      : ""

  const bodyPart =
    refs.bodyKeys.length > 0
      ? `b:${refs.bodyKeys.map((key) => `${key}=${encodeCtxValue(ctx.body?.[key])}`).join(",")}`
      : ""

  const parts = [authPart, queryPart, headerPart, bodyPart].filter((p) => p.length > 0)
  return parts.length > 0 ? parts.join("|") : "public"
}
