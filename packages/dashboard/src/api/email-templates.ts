import type { AnyCollectionDef } from "@gettersethya/mira-client"
import { AppConfig, EmailService, EmailTemplates } from "@gettersethya/mira"
import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"

/** Names of the collections whose auth email flows can be previewed. */
export const authCollectionNames = (collections: ReadonlyArray<AnyCollectionDef>) =>
  new Set(
    collections
      .filter((collection) => collection.schema["x-collection-kind"] === "auth")
      .map((collection) => collection.name)
  )

/**
 * `GET /_dashboard/api/email/templates?collection=<name>`
 *
 * Auth-wrapped by the router. Returns the effective templates for one auth
 * collection using sentinel preview inputs. It resolves the `EmailTemplates`
 * reference directly, never the transport: the response contains no recipient,
 * live link, or SMTP detail, and works while email is disabled.
 */
export const makeEmailTemplatesRoute = (collections: ReadonlyArray<AnyCollectionDef>) => {
  const authNames = authCollectionNames(collections)
  return Effect.gen(function* () {
    const req = yield* HttpServerRequest.HttpServerRequest
    const url = new URL(req.url, "http://localhost")
    const collection = url.searchParams.get("collection")
    if (collection === null || collection.length === 0) {
      return HttpServerResponse.jsonUnsafe({ error: "missing_collection" }, { status: 400 })
    }
    if (!authNames.has(collection)) {
      return HttpServerResponse.jsonUnsafe({ error: "unknown_collection" }, { status: 404 })
    }

    const templates = yield* EmailTemplates
    const config = yield* AppConfig
    const email = yield* EmailService
    return HttpServerResponse.jsonUnsafe({
      collection,
      transportEnabled: email.enabled,
      templates: templates.preview(collection, config.appName)
    })
  })
}
