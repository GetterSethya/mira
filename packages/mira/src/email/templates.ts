import type { EmailMessage } from "./types.js"

const escapeHtml = (value: string) =>
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
