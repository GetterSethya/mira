import type { AnyCollectionDef } from "@gettersethya/mira-client"
import type { RequestCtx } from "@/collection-service/context.js"
import { extractCtxRefs } from "@/collection-service/where.js"
import { enforcerForAction } from "@/rule/enforcer.js"

/**
 * Derives the portion of a cache key that captures everything a collection's
 * row-level access rule for `action` could depend on in `ctx`: the admin flag,
 * the authenticated identity, and only the specific request query/header keys
 * the compiled rule actually references.
 *
 * Two requests that produce the same tag are guaranteed to be authorized
 * identically by the rule — so caching by `recordKey::ctxTag` cannot let one
 * requester's cached result leak to a requester the rule would otherwise deny
 * or show a different field set to.
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
              ? `collection=${ctx.auth?.collection ?? ""}`
              : `${field}=${String(ctx.auth?.record[field] ?? "")}`
          )
          .join(",")}`
      : ""

  const queryPart =
    refs.queryKeys.length > 0
      ? `q:${refs.queryKeys.map((key) => `${key}=${String(ctx.query[key] ?? "")}`).join(",")}`
      : ""

  const headerPart =
    refs.headerKeys.length > 0
      ? `h:${refs.headerKeys.map((key) => `${key}=${String(ctx.headers[key] ?? "")}`).join(",")}`
      : ""

  const parts = [authPart, queryPart, headerPart].filter((p) => p.length > 0)
  return parts.length > 0 ? parts.join("|") : "public"
}
