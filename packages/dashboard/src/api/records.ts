import { Effect, Option } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { Repository } from "@gettersethya/mira"
import type { AnyCollectionDef } from "@gettersethya/mira-client"
import { requireDashboardAuth } from "./auth.js"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function makeRecordsProxyRoute(
  collections: ReadonlyArray<AnyCollectionDef>,
  action: "list" | "create" | "view" | "update" | "delete"
) {
  const collectionNames = new Set(collections.map((c) => c.name))

  return Effect.flatMap(HttpRouter.RouteContext, (routeCtx) =>
    Effect.gen(function* () {
      yield* requireDashboardAuth

      const name = routeCtx.params["name"]
      const id = routeCtx.params["id"]

      if (name === undefined || !collectionNames.has(name)) {
        return HttpServerResponse.unsafeJson(
          { error: "not_found", message: `Unknown collection "${name ?? ""}"` },
          { status: 404 }
        )
      }

      const repo = yield* Repository

      switch (action) {
        case "list": {
          const req = yield* HttpServerRequest.HttpServerRequest
          const url = new URL(req.url, "http://localhost")
          const limit = Math.min(Number(url.searchParams.get("limit") ?? "50"), 500)
          const cursorParam = url.searchParams.get("after")
          const cursorWhere =
            cursorParam !== null ? { where: { sql: `t."seqId" > ?`, params: [Number(cursorParam)] } } : undefined
          const result = yield* repo.list(name, limit, cursorWhere).pipe(Effect.orElseSucceed(() => ({ items: [] })))
          return HttpServerResponse.unsafeJson(result, { status: 200 })
        }
        case "create": {
          const req = yield* HttpServerRequest.HttpServerRequest
          const parsed = yield* req.json.pipe(Effect.orElseSucceed(() => null))
          if (!isRecord(parsed)) {
            return HttpServerResponse.unsafeJson({ error: "invalid_body" }, { status: 400 })
          }
          const record = yield* repo.create(name, parsed).pipe(Effect.catchAll(() => Effect.succeed(null)))
          if (record === null) {
            return HttpServerResponse.unsafeJson({ error: "create_failed" }, { status: 500 })
          }
          return HttpServerResponse.unsafeJson(record, { status: 201 })
        }
        case "view": {
          if (id === undefined) {
            return HttpServerResponse.unsafeJson({ error: "not_found", message: "Missing id" }, { status: 404 })
          }
          const opt = yield* repo.view(name, id).pipe(Effect.catchAll(() => Effect.succeed(Option.none())))
          if (Option.isNone(opt)) {
            return HttpServerResponse.unsafeJson({ error: "not_found" }, { status: 404 })
          }
          return HttpServerResponse.unsafeJson(opt.value, { status: 200 })
        }
        case "update": {
          if (id === undefined) {
            return HttpServerResponse.unsafeJson({ error: "not_found", message: "Missing id" }, { status: 404 })
          }
          const req = yield* HttpServerRequest.HttpServerRequest
          const parsed = yield* req.json.pipe(Effect.orElseSucceed(() => null))
          if (!isRecord(parsed)) {
            return HttpServerResponse.unsafeJson({ error: "invalid_body" }, { status: 400 })
          }
          const opt = yield* repo.update(name, id, parsed).pipe(Effect.catchAll(() => Effect.succeed(Option.none())))
          if (Option.isNone(opt)) {
            return HttpServerResponse.unsafeJson({ error: "not_found" }, { status: 404 })
          }
          return HttpServerResponse.unsafeJson(opt.value, { status: 200 })
        }
        case "delete": {
          if (id === undefined) {
            return HttpServerResponse.unsafeJson({ error: "not_found", message: "Missing id" }, { status: 404 })
          }
          const opt = yield* repo.delete(name, id).pipe(Effect.catchAll(() => Effect.succeed(Option.none())))
          if (Option.isNone(opt)) {
            return HttpServerResponse.unsafeJson({ error: "not_found" }, { status: 404 })
          }
          return HttpServerResponse.empty({ status: 204 })
        }
      }
    })
  )
}
