import { describe, expect, it } from "vitest"

import {
  EMAIL_TEMPLATE_IDS,
  makeEmailTemplates,
  passwordResetEmail,
  sanitizeEmailSubject,
  verificationOtpEmail
} from "@/email/index.js"
import type { LoginOtpEmailInput, VerificationOtpEmailInput } from "@/email/index.js"

const verificationInput: VerificationOtpEmailInput = {
  appName: "Acme",
  email: "user@example.invalid",
  code: "123456",
  expiresMinutes: 10
}

const loginInput: LoginOtpEmailInput = {
  appName: "Acme",
  email: "user@example.invalid",
  code: "654321",
  expiresMinutes: 10
}

const resetInput = {
  appName: "Acme",
  email: "user@example.invalid",
  resetUrl: "https://example.invalid/reset-password?token=sample-token",
  expiresMinutes: 30
}

describe("makeEmailTemplates", () => {
  it("renders the exact built-in message when no overrides are configured", () => {
    const templates = makeEmailTemplates()
    const expected = verificationOtpEmail(verificationInput)
    expect(templates.render("users", "verification", verificationInput)).toEqual({
      subject: expected.subject,
      text: expected.text,
      html: expected.html
    })
    expect(templates.source("users", "verification")).toBe("builtin")
  })

  it("applies a global default override", () => {
    const templates = makeEmailTemplates({
      defaults: {
        loginOtp: ({ appName, code }) => ({
          subject: `${appName} code`,
          text: `Use ${code}.`
        })
      }
    })
    expect(templates.render("users", "loginOtp", loginInput)).toEqual({
      subject: "Acme code",
      text: "Use 654321."
    })
    expect(templates.source("users", "loginOtp")).toBe("global")
  })

  it("prefers a collection override over a global override and the built-in", () => {
    const templates = makeEmailTemplates({
      defaults: {
        verification: () => ({ subject: "Global verify", text: "global" })
      },
      collections: {
        users: {
          verification: ({ code }) => ({ subject: "Users verify", text: `code ${code}` })
        }
      }
    })
    expect(templates.render("users", "verification", verificationInput)).toEqual({
      subject: "Users verify",
      text: "code 123456"
    })
    expect(templates.source("users", "verification")).toBe("collection")

    // Other collections still get the global override.
    expect(templates.render("members", "verification", verificationInput).subject).toBe(
      "Global verify"
    )
    expect(templates.source("members", "verification")).toBe("global")

    // Untouched templates fall through to the built-in.
    expect(templates.source("users", "passwordReset")).toBe("builtin")
    const expected = passwordResetEmail(resetInput)
    expect(templates.render("users", "passwordReset", resetInput).subject).toBe(expected.subject)
  })

  it("strips CR/LF from custom subjects", () => {
    const templates = makeEmailTemplates({
      defaults: {
        loginOtp: () => ({
          subject: "Your code\r\nBcc: attacker@example.invalid",
          text: "body"
        })
      }
    })
    const rendered = templates.render("users", "loginOtp", loginInput)
    expect(rendered.subject).toBe("Your code Bcc: attacker@example.invalid")
    expect(rendered.subject).not.toMatch(/[\r\n]/)
    expect(sanitizeEmailSubject("a\nb\rc")).toBe("a b c")
  })

  it("previews all six templates with sentinel inputs and source labels", () => {
    const templates = makeEmailTemplates({
      collections: { admins: { loginAlert: () => ({ subject: "Alert", text: "sample" }) } }
    })
    const preview = templates.preview("users", "Acme")
    expect(preview.map((entry) => entry.id)).toEqual(EMAIL_TEMPLATE_IDS)
    expect(preview).toHaveLength(6)
    for (const entry of preview) {
      expect(entry.subject.length).toBeGreaterThan(0)
      expect(entry.text.length).toBeGreaterThan(0)
      expect(entry.html === null || entry.html.includes("<")).toBe(true)
    }
    expect(preview.find((entry) => entry.id === "verification")?.source).toBe("builtin")
    expect(templates.preview("admins", "Acme").find((entry) => entry.id === "loginAlert")?.source).toBe(
      "collection"
    )

    // No live data: only the documented sentinel values appear.
    const allText = preview.map((entry) => `${entry.subject}\n${entry.text}\n${entry.html ?? ""}`).join("\n")
    expect(allText).toContain("example.invalid")
    expect(allText).toContain("203.0.113.10")
    expect(allText).not.toContain("user@acme.com")
  })

  it("preview works without an email transport", () => {
    // `preview` is pure: it never resolves EmailService or calls send/describe.
    expect(() => makeEmailTemplates().preview("users", "Acme")).not.toThrow()
  })
})
