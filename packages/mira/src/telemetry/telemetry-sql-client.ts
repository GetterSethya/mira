import { Context } from "effect"
import type { SqlClient } from "effect/sql"

/**
 * Tag for the dedicated SQLite SqlClient used by the telemetry system.
 * Separate from the main app SqlClient to avoid contention.
 */
export class TelemetrySqlClient extends Context.Service<
  TelemetrySqlClient,
  SqlClient.SqlClient
>()("TelemetrySqlClient") {}
