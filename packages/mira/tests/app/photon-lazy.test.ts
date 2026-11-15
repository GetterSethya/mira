import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, it } from "@effect/vitest"
import { BaseCollection, Field } from "@gettersethya/mira-client"
import type { AnyCollectionDef } from "@gettersethya/mira-client"
import { Effect } from "effect"
import { expect, vi } from "vitest"

import { Mira } from "@/app/index.js"
import { SqliteDatabase } from "@/databases/sqlite.js"
import { NodePlatform } from "@/platforms/node.js"
import { LocalFileStorage } from "@/storage/local-preset.js"
import { ThumbnailService } from "@/thumbnail/types.js"

/**
 * Counts module evaluations of the Photon backend. The factory only runs when
 * something imports `@cf-wasm/photon/node`, so the counter is a direct probe of
 * whether the app builder paid Photon's module-init cost.
 */
const photon = vi.hoisted(() => ({ loads: 0 }))

vi.mock("@cf-wasm/photon/node", () => {
  photon.loads += 1
  return {
    PhotonImage: class {},
    crop: () => undefined,
    resize: () => undefined,
    SamplingFilter: { Lanczos3: 0 }
  }
})

const Posts = BaseCollection.define("posts", {
  title: Field.text({ required: true })
})

const Attachments = BaseCollection.define("attachments", {
  file: Field.file({ mimeTypes: ["image/png"] })
})

/** Builds the app and reports whether the wired backend can handle PNGs. */
const acceptsPng = (collections: ReadonlyArray<AnyCollectionDef>) => {
  const dir = mkdtempSync(join(tmpdir(), "mira-photon-lazy-"))
  const app = Mira.builder()
    .platform(NodePlatform)
    .database(SqliteDatabase({ filename: join(dir, "app.db") }))
    .storage(LocalFileStorage({ directory: join(dir, "uploads") }))
    .collections(collections)
    .build()

  return Effect.gen(function* () {
    const thumbnails = yield* ThumbnailService
    return thumbnails.supported("image/png")
  }).pipe(
    Effect.provide(app.buildServiceLayer()),
    Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true })))
  )
}

describe("lazy Photon loading", () => {
  it.effect("never imports Photon when no collection has a file field", () =>
    Effect.gen(function* () {
      const loadsBefore = photon.loads
      expect(yield* acceptsPng([Posts])).toBe(false)
      expect(photon.loads).toBe(loadsBefore)
    }))

  it.effect("imports Photon only when a file field selects the backend", () =>
    Effect.gen(function* () {
      const loadsBefore = photon.loads
      expect(yield* acceptsPng([Posts, Attachments])).toBe(true)
      expect(photon.loads).toBe(loadsBefore + 1)
    }))
})
