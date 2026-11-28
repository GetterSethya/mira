import { SqliteClient } from "@effect/sql-sqlite-node"
import { describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { expect } from "vitest"

import { NodeCryptoLayer } from "@/crypto/node.js"
import { Dialect } from "@/dialect/dialect.js"
import { sqliteDialect } from "@/dialect/dialect-sqlite.js"
import type { Repository } from "@/repository/repository.js"
import { RepositoryLive } from "@/repository/repository.js"

const infra = Layer.mergeAll(
  SqliteClient.layer({ filename: ":memory:" }),
  NodeCryptoLayer,
  Layer.succeed(Dialect, sqliteDialect)
)

describe("repository dialect requirement", () => {
  it("requires Dialect at the type level", () => {
    // @ts-expect-error RepositoryLive requires the Dialect service.
    const missing: Layer.Layer<Repository, never, never> = RepositoryLive // oxlint-disable-line effecttsgo/missing-layer-context -- negative type test: the missing Dialect requirement is intentional.
    void missing
    expect(true).toBe(true)
  })

  it.effect("builds with SqlClient, CryptoService, and Dialect", () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(RepositoryLive.pipe(Layer.provide(infra)))
      expect(context).toBeDefined()
    })
  )
})
