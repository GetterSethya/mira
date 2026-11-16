import { Context } from "effect"

import type { EmailMessage } from "./types.js"

export const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")

const layout = (appName: string, title: string, body: string) => `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f5f5f5;font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#18181b">
    <div style="max-width:560px;margin:0 auto;padding:32px 20px">
      <p style="margin:0 0 8px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#71717a">${escapeHtml(appName)}</p>
      <h1 style="margin:0 0 20px;font-size:22px;line-height:1.25">${escapeHtml(title)}</h1>
      <div style="background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:24px;font-size:15px;line-height:1.6">
        ${body}
      </div>
      <p style="margin:20px 0 0;font-size:12px;color:#71717a">This message was sent by ${escapeHtml(appName)}.</p>
    </div>
  </body>
</html>`

const paragraph = (text: string) => `<p style="margin:0 0 14px">${escapeHtml(text)}</p>`

const codeBlock = (title: string, code: string) =>
  `${paragraph(title)}<p style="margin:0 0 16px;font-size:32px;letter-spacing:.2em;font-weight:700">${escapeHtml(code)}</p>`

const button = (href: string, label: string) =>
  `<p style="margin:0 0 16px"><a href="${escapeHtml(href)}" style="display:inline-block;background:#0a0a0a;color:#fff;text-decoration:none;border-radius:8px;padding:11px 18px;font-weight:600">${escapeHtml(label)}</a></p>`

export interface LoginAlertEmailInput {
  readonly appName: string
  readonly collection: string
  readonly email: string
  readonly ip: string
  readonly userAgent: string
  readonly time: string
}

export const loginAlertEmail = (input: LoginAlertEmailInput): EmailMessage => {
  const subject = `New sign-in to ${input.appName}`
  const body = [
    paragraph(`A new sign-in to ${input.appName} succeeded.`),
    paragraph(`Account: ${input.email}`),
    paragraph(`Collection: ${input.collection}`),
    paragraph(`Time: ${input.time}`),
    paragraph(`IP: ${input.ip}`),
    paragraph(`Device: ${input.userAgent}`),
    paragraph("If this was not you, reset your password immediately.")
  ].join("")
  return {
    to: input.email,
    subject,
    text: [
      `A new sign-in to ${input.appName} succeeded.`,
      `Account: ${input.email}`,
      `Collection: ${input.collection}`,
      `Time: ${input.time}`,
      `IP: ${input.ip}`,
      `Device: ${input.userAgent}`,
      "",
      "If this was not you, reset your password immediately."
    ].join("\n"),
    html: layout(input.appName, subject, body)
  }
}

export interface PasswordResetEmailInput {
  readonly appName: string
  readonly email: string
  readonly resetUrl: string
  readonly expiresMinutes: number
}

export const passwordResetEmail = (input: PasswordResetEmailInput): EmailMessage => {
  const subject = `Reset your ${input.appName} password`
  const body = [
    paragraph(`A password reset was requested for ${input.email}.`),
    button(input.resetUrl, "Reset password"),
    paragraph(`This link expires in ${input.expiresMinutes} minutes and can be used once.`),
    paragraph("If you did not request this, ignore this message.")
  ].join("")
  return {
    to: input.email,
    subject,
    text: [
      `A password reset was requested for ${input.email}.`,
      "",
      input.resetUrl,
      "",
      `This link expires in ${input.expiresMinutes} minutes and can be used once.`,
      "If you did not request this, ignore this message."
    ].join("\n"),
    html: layout(input.appName, subject, body)
  }
}

export interface EmailChangeEmailInput {
  readonly appName: string
  readonly currentEmail: string
  readonly newEmail: string
  readonly confirmUrl: string
  readonly expiresMinutes: number
}

export const emailChangeEmail = (input: EmailChangeEmailInput): EmailMessage => {
  const subject = `Confirm your new ${input.appName} email`
  const body = [
    paragraph(`A request was made to change the email for ${input.currentEmail} to ${input.newEmail}.`),
    button(input.confirmUrl, "Confirm new email"),
    paragraph(`This link expires in ${input.expiresMinutes} minutes and can be used once.`),
    paragraph("If you did not request this, ignore this message.")
  ].join("")
  return {
    to: input.newEmail,
    subject,
    text: [
      `A request was made to change the email for ${input.currentEmail} to ${input.newEmail}.`,
      "",
      input.confirmUrl,
      "",
      `This link expires in ${input.expiresMinutes} minutes and can be used once.`,
      "If you did not request this, ignore this message."
    ].join("\n"),
    html: layout(input.appName, subject, body)
  }
}

export interface VerificationOtpEmailInput {
  readonly appName: string
  readonly email: string
  readonly code: string
  readonly expiresMinutes: number
}

