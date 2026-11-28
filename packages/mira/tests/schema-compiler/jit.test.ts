import { describe, it } from "@effect/vitest"
import { BaseCollection, Field } from "@gettersethya/mira-client"
import { Effect, Result, Schema } from "effect"
import { expect } from "vitest"

import { buildInputSchemas, parseErrToValidationError } from "@/collection-service/input-schema.js"
import { enableSchemaJit, isSchemaJitEnabled, registerSchemaJitRoot } from "@/schema-compiler/index.js"

const Posts = BaseCollection.define("jit_posts", {
  title: Field.text({ required: true }),
  body: Field.text(),
  published: Field.boolean({ default: false })
})

describe("schema JIT compiler", () => {
  it.effect("decodes the same values and issues with the compiler on", () =>
    Effect.gen(function* () {
      const before = buildInputSchemas(Posts)
      const valid = { title: "hello", body: "body", published: true }
      const invalid = { title: 42 }

      const beforeValue = yield* Schema.decodeUnknownEffect(before.create)(valid)
      const beforeResult = yield* Effect.result(Schema.decodeUnknownEffect(before.create)(invalid))
      const beforeIssues = Result.isFailure(beforeResult)
        ? parseErrToValidationError("jit_posts")(beforeResult.failure).issues
        : []

      enableSchemaJit()
      expect(isSchemaJitEnabled()).toBe(true)

      // A fresh AST after enabling is registered from the start. A parser that
      // already captured the interpreted entry keeps it, which is exactly why
      // Mira enables at build time.
      const after = buildInputSchemas(Posts)
      registerSchemaJitRoot(after.create)
      registerSchemaJitRoot(after.update)

      const afterValue = yield* Schema.decodeUnknownEffect(after.create)(valid)
      const afterResult = yield* Effect.result(Schema.decodeUnknownEffect(after.create)(invalid))
      const afterIssues = Result.isFailure(afterResult)
        ? parseErrToValidationError("jit_posts")(afterResult.failure).issues
        : []

      expect(afterValue).toEqual(beforeValue)
      expect(afterIssues).toEqual(beforeIssues)
    })
  )

  it.effect("keeps partial compilation correct for transformations", () =>
    Effect.gen(function* () {
      enableSchemaJit()
      registerSchemaJitRoot(Schema.FiniteFromString)

      const value = yield* Schema.decodeUnknownEffect(Schema.FiniteFromString)("42")
      expect(value).toBe(42)
    })
  )
})
