import { describe, expect, it } from "vitest"

import { Bytes } from "@/collection/bytes.js"

describe("Bytes", () => {
  it("fromKB", () => expect(Bytes.fromKB(1)).toBe(1024))
  it("fromMB", () => expect(Bytes.fromMB(1)).toBe(1_048_576))
  it("fromGB", () => expect(Bytes.fromGB(1)).toBe(1_073_741_824))
  it("fromTB", () => expect(Bytes.fromTB(1)).toBe(1_099_511_627_776))
})
