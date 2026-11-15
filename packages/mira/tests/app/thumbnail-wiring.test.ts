import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, it } from "@effect/vitest"
import { BaseCollection, Field } from "@gettersethya/mira-client"
import type { AnyCollectionDef } from "@gettersethya/mira-client"
import { Effect } from "effect"
import { expect } from "vitest"

import { Mira } from "@/app/index.js"
import { SqliteDatabase } from "@/databases/sqlite.js"
import { NodePlatform } from "@/platforms/node.js"
import { LocalFileStorage } from "@/storage/local-preset.js"
import { ThumbnailService } from "@/thumbnail/index.js"

const Posts = BaseCollection.define("posts", {
  title: Field.text({ required: true })
})

const Attachments = BaseCollection.define("attachments", {
  file: Field.file({ mimeTypes: ["image/png"] })
})

/** Reports whether the wired thumbnail backend can handle PNGs. */
const acceptsPng = (collections: ReadonlyArray<AnyCollectionDef>) => {
  const dir = mkdtempSync(join(tmpdir(), "mira-thumbnail-wiring-"))
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

describe("MiraApp thumbnail wiring", () => {
  it.effect("uses the no-op backend when no collection has a file field", () =>
    Effect.gen(function* () {
      expect(yield* acceptsPng([Posts])).toBe(false)
    }))

  it.effect("uses the image backend when a collection has a file field", () =>
    Effect.gen(function* () {
      expect(yield* acceptsPng([Posts, Attachments])).toBe(true)
    }))
})
