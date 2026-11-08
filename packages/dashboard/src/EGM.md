# Dashboard Plugin (src)

## Overview

`packages/dashboard/src` is the server-side half of the Mira admin dashboard. It exports a single
`MiraPlugin` value (`MiraDashboard`) that the host app installs with `MiraApp.extend()`. The plugin
contributes an admin collection (`_superadmin`), a set of dashboard HTTP routes under `/_dashboard`,
lifecycle logging, and audit log hooks for record and cron events. It also serves the prebuilt
SvelteKit SPA from `ui/dist` and exposes pure code-generation / snippet builders consumed by that SPA
bundle.

The directory is split in two: this level holds the plugin definition, the browser-safe collection
definition, the route table, and the browser-importable generators (`codegen.ts`, `snippets.ts`,
`package-manager.ts`); `./api/EGM.md` documents the request handlers themselves.

Browser bundling constraint: `collection.ts` imports only `@gettersethya/mira-client` because
`@gettersethya/mira` transitively reaches Node-only APIs (`node:crypto`, `@effect/platform-node`) and
would break the browser build. Rules are therefore attached to the collection server-side in
`superadmin.ts`.

## Interface

### Plugin entry point

- `MiraDashboard` — the `MiraPlugin` definition: `adminCollections`, `routes`, lifecycle hooks, and audit hooks. [index.ts:MiraDashboard]
- `makeDashboardRouter` (re-export) — builds the `/_dashboard` route array for a given collection list. [index.ts:makeDashboardRouter], [router.ts:makeDashboardRouter]
- `SuperAdminCollection` (re-export) — the rule-bearing superadmin collection definition. [index.ts:SuperAdminCollection], [superadmin.ts:SuperAdminCollection]
- `getRegisterToken` / `setRegisterToken` / `generateRegisterToken` (re-exports) — in-memory first-boot registration token. [index.ts:getRegisterToken], [superadmin.ts:getRegisterToken], [superadmin.ts:setRegisterToken], [superadmin.ts:generateRegisterToken]
- `MiraPlugin` (type, re-exported from `@gettersethya/mira`) — plugin interface type. [index.ts:MiraPlugin]

### Collection definition

- `SuperAdminDef` — browser-safe `AuthCollection.define("_superadmin", …)` definition with a single `name` text field; carries no rules. [collection.ts:SuperAdminDef]
- `SuperAdminDef` (re-export from `collection.ts`). [superadmin.ts:SuperAdminDef]

### Collection rules and registration token

- `SuperAdminRules` — `defineRule` result granting list/view/update/delete only to actors whose `authCollection` is `_superadmin`, with `create: R.public()`. [superadmin.ts:SuperAdminRules]
- `SuperAdminCollection` — `SuperAdminDef` with `SuperAdminRules` applied via `applyRulesToCollections`. [superadmin.ts:SuperAdminCollection]
- `getRegisterToken` — returns the current module-level registration token. [superadmin.ts:getRegisterToken]
- `setRegisterToken` — replaces the module-level registration token. [superadmin.ts:setRegisterToken]
- `generateRegisterToken` — 32 random bytes encoded as a hex string. [superadmin.ts:generateRegisterToken]

### Routing

- `makeDashboardRouter(_collections)` — returns the ordered route list for the SPA plus every `/_dashboard/api/*` route; the `_collections` argument is currently unused. [router.ts:makeDashboardRouter]

| Method | Path | Handler | Registration |
|---|---|---|---|
| GET | `/_dashboard/*` | SPA static file / `index.html` fallback | [router.ts:makeDashboardSpaRoute] |
| GET | `/_dashboard/api/bootstrap-status` | `bootstrapStatusRoute` | [router.ts:makeDashboardRouter] |
| POST | `/_dashboard/api/register` | `registerRoute` | [router.ts:makeDashboardRouter] |
| POST | `/_dashboard/api/superadmin/create` | `createSuperadminRoute` (auth-wrapped) | [router.ts:makeDashboardRouter] |
| GET | `/_dashboard/api/superadmin` | `listSuperadminsRoute` (auth-wrapped) | [router.ts:makeDashboardRouter] |
| DELETE | `/_dashboard/api/superadmin/:id` | `deleteSuperadminRoute` (auth-wrapped) | [router.ts:makeDashboardRouter] |
| GET | `/_dashboard/api/config` | `configRoute` (auth-wrapped) | [router.ts:makeDashboardRouter] |
| PUT | `/_dashboard/api/config` | `configUpdateRoute` (auth-wrapped) | [router.ts:makeDashboardRouter] |
| GET | `/_dashboard/api/crons` | `cronsRoute` (auth-wrapped) | [router.ts:makeDashboardRouter] |
| POST | `/_dashboard/api/crons/:name/run` | `cronRunNowRoute` (auth-wrapped) | [router.ts:makeDashboardRouter] |

Auth-wrapped routes are guarded by `requireDashboardAuth`, see [./api/EGM.md](./api/EGM.md).

### Code generation

- `CodegenOptions` (type) — `include` collection-name filter and `generatedAt` header timestamp. [codegen.ts:CodegenOptions]
- `pascalCase(name)` — deterministic PascalCase identifier for a collection name; leading digits get a `_` prefix. [codegen.ts:pascalCase]
- `resolveSubset(schemas, rootName)` — the root collection plus the transitive closure of its relation targets, dependency-first. [codegen.ts:resolveSubset]
- `generateCollectionFile(schemas, options?)` — renders the whole `mira.generated.ts` module (imports, collection defs, record/create/update aliases, `collections` map). [codegen.ts:generateCollectionFile]

### Connect-sheet snippets

