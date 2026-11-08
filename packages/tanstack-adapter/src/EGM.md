# tanstack-adapter/src

## Overview

This directory is the entire implementation of
`@gettersethya/mira-tanstack-adapter`. `_core.ts` defines the framework-agnostic
adapter: it enriches Mira `CollectionClient` handlers with structured query keys
and plain TanStack-compatible option objects. `index.ts` is a pure barrel that
re-exports the supported public surface and hides the internal mapped type used
to correlate collection kinds with auth extras. Nothing here imports a UI
framework, TanStack, or server-only Mira code.

## Interface

- `QueryKey` (type) — readonly array of unknown values used as a TanStack query key — `[_core.ts:QueryKey]`.
- `QueryOptionsShape<T>` (type) — alias for the client SDK's `AdaptedQueryOptions<T>` (`{ queryKey, queryFn }`) — `[_core.ts:QueryOptionsShape]`.
- `MutationOptionsShape<TData, TInput>` (type) — alias for `AdaptedMutationOptions<TData, TInput>` (`{ mutationFn }`) — `[_core.ts:MutationOptionsShape]`.
- `ActionKeys` — `as const` map of action names to string keys: `getList`, `getOne`, `getFirstOrNone`, `getFullList`, `me` — `[_core.ts:ActionKeys]`.
- `ActionKey` (type) — union of every `ActionKeys` value — `[_core.ts:ActionKey]`.
- `enrichQuery(handler, key)` — attaches `queryKey` and `{ queryKey, queryFn }` to a zero-arg-`raw()` handler and returns the same handler — `[_core.ts:enrichQuery]`.
- `enrichMutation(handler)` — attaches `{ mutationFn }` to a single-arg-`raw(input)` handler and returns the same handler — `[_core.ts:enrichMutation]`.
- `createCollectionAdapter()` — factory returning a fresh `adaptCollectionClient` function — `[_core.ts:createCollectionAdapter]`.
- `adaptCollectionClient(client, name, kind)` — inner adapter function produced by the factory (not exported at module level); returns `AdaptedCollectionClient<F, K>` — `[_core.ts:adaptCollectionClient]`.
- `collectionAdapter` — prebuilt singleton adapter produced by `createCollectionAdapter()` — `[_core.ts:collectionAdapter]`.
- `KindAuthAdapters<F>` (type) — internal, non-exported mapped type that indexes per-kind auth builders so a generic kind yields only its own extras — `[_core.ts:KindAuthAdapters]`.
- `kindAuthAdapters` — per-call lookup constructed inside the adapter: `base`/`view` return `{}`, `auth` returns the auth extras — `[_core.ts:kindAuthAdapters]`.
- `fields` — the source client's fields map, passed through by reference — `[_core.ts:fields]`.
- `getList(options?)` — query method; key `[name, "getList", options ?? {}]` — `[_core.ts:getList]`.
- `getOne(id, options?)` — query method; key `[name, "getOne", id, options ?? {}]` — `[_core.ts:getOne]`.
- `getFirstOrNone(filter, options?)` — query method; key `[name, "getFirstOrNone", options ?? {}]` — `[_core.ts:getFirstOrNone]`.
- `getFullList(options?)` — query method; key `[name, "getFullList", options ?? {}]` — `[_core.ts:getFullList]`.
- `create()` — mutation method carrying `mutationOptions` — `[_core.ts:create]`.
- `update()` — mutation method carrying `mutationOptions` — `[_core.ts:update]`.
- `delete()` — mutation method carrying `mutationOptions` — `[_core.ts:delete]`.
- `authWithPassword()` — auth-kind-only mutation carrying `mutationOptions` — `[_core.ts:authWithPassword]`.
- `register()` — auth-kind-only mutation carrying `mutationOptions` — `[_core.ts:register]`.
- `me()` — auth-kind-only query; key `[name, "me"]` with no options segment — `[_core.ts:me]`.
- `invalidateAll(queryClient)` — calls `queryClient.invalidateQueries({ queryKey: [name] })` — `[_core.ts:invalidateAll]`.
- `invalidateOne(queryClient, id)` — calls `queryClient.invalidateQueries({ queryKey: [name, "getOne", id] })` — `[_core.ts:invalidateOne]`.
- Barrel: `index.ts` re-exports the four types and five values above and nothing else — `[index.ts:ActionKey]`, `[index.ts:collectionAdapter]`.

