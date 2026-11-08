# @gettersethya/mira-tanstack-adapter Blueprint

## Overview

`@gettersethya/mira-tanstack-adapter` is the framework-agnostic TanStack Query
bridge for the Mira client SDK. It wraps a `CollectionClient` so every query
handler additionally exposes `queryKey` / `queryOptions` and every mutation
handler exposes `mutationOptions`, while leaving the underlying `raw()` method
intact. The option objects are plain `{ queryKey, queryFn }` /
`{ mutationFn }` structures, so the package imports no TanStack, React, Solid,
or Svelte code — any TanStack Query binding accepts the same objects and infers
`data` from the handler's return type. The package ships a single ESM entry and
depends only on `@gettersethya/mira-client` at runtime.

## Interface

- Package manifest: ESM (`"type": "module"`), single `.` export backed by `./dist/index.js` with `./dist/index.d.ts` types — `[package.json:exports]`.
- Peer dependency on `@gettersethya/mira-client` only; no TanStack package appears in `dependencies` or `peerDependencies` — `[package.json:peerDependencies]`.
- Published file set is `dist` and the build runs clean → `tsc` → export check — `[package.json:files]`, `[package.json:scripts]`.
- Re-exported type surface: `ActionKey` (type), `MutationOptionsShape` (type), `QueryKey` (type), `QueryOptionsShape` (type) — `[src/index.ts:ActionKey]`, `[src/index.ts:MutationOptionsShape]`, `[src/index.ts:QueryKey]`, `[src/index.ts:QueryOptionsShape]`.
- Re-exported value surface: `ActionKeys`, `collectionAdapter`, `createCollectionAdapter`, `enrichMutation`, `enrichQuery` — `[src/index.ts:ActionKeys]`, `[src/index.ts:collectionAdapter]`, `[src/index.ts:createCollectionAdapter]`, `[src/index.ts:enrichMutation]`, `[src/index.ts:enrichQuery]`.
- `src` — [src/EGM.md](./src/EGM.md) — sole implementation directory: `_core.ts` holds the adapter and its types, `index.ts` is the public barrel.
- `README.md` — [README.md](./README.md) — usage guide (setup, queries, mutations, query-key structure, per-collection usage).

## Invariants

- The public surface is exactly the barrel in `src/index.ts`; `_core.ts` is deliberately reachable only through that barrel — `[src/index.ts:ActionKeys]`.
- Query option objects are structurally `{ queryKey, queryFn }` and mutation option objects are `{ mutationFn }`; no TanStack type or runtime import exists in the package — `[src/_core.ts:QueryOptionsShape]`, `[src/_core.ts:MutationOptionsShape]`.
- Query keys follow the shared `[collectionName, actionKey, ...params]` convention, so cache invalidation can target a whole collection or a single action — `[src/_core.ts:ActionKeys]`, `[src/_core.ts:getList]`.
- Auth-only accessors (`authWithPassword`, `register`, `me`) are produced only when the collection kind is `"auth"` — `[src/_core.ts:authWithPassword]`, `[src/_core.ts:me]`.
- `collectionAdapter` is a module-level singleton created by `createCollectionAdapter()`; adapter instances are stateless between calls — `[src/_core.ts:collectionAdapter]`, `[src/_core.ts:createCollectionAdapter]`.
- The only runtime package dependency is the peer `@gettersethya/mira-client`; TanStack Query is the consumer's choice — `[package.json:peerDependencies]`.

## Side Effects

- Importing the package constructs the stateless `collectionAdapter` singleton and nothing else — no I/O, timers, or environment reads — `[src/_core.ts:collectionAdapter]`.
- Adapter construction itself is pure closure creation; network traffic begins only when a produced `queryFn` / `mutationFn` is called — `[src/_core.ts:createCollectionAdapter]`.
- Cache mutation is external and opt-in: callers pass their own `queryClient` to `invalidateAll` / `invalidateOne` — `[src/_core.ts:invalidateAll]`, `[src/_core.ts:invalidateOne]`.

## Verification

- Run: `pnpm --filter @gettersethya/mira-tanstack-adapter test`
- Optional typecheck (build `@gettersethya/mira-collection` and `@gettersethya/mira-client` first): `pnpm --filter @gettersethya/mira-tanstack-adapter typecheck`
