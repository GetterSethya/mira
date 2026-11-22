import { describe, expect, it } from "vitest"

import { cursorFromSeqId, MAX_SEQ_ID, parseCursor } from "@/collection-service/cursor.js"

describe("cursorFromSeqId", () => {
  it("keeps safe numbers as numbers", () => {
    expect(cursorFromSeqId(0)).toBe(0)
    expect(cursorFromSeqId(1)).toBe(1)
    expect(cursorFromSeqId(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER)
  })

  it("rejects unsafe and invalid numbers", () => {
    expect(cursorFromSeqId(9007199254740992)).toBeNull()
    expect(cursorFromSeqId(-1)).toBeNull()
    expect(cursorFromSeqId(1.5)).toBeNull()
    expect(cursorFromSeqId(Number.NaN)).toBeNull()
    expect(cursorFromSeqId(Number.POSITIVE_INFINITY)).toBeNull()
  })

  it("converts bigints to canonical decimal strings", () => {
    expect(cursorFromSeqId(0n)).toBe("0")
    expect(cursorFromSeqId(1n)).toBe("1")
    expect(cursorFromSeqId(9007199254740993n)).toBe("9007199254740993")
    expect(cursorFromSeqId(MAX_SEQ_ID)).toBe("9223372036854775807")
  })

  it("rejects invalid bigints", () => {
    expect(cursorFromSeqId(-1n)).toBeNull()
    expect(cursorFromSeqId(MAX_SEQ_ID + 1n)).toBeNull()
  })

  it("accepts canonical decimal strings", () => {
    expect(cursorFromSeqId("0")).toBe("0")
    expect(cursorFromSeqId("1")).toBe("1")
    expect(cursorFromSeqId("9007199254740993")).toBe("9007199254740993")
    expect(cursorFromSeqId("9223372036854775807")).toBe("9223372036854775807")
  })

  it("rejects non-canonical, unsafe, and non-string values", () => {
    expect(cursorFromSeqId(null)).toBeNull()
    expect(cursorFromSeqId(undefined)).toBeNull()
    expect(cursorFromSeqId({})).toBeNull()
    expect(cursorFromSeqId("01")).toBeNull()
    expect(cursorFromSeqId("1e3")).toBeNull()
    expect(cursorFromSeqId("")).toBeNull()
    expect(cursorFromSeqId("9223372036854775808")).toBeNull()
    expect(cursorFromSeqId("99999999999999999999")).toBeNull()
  })
})

describe("parseCursor", () => {
  it("returns null when there is no cursor", () => {
    expect(parseCursor(null)).toBeNull()
  })

  it("keeps safe integers as numbers", () => {
    expect(parseCursor("0")).toBe(0)
    expect(parseCursor("42")).toBe(42)
  })

  it("preserves legacy parser forms when the floor is safe", () => {
    expect(parseCursor("1.9")).toBe(1)
    expect(parseCursor("1e3")).toBe(1000)
    expect(parseCursor("0x10")).toBe(16)
    expect(parseCursor("+5")).toBe(5)
  })

  it("accepts empty and whitespace-only values as zero", () => {
    expect(parseCursor("")).toBe(0)
    expect(parseCursor(" ")).toBe(0)
  })

  it("keeps large canonical decimal strings as strings", () => {
    expect(parseCursor("9007199254740993")).toBe("9007199254740993")
    expect(parseCursor("9223372036854775807")).toBe("9223372036854775807")
    expect(parseCursor(" 9007199254740993 ")).toBe("9007199254740993")
  })

  it("rejects malformed and out-of-range values", () => {
    expect(parseCursor("abc")).toBeNull()
    expect(parseCursor("-1")).toBeNull()
    expect(parseCursor("Infinity")).toBeNull()
    expect(parseCursor("1e309")).toBeNull()
    expect(parseCursor("9007199254740991.5")).toBeNull()
    expect(parseCursor("9223372036854775808")).toBeNull()
    expect(parseCursor("99999999999999999999")).toBeNull()
  })
})
