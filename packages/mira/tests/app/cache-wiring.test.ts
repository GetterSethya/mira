import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, it } from "@effect/vitest"
import { BaseCollection, Field } from "@gettersethya/mira-client"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { expect } from "vitest"

import { Mira } from "@/app/index.js"
import type { MiraCacheConfig } from "@/cache/index.js"
import { CollectionService } from "@/collection-service/collection-service.js"
import type { RequestCtx } from "@/collection-service/context.js"
import { SqliteDatabase } from "@/databases/sqlite.js"
import { NodePlatform } from "@/platforms/node.js"
import { LocalFileStorage } from "@/storage/local-preset.js"

const Posts = BaseCollection.define("posts", {
  title: Field.text({ required: true })
})

const adminCtx: RequestCtx = { headers: {}, query: {}, admin: true }

const EXTERNAL_ROW = {
  id: "external-1",
  title: "inserted behind the service",
  created: "2024-01-01T00:00:00.000Z",
  updated: "2024-01-01T00:00:00.000Z"
}

/**
 * Calls `list` twice against a real app service layer, inserting a row directly
 * through SQL between the calls (so no cache invalidation runs). A cached
 * service replays the first page; an uncached one sees the new row.
 */
const listPageLengths = (options?: MiraCacheConfig) => {
  const dir = mkdtempSync(join(tmpdir(), "mira-cache-wiring-"))
  const builder = Mira.builder()
    .platform(NodePlatform)
    .database(SqliteDatabase({ filename: join(dir, "app.db") }))
    .storage(LocalFileStorage({ directory: join(dir, "uploads") }))
    .collections([Posts])

  const app = (options === undefined ? builder : builder.cache(options)).build()

  return Effect.gen(function* () {
    const svc = yield* CollectionService
    const sql = yield* SqlClient.SqlClient

    const before = yield* svc.list(Posts, null, 10, adminCtx)
    yield* sql`INSERT INTO ${sql("posts")} ${sql.insert(EXTERNAL_ROW)}`
    const after = yield* svc.list(Posts, null, 10, adminCtx)

    return { before: before.items.length, after: after.items.length }
  }).pipe(
    Effect.provide(app.buildServiceLayer()),
    Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true })))
  )
}

describe("MiraApp cache wiring", () => {
  it.effect("serves a cached list page by default", () =>
    Effect.gen(function* () {
      const lengths = yield* listPageLengths()
      expect(lengths.before).toBe(0)
      expect(lengths.after).toBe(0)
    }))

  it.effect("reads through to the database when cache.enabled is false", () =>
    Effect.gen(function* () {
      const lengths = yield* listPageLengths({ enabled: false })
      expect(lengths.before).toBe(0)
      expect(lengths.after).toBe(1)
    }))

  it.effect("keeps caching when only tuning values are provided", () =>
    Effect.gen(function* () {
      const lengths = yield* listPageLengths({ recordTtlMs: 1_000 })
      expect(lengths.before).toBe(0)
      expect(lengths.after).toBe(0)
    }))
})
