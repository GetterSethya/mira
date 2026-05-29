import { HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { Chunk, Effect, Redacted, Stream } from "effect"
import type { AnyCollectionDef } from "@gettersethya/mira-client"
import { andWhere, idClause, resolveCtxPlaceholders } from "@/collection-service/where.js"
import type { RequestCtx } from "@/collection-service/context.js"
import { Repository } from "@/repository/repository.js"
import { FileStorage } from "@/storage/storage.js"
import { ThumbnailService, parseThumbSpec } from "@/thumbnail/types.js"
import { AppConfig } from "@/config/index.js"
import { enforcerForAction } from "@/rule/enforcer.js"
import { verifyFileToken } from "./auth.js"

export type FileServeServices = Repository | FileStorage | ThumbnailService | AppConfig

const MIME_MAP: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  txt: "text/plain",
  html: "text/html",
  css: "text/css",
  js: "application/javascript",
  json: "application/json",
  mp4: "video/mp4",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  bin: "application/octet-stream"
}

function mimeFromKey(key: string): string {
  const ext = key.split(".").pop()?.toLowerCase() ?? ""
  return MIME_MAP[ext] ?? "application/octet-stream"
}

function getQueryParam(
  req: HttpServerRequest.HttpServerRequest,
  name: string
): string | undefined {
  const queryStr = req.url.includes("?") ? req.url.split("?")[1] : ""
  return new URLSearchParams(queryStr).get(name) ?? undefined
}

