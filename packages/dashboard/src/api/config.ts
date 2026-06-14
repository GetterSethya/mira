import { Effect, Redacted } from "effect"
import { HttpServerResponse } from "@effect/platform"
import { AppConfig } from "@gettersethya/mira"

export const configRoute = Effect.gen(function* () {
  const config = yield* AppConfig

  const allConfig: Record<string, unknown> = {
    appName: config.appName,
    port: config.port,
    applicationUrl: config.applicationUrl,
    jwtSecret: `${Redacted.value(config.jwtSecret).slice(0, 4)}***`,
    useS3: config.useS3
  }

  return HttpServerResponse.unsafeJson({
    config: allConfig,
    keys: Object.keys(allConfig)
  })
})
