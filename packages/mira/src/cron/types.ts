import { Data } from "effect"
import type { Effect, Schedule } from "effect"
import type { PlatformServices } from "@/app/types.js"
import type { AppConfig } from "@/config/index.js"
import type { Repository } from "@/repository/index.js"
import type { CollectionService } from "@/collection-service/collection-service.js"

export interface CronDef<R = PlatformServices | AppConfig | Repository | CollectionService> {
  readonly name: string
  readonly schedule: Schedule.Schedule<unknown, unknown, never>
  readonly handler: () => Effect.Effect<void, unknown, R>
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
  readonly error: unknown | undefined
}

export interface CronState {
  readonly name: string
  readonly status: "standby" | "running"
  readonly lastRunAt: Date | undefined
  readonly lastStatus: "success" | "error" | undefined
  readonly lastDurationMs: number | undefined
  readonly lastError: unknown | undefined
}

export class CronNotFoundError extends Data.TaggedError("CronNotFoundError")<{
  readonly name: string
}> {}
