import { describe, expect, it } from "vitest"

import { buildFileUrl } from "@/client/file.js"

describe("buildFileUrl", () => {
  it("produces correct URL with no opts", () => {
    const url = buildFileUrl("http://localhost", "users", "abc", "avatar.png")
    expect(url).toBe("http://localhost/api/files/users/abc/avatar.png")
  })

  it("produces correct URL with thumb", () => {
    const url = buildFileUrl("http://localhost", "users", "abc", "avatar.png", { thumb: "200x200" })
    expect(url).toBe("http://localhost/api/files/users/abc/avatar.png?thumb=200x200")
  })

  it("produces correct URL with token", () => {
    const url = buildFileUrl("http://localhost", "users", "abc", "avatar.png", { token: "tok123" })
    expect(url).toBe("http://localhost/api/files/users/abc/avatar.png?token=tok123")
  })

  it("produces correct URL with both token and thumb", () => {
    const url = buildFileUrl("http://localhost", "users", "abc", "avatar.png", { token: "tok123", thumb: "100x100" })
    expect(url).toBe("http://localhost/api/files/users/abc/avatar.png?token=tok123&thumb=100x100")
  })
})
