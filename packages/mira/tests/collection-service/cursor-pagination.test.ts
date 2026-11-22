import { describe, it } from "@effect/vitest"
import { Cause, Effect, Exit } from "effect"
import { expect } from "vitest"

import { CollectionService } from "@/collection-service/collection-service.js"
import { parseCursor } from "@/collection-service/cursor.js"

import {
  makeCursorTestLayer,
  makeFakeLargeCursorServiceLayer,
  noCtx,
  Posts,
  setupPostsTable
} from "./_cursor-harness.js"

const resetAndSeed = (titles: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    yield* setupPostsTable
    const svc = yield* CollectionService
    for (const title of titles) {
      yield* svc.create(Posts, { title, published: false }, noCtx)
    }
  })

const numberMap = (row: Record<string, unknown>) => row["seqId"]
const stringMap = (row: Record<string, unknown>) => String(row["seqId"])
const bigintMap = (row: Record<string, unknown>) => BigInt(String(row["seqId"]))


describe("cursor pagination with driver-shaped seqIds", () => {
  it.effect("keeps number cursors for the shipped SQLite shape", () =>
    Effect.gen(function* () {
      yield* resetAndSeed(["a", "b", "c"])
      const svc = yield* CollectionService
      const page1 = yield* svc.list(Posts, null, 2, noCtx)
      expect(page1.nextCursor).toBe(2)

      const cursor = parseCursor(String(page1.nextCursor))
      const page2 = yield* svc.list(Posts, cursor, 2, noCtx)
      expect(page2.items).toHaveLength(1)
      expect(page2.nextCursor).toBeNull()
    }).pipe(Effect.provide(makeCursorTestLayer(numberMap))))
})

describe("cursor pagination with string and bigint driver values", () => {
  it.effect("round-trips a string cursor", () =>
    Effect.gen(function* () {
      yield* resetAndSeed(["a", "b", "c"])
      const svc = yield* CollectionService
      const page1 = yield* svc.list(Posts, null, 2, noCtx)
      expect(page1.nextCursor).toBe("2")

      const cursor = parseCursor(String(page1.nextCursor))
      const page2 = yield* svc.list(Posts, cursor, 2, noCtx)
      expect(page2.items).toHaveLength(1)
      expect(page2.nextCursor).toBeNull()
    }).pipe(Effect.provide(makeCursorTestLayer(stringMap))))

  it.effect("round-trips a bigint cursor", () =>
    Effect.gen(function* () {
      yield* resetAndSeed(["a", "b", "c"])
      const svc = yield* CollectionService
      const page1 = yield* svc.list(Posts, null, 2, noCtx)
      expect(page1.nextCursor).toBe("2")

      const cursor = parseCursor(String(page1.nextCursor))
      const page2 = yield* svc.list(Posts, cursor, 2, noCtx)
      expect(page2.items).toHaveLength(1)
      expect(page2.nextCursor).toBeNull()
    }).pipe(Effect.provide(makeCursorTestLayer(bigintMap))))
})

