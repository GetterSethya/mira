import { createMiraClient } from "@gettersethya/mira-client"
import { SuperAdminCollection } from "../../../src/superadmin.js"

export const mira = createMiraClient("/").withCollections({
  superadmin: SuperAdminCollection
})

export { SuperAdminCollection }