- `SnippetLanguage` (type) — `"ts" | "bash" | "json"`. [snippets.ts:SnippetLanguage]
- `SnippetBlock` (type) — `{ id, label, language, code }`. [snippets.ts:SnippetBlock]
- `SnippetSection` (type) — `{ id, heading, description, blocks }`. [snippets.ts:SnippetSection]
- `SnippetOptions` (type) — `{ schema, allSchemas, baseUrl, packageManager? }`. [snippets.ts:SnippetOptions]
- `sdkSections(options)` — plain client / server-to-server / TanStack Query sections. [snippets.ts:sdkSections]
- `fetchSections(options)` — raw `fetch` read/auth/write sections. [snippets.ts:fetchSections]
- `curlSections(options)` — `curl` read/auth/write sections. [snippets.ts:curlSections]

### Package managers

- `PACKAGE_MANAGERS` — `["pnpm", "npm", "yarn", "bun"]` in render order. [package-manager.ts:PACKAGE_MANAGERS]
- `PackageManager` (type) — element type of `PACKAGE_MANAGERS`. [package-manager.ts:PackageManager]
- `isPackageManager(value)` — type guard narrowing arbitrary values (`localStorage`, query params). [package-manager.ts:isPackageManager]
- `installCommand(manager, packages)` — renders the install command for a manager. [package-manager.ts:installCommand]

### Subdirectories

- [api](./api/EGM.md) — dashboard HTTP handlers: auth guard, bootstrap status, first-boot registration, superadmin CRUD, config read/write, cron list/run-now.

## Invariants

- `collection.ts` must import only from `@gettersethya/mira-client`; importing `@gettersethya/mira` there re-introduces Node-only APIs into the browser bundle. [collection.ts:SuperAdminDef]
- Rules are never part of the browser-safe definition; they are attached server-side by `defineRule` + `applyRulesToCollections`. [superadmin.ts:SuperAdminRules], [superadmin.ts:SuperAdminCollection]
- `MiraDashboard` declares `adminCollections: [SuperAdminCollection]`, which is what grants `_superadmin` tokens a rule bypass on the generic collection routes. [index.ts:MiraDashboard]
- `onBootstrap` generates a fresh registration token on every boot, but only calls `setRegisterToken` and logs a registration URL when the `_superadmin` list is empty; otherwise it logs the dashboard URL. [index.ts:MiraDashboard]
- The registration token lives in a module-level `let` and is lost on restart; it is not persisted. [superadmin.ts:setRegisterToken]
- `generateRegisterToken` requires `globalThis.crypto.getRandomValues` and Node's `Buffer`. [superadmin.ts:generateRegisterToken]
- `makeDashboardRouter` ignores its `_collections` argument; routes are static. [router.ts:makeDashboardRouter]
- The SPA route strips the `/_dashboard` prefix, serves the matching file from `ui/dist`, and falls back to `index.html` when the file does not exist (client-side routing). [router.ts:makeDashboardSpaRoute]
- `wrapRoute` maps a `DashboardUnauthorizedError` failure to 401, any other failure to 400, and a defect (no failure) to 500. [router.ts:wrapRoute]
- `wrapAuthRoute` runs `requireDashboardAuth` first, returns 401 when it fails, and annotates `auth.collection` on the current span and its parent. [router.ts:wrapAuthRoute]
- Generated code orders collections dependency-first; a relation cycle disables the ordering, falls back to input order, and emits a warning comment. [codegen.ts:generateCollectionFile], [codegen.ts:orderByDependencies]
- Generated field entries skip `x-system` fields, keep non-system `x-hidden` fields as `hidden: true`, and append `.view()` inside view collections. [codegen.ts:renderFieldEntries], [codegen.ts:renderSimpleField]
- A relation whose target collection is not emitted is downgraded to `Field.text(...)` with a `// relation target "…" was not found` comment. [codegen.ts:renderRelationField]
- `pascalCase` is deterministic and never emits an identifier starting with a digit. [codegen.ts:pascalCase]
- Snippet generation defaults the package manager to `"pnpm"` when `packageManager` is omitted. [snippets.ts:sdkSections]
- View collections (`kind === "view"`) get no create/update/delete snippets; they get list/getOne plus a read-only note instead. [snippets.ts:fetchSections], [snippets.ts:sdkSections]
- Auth collections always include `email`/`password`/`passwordConfirm` in generated create bodies. [snippets.ts:createBody]
- `installCommand` maps `npm` to `install` and the other three managers to `add`. [package-manager.ts:installCommand]

## Side Effects

- Registers the dashboard HTTP routes (SPA catch-all + nine `/api` routes) with the host router. [router.ts:makeDashboardRouter]
- Reads the SvelteKit SPA bundle from disk at `<module dir>/../../ui/dist`, including an `index.html` fallback read. [router.ts:makeDashboardSpaRoute]
- Requires `SqlClient` in its route service set, so the plugin's routes touch the SQLite database through the handler layer. [router.ts:DashboardRouteServices]
- Verifies JWTs on every auth-wrapped route via `requireDashboardAuth`, which reads `AppConfig.jwtSecret`. [router.ts:wrapAuthRoute], [./api/EGM.md](./api/EGM.md)
- Queries the `_superadmin` collection during `onBootstrap` with `admin: true`. [index.ts:MiraDashboard]
- Emits `Effect.log` lines on bootstrap/serve and on every audited create/update/delete and cron success/error. [index.ts:MiraDashboard]
- Mutates module-level registration-token state. [superadmin.ts:setRegisterToken]
- Uses non-deterministic randomness (`crypto.getRandomValues`) when minting a token. [superadmin.ts:generateRegisterToken]

## Verification

- Run: `pnpm --filter @gettersethya/mira-dashboard test`
