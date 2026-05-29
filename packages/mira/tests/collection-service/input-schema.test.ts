import { Effect, Either, Match, Schema } from "effect"
import { describe, it } from "@effect/vitest"
import { expect } from "vitest"
import { BaseCollection } from "@gettersethya/mira-client"
import { Field } from "@gettersethya/mira-client"
import type { AnyCollectionDef } from "@gettersethya/mira-client"
import { buildInputSchemas, parseErrToValidationError } from "@/collection-service/input-schema.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createDecode(colDef: AnyCollectionDef, input: unknown) {
  return Schema.decodeUnknown(buildInputSchemas(colDef).create)(input)
}

function updateDecode(colDef: AnyCollectionDef, input: unknown) {
  return Schema.decodeUnknown(buildInputSchemas(colDef).update)(input)
}

// ---------------------------------------------------------------------------
// propertyToSchema — type mapping
// ---------------------------------------------------------------------------

describe("propertyToSchema — type mapping", () => {
  it.effect("Field.text() — valid string succeeds", () =>
    Effect.gen(function* () {
      const col = BaseCollection.define("t", { title: Field.text() })
      const result = yield* createDecode(col, { title: "hello" }).pipe(Effect.either)
      expect(Either.isRight(result)).toBe(true)
    })
  )

  it.effect("Field.text() — wrong type fails", () =>
    Effect.gen(function* () {
      const col = BaseCollection.define("t", { title: Field.text() })
      const result = yield* createDecode(col, { title: 42 }).pipe(Effect.either)
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        const ve = parseErrToValidationError("t")(result.left)
        expect(ve.issues.length).toBeGreaterThan(0)
      }
    })
  )

  it.effect("Field.text({ minLength: 3 }) — too short fails", () =>
    Effect.gen(function* () {
      const col = BaseCollection.define("t", { title: Field.text({ minLength: 3 }) })
      const result = yield* createDecode(col, { title: "ab" }).pipe(Effect.either)
      expect(Either.isLeft(result)).toBe(true)
    })
  )

  it.effect("Field.text({ maxLength: 5 }) — too long fails", () =>
    Effect.gen(function* () {
      const col = BaseCollection.define("t", { title: Field.text({ maxLength: 5 }) })
      const result = yield* createDecode(col, { title: "abcdef" }).pipe(Effect.either)
      expect(Either.isLeft(result)).toBe(true)
    })
  )

  it.effect("Field.text({ minLength: 2, maxLength: 5 }) — at min succeeds", () =>
    Effect.gen(function* () {
      const col = BaseCollection.define("t", { title: Field.text({ minLength: 2, maxLength: 5 }) })
      const result = yield* createDecode(col, { title: "ab" }).pipe(Effect.either)
      expect(Either.isRight(result)).toBe(true)
    })
  )

  it.effect("Field.email() — valid email succeeds", () =>
    Effect.gen(function* () {
      const col = BaseCollection.define("t", { email: Field.email() })
      const result = yield* createDecode(col, { email: "a@b.com" }).pipe(Effect.either)
      expect(Either.isRight(result)).toBe(true)
    })
  )

  it.effect("Field.email() — invalid email fails", () =>
    Effect.gen(function* () {
      const col = BaseCollection.define("t", { email: Field.email() })
      const result = yield* createDecode(col, { email: "notanemail" }).pipe(Effect.either)
      expect(Either.isLeft(result)).toBe(true)
    })
  )

  it.effect("Field.number() — valid number succeeds", () =>
    Effect.gen(function* () {
      const col = BaseCollection.define("t", { score: Field.number() })
      const result = yield* createDecode(col, { score: 3.14 }).pipe(Effect.either)
      expect(Either.isRight(result)).toBe(true)
    })
  )

  it.effect("Field.number({ min: 0 }) — below min fails", () =>
    Effect.gen(function* () {
      const col = BaseCollection.define("t", { score: Field.number({ min: 0 }) })
      const result = yield* createDecode(col, { score: -1 }).pipe(Effect.either)
      expect(Either.isLeft(result)).toBe(true)
    })
  )

  it.effect("Field.number({ max: 100 }) — above max fails", () =>
    Effect.gen(function* () {
      const col = BaseCollection.define("t", { score: Field.number({ max: 100 }) })
      const result = yield* createDecode(col, { score: 101 }).pipe(Effect.either)
      expect(Either.isLeft(result)).toBe(true)
    })
  )

  it.effect("Field.integer() — valid integer succeeds", () =>
    Effect.gen(function* () {
      const col = BaseCollection.define("t", { count: Field.integer() })
      const result = yield* createDecode(col, { count: 5 }).pipe(Effect.either)
      expect(Either.isRight(result)).toBe(true)
    })
  )

  it.effect("Field.integer() — float rejected", () =>
    Effect.gen(function* () {
      const col = BaseCollection.define("t", { count: Field.integer() })
      const result = yield* createDecode(col, { count: 1.5 }).pipe(Effect.either)
      expect(Either.isLeft(result)).toBe(true)
    })
  )

  it.effect("Field.integer({ min: 1 }) — at min succeeds", () =>
    Effect.gen(function* () {
      const col = BaseCollection.define("t", { count: Field.integer({ min: 1 }) })
      const result = yield* createDecode(col, { count: 1 }).pipe(Effect.either)
      expect(Either.isRight(result)).toBe(true)
    })
  )

  it.effect("Field.boolean() — valid boolean succeeds", () =>
    Effect.gen(function* () {
      const col = BaseCollection.define("t", { active: Field.boolean() })
      const result = yield* createDecode(col, { active: true }).pipe(Effect.either)
      expect(Either.isRight(result)).toBe(true)
    })
  )

  it.effect("Field.boolean() — wrong type fails", () =>
    Effect.gen(function* () {
      const col = BaseCollection.define("t", { active: Field.boolean() })
      const result = yield* createDecode(col, { active: "yes" }).pipe(Effect.either)
      expect(Either.isLeft(result)).toBe(true)
    })
  )

  it.effect("Field.date() — string passes", () =>
    Effect.gen(function* () {
      const col = BaseCollection.define("t", { at: Field.date() })
      const result = yield* createDecode(col, { at: "2024-01-01" }).pipe(Effect.either)
      expect(Either.isRight(result)).toBe(true)
    })
  )

  it.effect("Field.json() — any value passes", () =>
    Effect.gen(function* () {
      const col = BaseCollection.define("t", { meta: Field.json() })
      const result = yield* createDecode(col, { meta: { x: 1 } }).pipe(Effect.either)
      expect(Either.isRight(result)).toBe(true)
    })
  )

  it.effect("Field.file() — string passes", () =>
    Effect.gen(function* () {
      const col = BaseCollection.define("t", { avatar: Field.file() })
      const result = yield* createDecode(col, { avatar: "key/abc" }).pipe(Effect.either)
      expect(Either.isRight(result)).toBe(true)
    })
  )

  it.effect("Field.literalText() — valid literal value succeeds", () =>
    Effect.gen(function* () {
      const col = BaseCollection.define("t", { role: Field.literalText({ literal: ["admin", "agent"] }) })
      const result = yield* createDecode(col, { role: "admin" }).pipe(Effect.either)
      expect(Either.isRight(result)).toBe(true)
    })
  )

  it.effect("Field.literalText() — invalid literal value fails", () =>
    Effect.gen(function* () {
      const col = BaseCollection.define("t", { role: Field.literalText({ literal: ["admin", "agent"] }) })
      const result = yield* createDecode(col, { role: "superadmin" }).pipe(Effect.either)
      expect(Either.isLeft(result)).toBe(true)
    })
  )

  it.effect("Field.literalText() optional — undefined succeeds", () =>
    Effect.gen(function* () {
      const col = BaseCollection.define("t", { role: Field.literalText({ literal: ["admin", "agent"], required: false }) })
      const result = yield* createDecode(col, {}).pipe(Effect.either)
      expect(Either.isRight(result)).toBe(true)
    })
  )

  it.effect("Field.literalText() optional — invalid string fails", () =>
    Effect.gen(function* () {
      const col = BaseCollection.define("t", { role: Field.literalText({ literal: ["admin", "agent"], required: false }) })
      const result = yield* createDecode(col, { role: "nope" }).pipe(Effect.either)
      expect(Either.isLeft(result)).toBe(true)
    })
  )

  it.effect("Field.literalText() — custom error on literal constraint", () =>
    Effect.gen(function* () {
      const col = BaseCollection.define("t", {
        role: Field.literalText({ literal: ["a", "b"], error: (k) => k === "literal" ? "bad value" : undefined })
      })
      const result = yield* createDecode(col, { role: "c" }).pipe(Effect.either)
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        const ve = parseErrToValidationError("t")(result.left)
        expect(ve.issues.some((i) => i.includes("bad value"))).toBe(true)
      }
    })
  )
})

