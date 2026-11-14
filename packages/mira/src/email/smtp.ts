import { Effect, Layer, Redacted } from "effect"

import type { MiraEmail } from "@/app/types.js"
import { AppConfig } from "@/config/index.js"
import { resolveConfigValue, unwrapSecret } from "@/config/config-value.js"
import type { ConfigValue } from "@/config/config-value.js"

import type { EmailDescription, EmailMessage, EmailSendOptions, MailTransportConfig } from "./types.js"
import { EmailService, MailTransport } from "./types.js"

export type SmtpConfigValue<T> = ConfigValue<T>

export interface SmtpEmailConfig {
  readonly host: SmtpConfigValue<string>
  readonly port: SmtpConfigValue<number>
  readonly secure?: SmtpConfigValue<boolean>
  readonly requireTLS?: SmtpConfigValue<boolean>
  readonly auth?: {
    readonly user: SmtpConfigValue<string>
    readonly pass: SmtpConfigValue<string | Redacted.Redacted<string>>
  }
  readonly from: SmtpConfigValue<string>
  readonly replyTo?: SmtpConfigValue<string>
  readonly appUrl?: SmtpConfigValue<string>
  readonly passwordResetUrl?: SmtpConfigValue<string>
  readonly connectionTimeoutMs?: SmtpConfigValue<number>
  readonly greetingTimeoutMs?: SmtpConfigValue<number>
  readonly socketTimeoutMs?: SmtpConfigValue<number>
  readonly tls?: {
    readonly rejectUnauthorized?: SmtpConfigValue<boolean>
    readonly servername?: SmtpConfigValue<string>
  }
}

const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000
const DEFAULT_GREETING_TIMEOUT_MS = 10_000
const DEFAULT_SOCKET_TIMEOUT_MS = 30_000

const resolve = <A>(value: ConfigValue<A> | undefined, fallback: A) =>
  value === undefined ? Effect.succeed(fallback) : resolveConfigValue(value)

const requireResetPlaceholders = (template: string) => {
  if (!template.includes("{{token}}") || !template.includes("{{collection}}")) {
    throw new Error(
      "SmtpEmail.passwordResetUrl must contain both {{token}} and {{collection}} placeholders"
    )
  }
  return template
}

/**
 * SMTP-backed email preset.
 *
 * Settings are resolved once when the layer is built, like
 * `S3CompatibleStorage`. The actual socket work is delegated to the platform
 * `MailTransport`, so this file does not import nodemailer.
 */
export const SmtpEmail = (config: SmtpEmailConfig): MiraEmail => ({
  layer: Layer.effect(
    EmailService,
    Effect.gen(function* () {
      const appConfig = yield* AppConfig
      const transport = yield* MailTransport

      const host = yield* resolveConfigValue(config.host)
      const port = yield* resolveConfigValue(config.port)
      const secure = yield* resolve(config.secure, false)
      const requireTLS = yield* resolve(config.requireTLS, false)
      const from = yield* resolveConfigValue(config.from)
      const replyTo = config.replyTo === undefined ? undefined : yield* resolveConfigValue(config.replyTo)
      const configuredAppUrl =
        config.appUrl === undefined ? undefined : yield* resolveConfigValue(config.appUrl)
      const configuredResetUrl =
        config.passwordResetUrl === undefined
          ? undefined
          : yield* resolveConfigValue(config.passwordResetUrl)
      const connectionTimeoutMs = yield* resolve(
        config.connectionTimeoutMs,
        DEFAULT_CONNECTION_TIMEOUT_MS
      )
      const greetingTimeoutMs = yield* resolve(
        config.greetingTimeoutMs,
        DEFAULT_GREETING_TIMEOUT_MS
      )
      const socketTimeoutMs = yield* resolve(config.socketTimeoutMs, DEFAULT_SOCKET_TIMEOUT_MS)
      const rejectUnauthorized = yield* resolve(config.tls?.rejectUnauthorized, true)
      const servername =
        config.tls?.servername === undefined
          ? null
          : yield* resolveConfigValue(config.tls.servername)

      const user =
        config.auth === undefined
          ? null
          : yield* resolveConfigValue(config.auth.user)
      const pass =
        config.auth === undefined
          ? null
          : unwrapSecret(yield* resolveConfigValue(config.auth.pass))

      const transportConfig: MailTransportConfig = {
        host,
        port,
        secure,
        requireTLS,
        from,
        replyTo: replyTo ?? null,
        auth: user === null || pass === null ? null : { user, pass },
        connectionTimeoutMs,
        greetingTimeoutMs,
        socketTimeoutMs,
        tls: { rejectUnauthorized, servername }
      }

      const resetUrl = () => {
        if (configuredResetUrl !== undefined) {
          return requireResetPlaceholders(configuredResetUrl)
        }
        const appUrl = configuredAppUrl ?? appConfig.applicationUrl
        return requireResetPlaceholders(
          `${appUrl}/reset-password?token={{token}}&collection={{collection}}`
        )
      }

      const describe = (): EmailDescription => ({
        enabled: true,
        transport: "smtp",
        host,
        port,
        secure,
        requireTLS,
        from,
        replyTo: replyTo ?? null,
        hasAuth: transportConfig.auth !== null,
        passwordResetUrl: resetUrl()
      })

      return {
        enabled: true,
        send: (message: EmailMessage, options: EmailSendOptions) =>
          transport
            .send(transportConfig, message)
            .pipe(
              Effect.withSpan("email.send", {
                kind: "client",
                attributes: { "email.purpose": options.purpose, "email.enabled": true }
              })
            ),
        verify: () => transport.verify(transportConfig).pipe(Effect.withSpan("email.verify", { kind: "client" })),
        describe
      }
    }).pipe(Effect.orDie)
  )
})
