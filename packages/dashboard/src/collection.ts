import { AuthCollection, Field } from "@gettersethya/mira-client"

/**
 * Browser-safe collection definition for the dashboard's superadmin collection.
 *
 * Kept in its own module (importing only `@gettersethya/mira-client`) so the
 * dashboard UI bundle can import it without pulling in `@gettersethya/mira`,
 * which transitively reaches Node-only APIs (`node:crypto`,
 * `@effect/platform-node`) and breaks the browser build.
 *
 * Rules are attached server-side in `superadmin.ts` via `defineRule`.
 */
export const SuperAdminDef = AuthCollection.define("_superadmin", {
  name: Field.text({ default: "" })
})