// ---------------------------------------------------------------------------
// Struct assembly — required vs optional
// ---------------------------------------------------------------------------

describe("struct assembly", () => {
  it.effect("required field missing → create fails", () =>
    Effect.gen(function* () {
      const col = BaseCollection.define("t", { title: Field.text() })
      const result = yield* createDecode(col, {}).pipe(Effect.either)
      expect(Either.isLeft(result)).toBe(true)
    })
  )

  it.effect("required field missing → update succeeds", () =>
    Effect.gen(function* () {
      const col = BaseCollection.define("t", { title: Field.text() })
      const result = yield* updateDecode(col, {}).pipe(Effect.either)
      expect(Either.isRight(result)).toBe(true)
    })
  )

  it.effect("optional field absent → create succeeds", () =>
    Effect.gen(function* () {
      const col = BaseCollection.define("t", { title: Field.text({ required: false }) })
      const result = yield* createDecode(col, {}).pipe(Effect.either)
      expect(Either.isRight(result)).toBe(true)
    })
  )

  it.effect("unknown keys are stripped", () =>
    Effect.gen(function* () {
      const col = BaseCollection.define("t", { title: Field.text() })
      const result = yield* createDecode(col, { title: "x", extra: 1 }).pipe(Effect.either)
      expect(Either.isRight(result)).toBe(true)
      if (Either.isRight(result)) {
        expect("extra" in result.right).toBe(false)
      }
    })
  )

  it.effect("x-system fields excluded from schema (stripped as unknown keys)", () =>
    Effect.gen(function* () {
      const col = BaseCollection.define("t", { title: Field.text() })
      const result = yield* createDecode(col, { title: "x", id: "hack" }).pipe(Effect.either)
      expect(Either.isRight(result)).toBe(true)
      if (Either.isRight(result)) {
        expect("id" in result.right).toBe(false)
      }
    })
  )
})

