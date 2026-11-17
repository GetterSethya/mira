/** The single production DDL source for the `_config` system table. */
export const CONFIG_TABLE_DDL =
  "CREATE TABLE IF NOT EXISTS _config (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
