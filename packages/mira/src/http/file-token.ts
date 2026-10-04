import type { AnyCollectionDef } from "@gettersethya/mira-client"
import { Effect, Redacted, Schema } from "effect"
import type { HttpRouter} from "effect/http";
import { HttpServerRequest, HttpServerResponse } from "effect/http"

import { idClause } from "@/collection-service/where.js"
import { AppConfig } from "@/config/index.js"
import { Repository } from "@/repository/repository.js"

import { signFileToken, verifyJwt } from "./auth.js"

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

    // Require auth token from Bearer header or mira_token cookie
    const rawToken = extractToken(req)
    if (rawToken === null) {
      return HttpServerResponse.jsonUnsafe({ error: "unauthorized" }, { status: 401 })
    }

    const authPayload = yield* verifyJwt(rawToken, jwtSecret).pipe(
      Effect.orElseSucceed(() => null)
    )
    if (authPayload === null) {
      return HttpServerResponse.jsonUnsafe({ error: "unauthorized" }, { status: 401 })
    }

    // Verify the auth user still exists
    const repo = yield* Repository
    const authRows = yield* repo
      .viewFilter(authPayload.col, { where: idClause(authPayload.sub) })
      .pipe(Effect.orElseSucceed(() => []))

    if (authRows.length === 0) {
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
      { sub: authPayload.sub, col: authPayload.col, filecol: body.collection },
      jwtSecret
    ).pipe(Effect.orDie)

    const expiresAt = Date.now() + 5 * 60 * 1000

    return HttpServerResponse.jsonUnsafe({ token: fileToken, expiresAt }, { status: 200 })
  }).pipe(Effect.orDie)
}