export const verificationOtpEmail = (input: VerificationOtpEmailInput): EmailMessage => {
  const subject = `Verify your ${input.appName} email`
  const body = [
    paragraph(`Use this code to verify ${input.email}.`),
    codeBlock("Verification code", input.code),
    paragraph(`The code expires in ${input.expiresMinutes} minutes.`),
    paragraph("If you did not create an account, ignore this message.")
  ].join("")
  return {
    to: input.email,
    subject,
    text: [
      `Use this code to verify ${input.email}.`,
      "",
      input.code,
      "",
      `The code expires in ${input.expiresMinutes} minutes.`,
      "If you did not create an account, ignore this message."
    ].join("\n"),
    html: layout(input.appName, subject, body)
  }
}

export interface LoginOtpEmailInput {
  readonly appName: string
  readonly email: string
  readonly code: string
  readonly expiresMinutes: number
}

export const loginOtpEmail = (input: LoginOtpEmailInput): EmailMessage => {
  const subject = `Your ${input.appName} login code`
  const body = [
    paragraph(`Use this code to finish signing in as ${input.email}.`),
    codeBlock("Login code", input.code),
    paragraph(`The code expires in ${input.expiresMinutes} minutes.`),
    paragraph("If you did not try to sign in, change your password immediately.")
  ].join("")
  return {
    to: input.email,
    subject,
    text: [
      `Use this code to finish signing in as ${input.email}.`,
      "",
      input.code,
      "",
      `The code expires in ${input.expiresMinutes} minutes.`,
      "If you did not try to sign in, change your password immediately."
    ].join("\n"),
    html: layout(input.appName, subject, body)
  }
}

export const passwordlessOtpEmail = (input: LoginOtpEmailInput): EmailMessage => {
  const subject = `Your ${input.appName} sign-in code`
  const body = [
    paragraph(`Use this code to sign in as ${input.email}.`),
    codeBlock("Sign-in code", input.code),
    paragraph(`The code expires in ${input.expiresMinutes} minutes.`),
    paragraph("If you did not request this, ignore this message.")
  ].join("")
  return {
    to: input.email,
    subject,
    text: [
      `Use this code to sign in as ${input.email}.`,
      "",
      input.code,
      "",
      `The code expires in ${input.expiresMinutes} minutes.`,
      "If you did not request this, ignore this message."
    ].join("\n"),
    html: layout(input.appName, subject, body)
  }
}

// ---------------------------------------------------------------------------
// Collection-aware templates
// ---------------------------------------------------------------------------

/** The six built-in auth email templates. */
export type EmailTemplateId =
  | "verification"
  | "loginOtp"
  | "passwordless"
  | "passwordReset"
  | "emailChange"
  | "loginAlert"

/** Input shape per template, reusing the built-in builders' input interfaces. */
export type EmailTemplateInputs = {
  readonly verification: VerificationOtpEmailInput
  readonly loginOtp: LoginOtpEmailInput
  readonly passwordless: LoginOtpEmailInput
  readonly passwordReset: PasswordResetEmailInput
  readonly emailChange: EmailChangeEmailInput
  readonly loginAlert: LoginAlertEmailInput
}

/** A rendered message without the recipient — the flow owns `to`. */
export type EmailTemplateContent = Omit<EmailMessage, "to">

/**
 * A renderer for a single template. Overrides are trusted application code
 * (`(input) => content`), not mustache strings.
 */
export type EmailTemplateOverrides = {
  readonly [K in EmailTemplateId]?: (input: EmailTemplateInputs[K]) => EmailTemplateContent
}

/**
 * Template overrides: `defaults` apply app-wide, `collections` overrides apply
 * to one registered auth collection. Resolution order is collection → global
 * default → built-in.
 */
export interface EmailTemplatesConfig {
  readonly defaults?: EmailTemplateOverrides
  readonly collections?: Readonly<Record<string, EmailTemplateOverrides>>
}

/** Where the effective template came from. */
export type EmailTemplateSource = "builtin" | "global" | "collection"

/** Read-only preview of one effective template, safe to send to the dashboard. */
export interface EmailTemplatePreview {
  readonly id: EmailTemplateId
  readonly label: string
  readonly source: EmailTemplateSource
  readonly subject: string
  readonly text: string
  readonly html: string | null
}

export interface EmailTemplatesShape {
  render<K extends EmailTemplateId>(
    collection: string,
    id: K,
    input: EmailTemplateInputs[K]
  ): EmailTemplateContent
  preview(collection: string, appName: string): ReadonlyArray<EmailTemplatePreview>
  source(collection: string, id: EmailTemplateId): EmailTemplateSource
}

type RequiredTemplateRenderers = {
  readonly [K in EmailTemplateId]: (input: EmailTemplateInputs[K]) => EmailTemplateContent
}

/** Strip CR/LF so user-supplied subjects cannot inject mail headers. */
export const sanitizeEmailSubject = (subject: string) =>
  subject.replace(/[\r\n]+/g, " ").trim()

/** Build an `EmailMessage` without its `to` field. */
const withoutRecipient = (message: EmailMessage): EmailTemplateContent => ({
  subject: message.subject,
  text: message.text,
  ...(message.html === undefined ? {} : { html: message.html }),
  ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
  ...(message.headers === undefined ? {} : { headers: message.headers })
})

export const EMAIL_TEMPLATE_IDS: ReadonlyArray<EmailTemplateId> = [
  "verification",
  "loginOtp",
  "passwordless",
  "passwordReset",
  "emailChange",
  "loginAlert"
]

