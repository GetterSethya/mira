import type { AnyCollectionDef } from "@gettersethya/mira-client"
import type { Tracer } from "effect";
import { Cause, Duration, Effect, Option, Redacted, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"

import { CollectionService } from "@/collection-service/collection-service.js"
import type { RequestCtx } from "@/collection-service/context.js"
import { makeRowDecoder } from "@/collection-service/decode.js"
import { ValidationError } from "@/collection-service/errors.js"
import { AppConfig } from "@/config/index.js"
import type { CryptoService } from "@/crypto/index.js"
import { Dialect } from "@/dialect/dialect.js"
import { Repository } from "@/repository/repository.js"
import type { RepoRecord } from "@/repository/types.js"
import type { FileStorage } from "@/storage/storage.js"
import type { ThumbnailService } from "@/thumbnail/types.js"

import type { AuthService} from "./auth.js";
import { signJwt, verifyAnyJwt, verifyJwt, verifyPassword } from "./auth.js"
import { catchCollectionErrors } from "./errors.js"
import { makeFileServeRoute } from "./file-serve.js"
import { makeFileTokenRoute } from "./file-token.js"
import { processMultipartUpload } from "./files.js"
import { parseExpandParam, parseFilterParam, parsePaginationParam, parseSelectParam, parseSortParam } from "./params.js"
import { makeSchemaRoute } from "./schema.js"
import { telemetryLogsRoute, telemetrySpansRoute } from "./telemetry-routes.js"

type Ms =
  | CollectionService
  | Repository
  | FileStorage
  | ThumbnailService
  | AppConfig
  | AuthService
  | CryptoService
  | Dialect

const AuthBodySchema = Schema.Struct({
  email: Schema.String,
  password: Schema.String
})

function buildRequestCtx(
  auth: { collection: string; record: RepoRecord } | undefined,
  req: HttpServerRequest.HttpServerRequest
): RequestCtx {
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") headers[k] = v
  }
  const queryStr = req.url.includes("?") ? req.url.split("?")[1] : ""
  const sp = new URLSearchParams(queryStr)
  const query: Record<string, string | ReadonlyArray<string>> = {}
  for (const [k, v] of sp) {
    const existing = query[k]
    if (existing === undefined) {
      query[k] = v
    } else {
      const arr: Array<string> = []
      arr.push(v)
      if (typeof existing === "string") {
        arr.unshift(existing)
      } else {
        arr.unshift(...existing)
      }
      query[k] = arr
    }
  }
  return auth ? { auth, headers, query } : { headers, query }
}

function extractToken(req: HttpServerRequest.HttpServerRequest) {
  const auth = req.headers["authorization"]
  if (typeof auth === "string") {
    const m = auth.match(/^Bearer\s+(.+)$/i)
    if (m !== null) return m[1]
  }
  return req.cookies["mira_token"] ?? null
}

function getBody(req: HttpServerRequest.HttpServerRequest, collection: AnyCollectionDef) {
  const ct = req.headers["content-type"] ?? ""
  if (ct.includes("multipart/form-data")) {
    return processMultipartUpload(req, collection.schema, collection.name).pipe(
      Effect.withSpan("http.body.parse", { kind: "internal", attributes: { content_type: "multipart" } })
    )
  }
  return Effect.gen(function* () {
    const parsed = yield* req.json.pipe(
      Effect.mapError(
        (e) =>
          new ValidationError({
            collection: collection.name,
            issues: [`Invalid JSON body: ${e.message}`]
          })
      )
    )
    const result: RepoRecord = {}
    if (typeof parsed === "object" && parsed !== null) {
      for (const [k, v] of Object.entries(parsed)) {
        result[k] = v
      }
    }
    return result
  }).pipe(Effect.withSpan("http.body.parse", { kind: "internal", attributes: { content_type: "json" } }))
}

