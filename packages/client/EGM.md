# Mira Client SDK Blueprint (`packages/client`)

## System Overview

`@gettersethya/mira-client` is the isomorphic TypeScript client SDK for a Mira server. It gives each collection definition a typed accessor (`getList`, `getOne`, `getFirstOrNone`, `getFullList`, `create`, `update`, `delete`, auth methods for auth collections, and file-field helpers) and exposes every operation through a dual-interface handler: Promise-based `.raw()` or Effect-based `.toEffect()`.

The package is a workspace member that depends on `@gettersethya/mira-collection` for the collection DSL and keeps `effect` as a peer dependency. It is built with `tsc` plus `tsc-alias` (rewriting `@/` aliases to relative imports) and published from `dist`; the source is rooted in [`src`](./src/EGM.md), with the implementation concentrated in [`src/client`](./src/client/EGM.md).

## Subdirectories & System Boundaries

- `src`: [Source entry](./src/EGM.md) — the package barrel (`src/index.ts`) that re-exports the client SDK and collection DSL.
  - `src/client`: [Client SDK implementation](./src/client/EGM.md) — handlers, collection/factory wiring, browser/server auth, file-field clients, telemetry client, and adapter enrichment types.

## Global Invariants

- The published package surface is a single entry: `exports["."]` points at `./dist/index.js` / `./dist/index.d.ts`; no subpath or source imports are exported. [package.json:exports]
- `effect` is a peer dependency, so the SDK never bundles a second Effect runtime. [package.json:peerDependencies]
- The collection DSL is consumed from the workspace package `@gettersethya/mira-collection`, not reimplemented locally. [package.json:dependencies]
- Every HTTP failure surfaced by the SDK is a `MiraError` with an HTTP `status` and response `body`. [src/client/errors.ts:MiraError]
- One `createMiraClient` factory covers both deployment modes: browser (cookie session, `credentials: "include"`) and server/SSR (manual bearer token). [src/client/factory.ts:createMiraClient] [src/client/factory.ts:createExecute]
- The SDK is environment-neutral: it uses `fetch`, `FormData`, `URLSearchParams`, `Blob`, and `globalThis.atob`, with no Node-only imports in `src`. [src/client/handler.ts:FetchHttpClient] [src/client/auth.ts:decodeJwtExp]
- Client state is per instance: auth token, login flag, session memo, and file-token cache are created inside the factory and never shared across `createMiraClient` calls. [src/client/factory.ts:createMiraClientInternal]
- Auth-bearing collection accessors guarantee `authWithPassword`/`register`/`me` at the type level through the kind-indexed `AuthByKind` lookup. [src/client/collection.ts:AuthByKind]

## Global Side Effects

- Network I/O: every operation issues an HTTP request to the configured `baseUrl` (`/api/collections/*`, `/api/auth/*`, `/api/files/*`, `/api/_schema`, `/api/_telemetry/*`). [src/client/factory.ts:createExecute]
- Browser cookie jar: browser-mode requests opt into cookies with `FetchHttpClient.RequestInit` `{ credentials: "include" }`. [src/client/factory.ts:createExecute]
- In-memory mutable state: `MutableRef` values for the auth token, login flag, session memo, and per-collection file-token cache. [src/client/factory.ts:createMiraClientInternal]
- File-token cache writes on successful `POST /api/files/token`, with a 30-second expiry buffer. [src/client/file.ts:makeGetFileToken]
- Fire-and-forget logout request on `BrowserAuth.clear()`. [src/client/auth.ts:makeBrowserAuth]
- Scheduling/timers: a configured retry `Schedule` can delay and re-run failed effects. [src/client/collection.ts:withRetry]
- No disk, database, `localStorage`, or environment-variable access; configuration is passed explicitly to the factory. [src/client/factory.ts:createMiraClient]

## System Verification

- Run: `pnpm --filter @gettersethya/mira-client test`
- Optional typecheck: `pnpm --filter @gettersethya/mira-client typecheck`