const EMAIL_TEMPLATE_LABELS: { readonly [K in EmailTemplateId]: string } = {
  verification: "Verification OTP",
  loginOtp: "Login OTP",
  passwordless: "Passwordless OTP",
  passwordReset: "Password reset",
  emailChange: "Email change",
  loginAlert: "Login alert"
}

/**
 * The built-in renderers, minus the recipient. These are the exact messages
 * `auth-email.ts` sent before the template service existed.
 */
const BUILTIN_TEMPLATES: RequiredTemplateRenderers = {
  verification: (input) => withoutRecipient(verificationOtpEmail(input)),
  loginOtp: (input) => withoutRecipient(loginOtpEmail(input)),
  passwordless: (input) => withoutRecipient(passwordlessOtpEmail(input)),
  passwordReset: (input) => withoutRecipient(passwordResetEmail(input)),
  emailChange: (input) => withoutRecipient(emailChangeEmail(input)),
  loginAlert: (input) => withoutRecipient(loginAlertEmail(input))
}

const overrideFor = <K extends EmailTemplateId>(
  config: EmailTemplatesConfig,
  collection: string,
  id: K
): ((input: EmailTemplateInputs[K]) => EmailTemplateContent) | undefined => {
  const perCollection = config.collections?.[collection]
  const fromCollection = perCollection?.[id]
  if (fromCollection !== undefined) return fromCollection
  return config.defaults?.[id]
}

const sourceFor = <K extends EmailTemplateId>(
  config: EmailTemplatesConfig,
  collection: string,
  id: K
): EmailTemplateSource => {
  if (config.collections?.[collection]?.[id] !== undefined) return "collection"
  if (config.defaults?.[id] !== undefined) return "global"
  return "builtin"
}

const PREVIEW_EMAIL = "user@example.invalid"
const PREVIEW_NEW_EMAIL = "new-user@example.invalid"
const PREVIEW_TOKEN = "sample-token-not-valid"
const PREVIEW_IP = "203.0.113.10"
const PREVIEW_TIME = "2026-01-01T00:00:00.000Z"

const previewUrl = (collection: string, path: string) =>
  `https://example.invalid/${path}?token=${PREVIEW_TOKEN}&collection=${encodeURIComponent(collection)}`

/**
 * Pure template resolver. Defaults to the six built-ins; overrides are looked
 * up per collection first, then app-wide.
 */
export const makeEmailTemplates = (config: EmailTemplatesConfig = {}): EmailTemplatesShape => {
  const render = <K extends EmailTemplateId>(
    collection: string,
    id: K,
    input: EmailTemplateInputs[K]
  ): EmailTemplateContent => {
    const override = overrideFor(config, collection, id)
    const content = override === undefined ? BUILTIN_TEMPLATES[id](input) : override(input)
    return { ...content, subject: sanitizeEmailSubject(content.subject) }
  }

  const source = (collection: string, id: EmailTemplateId) => sourceFor(config, collection, id)

  const previewOf = <K extends EmailTemplateId>(
    id: K,
    collection: string,
    appName: string,
    input: EmailTemplateInputs[K]
  ): EmailTemplatePreview => {
    const content = render(collection, id, input)
    return {
      id,
      label: EMAIL_TEMPLATE_LABELS[id],
      source: sourceFor(config, collection, id),
      subject: content.subject,
      text: content.text,
      html: content.html ?? null
    }
  }

  const preview = (collection: string, appName: string): ReadonlyArray<EmailTemplatePreview> => [
    previewOf("verification", collection, appName, {
      appName,
      email: PREVIEW_EMAIL,
      code: "123456",
      expiresMinutes: 10
    }),
    previewOf("loginOtp", collection, appName, {
      appName,
      email: PREVIEW_EMAIL,
      code: "123456",
      expiresMinutes: 10
    }),
    previewOf("passwordless", collection, appName, {
      appName,
      email: PREVIEW_EMAIL,
      code: "123456",
      expiresMinutes: 10
    }),
    previewOf("passwordReset", collection, appName, {
      appName,
      email: PREVIEW_EMAIL,
      resetUrl: previewUrl(collection, "reset-password"),
      expiresMinutes: 30
    }),
    previewOf("emailChange", collection, appName, {
      appName,
      currentEmail: PREVIEW_EMAIL,
      newEmail: PREVIEW_NEW_EMAIL,
      confirmUrl: previewUrl(collection, "email-change"),
      expiresMinutes: 30
    }),
    previewOf("loginAlert", collection, appName, {
      appName,
      collection,
      email: PREVIEW_EMAIL,
      ip: PREVIEW_IP,
      userAgent: "Mira preview (sample)",
      time: PREVIEW_TIME
    })
  ]

  return { render, preview, source }
}

/**
 * Template service tag. The default value is the six built-ins, so callers and
 * plugin routes never have to add a layer requirement.
 */
export const EmailTemplates = Context.Reference<EmailTemplatesShape>("mira/EmailTemplates", {
  defaultValue: () => makeEmailTemplates()
})
