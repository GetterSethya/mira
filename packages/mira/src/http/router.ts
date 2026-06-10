import { HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { Cause, Effect, Option, Redacted, Schema, Tracer } from "effect"
import type { AnyCollectionDef } from "@gettersethya/mira-client"
import { CollectionService } from "@/collection-service/collection-service.js"
import type { RequestCtx } from "@/collection-service/context.js"
import { ValidationError } from "@/collection-service/errors.js"
import { Repository } from "@/repository/repository.js"
import type { RepoRecord } from "@/repository/types.js"
import { FileStorage } from "@/storage/storage.js"
import { ThumbnailService } from "@/thumbnail/types.js"
import { AppConfig } from "@/config/index.js"
import { CryptoService } from "@/crypto/index.js"
import { AuthService, signJwt, verifyAnyJwt, verifyJwt, verifyPassword } from "./auth.js"
import { makeRowDecoder } from "@/collection-service/decode.js"
import { catchCollectionErrors } from "./errors.js"
import { parseExpandParam, parseFilterParam, parsePaginationParam, parseSelectParam, parseSortParam } from "./params.js"
import { processMultipartUpload } from "./files.js"
import { makeFileServeRoute } from "./file-serve.js"
import { makeFileTokenRoute } from "./file-token.js"
import { makeSchemaRoute } from "./schema.js"
import { telemetryLogsRoute, telemetrySpansRoute } from "./telemetry-routes.js"

type Ms = CollectionService | Repository | FileStorage | ThumbnailService | AppConfig | AuthService | CryptoService

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

function extractBearerToken(req: HttpServerRequest.HttpServerRequest) {
  const auth = req.headers["authorization"]
  if (typeof auth !== "string") return null
  const m = auth.match(/^Bearer\s+(.+)$/i)
  if (m === null) return null
  return m[1]
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
  const decoderMap = new Map(collections.map((c) => [c.name, makeRowDecoder(c.schema)]))

  function collectionRoute(
    operation: string,
    body: (
      col: AnyCollectionDef,
      ctx: RequestCtx,
      req: HttpServerRequest.HttpServerRequest,
      routeCtx: HttpRouter.RouteContext
    ) => Effect.Effect<HttpServerResponse.HttpServerResponse, HttpServerResponse.HttpServerResponse, Ms>
  ) {
    return Effect.flatMap(HttpRouter.RouteContext, (routeCtx) => {
      const name = routeCtx.params["name"]
      if (name === undefined) {
        return Effect.succeed(
          HttpServerResponse.unsafeJson({ error: "not_found", message: "Missing collection" }, { status: 404 })
        )
      }
      const col = collectionMap.get(name)
      if (col === undefined) {
        return Effect.succeed(
          HttpServerResponse.unsafeJson(
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
          return yield* Effect.catchAllCause(body(col, ctx, req, routeCtx), (cause) => {
            const failure = Cause.failureOption(cause)
            if (Option.isSome(failure)) {
              return Effect.succeed(failure.value)
            }
            return Effect.succeed(HttpServerResponse.unsafeJson({ error: "internal" }, { status: 500 }))
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
    const token = extractBearerToken(req)

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
      return HttpServerResponse.unsafeJson(list, { status: 200 })
    })
  )

  const createRoute = collectionRoute("create", (col, ctx, req) =>
    Effect.gen(function* () {
      const body = yield* getBody(req, col).pipe(catchCollectionErrors)
      const svc = yield* CollectionService
      const record = yield* svc.create(col, body, ctx).pipe(catchCollectionErrors)
      return HttpServerResponse.unsafeJson(record, { status: 201 })
    })
  )

  const viewRoute = collectionRoute("view", (col, ctx, _req, routeCtx) => {
    const id = routeCtx.params["id"]
    if (id === undefined) {
      return Effect.succeed(
        HttpServerResponse.unsafeJson({ error: "not_found", message: "Missing id" }, { status: 404 })
      )
    }
    const select = parseSelectParam(ctx.query)
    const expand = parseExpandParam(ctx.query)
    return Effect.gen(function* () {
      const svc = yield* CollectionService
      const record = yield* svc.view(col, id, ctx, select, expand).pipe(catchCollectionErrors)
      return HttpServerResponse.unsafeJson(record, { status: 200 })
    })
  })

  const updateRoute = collectionRoute("update", (col, ctx, req, routeCtx) => {
    const id = routeCtx.params["id"]
    if (id === undefined) {
      return Effect.succeed(
        HttpServerResponse.unsafeJson({ error: "not_found", message: "Missing id" }, { status: 404 })
      )
    }
    return Effect.gen(function* () {
      const body = yield* getBody(req, col).pipe(catchCollectionErrors)
      const svc = yield* CollectionService
      const record = yield* svc.update(col, id, body, ctx).pipe(catchCollectionErrors)
      return HttpServerResponse.unsafeJson(record, { status: 200 })
    })
  })

  const deleteRoute = collectionRoute("delete", (col, ctx, _req, routeCtx) => {
    const id = routeCtx.params["id"]
    if (id === undefined) {
      return Effect.succeed(
        HttpServerResponse.unsafeJson({ error: "not_found", message: "Missing id" }, { status: 404 })
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
        return HttpServerResponse.unsafeJson({ error: "read_only" }, { status: 405 })
      }
      const { email, password } = yield* req.json.pipe(
        Effect.flatMap(Schema.decodeUnknown(AuthBodySchema)),
        Effect.mapError(() =>
          HttpServerResponse.unsafeJson(
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
        return HttpServerResponse.unsafeJson({ error: "forbidden" }, { status: 403 })
      }
      const fullRow = rows[0]
      const storedHash = fullRow["password"]
      if (typeof storedHash !== "string") {
        return HttpServerResponse.unsafeJson({ error: "forbidden" }, { status: 403 })
      }
      const rid = fullRow["id"]
      if (typeof rid !== "string") {
        return HttpServerResponse.unsafeJson({ error: "forbidden" }, { status: 403 })
      }
      const valid = yield* verifyPassword(password, storedHash).pipe(Effect.orElseSucceed(() => false))
      if (!valid) {
        return HttpServerResponse.unsafeJson({ error: "forbidden" }, { status: 403 })
      }
      const config = yield* AppConfig
      const jwtSecret = Redacted.value(config.jwtSecret)
      const token = yield* signJwt({ sub: rid, col: col.name }, jwtSecret).pipe(
        Effect.mapError(() => HttpServerResponse.unsafeJson({ error: "internal" }, { status: 500 }))
      )
      const decode = decoderMap.get(col.name) ?? Effect.succeed
      const decodedRow = yield* decode(fullRow)
      const publicRow = Object.fromEntries(
        Object.entries(decodedRow).filter(([k]) => {
          const prop = col.schema.properties[k]
          return prop !== undefined && !prop["x-hidden"] && k !== "password"
        })
      )
      return HttpServerResponse.unsafeJson({ token, record: publicRow }, { status: 200 })
    })
  )

  const fileServeRoute = makeFileServeRoute(collections)
  const fileTokenRoute = makeFileTokenRoute(collections)
  const schemaRoute = requireApiAuth("schema", makeSchemaRoute(collections))

  function requireApiAuth<E, R>(operation: string, effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) {
    return Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest
      const token = extractBearerToken(req)

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
        return HttpServerResponse.unsafeJson({ error: "unauthorized" }, { status: 401 })
      }
      return yield* effect.pipe(
        Effect.catchAll(() => Effect.succeed(HttpServerResponse.unsafeJson({ error: "internal" }, { status: 500 })))
      )
    }).pipe(Effect.withSpan("http.handler", { kind: "server", attributes: { operation } }))
  }

  const telemetryLogs = requireApiAuth("telemetry_logs", telemetryLogsRoute)
  const telemetrySpans = requireApiAuth("telemetry_spans", telemetrySpansRoute)

  return HttpRouter.empty.pipe(
    HttpRouter.get("/api/collections/:name", listRoute),
    HttpRouter.post("/api/collections/:name", createRoute),
    HttpRouter.get("/api/collections/:name/:id", viewRoute),
    HttpRouter.patch("/api/collections/:name/:id", updateRoute),
    HttpRouter.del("/api/collections/:name/:id", deleteRoute),
    HttpRouter.post("/api/collections/:name/auth-with-password", authRoute),
    HttpRouter.get("/api/files/:collection/:id/:filename", fileServeRoute),
    HttpRouter.post("/api/files/token", fileTokenRoute),
    HttpRouter.get("/api/_schema", schemaRoute),
    HttpRouter.get("/api/_telemetry/logs", telemetryLogs),
    HttpRouter.get("/api/_telemetry/spans", telemetrySpans)
  )
}