describe("cursor boundaries", () => {
  it.effect("returns null on an exact final page", () =>
    Effect.gen(function* () {
      yield* resetAndSeed(["a", "b"])
      const svc = yield* CollectionService
      const page = yield* svc.list(Posts, null, 2, noCtx)
      expect(page.items).toHaveLength(2)
      expect(page.nextCursor).toBeNull()
    }).pipe(Effect.provide(makeCursorTestLayer(numberMap))))

  it.effect("returns an empty page for zero or negative perPage", () =>
    Effect.gen(function* () {
      yield* resetAndSeed(["a", "b"])
      const svc = yield* CollectionService
      expect(yield* svc.list(Posts, null, 0, noCtx)).toEqual({ items: [], nextCursor: null })
      expect(yield* svc.list(Posts, null, -1, noCtx)).toEqual({ items: [], nextCursor: null })
    }).pipe(Effect.provide(makeCursorTestLayer(numberMap))))

  it.effect("supports descending seqId", () =>
    Effect.gen(function* () {
      yield* resetAndSeed(["a", "b", "c"])
      const svc = yield* CollectionService
      const adminCtx = { ...noCtx, admin: true }
      const page1 = yield* svc.list(Posts, null, 2, adminCtx, undefined, {
        field: "seqId",
        direction: "desc"
      })
      expect(page1.nextCursor).toBe(2)

      const page2 = yield* svc.list(
        Posts,
        page1.nextCursor,
        2,
        adminCtx,
        undefined,
        { field: "seqId", direction: "desc" }
      )
      expect(page2.items).toHaveLength(1)
      expect(page2.nextCursor).toBeNull()
    }).pipe(Effect.provide(makeCursorTestLayer(numberMap))))

  it.effect("fails loudly when more rows exist and the last seqId is unusable", () =>
    Effect.gen(function* () {
      yield* resetAndSeed(["a", "b", "c"])
      const svc = yield* CollectionService
      const exit = yield* Effect.exit(svc.list(Posts, null, 2, noCtx))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(String(Cause.squash(exit.cause))).toContain(
          "returned a page with more rows and no usable seqId for cursor pagination"
        )
      }
    }).pipe(Effect.provide(makeCursorTestLayer(() => ({})))))

  it.effect("allows a final page with an unusable seqId", () =>
    Effect.gen(function* () {
      yield* resetAndSeed(["a", "b"])
      const svc = yield* CollectionService
      const page = yield* svc.list(Posts, null, 5, noCtx)
      expect(page.items).toHaveLength(2)
      expect(page.nextCursor).toBeNull()
    }).pipe(Effect.provide(makeCursorTestLayer(() => ({})))))
})

const largeRows = [
  { id: "a", title: "a", seqId: "9007199254740993" },
  { id: "b", title: "b", seqId: "9007199254740994" },
  { id: "c", title: "c", seqId: "9007199254740995" }
] as const

describe("large cursor contract with a fake repository", () => {
  it.effect("round-trips cursors above 2^53", () =>
    Effect.gen(function* () {
      const svc = yield* CollectionService

      const page1 = yield* svc.list(Posts, null, 1, noCtx)
      expect(page1.nextCursor).toBe("9007199254740993")

      const page2 = yield* svc.list(Posts, parseCursor(String(page1.nextCursor)), 1, noCtx)
      expect(page2.nextCursor).toBe("9007199254740994")

      const page3 = yield* svc.list(Posts, parseCursor(String(page2.nextCursor)), 1, noCtx)
      expect(page3.nextCursor).toBeNull()
      expect(page3.items[0]?.["id"]).toBe("c")
    }).pipe(Effect.provide(makeFakeLargeCursorServiceLayer(largeRows))))

  it.effect("supports descending seqId above 2^53", () =>
    Effect.gen(function* () {
      const svc = yield* CollectionService
      const adminCtx = { ...noCtx, admin: true }
      const page1 = yield* svc.list(Posts, null, 1, adminCtx, undefined, {
        field: "seqId",
        direction: "desc"
      })
      expect(page1.nextCursor).toBe("9007199254740995")

      const page2 = yield* svc.list(
        Posts,
        parseCursor(String(page1.nextCursor)),
        1,
        adminCtx,
        undefined,
        { field: "seqId", direction: "desc" }
      )
      expect(page2.nextCursor).toBe("9007199254740994")
    }).pipe(Effect.provide(makeFakeLargeCursorServiceLayer(largeRows))))

  it.effect("fails on a full page whose last row is an unsafe number", () =>
    Effect.gen(function* () {
      yield* resetAndSeed(["a", "b", "c"])
      const svc = yield* CollectionService
      const exit = yield* Effect.exit(svc.list(Posts, null, 2, noCtx))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(String(Cause.squash(exit.cause))).toContain(
          "returned a page with more rows and no usable seqId for cursor pagination"
        )
      }
    }).pipe(
      Effect.provide(
        makeCursorTestLayer((row) =>
          row["seqId"] === 2 ? 9007199254740992 : row["seqId"]
        )
      )
    ))
})
