import { LocalFileStorage, Mira, NodePlatform, SqliteDatabase } from "@gettersethya/mira"

const app = Mira.builder()
  .platform(NodePlatform)
  .database(SqliteDatabase({ filename: process.env["DB_PATH"] ?? "mira.db" }))
  .storage(LocalFileStorage({ directory: process.env["UPLOAD_DIR"] ?? "./uploads" }))
  .collections([])
  .build()

app.serve()
