import { HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { FileSystem, Path } from "@effect/platform"
import { Cause, Effect, Option } from "effect"
import type { AnyCollectionDef } from "@gettersethya/mira-client"
import type { Repository, AuthService, AppConfig, CollectionService } from "@gettersethya/mira"
import { bootstrapStatusRoute } from "./api/bootstrap-status.js"
import { registerRoute } from "./api/register.js"
import { createSuperadminRoute, listSuperadminsRoute, deleteSuperadminRoute } from "./api/superadmin.js"
import { configRoute } from "./api/config.js"
import { loginRoute } from "./api/login.js"
import { DashboardUnauthorizedError } from "./api/auth.js"

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

function wrapRoute<E, R>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, R> {
  return Effect.catchAllCause(effect, (cause) => {
    const failure = Cause.failureOption(cause)
    if (Option.isSome(failure)) {
      if (failure.value instanceof DashboardUnauthorizedError) {
        return Effect.succeed(HttpServerResponse.unsafeJson({ error: "unauthorized" }, { status: 401 }))
      }
      return Effect.succeed(HttpServerResponse.unsafeJson({ error: "bad_request" }, { status: 400 }))
    }
    return Effect.succeed(HttpServerResponse.unsafeJson({ error: "internal" }, { status: 500 }))
  })
}

function makeDashboardSpaRoute(): HttpRouter.HttpRouter<never, FileSystem.FileSystem | Path.Path> {
  const spaHandler = wrapRoute(
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

  return HttpRouter.empty.pipe(HttpRouter.get("/_dashboard", spaHandler), HttpRouter.get("/_dashboard/*", spaHandler))
}

type DashboardRouterServices =
  | FileSystem.FileSystem
  | Path.Path
  | Repository
  | AuthService
  | AppConfig
  | CollectionService

export function makeDashboardRouter(
  _collections: ReadonlyArray<AnyCollectionDef>
): HttpRouter.HttpRouter<never, DashboardRouterServices> {
  return HttpRouter.empty.pipe(
    HttpRouter.get("/_dashboard/api/bootstrap-status", wrapRoute(bootstrapStatusRoute)),
    HttpRouter.post("/_dashboard/api/register", wrapRoute(registerRoute)),
    HttpRouter.post("/_dashboard/api/login", wrapRoute(loginRoute)),
    HttpRouter.post("/_dashboard/api/superadmin/create", wrapRoute(createSuperadminRoute)),
    HttpRouter.get("/_dashboard/api/superadmin", wrapRoute(listSuperadminsRoute)),
    HttpRouter.del("/_dashboard/api/superadmin/:id", wrapRoute(deleteSuperadminRoute)),
    HttpRouter.get("/_dashboard/api/config", wrapRoute(configRoute)),
    HttpRouter.concat(makeDashboardSpaRoute())
  )
}