// ---------------------------------------------------------------------------
// error callback
// ---------------------------------------------------------------------------

describe("error callback", () => {
  it.effect("minLength custom message fires", () =>
    Effect.gen(function* () {
      const col = BaseCollection.define("t", {
        title: Field.text({ minLength: 5, error: (k) => (k === "minLength" ? "Too short" : "Bad") })
      })
      const result = yield* createDecode(col, { title: "ab" }).pipe(Effect.either)
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        const ve = parseErrToValidationError("t")(result.left)
        expect(ve.issues.some((i) => i.includes("Too short"))).toBe(true)
      }
    })
  )

  it.effect("maxLength custom message fires", () =>
    Effect.gen(function* () {
      const col = BaseCollection.define("t", {
        title: Field.text({ maxLength: 3, error: (k) => (k === "maxLength" ? "Too long" : "Bad") })
      })
      const result = yield* createDecode(col, { title: "abcd" }).pipe(Effect.either)
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        const ve = parseErrToValidationError("t")(result.left)
        expect(ve.issues.some((i) => i.includes("Too long"))).toBe(true)
      }
    })
  )

  it.effect("minimum custom message fires", () =>
    Effect.gen(function* () {
      const col = BaseCollection.define("t", {
        n: Field.number({ min: 1, error: (k) => (k === "minimum" ? "Too small" : "Bad") })
      })
      const result = yield* createDecode(col, { n: 0 }).pipe(Effect.either)
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        const ve = parseErrToValidationError("t")(result.left)
        expect(ve.issues.some((i) => i.includes("Too small"))).toBe(true)
      }
    })
  )

  it.effect("maximum custom message fires", () =>
    Effect.gen(function* () {
      const col = BaseCollection.define("t", {
        n: Field.number({ max: 10, error: (k) => (k === "maximum" ? "Too big" : "Bad") })
      })
      const result = yield* createDecode(col, { n: 11 }).pipe(Effect.either)
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        const ve = parseErrToValidationError("t")(result.left)
        expect(ve.issues.some((i) => i.includes("Too big"))).toBe(true)
      }
    })
  )

  it.effect("int custom message fires", () =>
    Effect.gen(function* () {
      const col = BaseCollection.define("t", {
        n: Field.integer({ error: (k) => (k === "int" ? "Must be int" : "Bad") })
      })
      const result = yield* createDecode(col, { n: 1.5 }).pipe(Effect.either)
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        const ve = parseErrToValidationError("t")(result.left)
        expect(ve.issues.some((i) => i.includes("Must be int"))).toBe(true)
      }
    })
  )

  it.effect("email custom message fires", () =>
    Effect.gen(function* () {
      const col = BaseCollection.define("t", {
        e: Field.email({ error: (k) => (k === "email" ? "Bad email" : "Bad") })
      })
      const result = yield* createDecode(col, { e: "x" }).pipe(Effect.either)
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        const ve = parseErrToValidationError("t")(result.left)
        expect(ve.issues.some((i) => i.includes("Bad email"))).toBe(true)
      }
    })
  )

  it.effect("Match.orElse fallback fires on type mismatch", () =>
    Effect.gen(function* () {
      const col = BaseCollection.define("t", {
        title: Field.text({ error: (k) => Match.value(k).pipe(Match.orElse(() => "Fallback")) })
      })
      const result = yield* createDecode(col, { title: 42 }).pipe(Effect.either)
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        const ve = parseErrToValidationError("t")(result.left)
        expect(ve.issues.some((i) => i.includes("Fallback"))).toBe(true)
      }
    })
  )

  it.effect("no error callback → default message (non-empty issues)", () =>
    Effect.gen(function* () {
      const col = BaseCollection.define("t", { title: Field.text({ minLength: 3 }) })
      const result = yield* createDecode(col, { title: "a" }).pipe(Effect.either)
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        const ve = parseErrToValidationError("t")(result.left)
        expect(ve.issues.length).toBeGreaterThan(0)
      }
    })
  )

  it.effect("required custom message fires on create", () =>
    Effect.gen(function* () {
      const col = BaseCollection.define("t", {
        title: Field.text({ error: (k) => (k === "required" ? "Field needed" : "Bad") })
      })
      const result = yield* createDecode(col, {}).pipe(Effect.either)
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        const ve = parseErrToValidationError("t")(result.left)
        expect(ve.issues.some((i) => i.includes("Field needed"))).toBe(true)
      }
    })
  )

  it.effect("required message NOT fired on update", () =>
    Effect.gen(function* () {
      const col = BaseCollection.define("t", {
        title: Field.text({ error: (k) => (k === "required" ? "Field needed" : "Bad") })
      })
      const result = yield* updateDecode(col, {}).pipe(Effect.either)
      expect(Either.isRight(result)).toBe(true)
    })
  )
})