export function makeCollectionRouter(collections: ReadonlyArray<AnyCollectionDef>) {
  const collectionMap = new Map(collections.map((c) => [c.name, c]))

  function collectionRoute(
    operation: string,
    body: (
      col: AnyCollectionDef,
      ctx: RequestCtx,
      req: HttpServerRequest.HttpServerRequest,
      params: Readonly<Record<string, string | undefined>>
    ) => Effect.Effect<HttpServerResponse.HttpServerResponse, HttpServerResponse.HttpServerResponse, Ms>
  ) {
    return Effect.flatMap(HttpRouter.params, (params) => {
      const name = params["name"]
      if (name === undefined) {
        return Effect.succeed(
          HttpServerResponse.jsonUnsafe({ error: "not_found", message: "Missing collection" }, { status: 404 })
        )
      }
      const col = collectionMap.get(name)
      if (col === undefined) {
        return Effect.succeed(
          HttpServerResponse.jsonUnsafe(
            { error: "not_found", message: `Unknown collection "${name}"` },
            { status: 404 }
          )
        )
      }
      return Effect.flatMap(HttpServerRequest.HttpServerRequest, (req) =>
        Effect.gen(function* () {
          const auth = yield* resolveAuth(req)
          const ctx = buildRequestCtx(auth ?? undefined, req)
          yield* Effect.currentSpan.pipe(
            Effect.tap((span: Tracer.Span) =>
              Effect.sync(() => {
                span.attribute("auth.result", auth !== undefined ? "authenticated" : "anonymous")
                span.attribute("auth.collection", auth?.collection ?? "")
                const parent = span.parent
                if (Option.isSome(parent) && parent.value._tag === "Span") {
                  parent.value.attribute("auth.collection", auth?.collection ?? "")
                }
              })
            ),
            Effect.ignore
          )
          return yield* Effect.catchCause(body(col, ctx, req, params), (cause) => {
            const failure = Cause.findErrorOption(cause)
            if (Option.isSome(failure)) {
              return Effect.succeed(failure.value)
            }
            return Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "internal" }, { status: 500 }))
          })
        }).pipe(
          Effect.withSpan("http.handler", {
            kind: "server",
            attributes: { collection: col.name, operation }
          })
        )
      )
    })
  }

  function resolveAuth(req: HttpServerRequest.HttpServerRequest) {
    const token = extractToken(req)

    return Effect.gen(function* () {
      const annotate = (key: string, value: string | boolean) =>
        Effect.currentSpan.pipe(
          Effect.tap((span: Tracer.Span) => Effect.sync(() => span.attribute(key, value))),
          Effect.ignore
        )

      if (token === null) {
        yield* annotate("auth.result", "anonymous")
        return yield* Effect.void
      }
      const config = yield* AppConfig
      const jwtSecret = Redacted.value(config.jwtSecret)
      const payload = yield* verifyJwt(token, jwtSecret).pipe(Effect.orElseSucceed(() => undefined))
      if (payload === undefined) {
        yield* annotate("auth.result", "invalid_token")
        return undefined
      }
      const targetCol = collectionMap.get(payload.col)
      if (targetCol === undefined || targetCol.schema["x-collection-kind"] !== "auth") {
        yield* annotate("auth.result", "invalid_token")
        return undefined
      }
      const repo = yield* Repository
      const rows = yield* repo
        .viewFilter(payload.col, { where: { sql: "t.id = ?", params: [payload.sub] } })
        .pipe(Effect.orElseSucceed(() => []))
      if (rows.length === 0) {
        yield* annotate("auth.result", "invalid_token")
        return undefined
      }
      yield* annotate("auth.result", "authenticated")
      yield* annotate("auth.collection", payload.col)
      return { collection: payload.col, record: rows[0] }
    }).pipe(Effect.withSpan("http.auth", { kind: "internal" }))
  }

  const listRoute = collectionRoute("list", (col, ctx) =>
    Effect.gen(function* () {
      const svc = yield* CollectionService
      const filter = yield* parseFilterParam(ctx.query, col.schema, col.name).pipe(catchCollectionErrors)
      const sort = parseSortParam(ctx.query, col.schema)
      const { cursor, limit } = parsePaginationParam(ctx.query)
      const select = parseSelectParam(ctx.query)
      const expand = parseExpandParam(ctx.query)
      const list = yield* svc
        .list(col, cursor, limit, ctx, filter ?? undefined, sort ?? undefined, select, expand)
        .pipe(catchCollectionErrors)
      return HttpServerResponse.jsonUnsafe(list, { status: 200 })
    })
  )

  const createRoute = collectionRoute("create", (col, ctx, req) =>
    Effect.gen(function* () {
      const body = yield* getBody(req, col).pipe(catchCollectionErrors)
      const svc = yield* CollectionService
      const record = yield* svc.create(col, body, ctx).pipe(catchCollectionErrors)
      return HttpServerResponse.jsonUnsafe(record, { status: 201 })
    })
  )

  const viewRoute = collectionRoute("view", (col, ctx, _req, params) => {
    const id = params["id"]
    if (id === undefined) {
      return Effect.succeed(
        HttpServerResponse.jsonUnsafe({ error: "not_found", message: "Missing id" }, { status: 404 })
      )
    }
    const select = parseSelectParam(ctx.query)
    const expand = parseExpandParam(ctx.query)
    return Effect.gen(function* () {
      const svc = yield* CollectionService
      const record = yield* svc.view(col, id, ctx, select, expand).pipe(catchCollectionErrors)
      return HttpServerResponse.jsonUnsafe(record, { status: 200 })
    })
  })

  const updateRoute = collectionRoute("update", (col, ctx, req, params) => {
    const id = params["id"]
    if (id === undefined) {
      return Effect.succeed(
        HttpServerResponse.jsonUnsafe({ error: "not_found", message: "Missing id" }, { status: 404 })
      )
    }
    return Effect.gen(function* () {
      const body = yield* getBody(req, col).pipe(catchCollectionErrors)
      const svc = yield* CollectionService
      const record = yield* svc.update(col, id, body, ctx).pipe(catchCollectionErrors)
      return HttpServerResponse.jsonUnsafe(record, { status: 200 })
    })
  })

  const deleteRoute = collectionRoute("delete", (col, ctx, _req, params) => {
    const id = params["id"]
    if (id === undefined) {
      return Effect.succeed(
        HttpServerResponse.jsonUnsafe({ error: "not_found", message: "Missing id" }, { status: 404 })
      )
    }
    return Effect.gen(function* () {
      const svc = yield* CollectionService
      yield* svc.delete(col, id, ctx).pipe(catchCollectionErrors)
      return HttpServerResponse.empty({ status: 204 })
    })
  })

  const authRoute = collectionRoute("auth", (col, _ctx, req) =>
    Effect.gen(function* () {
      if (col.schema["x-collection-kind"] !== "auth") {
        return HttpServerResponse.jsonUnsafe({ error: "read_only" }, { status: 405 })
      }
      const { email, password } = yield* req.json.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(AuthBodySchema)),
        Effect.mapError(() =>
          HttpServerResponse.jsonUnsafe(
            { error: "validation_failed", issues: ["email and password are required"] },
            { status: 422 }
          )
        )
      )
      const repo = yield* Repository
      const rows = yield* repo
        .viewFilter(col.name, { where: { sql: "t.email = ?", params: [email] } })
        .pipe(Effect.orElseSucceed(() => []))
      if (rows.length === 0) {
        return HttpServerResponse.jsonUnsafe({ error: "forbidden" }, { status: 403 })
      }
      const fullRow = rows[0]
      const storedHash = fullRow["password"]
      if (typeof storedHash !== "string") {
        return HttpServerResponse.jsonUnsafe({ error: "forbidden" }, { status: 403 })
      }
      const rid = fullRow["id"]
      if (typeof rid !== "string") {
        return HttpServerResponse.jsonUnsafe({ error: "forbidden" }, { status: 403 })
      }
      const valid = yield* verifyPassword(password, storedHash).pipe(Effect.orElseSucceed(() => false))
      if (!valid) {
        return HttpServerResponse.jsonUnsafe({ error: "forbidden" }, { status: 403 })
      }
      const config = yield* AppConfig
      const jwtSecret = Redacted.value(config.jwtSecret)
      const token = yield* signJwt({ sub: rid, col: col.name }, jwtSecret).pipe(
        Effect.mapError(() => HttpServerResponse.jsonUnsafe({ error: "internal" }, { status: 500 }))
      )
      const dialect = yield* Dialect
      const decode = makeRowDecoder(col.schema, dialect.storesBooleanAsInteger)
      const decodedRow = yield* decode(fullRow)
      const publicRow = Object.fromEntries(
        Object.entries(decodedRow).filter(([k]) => {
          const prop = col.schema.properties[k]
          return prop !== undefined && !prop["x-hidden"] && k !== "password"
        })
      )
      return HttpServerResponse.jsonUnsafe({ token, record: publicRow }, { status: 200 }).pipe(
        HttpServerResponse.setCookieUnsafe("mira_token", token, {
          httpOnly: true,
          sameSite: "strict",
          path: "/",
          maxAge: Duration.hours(72),
        })
      )
    })
  )

  const logoutRoute = Effect.succeed(
    HttpServerResponse.empty({ status: 204 }).pipe(
      HttpServerResponse.setCookieUnsafe("mira_token", "", {
        httpOnly: true,
        sameSite: "strict",
        path: "/",
        maxAge: Duration.zero,
      })
    )
  )

  const meRoute = Effect.flatMap(HttpServerRequest.HttpServerRequest, (req) =>
    Effect.gen(function* () {
      const auth = yield* resolveAuth(req)
      yield* Effect.currentSpan.pipe(
        Effect.tap((span: Tracer.Span) =>
          Effect.sync(() => {
            span.attribute("auth.result", auth !== undefined ? "authenticated" : "anonymous")
            span.attribute("auth.collection", auth?.collection ?? "")
            const parent = span.parent
            if (Option.isSome(parent) && parent.value._tag === "Span") {
              parent.value.attribute("auth.collection", auth?.collection ?? "")
            }
          })
        ),
        Effect.ignore
      )
      if (!auth) {
        return HttpServerResponse.jsonUnsafe({ error: "unauthorized" }, { status: 401 })
      }
      // `auth.record` is the full stored row (used as `ctx.auth` for rule
      // placeholders). Strip hidden fields before serialising it to the client
      // so credentials like `password` never leave the server.
      const meCollection = collectionMap.get(auth.collection)
      const publicRecord: RepoRecord = {}
      for (const [k, v] of Object.entries(auth.record)) {
        if (meCollection?.schema.properties[k]?.["x-hidden"] === true) continue
        publicRecord[k] = v
      }
      return HttpServerResponse.jsonUnsafe(
        { collection: auth.collection, record: publicRecord },
        { status: 200 }
      )
    }).pipe(Effect.withSpan("http.handler", { kind: "server", attributes: { operation: "me" } }))
  )

  const fileServeRoute = makeFileServeRoute(collections)
  const fileTokenRoute = makeFileTokenRoute(collections)
  const schemaRoute = requireApiAuth("schema", makeSchemaRoute(collections))

  function requireApiAuth<E, R>(operation: string, effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) {
    return Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest
      const token = extractToken(req)

      const annotate = (key: string, value: string) =>
        Effect.currentSpan.pipe(
          Effect.tap((span: Tracer.Span) => Effect.sync(() => span.attribute(key, value))),
          Effect.ignore
        )

      const authCol = yield* Effect.gen(function* () {
        if (token === null) {
          yield* annotate("auth.result", "anonymous")
          return null
        }

        const config = yield* AppConfig
        const jwtSecret = Redacted.value(config.jwtSecret)
        const result = yield* verifyAnyJwt(token, jwtSecret).pipe(Effect.orElseSucceed(() => undefined))

        if (result === undefined) {
          yield* annotate("auth.result", "invalid_token")
          return null
        }

        yield* annotate("auth.result", "authenticated")

        const col = result.payload["col"]
        if (typeof col === "string") {
          yield* annotate("auth.collection", col)
        }

        return typeof col === "string" ? col : ""
      }).pipe(Effect.withSpan("http.auth", { kind: "internal" }))

      if (authCol !== null) {
        yield* Effect.currentSpan.pipe(
          Effect.tap((span) =>
            Effect.sync(() => {
              span.attribute("auth.collection", authCol)
              const parent = span.parent
              if (Option.isSome(parent) && parent.value._tag === "Span") {
                parent.value.attribute("auth.collection", authCol)
              }
            })
          ),
          Effect.ignore
        )
      }

      if (authCol === null) {
        return HttpServerResponse.jsonUnsafe({ error: "unauthorized" }, { status: 401 })
      }
      return yield* effect.pipe(
        Effect.catch(() => Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "internal" }, { status: 500 })))
      )
    }).pipe(Effect.withSpan("http.handler", { kind: "server", attributes: { operation } }))
  }

  const telemetryLogs = requireApiAuth("telemetry_logs", telemetryLogsRoute)
  const telemetrySpans = requireApiAuth("telemetry_spans", telemetrySpansRoute)

  return [
    HttpRouter.route("GET", "/api/collections/:name", listRoute),
    HttpRouter.route("POST", "/api/collections/:name", createRoute),
    HttpRouter.route("GET", "/api/collections/:name/:id", viewRoute),
    HttpRouter.route("PATCH", "/api/collections/:name/:id", updateRoute),
    HttpRouter.route("DELETE", "/api/collections/:name/:id", deleteRoute),
    HttpRouter.route("POST", "/api/collections/:name/auth-with-password", authRoute),
    HttpRouter.route("POST", "/api/auth/logout", logoutRoute),
    HttpRouter.route("GET", "/api/auth/me", meRoute),
    HttpRouter.route("GET", "/api/files/:collection/:id/:filename", fileServeRoute),
    HttpRouter.route("POST", "/api/files/token", fileTokenRoute),
    HttpRouter.route("GET", "/api/_schema", schemaRoute),
    HttpRouter.route("GET", "/api/_telemetry/logs", telemetryLogs),
    HttpRouter.route("GET", "/api/_telemetry/spans", telemetrySpans)
  ]
}
