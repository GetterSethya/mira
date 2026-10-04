import type { AnyCollectionDef } from "@gettersethya/mira-client"
import { BaseCollection, Field } from "@gettersethya/mira-client"
import { Layer } from "effect"
import { describe, expect,it } from "vitest"

import { MiraApp } from "@/app/app.js"
import { MiraBuilder } from "@/app/builder.js"
import { defineRule } from "@/app/index.js"
import { MiraPlugin } from "@/app/plugin.js"
import { SqliteDatabase } from "@/databases/sqlite.js"
import { NodePlatform } from "@/platforms/node.js"
import { LocalFileStorage } from "@/storage/index.js"
import { ConsoleTelemetryLayer } from "@/telemetry/index.js"

// Use real presets as stubs — builder stores them without invoking them in unit tests
const stubPlatform = NodePlatform
const stubDatabase = SqliteDatabase({ filename: ":memory:" })
const stubStorage = LocalFileStorage({ directory: "./tmp/test" })
const stubCollections: ReadonlyArray<AnyCollectionDef> = []

const fullBuilder = () =>
  new MiraBuilder()
    .platform(stubPlatform)
    .database(stubDatabase)
    .storage(stubStorage)
    .collections(stubCollections)

describe("MiraBuilder", () => {
  it("stores platform on builder", () => {
    const b = new MiraBuilder().platform(stubPlatform)
    expect(b._getPartialConfig().platform).toBe(stubPlatform)
  })

  it("stores database on builder", () => {
    const b = new MiraBuilder().database(stubDatabase)
    expect(b._getPartialConfig().database).toBe(stubDatabase)
  })

  it("stores storage on builder", () => {
    const b = new MiraBuilder().storage(stubStorage)
    expect(b._getPartialConfig().storage).toBe(stubStorage)
  })

  it("stores collections on builder", () => {
    const b = new MiraBuilder().collections(stubCollections)
    expect(b._getPartialConfig().collections).toBe(stubCollections)
  })

  it("build() returns MiraApp when all required steps are satisfied", () => {
    const app = fullBuilder().build()
    expect(app).toBeInstanceOf(MiraApp)
  })

  it("defaults telemetry to ConsoleTelemetryLayer when .telemetry() not called", () => {
    const app = fullBuilder().build()
    expect(app._getConfig().telemetry).toBe(ConsoleTelemetryLayer)
  })

  it("uses provided telemetry when .telemetry() is called", () => {
    const customTelemetry = Layer.empty
    const app = fullBuilder().telemetry(customTelemetry).build()
    expect(app._getConfig().telemetry).toBe(customTelemetry)
  })

  it("each builder step returns a new builder (immutable)", () => {
    const b0 = new MiraBuilder()
    const b1 = b0.platform(stubPlatform)
    expect(b0).not.toBe(b1)
  })
})

describe("MiraApp.extend()", () => {
  it("returns this (chainable)", () => {
    const app = fullBuilder().build()
    const result = app.extend(MiraPlugin.fromLayer(Layer.empty))
    expect(result).toBe(app)
  })

  it("accumulates extras in order", () => {
    const pluginA = MiraPlugin.fromLayer(Layer.empty)
    const pluginB = MiraPlugin.fromLayer(Layer.empty)
    const app = fullBuilder().build()
    app.extend(pluginA).extend(pluginB)
    expect(app._getExtras()).toEqual([pluginA, pluginB])
  })
})

describe("MiraBuilder.rules()", () => {
  const postsDef = BaseCollection.define("posts", { title: Field.text() })

  it("stores rules on builder config", () => {
    const rb = defineRule(postsDef, (R) => ({ list: R.public() }))
    const b = fullBuilder().rules([rb])
    expect(b._getPartialConfig().rules).toEqual([rb])
  })

  it("throws on duplicate collection names", () => {
    const rb1 = defineRule(postsDef, (R) => ({ list: R.public() }))
    const rb2 = defineRule(postsDef, (R) => ({ view: R.public() }))
    expect(() => fullBuilder().rules([rb1, rb2])).toThrow(
      'Duplicate rule binding for collection "posts"'
    )
  })

  it("rules survive through build", () => {
    const rb = defineRule(postsDef, (R) => ({ list: R.public() }))
    const app = fullBuilder().rules([rb]).build()
    expect(app._getConfig().rules).toEqual([rb])
  })
})
