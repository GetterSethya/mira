import { Context, Data, Effect } from "effect"

import type { RateLimitedError, RateLimitUnavailableError } from "@/rate-limit/errors.js"

/** A single outgoing email message. */
export interface EmailMessage {
  readonly to: string | ReadonlyArray<string>
  readonly subject: string
  readonly text: string
  readonly html?: string
  readonly replyTo?: string
  readonly headers?: Readonly<Record<string, string>>
}

/** Non-secret description of the configured transport, safe for the dashboard. */
export interface EmailDescription {
  readonly enabled: boolean
  readonly transport: "smtp" | "none"
  readonly host: string | null
  readonly port: number | null
  readonly secure: boolean
  readonly requireTLS: boolean
  readonly from: string | null
  readonly replyTo: string | null
  readonly hasAuth: boolean
  /** Template with `{{token}}` / `{{collection}}`, or null when disabled. */
  readonly passwordResetUrl: string | null
}

export interface EmailSendResult {
  readonly messageId: string
  readonly accepted: ReadonlyArray<string>
  readonly rejected: ReadonlyArray<string>
}

export class EmailNotConfiguredError extends Data.TaggedError("EmailNotConfiguredError")<{
  readonly message: string
}> {}

export class EmailSendError extends Data.TaggedError("EmailSendError")<{
  readonly code: string
  readonly command: string | null
  readonly responseCode: number | null
  readonly message: string
}> {}

export interface EmailSendOptions {
  readonly purpose: string
  readonly collection?: string
  readonly userId?: string
}

export type EmailError =
  | EmailNotConfiguredError
  | EmailSendError
  | RateLimitedError
  | RateLimitUnavailableError

export interface EmailServiceShape {
  readonly enabled: boolean
  send(message: EmailMessage, options: EmailSendOptions): Effect.Effect<EmailSendResult, EmailError>
  verify(): Effect.Effect<void, EmailError>
  describe(): EmailDescription
}

const defaultEmailService: EmailServiceShape = {
  enabled: false,
  send: () =>
    Effect.fail(
      new EmailNotConfiguredError({
        message: "Email transport is not configured. Add .email(SmtpEmail(...)) to the Mira builder."
      })
    ),
  verify: () =>
    Effect.fail(
      new EmailNotConfiguredError({
        message: "Email transport is not configured. Add .email(SmtpEmail(...)) to the Mira builder."
      })
    ),
  describe: () => ({
    enabled: false,
    transport: "none",
    host: null,
    port: null,
    secure: false,
    requireTLS: false,
    from: null,
    replyTo: null,
    hasAuth: false,
    passwordResetUrl: null
  })
}

/**
 * Email service tag with a no-op default. Plugins can always `yield* EmailService`
 * and check `enabled`; no additional layer requirement is introduced.
 */
export const EmailService = Context.Reference<EmailServiceShape>("mira/EmailService", {
  defaultValue: () => defaultEmailService
})

/** Resolved SMTP connection settings handed to the platform mail transport. */
export interface MailTransportConfig {
  readonly host: string
  readonly port: number
  readonly secure: boolean
  readonly requireTLS: boolean
  readonly from: string
  readonly replyTo: string | null
  readonly auth: { readonly user: string; readonly pass: string } | null
  readonly connectionTimeoutMs: number
  readonly greetingTimeoutMs: number
  readonly socketTimeoutMs: number
  readonly tls: {
    readonly rejectUnauthorized: boolean
    readonly servername: string | null
  }
}

/**
 * Platform capability for sending mail.
 *
 * The Node implementation is the only code that imports nodemailer, so the
 * `EmailService` contract remains portable.
 */
export interface MailTransportShape {
  send(
    config: MailTransportConfig,
    message: EmailMessage
  ): Effect.Effect<EmailSendResult, EmailSendError>
  verify(config: MailTransportConfig): Effect.Effect<void, EmailSendError>
  describe(config: MailTransportConfig): EmailDescription
}

export class MailTransport extends Context.Service<MailTransport, MailTransportShape>()("MailTransport") {}
