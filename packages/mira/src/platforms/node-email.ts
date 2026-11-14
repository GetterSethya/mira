import { Effect, Layer } from "effect"
import * as nodemailer from "nodemailer"

import type {
  EmailDescription,
  EmailMessage,
  EmailSendResult,
  MailTransportConfig
} from "@/email/types.js"
import { EmailSendError, MailTransport } from "@/email/types.js"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const stringField = (record: Record<string, unknown>, key: string): string | null =>
  typeof record[key] === "string" ? record[key] : null

const numberField = (record: Record<string, unknown>, key: string): number | null =>
  typeof record[key] === "number" ? record[key] : null

const toSendError = (error: unknown): EmailSendError => {
  if (isRecord(error)) {
    return new EmailSendError({
      code: stringField(error, "code") ?? "EMAIL_SEND_FAILED",
      command: stringField(error, "command"),
      responseCode: numberField(error, "responseCode"),
      message: stringField(error, "message") ?? "Email send failed"
    })
  }
  return new EmailSendError({
    code: "EMAIL_SEND_FAILED",
    command: null,
    responseCode: null,
    message: typeof error === "string" ? error : "Email send failed"
  })
}

const makeTransporter = (config: MailTransportConfig): nodemailer.Transporter => nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    requireTLS: config.requireTLS,
    connectionTimeout: config.connectionTimeoutMs,
    greetingTimeout: config.greetingTimeoutMs,
    socketTimeout: config.socketTimeoutMs,
    ...(config.auth === null ? {} : { auth: { user: config.auth.user, pass: config.auth.pass } }),
    tls: {
      rejectUnauthorized: config.tls.rejectUnauthorized,
      ...(config.tls.servername === null ? {} : { servername: config.tls.servername })
    }
  })

const describe = (config: MailTransportConfig): EmailDescription => ({
  enabled: true,
  transport: "smtp",
  host: config.host,
  port: config.port,
  secure: config.secure,
  requireTLS: config.requireTLS,
  from: config.from,
  replyTo: config.replyTo,
  hasAuth: config.auth !== null,
  passwordResetUrl: null
})

const send = (config: MailTransportConfig, message: EmailMessage) =>
  Effect.tryPromise({
    try: async () => {
      const transporter = makeTransporter(config)
      try {
        const to = typeof message.to === "string" ? message.to : Array.from(message.to)
        const info = await transporter.sendMail({
          from: config.from,
          to,
          subject: message.subject,
          text: message.text,
          ...(message.html === undefined ? {} : { html: message.html }),
          ...(message.replyTo !== undefined
            ? { replyTo: message.replyTo }
            : config.replyTo !== null
              ? { replyTo: config.replyTo }
              : {}),
          ...(message.headers === undefined ? {} : { headers: message.headers })
        })
        const result: EmailSendResult = {
          messageId: info.messageId,
          accepted: info.accepted ?? [],
          rejected: info.rejected ?? []
        }
        return result
      } finally {
        transporter.close()
      }
    },
    catch: toSendError
  })

const verify = (config: MailTransportConfig) =>
  Effect.tryPromise({
    try: async () => {
      const transporter = makeTransporter(config)
      try {
        await transporter.verify()
      } finally {
        transporter.close()
      }
    },
    catch: toSendError
  })

/** Node-only `MailTransport`. This is the only module that imports nodemailer. */
export const NodeMailTransportLayer = Layer.succeed(MailTransport, {
  send,
  verify,
  describe
})
