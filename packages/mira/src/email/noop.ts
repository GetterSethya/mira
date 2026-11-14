import { Effect, Layer } from "effect"

import type { MiraEmail } from "@/app/types.js"

import { EmailNotConfiguredError, EmailService } from "./types.js"

const notConfigured = () =>
  new EmailNotConfiguredError({
    message: "Email transport is not configured. Add .email(SmtpEmail(...)) to the Mira builder."
  })

/** Default email preset. It exists so plugins can always require `EmailService`. */
export const NoopEmail: MiraEmail = {
  layer: Layer.succeed(EmailService, {
    enabled: false,
    send: () => Effect.fail(notConfigured()),
    verify: () => Effect.fail(notConfigured()),
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
  })
}