## Invariants

- The adapter type parameter `K` defaults to `"base"`; callers pass the kind explicitly because the runtime indexes `kindAuthAdapters[kind]` — `[_core.ts:adaptCollectionClient]`.
- `enrichQuery` and `enrichMutation` mutate the supplied handler in place with `Object.assign` and return that same object, preserving `raw()` and every other original member — `[_core.ts:enrichQuery]`, `[_core.ts:enrichMutation]`.
- Every query key starts with the collection name and the action key; `getOne` additionally inserts the record id before options — `[_core.ts:getList]`, `[_core.ts:getOne]`.
- Omitted options normalize to `{}` (`options ?? {}`), so `getList()` and `getList({})` produce identical keys — `[_core.ts:getList]`.
- `me` is the only key without an options element (`[name, "me"]`) — `[_core.ts:me]`.
- Per-kind extras are selected by the `kind` argument through the correlated `KindAuthAdapters` map; `base` and `view` contribute `{}` and only `auth` contributes `authWithPassword`/`register`/`me` — `[_core.ts:KindAuthAdapters]`, `[_core.ts:kindAuthAdapters]`.
- The adapter never re-implements transport: `queryFn` calls the handler's own `raw()`, and `mutationFn` forwards its input to `handler.raw(input)` — `[_core.ts:enrichQuery]`, `[_core.ts:enrichMutation]`.
- Query/mutation option objects are plain structural objects; the package has no TanStack import, so any TanStack binding can consume them — `[_core.ts:QueryOptionsShape]`, `[_core.ts:MutationOptionsShape]`.
- The option generics are declared `<const O ...>`, preserving literal `select`/`expand` keys so the adapted result types still narrow — `[_core.ts:getOne]`, `[_core.ts:getList]`.
- `invalidateAll` relies on TanStack prefix matching of `[name]`; `invalidateOne` targets exactly `[name, "getOne", id]` — `[_core.ts:invalidateAll]`, `[_core.ts:invalidateOne]`.
- `fields` is not copied or rebuilt; it is the same reference as `client.fields` — `[_core.ts:fields]`.

## Side Effects

- `enrichQuery` mutates the input handler object by adding `queryKey` and `queryOptions` — `[_core.ts:enrichQuery]`.
- `enrichMutation` mutates the input handler object by adding `mutationOptions` — `[_core.ts:enrichMutation]`.
- Invoking `queryOptions.queryFn` calls `handler.raw()`, which may perform client-side HTTP when the client executes — `[_core.ts:enrichQuery]`.
- Invoking `mutationOptions.mutationFn(input)` calls `handler.raw(input)`, which may perform client-side HTTP when the client executes — `[_core.ts:enrichMutation]`.
- `invalidateAll` calls the caller-supplied `queryClient.invalidateQueries`, mutating that external cache — `[_core.ts:invalidateAll]`.
- `invalidateOne` calls the caller-supplied `queryClient.invalidateQueries`, mutating that external cache — `[_core.ts:invalidateOne]`.
- Adapter creation performs no I/O and keeps no per-call state; the only module-level state is the `const collectionAdapter` singleton — `[_core.ts:createCollectionAdapter]`, `[_core.ts:collectionAdapter]`.

## Verification

- Run: `pnpm --filter @gettersethya/mira-tanstack-adapter test`
- Optional typecheck (build `@gettersethya/mira-collection` and `@gettersethya/mira-client` first): `pnpm --filter @gettersethya/mira-tanstack-adapter typecheck`
- Parent blueprint: [../EGM.md](../EGM.md)
