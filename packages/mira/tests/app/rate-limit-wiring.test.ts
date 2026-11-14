import { DatabaseSync } from "node:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { expect } from "vitest"

import { Mira } from "@/app/index.js"
import { SqliteDatabase } from "@/databases/index.js"
import { EmailService } from "@/email/types.js"
import type { EmailServiceShape } from "@/email/types.js"
import { NodePlatform } from "@/platforms/node.js"
import {
  defaultEmailRateLimitPolicies,
  RateLimitStore
} from "@/rate-limit/index.js"
import type { RateLimitStoreShape } from "@/rate-limit/index.js"
import { LocalFileStorage } from "@/storage/index.js"

const fakeEmail: EmailServiceShape = {
  enabled: true,
  send: () => Effect.succeed({ messageId: "m", accepted: [], rejected: [] }),
  verify: () => Effect.void,
  describe: () => ({
    enabled: true,
    transport: "smtp",
    host: "localhost",
    port: 1025,
    secure: false,
    requireTLS: false,
    from: "mira@example.com",
    replyTo: null,
    hasAuth: false,
    passwordResetUrl: "http://localhost/reset?token={{token}}&collection={{collection}}"
  })
}

describe("app rate-limit wiring", () => {
  it.effect("uses the SQLite store for EmailService.send by default", () => {
    const dir = mkdtempSync(join(tmpdir(), "mira-rate-wiring-"))
    const dbPath = join(dir, "data.db")
    const storageDir = join(dir, "uploads")
    const app = Mira.builder()
      .platform(NodePlatform)
      .database(SqliteDatabase({ filename: dbPath }))
      .storage(LocalFileStorage({ directory: storageDir }))
      .email({ layer: Layer.succeed(EmailService, fakeEmail) })
      .rateLimits({
        emailPolicies: {
          sendRecoveryHourly: {
            ...defaultEmailRateLimitPolicies.sendRecoveryHourly,
            limit: 1
          }
        }
      })
      .collections([])
      .build()

    return Effect.gen(function* () {
      const email = yield* EmailService
      const first = yield* email.send(
        { to: "a@example.com", subject: "s", text: "t" },
        { purpose: "password_reset", collection: "users" }
      )
      const second = yield* email
        .send(
          { to: "b@example.com", subject: "s", text: "t" },
          { purpose: "password_reset", collection: "users" }
        )
        .pipe(Effect.exit)
      expect(first.messageId).toBe("m")
      expect(second._tag).toBe("Failure")

      const db = new DatabaseSync(dbPath)
      try {
        const rows = db
          .prepare("SELECT bucket FROM _rate_limits WHERE bucket LIKE ?")
          .all("%email:send:recovery-hourly%")
        expect(rows.length).toBeGreaterThan(0)
      } finally {
        db.close()
      }
    }).pipe(
      Effect.provide(app.buildServiceLayer()),
      Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true })))
    )
  })

  it.effect("uses a custom store from .rateLimits()", () => {
    const dir = mkdtempSync(join(tmpdir(), "mira-rate-wiring-custom-"))
    const dbPath = join(dir, "data.db")
    let calls = 0
    const countingStore: RateLimitStoreShape = {
      increment: (entries) => {
        calls += 1
        return Effect.succeed({ ok: true, counts: entries.map((entry) => entry.cost) })
      },
      prune: () => Effect.void
    }
    const app = Mira.builder()
      .platform(NodePlatform)
      .database(SqliteDatabase({ filename: dbPath }))
      .storage(LocalFileStorage({ directory: join(dir, "uploads") }))
      .email({ layer: Layer.succeed(EmailService, fakeEmail) })
      .rateLimits({ store: Layer.succeed(RateLimitStore, countingStore) })
      .collections([])
      .build()

    return Effect.gen(function* () {
      const email = yield* EmailService
      yield* email.send(
        { to: "a@example.com", subject: "s", text: "t" },
        { purpose: "password_reset", collection: "users" }
      )
      expect(calls).toBeGreaterThan(0)
    }).pipe(
      Effect.provide(app.buildServiceLayer()),
      Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true })))
    )
  })
})
