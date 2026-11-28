import type { Cron, Effect, Schedule } from "effect"
import { Data } from "effect"

import type { PlatformServices } from "@/app/types.js"
import type { CollectionService } from "@/collection-service/collection-service.js"
import type { AppConfig } from "@/config/index.js"
import type { Repository } from "@/repository/index.js"

export interface CronDef<R = PlatformServices | AppConfig | Repository | CollectionService, E = unknown> {
  readonly name: string
  readonly description?: string
  readonly schedule: Schedule.Schedule<unknown, unknown, Cron.CronParseError>
  readonly handler: () => Effect.Effect<void, E, R>
}

export interface CronContext {
  readonly name: string
  readonly scheduledAt: Date
}

export interface CronResultContext {
  readonly name: string
  readonly scheduledAt: Date
  readonly durationMs: number
}

export interface CronErrorContext {
  readonly name: string
  readonly scheduledAt: Date
  readonly durationMs: number
  readonly error: unknown
}

export interface CronFinishedContext {
  readonly name: string
  readonly scheduledAt: Date
  readonly durationMs: number
  readonly status: "success" | "error"
  readonly error: unknown
}

export interface CronState {
  readonly name: string
  readonly description: string | undefined
  readonly status: "standby" | "running"
  readonly lastRunAt: Date | undefined
  readonly lastStatus: "success" | "error" | undefined
  readonly lastDurationMs: number | undefined
  readonly lastError: unknown
}

export class CronNotFoundError extends Data.TaggedError("CronNotFoundError")<{
  // oxlint-disable-next-line effecttsgo/error-payload-shadows-name -- the cron name is part of the public error shape and is read by consumers
  readonly name: string
}> {}
