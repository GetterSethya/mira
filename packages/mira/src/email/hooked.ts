import { Effect, Layer } from "effect"

import { HookService } from "@/hooks/hook-service.js"
import type { EmailSendHookContext } from "@/hooks/types.js"

import { EmailService } from "./types.js"

/**
 * Decorator that routes every email through the plugin hooks before and after
 * the base transport. Only this layer's output is provided to the app.
 */
export const makeHookedEmailServiceLayer = () =>
  Layer.effect(
    EmailService,
    Effect.gen(function* () {
      const base = yield* EmailService
      const hooks = yield* HookService

      const send = (message: Parameters<typeof base.send>[0], options: Parameters<typeof base.send>[1]) =>
        Effect.gen(function* () {
          const context: EmailSendHookContext = {
            message,
            purpose: options.purpose,
            collection: options.collection ?? null,
            userId: options.userId ?? null,
            originalTo: message.to,
            skip: false
          }
          const hooked = yield* hooks.runEmailSend(context)
          if (hooked.skip) {
            return {
              messageId: "",
              accepted: [],
              rejected: []
            }
          }
          const result = yield* base.send(hooked.message, options).pipe(
            Effect.tapError((error) =>
              error._tag === "EmailSendError"
                ? hooks.runEmailError({
                    message: hooked.message,
                    purpose: hooked.purpose,
                    collection: hooked.collection,
                    userId: hooked.userId,
                    error
                  })
                : Effect.void
            )
          )
          yield* hooks.runEmailSent({
            message: hooked.message,
            purpose: hooked.purpose,
            collection: hooked.collection,
            userId: hooked.userId,
            result
          })
          return result
        })

      return {
        enabled: base.enabled,
        send,
        verify: base.verify,
        describe: base.describe
      }
    })
  )
