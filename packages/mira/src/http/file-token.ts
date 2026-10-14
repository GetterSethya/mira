import type { AnyCollectionDef } from "@gettersethya/mira-client"
import { Effect, Redacted, Schema } from "effect"
import type { HttpRouter} from "effect/http";
import { HttpServerRequest, HttpServerResponse } from "effect/http"

import { AppConfig } from "@/config/index.js"
import { Repository } from "@/repository/repository.js"

import { authenticateSession, signFileToken } from "./auth.js"

const TokenRequestSchema = Schema.Struct({
  collection: Schema.String
})

function extractToken(
  req: HttpServerRequest.HttpServerRequest
): string | null {
  const auth = req.headers["authorization"]
  if (typeof auth === "string") {
    const m = auth.match(/^Bearer\s+(.+)$/i)
    if (m !== null) return m[1]
  }
  return req.cookies["mira_token"] ?? null
}

export function makeFileTokenRoute(
  collections: ReadonlyArray<AnyCollectionDef>
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  Repository | AppConfig | HttpServerRequest.HttpServerRequest | HttpRouter.RouteContext
> {
  const collectionMap = new Map(collections.map((c) => [c.name, c]))

  return Effect.flatMap(HttpServerRequest.HttpServerRequest, (req) =>
    Effect.catchCause(
      issueToken(req, collectionMap),
      () =>
        Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "internal" }, { status: 500 }))
    )
  )
}

function issueToken(
  req: HttpServerRequest.HttpServerRequest,
  collectionMap: Map<string, AnyCollectionDef>
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, Repository | AppConfig> {
  return Effect.gen(function* () {
    const config = yield* AppConfig
    const jwtSecret = Redacted.value(config.jwtSecret)

    // Single fail-closed session check, shared with `resolveAuth` /
    // `requireApiAuth`: session typ + jti deny-list + record existence +
    // `pwf` credential binding + generation. A file token (no `typ: "session"`)
    // is rejected here, so it cannot be chained to mint further tokens.
    const auth = yield* authenticateSession(extractToken(req), (name) =>
      collectionMap.get(name)?.schema["x-collection-kind"] === "auth"
    )
    if (auth === undefined) {
      return HttpServerResponse.jsonUnsafe({ error: "unauthorized" }, { status: 401 })
    }
    const sub = auth.record["id"]
    if (typeof sub !== "string") {
      return HttpServerResponse.jsonUnsafe({ error: "unauthorized" }, { status: 401 })
    }

    // Parse body for target collection
    const body = yield* req.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(TokenRequestSchema)),
      Effect.orElseSucceed(() => null)
    )
    if (body === null) {
      return HttpServerResponse.jsonUnsafe(
        { error: "validation_failed", issues: ["collection is required"] },
        { status: 422 }
      )
    }

    if (!collectionMap.has(body.collection)) {
      return HttpServerResponse.jsonUnsafe(
        { error: "not_found", message: `Unknown collection "${body.collection}"` },
        { status: 404 }
      )
    }

    const fileToken = yield* signFileToken(
      { sub, col: auth.collection, filecol: body.collection },
      jwtSecret
    ).pipe(Effect.orDie)

    const expiresAt = Date.now() + 5 * 60 * 1000

    return HttpServerResponse.jsonUnsafe({ token: fileToken, expiresAt }, { status: 200 })
  }).pipe(Effect.orDie)
}
