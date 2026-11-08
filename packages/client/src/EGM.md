# Client Package Source Entry (`packages/client/src`)

## Overview

This directory holds the package entry barrel for `@gettersethya/mira-client`. `index.ts` is deliberately thin: it re-exports the runtime client SDK from `./client` and the shared collection DSL/filter/rule types from `@gettersethya/mira-collection`, so consumers use one import root for both the SDK and the definitions it operates on.

The implementation lives in the [`client`](./client/EGM.md) subdirectory.

## Interface

- `FilterBuilder<F>` (type) — explicitly re-exported from the client collection module; the builder type used in filter callbacks. [index.ts:FilterBuilder]
- Client SDK surface — `index.ts` re-exports every symbol from `./client/index.js` (handlers, `MiraError`, `createMiraClient`, `makeCollectionClient`, file helpers, telemetry client, and their types). [index.ts:client/index.js]
- Collection DSL surface — `index.ts` re-exports every symbol from `@gettersethya/mira-collection` (collection builders, filter DSL, rule builder, and inferred types). [index.ts:@gettersethya/mira-collection]
- Subdirectory contract: [Client SDK](./client/EGM.md) — per-file interfaces, invariants, and side effects for the client implementation.

## Invariants

- This file is a barrel only: it contains export declarations and no runtime logic or local definitions. [index.ts:client/index.js]
- The client SDK is surfaced through `./client/index.js`; new public client symbols must be exported there first to become visible here. [index.ts:client/index.js]
- `FilterBuilder<F>` is re-exported explicitly even though it also flows through the client barrel. [index.ts:FilterBuilder]
- Collection definitions, filters, and rules have a single source of truth in `@gettersethya/mira-collection`; this barrel does not duplicate or redefine them. [index.ts:@gettersethya/mira-collection]
- The barrel must remain environment-neutral: both re-exported modules are isomorphic and import no Node built-ins. [index.ts:client/index.js] [index.ts:@gettersethya/mira-collection]
- Package consumers resolve only the built `dist/index.js` entry; deep imports into `src` are not part of the published contract. [../package.json:exports]

## Side Effects

- None. The file performs no I/O, allocates no state, and registers no timers; it only evaluates the two re-exported module graphs. [index.ts:client/index.js]

## Verification

- Run: `pnpm --filter @gettersethya/mira-client test`
- Optional typecheck: `pnpm --filter @gettersethya/mira-client typecheck`
