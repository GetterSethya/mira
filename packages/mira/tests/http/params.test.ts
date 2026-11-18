import { describe, expect, it } from "vitest"

import { parsePaginationParam } from "@/http/params.js"

const parse = (after?: string, limit?: string) =>
  parsePaginationParam({
    ...(after === undefined ? {} : { after }),
    ...(limit === undefined ? {} : { limit })
  })

describe("parsePaginationParam", () => {
  it("returns no cursor when after is absent or repeated", () => {
    expect(parse().cursor).toBeNull()
    expect(parsePaginationParam({ after: ["1", "2"] }).cursor).toBeNull()
  })

  it("keeps safe integers as numbers", () => {
    expect(parse("0").cursor).toBe(0)
    expect(parse("42").cursor).toBe(42)
  })

  it("keeps large canonical decimal strings as strings", () => {
    expect(parse("9007199254740993").cursor).toBe("9007199254740993")
    expect(parse("9223372036854775807").cursor).toBe("9223372036854775807")
  })

  it("rejects out-of-range and malformed values", () => {
    expect(parse("9223372036854775808").cursor).toBeNull()
    expect(parse("99999999999999999999").cursor).toBeNull()
    expect(parse("abc").cursor).toBeNull()
    expect(parse("-1").cursor).toBeNull()
    expect(parse("Infinity").cursor).toBeNull()
    expect(parse("1e309").cursor).toBeNull()
    expect(parse("9007199254740991.5").cursor).toBeNull()
  })

  it("preserves the legacy number parser forms", () => {
    expect(parse("1.9").cursor).toBe(1)
    expect(parse("1e3").cursor).toBe(1000)
    expect(parse("0x10").cursor).toBe(16)
    expect(parse("+5").cursor).toBe(5)
    expect(parse("").cursor).toBe(0)
    expect(parse(" ").cursor).toBe(0)
  })

  it("trims a padded large string", () => {
    expect(parse(" 9007199254740993 ").cursor).toBe("9007199254740993")
  })

  it("keeps the limit default, clamp, floor, and invalid fallback", () => {
    expect(parse(undefined, undefined).limit).toBe(30)
    expect(parse(undefined, "0").limit).toBe(30)
    expect(parse(undefined, "200").limit).toBe(100)
    expect(parse(undefined, "1.9").limit).toBe(1)
    expect(parse(undefined, "abc").limit).toBe(30)
    expect(parse(undefined, "Infinity").limit).toBe(100)
    expect(parse(undefined, "1e309").limit).toBe(100)
    expect(parse(undefined, "-1").limit).toBe(30)
  })
})
