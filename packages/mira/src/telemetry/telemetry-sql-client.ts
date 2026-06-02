import { SqlClient } from "@effect/sql"
import { Context } from "effect"

/**
 * Tag for the dedicated SQLite SqlClient used by the telemetry system.
 * Separate from the main app SqlClient to avoid contention.
 */
export class TelemetrySqlClient extends Context.Tag("TelemetrySqlClient")<
  TelemetrySqlClient,
  SqlClient.SqlClient
>() {}
