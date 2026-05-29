/**
 * Entry point for the Mira server library.
 *
 * Usage:
 * ```ts
 * import { Mira, NodePlatform, SqliteDatabase, LocalFileStorage } from "@gettersethya/mira"
 *
 * const app = Mira.builder()
 *   .platform(NodePlatform)
 *   .database(SqliteDatabase({ filename: "data.db" }))
 *   .storage(LocalFileStorage({ directory: "./uploads" }))
 *   .collections([Posts, Users])
 *   .build()
 *   .serve()
 * ```
 *
 * @example
 * // Server-only: all client exports are re-exported from @gettersethya/mira too
 * import { BaseCollection, Field } from "@gettersethya/mira"
 *
 * @see MiraBuilder — the phantom-type fluent builder
 * @see MiraApp — the assembled server
 */
import { MiraBuilder } from "./builder.js"

export const Mira = {
  builder: () => new MiraBuilder(),
}

export type { MiraPlatform, MiraDatabase, MiraStorage } from "./types.js"
export type { MiraApp } from "./app.js"
export { MiraBuilder } from "./builder.js"
