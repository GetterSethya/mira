import { createMiraClient } from "@gettersethya/mira-client"
import { SuperAdminDef } from "../../../src/collection.js"

export const mira = createMiraClient("/").withCollections({
  superadmin: SuperAdminDef
})

export { SuperAdminDef as SuperAdminCollection }
