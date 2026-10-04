import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { FileSystem, Path } from "effect"
import type { AppConfig, CollectionService, CronService } from "@gettersethya/mira"
import { Cause, Effect, Option, Tracer } from "effect"
import type { AnyCollectionDef } from "@gettersethya/mira-client"
import { bootstrapStatusRoute } from "./api/bootstrap-status.js"
import { registerRoute } from "./api/register.js"
import { createSuperadminRoute, listSuperadminsRoute, deleteSuperadminRoute } from "./api/superadmin.js"
import { configRoute } from "./api/config.js"
import { cronsRoute, cronRunNowRoute } from "./api/crons.js"
import { DashboardUnauthorizedError, requireDashboardAuth } from "./api/auth.js"

function makeContentType(ext: string): string {
  const types: Record<string, string> = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2"
  }
  return types[ext] ?? "application/octet-stream"
}

function wrapRoute<E, R>(operation: string, effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) {
  return Effect.catchCause(effect, (cause) => {
    const failure = Cause.findErrorOption(cause)
    if (Option.isSome(failure)) {
      if (failure.value instanceof DashboardUnauthorizedError) {
        return Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "unauthorized" }, { status: 401 }))
      }
      return Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "bad_request" }, { status: 400 }))
    }
    return Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "internal" }, { status: 500 }))
  }).pipe(Effect.withSpan("http.handler", { kind: "server", attributes: { operation } }))
}

function wrapAuthRoute<E, R>(operation: string, effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) {
  return Effect.gen(function* () {
    const authResult = yield* requireDashboardAuth.pipe(
      Effect.catchTag("DashboardUnauthorizedError", () => Effect.succeed(null))
    )

    if (authResult === null) {
      return HttpServerResponse.jsonUnsafe({ error: "unauthorized" }, { status: 401 })
    }

    yield* Effect.currentSpan.pipe(
      Effect.tap((span: Tracer.Span) =>
        Effect.sync(() => {
          span.attribute("auth.collection", authResult.col)
          const parent = span.parent
          if (Option.isSome(parent) && parent.value._tag === "Span") {
            parent.value.attribute("auth.collection", authResult.col)
          }
        })
      ),
      Effect.ignore
    )

    return yield* Effect.catchCause(effect, (cause) => {
      const failure = Cause.findErrorOption(cause)
      if (Option.isSome(failure)) {
        return Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "bad_request" }, { status: 400 }))
      }
      return Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "internal" }, { status: 500 }))
    })
  }).pipe(Effect.withSpan("http.handler", { kind: "server", attributes: { operation } }))
}

function makeDashboardSpaRoute() {
  const spaHandler = wrapRoute("dashboard_spa",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const req = yield* HttpServerRequest.HttpServerRequest

      const modulePath = yield* path.fromFileUrl(new URL(import.meta.url))
      const distDir = path.join(path.dirname(modulePath), "../../ui/dist")

      const urlPath = req.url.split("?")[0]
      const stripped = urlPath.replace("/_dashboard", "").replace(/^\/+/, "")
      const filePath = stripped || "index.html"

      const fullPath = path.join(distDir, filePath)
      const exists = yield* fs.exists(fullPath)

      if (!exists) {
        const indexPath = path.join(distDir, "index.html")
        const content = yield* fs.readFile(indexPath)
        return HttpServerResponse.html(content.toString())
      }

      const content = yield* fs.readFile(fullPath)
      const ext = path.extname(fullPath)
      const contentType = makeContentType(ext)

      return HttpServerResponse.raw(content, {
        headers: { "content-type": contentType }
      })
    })
  )

  return [
    HttpRouter.route("GET", "/_dashboard/*", spaHandler)
  ]
}

type DashboardRouteServices =
  | FileSystem.FileSystem
  | Path.Path
  | CollectionService
  | AppConfig
  | CronService

export function makeDashboardRouter(
  _collections: ReadonlyArray<AnyCollectionDef>
): ReadonlyArray<HttpRouter.Route<never, DashboardRouteServices>> {
  return [
    ...makeDashboardSpaRoute(),
    HttpRouter.route("GET", "/_dashboard/api/bootstrap-status", wrapRoute("bootstrap_status", bootstrapStatusRoute)),
    HttpRouter.route("POST", "/_dashboard/api/register", wrapRoute("register", registerRoute)),
    HttpRouter.route("POST", "/_dashboard/api/superadmin/create", wrapAuthRoute("superadmin_create", createSuperadminRoute)),
    HttpRouter.route("GET", "/_dashboard/api/superadmin", wrapAuthRoute("superadmin_list", listSuperadminsRoute)),
    HttpRouter.route("DELETE", "/_dashboard/api/superadmin/:id", wrapAuthRoute("superadmin_delete", deleteSuperadminRoute)),
    HttpRouter.route("GET", "/_dashboard/api/config", wrapAuthRoute("config", configRoute)),
    HttpRouter.route("GET", "/_dashboard/api/crons", wrapAuthRoute("crons_list", cronsRoute)),
    HttpRouter.route("POST", "/_dashboard/api/crons/:name/run", wrapAuthRoute("crons_run", cronRunNowRoute))
  ]
}