export function makeFileServeRoute(
  collections: ReadonlyArray<AnyCollectionDef>
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  FileServeServices | HttpServerRequest.HttpServerRequest | HttpRouter.RouteContext
> {
  const collectionMap = new Map(collections.map((c) => [c.name, c]))

  return Effect.flatMap(HttpRouter.RouteContext, (routeCtx) => {
    const colName = routeCtx.params["collection"]
    const recordId = routeCtx.params["id"]
    const filename = routeCtx.params["filename"]

    if (colName === undefined || recordId === undefined || filename === undefined) {
      return Effect.succeed(
        HttpServerResponse.unsafeJson({ error: "not_found" }, { status: 404 })
      )
    }
    const collection = collectionMap.get(colName)
    if (collection === undefined) {
      return Effect.succeed(
        HttpServerResponse.unsafeJson(
          { error: "not_found", message: `Unknown collection "${colName}"` },
          { status: 404 }
        )
      )
    }

    return Effect.flatMap(HttpServerRequest.HttpServerRequest, (req) =>
      Effect.catchAllCause(
        serveFile(collection, recordId, filename, req),
        () =>
          Effect.succeed(HttpServerResponse.unsafeJson({ error: "internal" }, { status: 500 }))
      )
    )
  })
}

function serveFile(
  collection: AnyCollectionDef,
  recordId: string,
  filename: string,
  req: HttpServerRequest.HttpServerRequest
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, FileServeServices> {
  return Effect.gen(function* () {
    const config = yield* AppConfig
    const jwtSecret = Redacted.value(config.jwtSecret)
    const repo = yield* Repository
    const fileStorage = yield* FileStorage
    const thumbSvc = yield* ThumbnailService

    // Step 2: fetch record directly (no rule enforcement yet)
    const rows = yield* repo
      .viewFilter(collection.name, { where: idClause(recordId) })
      .pipe(Effect.orElseSucceed(() => []))

    if (rows.length === 0) {
      return HttpServerResponse.unsafeJson({ error: "not_found" }, { status: 404 })
    }
    const record = rows[0]

    // Step 3: find the file field whose stored value equals `filename`
    let fieldName: string | undefined
    let fieldProp: (typeof collection.schema.properties)[string] | undefined
    for (const [k, prop] of Object.entries(collection.schema.properties)) {
      if (prop["x-kind"] === "file" && record[k] === filename) {
        fieldName = k
        fieldProp = prop
        break
      }
    }

    if (fieldName === undefined || fieldProp === undefined) {
      return HttpServerResponse.unsafeJson({ error: "not_found" }, { status: 404 })
    }

    // Step 4: protected field — verify token and enforce view rule
    if (fieldProp["x-protected"] === true) {
      const tokenParam = getQueryParam(req, "token")
      if (tokenParam === undefined) {
        return HttpServerResponse.unsafeJson({ error: "forbidden" }, { status: 403 })
      }

      const tokenPayload = yield* verifyFileToken(tokenParam, jwtSecret).pipe(
        Effect.orElseSucceed(() => null)
      )
      if (tokenPayload === null || tokenPayload.filecol !== collection.name) {
        return HttpServerResponse.unsafeJson({ error: "forbidden" }, { status: 403 })
      }

      // Reconstruct auth context from file token sub + col
      const authRows = yield* repo
        .viewFilter(tokenPayload.col, { where: idClause(tokenPayload.sub) })
        .pipe(Effect.orElseSucceed(() => []))

      if (authRows.length === 0) {
        return HttpServerResponse.unsafeJson({ error: "forbidden" }, { status: 403 })
      }

      const ctx: RequestCtx = {
        auth: { collection: tokenPayload.col, record: authRows[0] },
        headers: {},
        query: {}
      }

      // Enforce the collection's view rule against the specific record
      const ruleResult = enforcerForAction(collection.schema, "view")
      if (ruleResult === null) {
        return HttpServerResponse.unsafeJson({ error: "forbidden" }, { status: 403 })
      }

      const ruleWhere = yield* resolveCtxPlaceholders(
        ruleResult,
        ctx,
        collection.name,
        "view"
      ).pipe(Effect.catchTag("ForbiddenError", () => Effect.succeed(null)))

      if (ruleWhere === null) {
        return HttpServerResponse.unsafeJson({ error: "forbidden" }, { status: 403 })
      }

      const allowed = yield* repo
        .viewFilter(collection.name, { where: andWhere(ruleWhere, idClause(recordId)) })
        .pipe(Effect.orElseSucceed(() => []))

      if (allowed.length === 0) {
        return HttpServerResponse.unsafeJson({ error: "forbidden" }, { status: 403 })
      }
    }

    // Steps 5-8: derive MIME, handle thumbnail with persistent cache, serve bytes
    const mimeType = mimeFromKey(filename)
    const rawThumb = getQueryParam(req, "thumb")
    const thumbSpec = rawThumb !== undefined ? parseThumbSpec(rawThumb) : null

    let bytes: Uint8Array

    if (thumbSpec !== null && rawThumb !== undefined && thumbSvc.supported(mimeType)) {
      const cacheKey = `_thumbs/${filename}/${rawThumb}`
      const hit = yield* fileStorage.exists(cacheKey).pipe(Effect.orElseSucceed(() => false))

      if (hit) {
        bytes = yield* fileStorage.read(cacheKey).pipe(Effect.orDie)
      } else {
        const original = yield* fileStorage.read(filename).pipe(
          Effect.catchTag("FileStorageNotFound", () => Effect.succeed(null)),
          Effect.orDie
        )
        if (original === null) {
          return HttpServerResponse.unsafeJson({ error: "not_found" }, { status: 404 })
        }

        // On thumb error fall back to original rather than returning an error
        const resized = yield* thumbSvc
          .resize(original, mimeType, thumbSpec)
          .pipe(Effect.orElse(() => Effect.succeed(original)))

        // Best-effort: persist the thumbnail for future requests
        yield* fileStorage
          .upload(cacheKey, Stream.fromChunk(Chunk.of(resized)), mimeType)
          .pipe(Effect.orElse(() => Effect.void))

        bytes = resized
      }
    } else {
      const result = yield* fileStorage.read(filename).pipe(
        Effect.catchTag("FileStorageNotFound", () => Effect.succeed(null)),
        Effect.orDie
      )
      if (result === null) {
        return HttpServerResponse.unsafeJson({ error: "not_found" }, { status: 404 })
      }
      bytes = result
    }

    return HttpServerResponse.uint8Array(bytes, {
      status: 200,
      headers: { "content-type": mimeType }
    })
  }).pipe(Effect.orDie)
}
